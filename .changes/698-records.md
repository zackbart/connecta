---
type: fixed
breaking: true
---

**Logs, status messages, and activity carry no error text (INV-6).** Each fix
above filtered one source, and a downstream's allowed answer still reached the
operator's log: `[connecta] call failed` kept 300 characters of it. Every
failure record is now built by one module from facts connecta checks itself,
each against a constant table or grammar: connector, catalog-listed tool,
step, origin, HTTP status, error class, code, retryability, errno, ids, and
counts. An error's class is named by its prototype chain, never its `name`,
and a tool only when the catalog listed it (otherwise `<unlisted>`) and its
name fits MCP's tool-name grammar (otherwise `<withheld>`, in activity rows
too). Logs and activity rows carry a classification code only from
connecta's own closed table, so `ActivityEventInput.errorCode` is now that
union, and a code a handler forwarded from a downstream is not recorded. `call
failed` drops `message` and gains those fields. Catalog refresh, storage,
activity-store, OAuth start, disconnect, and callback, credential-test, Clerk
email lookup, MCP handler, and Node request failures log a fixed event and
the record, with no message or stack; a credential test's `message` is no
longer logged. An unusable input schema is logged without the validator's
diagnostic or the caller's address. A `remoteMcp()` status message is the
failure's record, such as `Connector "svc" MCP handshake with
https://downstream.example failed (ConnectorCallError, unavailable,
ECONNREFUSED).`. A custom connector's `status()` contributes only its state:
`Registry.statusFor` drops its message, rebuilds a status connecta wrote
from the message it approved, whatever was assigned since, and the operator
page logs a status
as its state and, for a failure connecta described, that failure's record.
On Workers, a downstream reply whose Content-Type is neither text nor JSON is
handed on without its body, because workerd prints that Content-Type natively
when the SDK drains it (#695, #716).
