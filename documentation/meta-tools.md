# Meta-tools

Connecta keeps one small tool surface in model context and resolves downstream
tools behind it. `search_tools` finds addresses, `describe_tools` expands
schemas, the call tools enforce safety annotations, and `get_result` pages
bounded results. `execute_code` is registered only when the deployment
configures an executor.

## Result representation

For object results, `structuredContent` is the canonical full-fidelity value.
`content` carries the same complete value as compact JSON for clients that only
consume text. Keeping both follows MCP's backwards-compatibility guidance;
removing or summarizing the text copy is deferred until host-forwarding
measurements demonstrate that supported clients do not need it.

Plain-text guidance and errors remain text-only. A downstream MCP tool's native
content blocks also pass through unchanged when `call_tool` uses MCP result
mode; they are not a duplicated Connecta object result. Newly stashed JSON and
downstream content envelopes use compact serialization, so `get_result` byte
offsets and totals refer to that exact compact text.

## Authorization recovery

Every typed `auth_required` call failure uses the same envelope:

```json
{
  "code": "auth_required",
  "message": "...",
  "retryable": false,
  "connector": "service",
  "operation": "service.read",
  "recovery": "oauth",
  "nextAction": {
    "tool": "authorize_connector",
    "arguments": { "connector": "service" },
    "operatorHandoff": "Give the URL and instructions it returns to the operator."
  },
  "retry": "Retry service.read after the operator completes recovery."
}
```

`recovery` is `oauth`, `operator_config`, or `unavailable`. Call
`authorize_connector` only after this error. It returns the class-specific
handoff:

- `oauth`: an `authorizationUrl` and consent instructions;
- `operator_config`: an `operatorUrl` ending in `/credentials`, plus the
  declared credential label and field names/guidance; or
- `unavailable`: an honest deployment/configuration message.

The tool accepts no secret. `force` applies only to OAuth and may discard its
stored grant before restarting consent. Static credential values are written
only through the same-origin, Clerk-operator credential route. After OAuth
consent or an operator update, retry the original operation; a static update is
read from the vault on the next call and needs no redeploy.
