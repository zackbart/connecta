---
type: fixed
breaking: true
---

**A connector error no longer carries downstream-derived text as `cause`.**
A transport failure kept the runtime's error as `cause`, and that error can
quote the URL, headers, or body of the request it failed; any logger that
renders an error renders its cause. It now keeps only the origin and errno it
already reported in `details`, and as cause only the request's own abort
reason, which the caller wrote, and a credential connector whose runtime
refused the header still answers `auth_required`. At a `remoteMcp()`
handshake, `tools/list`, or `tools/call`, an error keeps its text only if it
is the downstream's JSON-RPC error answer, the endpoint's HTTP 4xx refusal,
or the request's own abort reason, checked first by identity (or as the SDK
rewraps it). Anything else, such as a parser's or validator's account, an
unexpected content type, an unsupported protocol version, a broken reply
stream, or a 5xx body, is told as the step, host, HTTP status, and error
class, with its classification kept. An OAuth flow passes an AbortError or
TimeoutError unchanged only when it is the request's own reason. An `api()`
handler's failure other than a `ConnectorCallError` (a plain `Error`, a
stream's TypeError, a JSON parser's account, an `AggregateError`) names the
tool and the error's class, with its verdict kept and no cause or nested
errors, and Workspace, Docs, and Cloudflare no longer keep a stream's or JSON
parser's error, which quotes the body, behind a failed read. An argument
mismatch is told from its reviewed findings (`/q: expected integer (type)`),
never the validator's sentence, which quoted the schema's types, enums, and
patterns. `auth_required` no longer keeps the SDK's `UnauthorizedError`
behind it (#695).
