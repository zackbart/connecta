# connecta

![A monochrome clay Connecta hub joining many tools](./assets/connecta-clay-hero.png)

One MCP endpoint in front of all your connectors. Agents see nine tools instead
of hundreds, and each client is configured once instead of once per integration.

## The problem

An agent connected to N MCP servers pays for all N before it does anything. Every
server's tool list is injected into the context window at connect time — hundreds
of definitions and their schemas, nearly all irrelevant to the task actually at
hand. That budget is spent whether the model calls one of them or none, and it
comes out of the same window the work needs.

The second cost is configuration. Every client — Claude, Cursor, whatever comes
next — has to be pointed at each server separately, with its own auth for each.
Adding an integration means touching every client; rotating one token means
finding every place it was pasted.

## What connecta is

One MCP endpoint you deploy — Cloudflare Worker, Node, or Docker — that
aggregates your downstream connectors behind a fixed set of **nine meta-tools**.
A connector is either a remote MCP server that connecta proxies, or a plain HTTP
API with hand-written tool definitions and a fetch handler.

```
                                        ┌── remoteMcp("notion")   → mcp.notion.com
Claude / Cursor ── MCP ──▶  connecta ───┼── remoteMcp("linear")   → mcp.linear.app
   sees 9 tools            /mcp         ├── api("resend")         → fetch(...)
                                        └── api("internal")       → fetch(...)
```

Rather than receiving every tool up front, the agent discovers what it needs.
`search_tools` returns ranked matches for a query and `describe_tools` returns
schemas — compact by default, raw JSON Schema on request — for only the
addresses it is about to call. `call_tool`,
`batch_call`, and `call_destructive_tool` invoke them by address
(`<connectorId>.<toolName>`). `list_connectors` reports what exists and whether
it is reachable, `authorize_connector` starts a downstream OAuth flow,
`get_result` pages through a result too large to return inline, and `skills`
hands the model a short guide to choosing among the rest.

That is the entire surface. The agent's context holds nine tool definitions
whether ten tools sit behind them or a thousand — and the client holds one URL
and one credential, no matter how many services that URL fans out to.

An optional tenth meta-tool, `execute_code`, runs model-written async JavaScript
in a sandbox with no network, filesystem, or environment access — only the
explicitly read-only tools as callable globals — turning a loop, a join across
connectors, or a filter over a large response into one round trip instead of a
dozen. The built-in Node executor runs QuickJS in bounded, replaceable child
processes so guest CPU never occupies the HTTP event loop. Configure no
`executor` and connecta is exactly the nine-tool server.

## Why it's shaped this way

**Config as code, one deployment per tenant.** Connectors are declared in
TypeScript. Adding one is a code change and a deploy — no database of
integrations, no registration API, no runtime admin. A deployment is a small
config file you can read in one sitting and review in a pull request, not a
platform to administer.

**Credentials stay server-side.** Downstream tokens live in an AES-GCM encrypted
vault over the deployment's own storage, with the key held outside it. A
connector reaches its own credential through `ctx.credential`; the operator
pages, meta-tools, and code sandbox never expose a secret value. Rotating a token
at `/credentials` is an operator action rather than a redeploy — though writing
to the vault is deliberately narrower than everything else, requiring a
Clerk-authenticated operator on a same-origin request, so a bearer-only
deployment cannot administer credentials from the browser. Which tools exist
is still code either way.

**Read-only is fail-closed.** Only tools explicitly annotated `readOnlyHint:
true` are reachable through `call_tool`, `batch_call`, and the sandbox. Missing,
false, or contradictory annotations do not get the benefit of the doubt: they
require `call_destructive_tool`, which is itself annotated so the MCP host can
put the question to a human. Connecta makes the boundary visible; approval is
the host's job.

**Toolkits scope what a team sees.** A deployment belongs to an org; a toolkit
is a named view over its registry for one group inside that org — support sees
Zendesk and Notion, exec also sees Gmail. A client selects one with
`?toolkit=support` on the MCP URL, and a credential can be bound so it opens
that view and nothing else. Inside a scoped session an out-of-scope address
fails exactly as a nonexistent one does. Two teams, one deployment. Who gets in
at all is the prior question: a static bearer token, or Clerk — where
`allowedDomains: ["acme.com"]` admits anyone whose verified primary email is on
your domain without enumerating users, and a `gate` hook handles what a domain
rule cannot express. Both fail closed, and each one configured must pass.

**Activity records the fact, not the payload.** The optional activity store logs
which resolved tool ran, for whom, and how it went — never arguments, results,
generated code, search text, or raw error messages. The exclusion is structural
rather than a redaction pass: the event type has nowhere to put a payload, which
is what keeps an operations log from becoming something worth stealing.

**Operator pages that cannot administer the deployment.** Connections at `GET /`
shows connector health, tool counts, downstream authorization links, and a
read-only map of the toolkit views declared in deployment config;
`/credentials` rotates stored secrets; and `/activity` shows the optional
payload-free ledger. They share one data-free shell with no build step and use
authenticated private APIs for deployment data. They cannot add a connector,
change policy, or alter what an agent may call. Credentials connecta stores are
also probed for liveness
proactively — using each connector's own test or status hook, never a downstream
tool call — so a dead token surfaces as `auth_required` with the URL to open on
Connections and in `list_connectors` before an agent's real call trips over it.

## When not to use it

Connecta is deliberately small, and declines several tempting shapes.
It is **not multi-tenant** — one deployment is one tenant, with one registry and
one credential store, and toolkits are scoped views rather than tenants. There
is **no policy engine**, no approvals, and no pauses — access decisions are
fixed ones connecta already knows how to answer (is this tool read-only, may
this credential open this toolkit), not rules you author. There is **no runtime
administration** — you cannot add a connector from a browser or an API. It
aggregates **tools only**, not MCP resources or prompts, and it will not ingest
a **GraphQL** schema, because generating hundreds of low-quality tool
definitions is the problem the nine meta-tools exist to solve. OpenAPI is a
softer no: not built in today, not refused either, and tracked as
[issue #26](https://github.com/zackbart/connecta/issues/26). If you want a
hosted multi-tenant integration platform with an approval workflow, this is the
wrong shape; the
[non-goals](https://github.com/zackbart/connecta/blob/main/docs/decisions.md#non-goals)
say so at more length.

## Getting started

Node deployments require Node.js 20.9 or newer.

```sh
npm install @zackbart/connecta
```

A minimal server with one hand-written connector:

```ts
import { api, bearerToken, createConnecta } from "@zackbart/connecta";
import { fileStorage, listen } from "@zackbart/connecta/node";

const connecta = createConnecta({
  storage: fileStorage("./.connecta-state.json"), // or memoryStorage()
  auth: bearerToken(process.env.CONNECTA_TOKEN ?? "dev-token"),
  connectors: [
    api("time", {
      description: "Time — current timestamp",
      tools: [
        {
          name: "get_now",
          description: "Return the current time as an ISO 8601 timestamp.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
          handler: async () => ({ now: new Date().toISOString() }),
        },
      ],
    }),
  ],
});

listen(connecta, 8787); // MCP at /mcp; Connections at http://localhost:8787/
```

Point an MCP client at `http://localhost:8787/mcp` with an
`Authorization: Bearer` header and it will see the nine meta-tools, with
`time.get_now` discoverable through `search_tools`.

Runnable deployments live in
[`examples/`](https://github.com/zackbart/connecta/tree/main/examples):
[`worker/`](https://github.com/zackbart/connecta/tree/main/examples/worker) is a
free-tier-compatible Cloudflare Worker with KV and D1 adapters, and the template
to copy for a real deployment; adding one Worker Loader binding opts it into
paid Dynamic Worker code mode without changing its TypeScript;
[`node/`](https://github.com/zackbart/connecta/tree/main/examples/node) adds
toolkits and code mode to the server above;
[`docker/`](https://github.com/zackbart/connecta/tree/main/examples/docker) is a
single-service compose stack. Anything beyond the core is installed only by the
deployments that use it: `@clerk/backend` and `quickjs-emscripten` are optional
peer dependencies, reached through the `/auth/clerk` and `/quickjs` subpaths,
and a Worker using code mode brings its own `@cloudflare/codemode`. Connecta
ships no service-specific connectors:
endpoint, credential, and tool choices stay in your project, declared with
`remoteMcp()` and `api()`.

## Learn more

- **[Documentation](https://github.com/zackbart/connecta/blob/main/docs/documentation.md)**
  — the reference index for architecture, connectors, inbound auth and
  downstream OAuth, storage, Clerk setup, testing, and troubleshooting. Start
  with the [meta-tools reference](https://github.com/zackbart/connecta/blob/main/docs/meta-tools.md#meta-tools-reference),
  the [config options](https://github.com/zackbart/connecta/blob/main/docs/operations.md#running-it),
  [request admission](https://github.com/zackbart/connecta/blob/main/docs/request-admission.md#request-admission-and-backpressure),
  [code mode](https://github.com/zackbart/connecta/blob/main/docs/code-mode.md#code-mode-execute_code),
  [toolkits](https://github.com/zackbart/connecta/blob/main/docs/toolkits.md#toolkits-scoped-views),
  [operator pages](https://github.com/zackbart/connecta/blob/main/docs/operator-ui.md#status-ui),
  or [credential health](https://github.com/zackbart/connecta/blob/main/docs/storage-and-credentials.md#credential-health-proactive-liveness-checks).
- **[Decisions](https://github.com/zackbart/connecta/blob/main/docs/decisions.md)**
  — what connecta refuses to be, which alternatives lost and why, and the
  invariants a change must preserve.
- **[CHANGELOG](https://github.com/zackbart/connecta/blob/main/CHANGELOG.md)** —
  what changed in each release.
- **[SECURITY](https://github.com/zackbart/connecta/blob/main/SECURITY.md)** —
  supported versions and how to report a vulnerability.
