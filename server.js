// eRozgar backend: keeps the TinyFish key server-side, discovers (Search) and reads (Fetch) live listings,
// then extracts, dedupes, scores and ranks them. MySQL stores users, sessions, listings, applications, activity.
// Run: npm install && node server.js  (Node 18+)
const http = require('http'), fs = require('fs'), path = require('path');
try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }); } catch {}
const KEY = process.env.TINYFISH_API_KEY, PORT = process.env.PORT || 3000, H = { 'X-API-Key': KEY };
const cache = new Map(), TTL = 15 * 60e3;               // results stay fresh for 15 min; ?fresh=1 bypasses
// Portals + company careers/ATS boards searched in parallel
const SOURCES = [
  ['LinkedIn', 'site:linkedin.com/jobs'], ['Naukri', 'site:naukri.com'], ['Internshala', 'site:internshala.com'],
  ['Indeed', 'site:in.indeed.com'], ['Greenhouse', 'site:boards.greenhouse.io'], ['Lever', 'site:jobs.lever.co'],
  ['Ashby', 'site:jobs.ashbyhq.com'], ['Workable', 'site:apply.workable.com'], ['Careers pages', 'careers "apply now" -site:linkedin.com'] ];
const SENIOR = { intern: /intern(ship)?|trainee/i, fresher: /fresher|entry[- ]level|graduate|junior|associate|0-1|0-2 years/i,
  mid: /mid[- ]level|[2-5]\+? years|engineer ii/i, senior: /senior|lead|staff|principal|manager|[6-9]\+? years/i };
const VISA = /visa sponsorship|sponsor(ship)?|relocation|work permit|h-?1b/i;

async function search(query) {
  const r = await fetch('https://api.search.tinyfish.ai?' + new URLSearchParams({ query, location: 'IN', language: 'en' }), { headers: H });
  if (!r.ok) throw new Error('TinyFish search ' + r.status);
  const j = await r.json(); return j.results || j.data || [];
}
async function fetchPages(urls) {                         // TinyFish Fetch: URL -> clean markdown
  if (!urls.length) return {};
  try {
    const r = await fetch('https://api.fetch.tinyfish.ai', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ urls, format: 'markdown' }) });
    const j = await r.json(), arr = j.results || j.data || (Array.isArray(j) ? j : []), out = {};
    arr.forEach(x => { out[x.url || x.final_url] = String(x.text || x.content || x.markdown || ''); }); return out;
  } catch { return {}; }
}
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function parse(r, source) {
  let title = (r.title || '').replace(/\s*[|\-–]\s*(LinkedIn|Naukri\.com|Indeed.*|Internshala|Greenhouse|Lever|Careers?).*$/i, '').trim(), company = '';
  const m = title.match(/^(.*?)\s+(?:at|@|-|–|\|)\s+(.+)$/i) || title.match(/^(.+?) hiring (.+)$/i);
  if (m) { title = m[1]; company = m[2]; }
  if (!company) { try { const u = new URL(r.url); company = (u.pathname.split('/')[1] && /greenhouse|lever|ashby|workable/.test(u.host)) ? u.pathname.split('/')[1] : (r.site_name || u.hostname.replace(/^(www|careers|jobs)\./, '').split('.')[0]); } catch {} }
  return { title: title.slice(0, 120), company: company.slice(0, 60), url: r.url, snippet: r.snippet || '', source };
}
function enrich(j, text, p) {
  const all = `${j.title} ${j.snippet} ${text.slice(0, 6000)}`;
  const cityHit = p.city && new RegExp(p.city.split(',')[0].trim(), 'i').test(all);
  j.location = cityHit ? p.city : (/remote|work from home|wfh/i.test(all) ? 'Remote' : (all.match(/\b(Bengaluru|Bangalore|Delhi|Gurugram|Gurgaon|Noida|Mumbai|Pune|Hyderabad|Chennai|Kolkata|Ahmedabad|Jaipur)\b/i) || [])[1] || 'See listing');
  j.level = Object.keys(SENIOR).find(k => SENIOR[k].test(`${j.title} ${j.snippet}`)) || Object.keys(SENIOR).find(k => SENIOR[k].test(all)) || 'unspecified';
  j.visa = VISA.test(all); j.remote = /remote|work from home/i.test(all);
  j.isInternship = /intern/i.test(`${j.title} ${j.url}`);
  const terms = norm(p.q).split(' ').filter(w => w.length > 1); let s = 0, why = [];
  const tH = terms.filter(w => norm(j.title).includes(w)), bH = terms.filter(w => norm(all).includes(w));
  if (terms.length) { s += 45 * tH.length / terms.length + 20 * bH.length / terms.length; if (tH.length) why.push('title matches ' + tH.join(', ')); }
  if (cityHit) { s += 20; why.push('in ' + p.city); } else if (j.remote && p.city) { s += 8; why.push('remote-friendly'); }
  if (p.level && p.level !== 'any') { if (j.level === p.level) { s += 12; why.push(p.level + ' level'); } else if (j.level !== 'unspecified') s -= 10; }
  if (p.visa === '1') { if (j.visa) { s += 8; why.push('mentions visa/relocation'); } else s -= 4; }
  if (p.type === 'internship') s += j.isInternship ? 10 : -25; else if (p.type === 'job' && j.isInternship) s -= 25;
  if (/\/(jobs?|careers?|view|apply|position|job-listings)\b|\/\d{5,}|jobs\.lever|greenhouse/i.test(j.url)) s += 8;   // looks like a real posting
  j.score = Math.max(0, Math.min(99, Math.round(s))); j.why = why; return j;
}
async function findJobs(p) {
  const key = JSON.stringify(p); const c = cache.get(key);
  if (c && !p.fresh && Date.now() - c.t < TTL) return { ...c.v, cached: true };
  const kind = p.type === 'internship' ? 'internship' : 'jobs';
  const base = `${p.q || ''} ${kind} ${p.city || ''} ${p.level && p.level !== 'any' ? p.level : ''} ${p.visa === '1' ? 'visa sponsorship' : ''}`.replace(/\s+/g, ' ').trim();
  const settled = await Promise.allSettled(SOURCES.map(async ([name, q]) => (await search(`${base} ${q}`)).slice(0, 8).map(r => parse(r, name))));
  let raw = settled.flatMap(s => s.status === 'fulfilled' ? s.value : []);
  if (!raw.length) throw new Error('No results from TinyFish. Check TINYFISH_API_KEY and network.');
  const seen = new Map();                                 // dedupe by URL and by title+company
  raw.forEach(j => { const k = norm(j.title) + '|' + norm(j.company), u = j.url.split('?')[0]; if (!seen.has(u) && !seen.has(k) && j.title) { seen.set(u, j); seen.set(k, j); } else { const e = seen.get(u) || seen.get(k); if (e && !e.alsoOn?.includes(j.source) && e.source !== j.source) (e.alsoOn = e.alsoOn || []).push(j.source); } });
  let jobs = [...new Set(seen.values())];
  const pages = await fetchPages(jobs.slice(0, 20).map(j => j.url));  // read the top candidates' real pages
  jobs = jobs.map(j => enrich(j, pages[j.url] || '', p)).sort((a, b) => b.score - a.score);
  const v = { jobs: jobs.slice(0, +p.limit || 30), total: raw.length, unique: jobs.length, sources: [...new Set(raw.map(j => j.source))], fetchedAt: new Date().toISOString() };
  cache.set(key, { t: Date.now(), v }); saveJobs(v.jobs).catch(e => console.error('db:', e.message)); return v;
}
async function courses() {
  const k = 'courses', c = cache.get(k); if (c && Date.now() - c.t < 6 * TTL) return c.v;
  const rs = await Promise.allSettled(['site:coursera.org most in-demand skills professional certificate', 'site:linkedin.com/learning top courses recruiters want', 'site:nptel.ac.in OR site:swayam.gov.in popular courses jobs'].map(search));
  const v = { courses: rs.flatMap(r => r.status === 'fulfilled' ? r.value.slice(0, 3) : []).map(r => ({ title: r.title, url: r.url, snippet: r.snippet, site: r.site_name || new URL(r.url).hostname })) };
  cache.set(k, { t: Date.now(), v }); return v;
}
const mysql = require('mysql2/promise'), crypto = require('crypto');
const db = mysql.createPool({ host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root', password: process.env.DB_PASS || '', database: process.env.DB_NAME || 'erozgar', connectionLimit: 8 });
const sha = s => crypto.createHash('sha1').update(s).digest('hex');
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
const okPw = (pw, h) => { const [s, x] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(hashPw(pw, s).split(':')[1], 'hex'), Buffer.from(x, 'hex')); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(x => x[0]));
async function getUser(req) { const t = cookie(req).er_sid; if (!t) return null; const [r] = await db.query('SELECT u.id,u.name,u.email,u.prefs FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?', [t]); return r[0] || null; }
async function startSession(res, id) { const t = crypto.randomBytes(32).toString('hex'); await db.query('INSERT INTO sessions(token,user_id) VALUES(?,?)', [t, id]); res.setHeader('Set-Cookie', `er_sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`); }
async function saveJobs(list) { for (const j of list) await db.query('INSERT INTO jobs(url_hash,title,company,location,source,level,is_internship,remote,visa,url,snippet) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE last_seen=NOW(),location=VALUES(location),level=VALUES(level)', [sha(j.url.split('?')[0]), j.title, j.company, j.location, j.source, j.level, +j.isInternship, +j.remote, +j.visa, j.url, j.snippet]); }
const pubUser = u => u && { name: u.name, email: u.email, prefs: u.prefs };
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), json = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  try {
    if (!KEY && (u.pathname === '/api/jobs' || u.pathname === '/api/courses')) return json(500, { error: 'Set TINYFISH_API_KEY in .env' });
    const user = u.pathname.startsWith('/api/') ? await getUser(req) : null, body = req.method === 'POST' ? await readBody(req) : {};
    if (u.pathname === '/api/signup' || u.pathname === '/api/login') {
      const { name, email, password } = body;
      if (!/.+@.+/.test(email || '') || (password || '').length < 6) return json(400, { error: 'Enter a valid email and a password of 6 or more characters.' });
      if (u.pathname === '/api/signup') {
        if (!name) return json(400, { error: 'Enter your name.' });
        try { const [r] = await db.query('INSERT INTO users(name,email,pass_hash) VALUES(?,?,?)', [name, email.toLowerCase(), hashPw(password)]); await startSession(res, r.insertId); return json(200, { user: { name, email, prefs: null } }); }
        catch { return json(409, { error: 'That email already has an account. Log in instead.' }); }
      }
      const [r] = await db.query('SELECT * FROM users WHERE email=?', [email.toLowerCase()]);
      if (!r[0] || !okPw(password, r[0].pass_hash)) return json(401, { error: 'Wrong email or password.' });
      await startSession(res, r[0].id); return json(200, { user: pubUser(r[0]) });
    }
    if (u.pathname === '/api/logout') { const t = cookie(req).er_sid; if (t) await db.query('DELETE FROM sessions WHERE token=?', [t]); res.setHeader('Set-Cookie', 'er_sid=; Max-Age=0; Path=/'); return json(200, { ok: 1 }); }
    if (u.pathname === '/api/me') {
      if (!user) return json(200, { user: null });
      const [a] = await db.query('SELECT UNIX_TIMESTAMP(applied_at)*1000 AS t,title,company,url,source FROM applications WHERE user_id=? ORDER BY applied_at DESC LIMIT 50', [user.id]);
      const [c] = await db.query('SELECT UNIX_TIMESTAMP(created_at)*1000 AS t,action AS a,title,company FROM activity WHERE user_id=? ORDER BY id DESC LIMIT 15', [user.id]);
      return json(200, { user: pubUser(user), applications: a, activity: c });
    }
    if (['/api/prefs', '/api/activity', '/api/apply'].includes(u.pathname)) {
      if (!user) return json(401, { error: 'Log in first.' });
      const j = body.job || {};
      if (u.pathname === '/api/prefs') await db.query('UPDATE users SET prefs=? WHERE id=?', [JSON.stringify(body), user.id]);
      else {
        if (!j.url) return json(400, { error: 'Missing job.' });
        if (u.pathname === '/api/apply') await db.query('INSERT IGNORE INTO applications(user_id,job_hash,title,company,url,source) VALUES(?,?,?,?,?,?)', [user.id, sha(j.url.split('?')[0]), j.title, j.company, j.url, j.source]);
        await db.query('INSERT INTO activity(user_id,action,title,company) VALUES(?,?,?,?)', [user.id, u.pathname === '/api/apply' ? 'Applied' : (body.action || 'Viewed'), j.title, j.company]);
      }
      return json(200, { ok: 1 });
    }
    if (u.pathname === '/api/jobs') {   // overview only for visitors: apply links, snippets and match reasons need a login
      const d = await findJobs(Object.fromEntries(u.searchParams));
      return json(200, { ...d, jobs: user ? d.jobs : d.jobs.map(j => ({ ...j, url: '', snippet: '', why: [] })) });
    }
    if (u.pathname === '/api/courses') return json(200, await courses());
    const f = path.join(__dirname, u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[\/\\])+/, ''));
    if (!f.startsWith(__dirname) || !fs.existsSync(f) || /\.env|server\.js/.test(f)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'text/plain' }); fs.createReadStream(f).pipe(res);
  } catch (e) { json(502, { error: e.message }); }
}).listen(PORT, () => console.log('eRozgar on http://localhost:' + PORT));
