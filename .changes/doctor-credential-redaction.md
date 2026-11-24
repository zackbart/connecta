---
type: security
breaking: true
---

`connecta doctor` no longer prints `CONNECTA_TOKEN`, `CF_ACCESS_CLIENT_ID` or `CF_ACCESS_CLIENT_SECRET` when the server it checks echoes request headers back, as a misdirected `--url`, a proxy or an error page quoting the request could. Doctor no longer prints text the server chose: a failed `/health` or MCP request reports `HTTP <status> from /health` or `MCP <status> from <endpoint>` without the body, a JSON-RPC error reports its code only, an execution check reports whether the tool errored or returned a wrong result without the result, and connector ids, tool names, the health status and the protocol version print only as plain identifiers that share nothing with a credential, otherwise as `<unprintable>`. The `--config` snapshot replaces any key or value containing a credential with `[redacted]` before it is serialized. Doctor refuses a credential shorter than 16 characters by variable name, refuses responses over 64 KiB from `/health` or 4 MiB from the config or MCP endpoint, and fails an unreadable `--dotenv` file with its error code, without the path.
