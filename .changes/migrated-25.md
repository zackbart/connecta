---
type: fixed
---

**No token endpoint's text reaches the host's console.** From client 2.1.0
the SDK writes a failed refresh or code exchange's `error_description`, or
the raw body of a non-OAuth answer, to `console.warn`, below any logger a
deployment configures. A token endpoint that echoes the form it refused
would put the refresh token, client secret, or authorization code there.
Every token-endpoint failure now reaches the SDK rebuilt: its OAuth `error`
code, a fixed description, the status, and `Retry-After`. That includes a
2xx code-exchange answer that is no token response the SDK accepts, such as
one whose `error` is `null`, a number, or an object, which the SDK otherwise
quotes whole in the error the connector rejects with. A code outside the
registered set becomes `invalid_request`, and a body without a string code
`server_error`, the classes the SDK already gave them, so refresh verdicts and
callback outcomes are unchanged. A bound grant is also handed back stamped,
so the SDK no longer warns about a migrated one on every read.
