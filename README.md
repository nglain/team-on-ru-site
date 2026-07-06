# team-on.ru static site

Static HTML/CSS source for https://team-on.ru/.

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
- `talk/`, `roadmap/`, `partners/`, `leadsell/`, `copilot/`, `main/` —
  static subpages.

## Deploy

Deploy by syncing the repository contents to `/var/www/teamon` on the origin
host and reloading nginx if the server configuration changed.
