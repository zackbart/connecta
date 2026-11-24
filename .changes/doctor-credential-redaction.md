---
type: security
---

`connecta doctor` no longer prints `CONNECTA_TOKEN`, `CF_ACCESS_CLIENT_ID` or `CF_ACCESS_CLIENT_SECRET` when the server it checks echoes request headers back, as a misdirected `--url`, a proxy or an error page quoting the request could. A failed `/health` or MCP request now reports `HTTP <status> from /health` or `MCP <status> from <endpoint>` without the response body, and everything doctor writes to stdout or stderr, including the `--config` snapshot, replaces each credential value, plain, `Bearer`-prefixed, or JSON-, URL- or HTML-escaped, with `[redacted]`. An unreadable `--dotenv` file fails with its error code, without the path.
