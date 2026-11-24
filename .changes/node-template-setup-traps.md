---
type: fixed
---

The Node template's `npm start`, `rotate-token` and `adopt-token` scripts read `.env` when it exists (`--env-file-if-exists`), and `npm run doctor` passes the new `connecta doctor --dotenv .env` option, which loads a file's variables when it exists. In both, a variable already set in the process environment wins. Existing deployments can copy the four scripts from `templates/node/package.json`; after that, an existing `.env` beside the deployment supplies every value the process environment leaves unset, including `CONNECTA_DATABASE`, so review a stale `.env` before restarting. `connecta doctor --help` and `connecta init --help` print usage and exit 0, and `init --help` no longer creates a directory named `--help`. The `auth` configuration documentation now states when a deployment admits anonymous callers.
