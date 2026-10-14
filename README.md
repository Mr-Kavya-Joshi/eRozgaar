# eRozgar
Stack: Apache (static page + reverse proxy) -> Node app (TinyFish + logic) -> MySQL (users, sessions, jobs, applications, activity).

1. Import the database: `mysql -u root -p < schema.sql`
2. `cp .env.example .env`, then set `TINYFISH_API_KEY` and your `DB_*` values.
3. `npm install` then `node server.js` (runs on port 3000; it also serves the page, so http://localhost:3000 works without Apache).
4. For Apache: copy `index.html` to the DocumentRoot, enable `proxy`, `proxy_http`, add `erozgar.apache.conf`, restart Apache.

Flow: Search API (9 portals/ATS boards in parallel) -> dedupe -> Fetch API reads top 20 pages -> extract location, seniority, visa, remote -> score and rank -> store in `jobs`. Results cached 15 min; Search always bypasses the cache.
Visitors get overviews only; the server withholds apply links, snippets and match reasons until login. Passwords are scrypt-hashed; sessions use an HttpOnly cookie.
