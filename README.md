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

## The nine meta-tools

A tool **address** is `<connectorId>.<toolName>` (e.g. `notion.search`).

| Tool | Input | Returns |
| --- | --- | --- |
| `list_connectors` | `{ probe? }` | live (`probe: true`, default) or cached health, tool count, and recent real-call observations |
| `skills` | `{ name? }` | lists or fetches the concise `usage` guide for choosing among the meta-tools |
| `search_tools` | `{ query?, connector?, limit?, offset?, fullDescriptions?, includeSchemas? }` | ranked, paginated matches; optionally includes compact/raw schemas to remove a round trip |
| `describe_tools` | `{ addresses[], format?, fullDescriptions? }` | names, descriptions, input/output schemas, and behavior annotations |
| `call_tool` | `{ address, args?, fields?, resultMode?, timeoutMs?, maxRetries?, diagnostics? }` | invokes only tools explicitly annotated `readOnlyHint: true` |
| `call_destructive_tool` | same as `call_tool` | invokes unannotated, write-capable, or destructive tools through a host-visible approval boundary |
| `authorize_connector` | `{ connector, force? }` | starts (or with `force`, restarts) the downstream OAuth flow; returns the `authorizationUrl` to open |
| `get_result` | `{ id, offset?, maxBytes? }` | a byte-slice page of a truncated result — `{ text, offset, nextOffset?, totalBytes }` |
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
import {
  api, bearerToken, clerkAuth, cloudflareKvStorage, createConnecta, remoteMcp,
} from "@zackbart/connecta";

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
key held in the runtime's secret store (`openssl rand -base64 32`). Credential
mutation routes require the configured Clerk provider and a same-origin browser
request; the static inbound bearer cannot administer the vault.

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
`call_tool`, `batch_call`, or `execute_code`; retries remain one event with an
`attempts` count. Implementing `list` enables the authenticated Activity tab in
`/ui`; `activityReadGate` can narrow reads further. Writes are best-effort and
never change a tool result. Clerk calls carry the Clerk user ID; shared bearer
calls are honestly labeled as bearer unless
`bearerToken(secret, { subjectId })` assigns that credential a stable subject.

## Learn more

- **[`docs/documentation.md`](./docs/documentation.md)** — how everything works: architecture,
  the meta-tools, connectors, inbound auth, downstream OAuth, storage, running it
  (Node / Workers / Docker), Clerk setup, testing, troubleshooting.
- **[`docs/design.md`](./docs/design.md)** — why it's built this way, and the non-goals.
- **Status UI** — a read-only operator dashboard at `GET /ui` (open shell; data from the bearer/Clerk-gated `/ui/data`). See [§14](./docs/documentation.md#14-status-ui).
