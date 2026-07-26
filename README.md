# connecta

![A monochrome clay Connecta hub joining many tools](./assets/connecta-clay-hero.png)

One MCP to rule them all. A single MCP endpoint that aggregates many downstream
connectors — remote MCP servers and plain HTTP APIs — and presents agents a fixed
set of **nine meta-tools** instead of hundreds of individual tools.

```
                                        ┌── remoteMcp("notion")   → mcp.notion.com
Claude / Cursor ── MCP ──▶  connecta ───┼── remoteMcp("linear")   → mcp.linear.app
   sees 9 tools            /mcp         ├── api("resend")         → fetch(...)
                                        └── api("internal")       → fetch(...)
```

The agent always sees exactly nine tools; it searches when it needs something and
describes only what it will call. Progressive disclosure is the point. Connectors
are declared in TypeScript (config as code — adding one is a code change + deploy,
no database of integrations), and the same fetch-based core runs on **Node** and
**Cloudflare Workers**. Optionally, **code mode** adds a tenth tool that runs
model-written orchestration code in a sandbox.

## Installation

Node deployments require Node.js 20.9 or newer.

```sh
npm install @zackbart/connecta
```

Provider and runtime integrations remain consumer-owned. Install only the
optional packages a deployment uses—for example:

```sh
npm install @clerk/backend          # optional Clerk auth adapter
npm install quickjs-emscripten      # optional Node code-mode executor
npm install @cloudflare/codemode    # optional Worker code-mode executor
```

## The nine meta-tools

A tool **address** is `<connectorId>.<toolName>` (e.g. `notion.search`).

| Tool | Input | Returns |
| --- | --- | --- |
| `list_connectors` | `{ probe? }` | live (`probe: true`, default) or cached health, tool count, and recent real-call observations |
| `skills` | `{ name? }` | lists or fetches the concise `usage` guide for choosing among the meta-tools, plus any operator-authored per-connector guide (`connector:<connectorId>`) |
| `search_tools` | `{ query?, connector?, limit?, offset?, fullDescriptions?, includeSchemas? }` | ranked, paginated matches; optionally includes compact/raw schemas to remove a round trip |
| `describe_tools` | `{ addresses[], format?, fullDescriptions? }` | names, descriptions, input/output schemas, and behavior annotations |
| `call_tool` | `{ address, args?, fields?, resultMode?, timeoutMs?, maxRetries?, diagnostics? }` | invokes only tools explicitly annotated `readOnlyHint: true` |
| `call_destructive_tool` | same as `call_tool` | invokes unannotated, write-capable, or destructive tools through a host-visible approval boundary |
| `authorize_connector` | `{ connector, force? }` | starts (or with `force`, restarts) the downstream OAuth flow; returns the `authorizationUrl` to open |
| `get_result` | `{ id, offset?, maxBytes? }` | a byte-slice page of a truncated result — `{ text, offset, nextOffset?, totalBytes }`; `maxBytes` is a whole number of bytes >= 1 and `offset` a whole number of bytes >= 0, aligned back to a character boundary and echoed as the `offset` served |
| `batch_call` | `{ calls, resultMode?, timeoutMs?, maxRetries? }` | 1–10 parallel calls sharing request-scoped clients, with attempts/timing/errors |
| `execute_code` *(optional)* | `{ code }` | result + logs of bounded async JS orchestration over explicitly read-only tools; registered only when an `executor` is configured |

## Package vs. deployments

This repository owns the reusable package. Each deployment should be a small,
separate Worker project that pins an exact package version and owns only its
connector configuration, auth policy, domain, bindings, migrations, and secrets.
[`examples/worker/`](./examples/worker/) is the starting template.

## Quickstart — Cloudflare Worker

```ts
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { bearerToken, createConnecta, remoteMcp } from "@zackbart/connecta";
import { clerkAuth } from "@zackbart/connecta/auth/clerk";
import { cloudflareKvStorage } from "./cloudflare-kv.js";

const build = (env: Env) =>
  createConnecta({
    publicUrl: env.PUBLIC_URL,
    storage: cloudflareKvStorage(env.CONNECTA_KV),
    // Code mode (optional): needs a `worker_loaders` binding in wrangler.jsonc.
    executor: new DynamicWorkerExecutor({ loader: env.LOADER }),
    auth: [
      bearerToken(env.CONNECTA_TOKEN),
      clerkAuth({
        publishableKey: env.CLERK_PUBLISHABLE_KEY,
        secretKey: env.CLERK_SECRET_KEY,
        publicUrl: env.PUBLIC_URL,
      }),
    ],
    connectors: [
      remoteMcp("notion", {
        url: "https://mcp.notion.com/mcp",
        auth: { type: "headers", headers: { Authorization: `Bearer ${env.NOTION_TOKEN}` } },
      }),
    ],
  });

// Lazy per-isolate singleton: keeps only serializable tool/catalog data warm.
let connecta: ReturnType<typeof build> | undefined;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    connecta ??= build(env);
    return connecta.fetch(request);
  },
};
```

Deployable example: [`examples/worker/`](./examples/worker/).
Its Cloudflare KV and D1 implementations are deployment-owned examples over the
generic `KVStorage` and `ActivityStore` contracts; they are not package exports.

`clerkAuth` is an optional adapter. Install `@clerk/backend` and import it from
`@zackbart/connecta/auth/clerk` only in deployments that use Clerk. Other
identity providers can implement the exported `InboundAuth` interface.

## Quickstart — Node

```ts
import { api, bearerToken, createConnecta } from "@zackbart/connecta";
import { fileStorage, listen } from "@zackbart/connecta/node";
import { quickJsExecutor } from "@zackbart/connecta/quickjs";

const connecta = createConnecta({
  storage: fileStorage("./.connecta-state.json"), // or memoryStorage()
  auth: bearerToken(process.env.CONNECTA_TOKEN!),
  executor: quickJsExecutor(), // code mode (optional): QuickJS/WASM sandbox
  connectors: [
    api("time", {
      description: "Time — clock utilities",
      tools: [{
        name: "get_now",
        description: "Return the current ISO timestamp.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        handler: async () => ({ now: new Date().toISOString() }),
      }],
    }),
  ],
});

listen(connecta, 8787); // http://localhost:8787/mcp
```

Example: [`examples/node/`](./examples/node/). Docker (single-service compose
stack): [`examples/docker/`](./examples/docker/).

## Toolkits — one deployment, many teams

A deployment belongs to an org. Optional **toolkits** give each group of team
members its own scoped view of the same registry — bound to that group's
credential — so different teams no longer need separate deployments:

```ts
createConnecta({
  connectors: [zendesk, notion, gmail],
  auth: [
    // Each team's credential is bound to that team's view.
    bearerToken(env.SUPPORT_TOKEN, { subjectId: "support", toolkits: ["support"] }),
    bearerToken(env.EXEC_TOKEN, { subjectId: "exec", toolkits: ["exec"] }),
    // The operator's: every view, plus /ui — declared, not left unbound.
    bearerToken(env.OPS_TOKEN, {
      subjectId: "ops",
      toolkits: ["support", "exec"],
      unscoped: true,
    }),
  ],
  toolkits: {
    support: { connectors: ["zendesk", "notion"] },
    exec: {
      connectors: ["zendesk", "notion", "gmail"],
      excludeTools: ["gmail.send_message"], // finer grain than a connector id
    },
  },
});
```

A client picks one at connect time: `https://…/mcp?toolkit=support`. Inside a
scoped session **every** meta-tool — search, describe, call, batch, skills,
authorize, `get_result`, and `execute_code` host calls — behaves as if
out-of-scope connectors and tools do not exist, and an out-of-scope address
fails identically to a nonexistent one. No `?toolkit=` ⇒ the full registry, as
before; an unknown name is an error, never a silent fallback.

`toolkits: [...]` on an auth adapter **binds** a credential to its views: the
support token cannot open `?toolkit=exec`, cannot connect unscoped (unless it also
passes `unscoped: true`), and cannot read the deployment-wide operator surfaces.
Refusal is a flat 403 at connect time, identical whether the toolkit is another
team's or does not exist at all — a mapping, not a policy engine. Leave `toolkits`
off and that credential keeps today's self-service selection. Details:
[docs §16](./docs/documentation.md#16-toolkits-scoped-views).

## Code mode

With an `executor` configured, the model can write an async function instead of
making one `call_tool` round trip per step — loops, joins across connectors,
filtering big responses down in-sandbox before they hit the context window:

```js
async () => {
  const pages = await notion.search({ query: "roadmap" });
  return pages.results.map((p) => p.title);
}
```

The sandbox has **no** network/filesystem/env — only explicitly read-only
connector globals and
`connecta.call`, `connecta.batch`, `connecta.search`, and `connecta.describe`;
credentials stay host-side. A run may make at most 20 host calls, a
`connecta.batch` may contain at most 10 calls, and every host call has a
15-second deadline. Executors:
`DynamicWorkerExecutor` (`@cloudflare/codemode`,
Workers, Worker Loader binding — open beta) or `quickJsExecutor()`
(`@zackbart/connecta/quickjs`, QuickJS-in-WASM, runs anywhere). Omit the `executor` and
connecta is exactly the nine-tool server. Details:
[docs §13](./docs/documentation.md#13-code-mode-execute_code).

## Credentials in `/ui`

API connectors can declare one operator-managed credential or a named set of
credential fields. Connecta renders
Add / Replace / Test / Remove controls inside that connector's `/ui` card,
encrypts the values with AES-GCM, and stores only ciphertext in the deployment's
existing `KVStorage`. Credentials are available only to the connector through
`ctx.credential.get()`, `get(name)`, or `getAll()`; they are never returned by
`/ui`, MCP tools, or code mode.

```ts
api("example", {
  description: "Example — authenticated API",
  credential: {
    label: "API token",
    description: "Token used for outbound Example API requests.",
  },
  tools: [{
    name: "get_profile",
    description: "Get the authenticated Example profile.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    handler: async (_args, ctx) => {
      const token = await ctx.credential?.get();
      if (!token) throw new Error("Example API token is not configured.");
      return fetch("https://api.example.com/profile", {
        headers: { Authorization: `Bearer ${token}` },
      }).then((response) => response.json());
    },
  }],
})
```

Set `credentialEncryptionKey` on `createConnecta` to a base64-encoded 32-byte
key held in the runtime's secret store (`openssl rand -base64 32`) — a connector
that declares a credential without one fails at construction rather than booting
with an unusable vault. Credential mutation routes require the configured Clerk
provider and a same-origin browser request; the static inbound bearer cannot
administer the vault.

Connecta does not bundle service-specific HTTP API connectors. Package consumers
define them with `api()` (or implement `Connector` directly), keeping endpoint,
credential, and tool choices in the consuming project.

## Payload-free tool activity

Connecta can record which resolved downstream tools were actually invoked
without storing their arguments, results, generated code, search text, or raw
errors. Supply a vendor-neutral `activity` store:

```ts
const events: ToolCallActivityEvent[] = [];

const connecta = createConnecta({
  connectors,
  activity: {
    record(event) {
      events.push(event);
    },
    async list({ limit }) {
      return { events: events.slice(-limit).reverse() };
    },
  },
});
```

One final event is emitted for each resolved connector call made through
`call_tool`, `call_destructive_tool`, `batch_call`, or `execute_code`; retries
remain one event with an `attempts` count. Implementing `list` enables the
authenticated Activity tab in `/ui`; `activityReadGate` can narrow reads
further. Writes are best-effort and never change a tool result. Clerk calls
carry the Clerk user ID; shared bearer calls are honestly labeled as bearer
unless `bearerToken(secret, { subjectId })` assigns that credential a stable
subject. On Workers, pass `ctx` through to `connecta.fetch(request, env, ctx)`
so async writes settle on `waitUntil`.
[`examples/worker/src/d1-activity.ts`](./examples/worker/src/d1-activity.ts) is
a complete D1 implementation with keyset paging and a retention pass.

## Operator dashboard

`GET /ui` is a read-only dashboard with no build step: connector health, tool
counts and descriptions with a client-side filter, downstream authorization
links, the credential controls above, and an Activity tab when an activity store
is configured. The shell is open because it carries no data; everything it shows
comes from `/ui/data`, behind the same auth gate as `/mcp`. With Clerk
configured it signs operators in through Clerk's hosted portal; a bearer-only
deployment falls back to a pasted token.

Every deployment-facing label and mark on `/ui` and the OAuth result pages comes
from `ConnectaConfig.branding` — `productName`, `ownerName`, their URLs,
`description`, `pageTitle`, `themeColor`, and `favicon` — each falling back to a
neutral Connecta default. Nothing about the operator is baked into the package.

## Learn more

- **[`docs/documentation.md`](./docs/documentation.md)** — how everything works: architecture,
  the meta-tools, connectors and their usage guides, inbound auth, downstream
  OAuth, storage, running it (Node / Workers / Docker), Clerk setup, testing,
  troubleshooting, code mode, the status UI, activity history, and toolkits.
- **[`docs/design.md`](./docs/design.md)** — why it's built this way, and the non-goals.
- **[`CHANGELOG.md`](./CHANGELOG.md)** — what changed in each release.
