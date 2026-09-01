# team-on.ru site

Landing page and the narrow public Timon chat ingress for https://team-on.ru/.

Current production origin:

- host: `72.56.80.17`
- nginx root: `/var/www/teamon`
- nginx server names: `team-on.ru`, `www.team-on.ru`

This repository intentionally excludes server-local backup files such as
`*.bak*` and does not store nginx certificates, private keys, or deployment
secrets.

## Structure

- `index.html` — main landing page.
- `favicon.svg` — site icon.
- `server.mjs` — same-origin Timon proxy: opaque browser sessions, message
  limits, concurrency limits, and a server-held upstream token.
- `server.test.mjs` — built-in Node tests for session isolation and limits.
- `ops/timon-agent.json` — versioned public-agent identity and advisory-only
  boundary; it contains no runtime credentials.
- `ops/teamon-timon-web.service` and `ops/nginx-timon-locations.conf` —
  production service and same-origin route templates.
- `talk/`, `roadmap/`, `partners/`, `leadsell/`, `copilot/`, `main/` —
  static subpages.

## Deploy

Deploy static files to `/var/www/teamon`. Run `server.mjs` as an unprivileged
loopback-only service and proxy `/api/timon/` to it from nginx. Runtime secrets
belong in the server-local environment file and must never be committed.
