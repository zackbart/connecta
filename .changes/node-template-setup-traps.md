---
type: fixed
---

The Node template's `npm start`, `rotate-token`, `adopt-token` and `doctor` scripts read `.env` when it exists (`--env-file-if-exists`), with variables already in the process environment taking precedence; existing deployments can copy the four scripts from `templates/node/package.json`. `connecta doctor --help` and `connecta init --help` print usage and exit 0, and `init --help` no longer creates a directory named `--help`. The `auth` configuration documentation now describes what omitting it does.
