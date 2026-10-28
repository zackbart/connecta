---
type: fixed
---

Report principal-forwarding remote MCP connectors truthfully on the operator page: check as the admitted operator under the same caller policy as a call, and show actual downstream failures without a deployment-secret diagnosis or fix prompt. Checks without an admitted caller return the non-error `per_caller` state ("Authenticates as each caller; verified on use."). Adding `per_caller` to the public status union is an additive type change; exhaustive status consumers must handle it.

Operator observations are isolated by an opaque admitted viewer key, including same-role Cloudflare Access identity changes during pending probes.
