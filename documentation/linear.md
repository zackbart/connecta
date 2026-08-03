# Linear prebuilt connection

Import `linear()` independently from `@zackbart/connecta/providers/linear`. It
wraps Linear's hosted MCP server with endpoint selection, OAuth by default, a
task-oriented usage guide, and a vetted safety classification. It adds no
provider dependency and is not reachable from Connecta's root entry.

```ts
import { linear } from "@zackbart/connecta/providers/linear";

const tracker = linear("product_tracker", {
  title: "Product issue tracking",
  purpose: "Issue and project planning for the platform team",
  instructions: "File bugs into the Platform team unless the request names another.",
});
```

The `id` owns the ordinary connector namespaces; use a different id for every
Linear workspace or access mode. `purpose` is required because an agent
choosing between two instances needs to know which workspace answers the
question. Workspace `instructions` are appended to the maintained guide and
cannot change the connector's safety classification.

## Access modes

Linear publishes two hosted endpoints, and `access` selects between them:

| `access` | Endpoint | OAuth scopes |
| --- | --- | --- |
| `"read-write"` (default) | `https://mcp.linear.app/mcp` | `read`, `write` |
| `"read-only"` | `https://mcp.linear.app/mcp/readonly` | `read` |

Read-only is not a client-side filter. The endpoint advertises the `read` scope
alone, so the token minted for it cannot reach Linear's write APIs — a stronger
guarantee than any annotation Connecta applies. A deployment that only reports
on delivery should use it, and can run it beside a read-write instance under a
different id:

```ts
linear("delivery_reporting", {
  purpose: "Executive delivery reporting",
  access: "read-only",
});
```

Linear's deprecated `/sse` transport is deliberately unreachable from this
connection; it now answers 404.

## Authentication

OAuth 2.1 with dynamic client registration is the default and keeps each
connector instance's flow and tokens in its connector-scoped storage. Linear
also accepts a bearer token or a personal API key passed directly in the
`Authorization` header, which suits a headless deployment:

```ts
linear("automation_tracker", {
  purpose: "Headless release reporting",
  auth: {
    type: "headers",
    headers: { Authorization: env.LINEAR_API_KEY },
  },
});
```

Keep that key in the runtime's secret store; it is a password, not ordinary
configuration. A personal API key carries the acting user's full workspace
permissions, so pair it with `access: "read-only"` unless the deployment
genuinely writes.

## Safety classification

The wrapper classifies Linear's documented `list_*`, `get_*`, and
`search_documentation` tools as reads, and its `save_*`, `create_*`, `delete_*`,
`resolve_*`, `submit_*`, and `merge_*` tools as writes. An unfamiliar tool added
by the downstream fails closed onto `call_destructive_tool` until a Connecta
release reviews it.

That classification is **fill-in only**. It supplies the annotations Linear
leaves unset and may always tighten one — but it never contradicts an explicit
downstream annotation. A tool on the read allowlist that arrives carrying
`destructiveHint: true` or `readOnlyHint: false` keeps exactly what the
downstream said and stays behind `call_destructive_tool`: the downstream is
telling you this release's allowlist is stale, and the fail-closed invariant
does not bend for a maintained connection.

Two details of Linear's own design shape the classification:

- **`save_*` tools are upserts.** Omitting a record id creates; supplying one
  updates in place. Because an upsert can overwrite, every `save_*` is
  classified destructive even though some calls only create. The genuine
  creates are `create_issue_label` and `create_initiative_label`, plus the
  attachment upload tools, which assert `readOnlyHint: false` without claiming
  a destruction they do not perform.
- **`extract_images` is deliberately unclassified.** It is a markdown helper
  rather than a workspace query, and Linear does not document it as read-only,
  so it fails closed rather than being assumed safe.

## The catalog is not a fixed set

Linear's hosted `tools/list` varies by workspace plan and enabled features:
customer requests, releases, and code review do not appear in every workspace.
The maintained allowlists are therefore a superset — a classified name a
workspace never returns costs nothing, and a genuinely new tool fails closed.
Agents should search this connector's catalog for what the workspace actually
exposes rather than assuming a tool exists; the usage guide says so explicitly.

## Rate limits

Linear documents no MCP-specific rate limit. The MCP server rides the
[GraphQL API limits](https://linear.app/developers/rate-limiting), which are
metered **per user per hour** and shared with everything else that credential
does. Linear's own page is internally inconsistent on the API-key request
figure — the prose says 5,000 requests per hour while the table below it says
2,500 for an API key and 5,000 for an OAuth app, against 600 unauthenticated —
and limits are raised dynamically for workspace-level OAuth apps using Actor
Authorization.

For that reason this connection declares **no call-admission budget by
default**. Connecta's counter is per runtime, not per user, so a hardcoded
ceiling would either throttle a healthy deployment or fail to protect a busy
one. An operator who knows their workspace can supply one explicitly:

```ts
linear("product_tracker", {
  purpose: "Issue and project planning for the platform team",
  callAdmission: {
    rules: [
      { budget: { kind: "rolling-window", maxCalls: 1_000, windowMs: 3_600_000 } },
    ],
  },
});
```

A budget-only rule needs no queue. If you add `maxConcurrency` you are asking
for a queue, and the admission controller then requires the rest of the queue
settings at construction.
