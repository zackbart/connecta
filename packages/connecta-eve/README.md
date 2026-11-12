# @zackbart/connecta-eve

Connect an Eve agent to a Connecta agent pool and load its endpoint instructions
once per turn. The helper runs in the Eve app; the Connecta server
runs separately. No `@zackbart/connecta` dependency is installed by this package.

Requires **Node 24+** and **Eve 1.0.0-rc.10**. Development and consumer
checks use that exact release candidate. The peer stays pinned during the RC
period; later candidates and stable 1.0 need a compatibility check. Helper
releases share Connecta's version and tag; choose the helper version matching
your server release.

## Install and add two files

```sh
npm install @zackbart/connecta-eve eve@1.0.0-rc.10
```

The server must declare your agent, admit it to the named pool and issue its
agent token. See Connecta's [agent token setup](https://github.com/zackbart/connecta/blob/main/documentation/auth.md#issue-rotate-or-revoke-an-agent-token).

Set these in the Eve app's environment:

```sh
CONNECTA_URL=https://connecta.example.com
CONNECTA_ACCESS_TOKEN=cta_your_agent_token
```

Create `agent/connections/connecta.ts`:

```ts
import { connectaConnection } from "@zackbart/connecta-eve";

export default connectaConnection({ pool: "assistant" });
```

Create `agent/instructions/connecta.ts`:

```ts
import { connectaInstructions } from "@zackbart/connecta-eve";

export default connectaInstructions({ pool: "assistant" });
```

`description` is optional. Eve shows it in its catalog listing and matches its
words against every search query for every tool of the connection, so the default
is a fixed neutral line. If you set one, describe the domain in prose, such as
`"Member records, giving and event registration."`. Do not list connectors or
operations: on a three-connector meta pool, `"CRM, invoices and tickets"` made the
query `"invoices"` return all six routing tools, 9.4 KB measured, and tells the
model nothing about the operations behind them. The instructions carry the roster.
A string such as
`"Company tools through Connecta"` tells the model nothing, so the helper warns
at startup.

Eve names a connection after its file. If yours is not `connecta.ts`, say so in
the instructions, or the model is told tool names that do not exist:

```ts
// agent/connections/workspace.ts gives the model workspace__* tools.
export default connectaInstructions({ pool: "assistant", connection: "workspace" });
```

Both factories accept `url` to override `CONNECTA_URL`. With `pool`, the URL is
`<url>/agent/<pool>`; without `pool`, supply the complete endpoint URL. Pool
names must match `[a-z0-9_-]+`. `connectaEndpoint({ url, pool })` returns the same
URL for other clients. Keep both files pointed at the same endpoint and token
source.

Auth is app-owned. The default token comes from `CONNECTA_ACCESS_TOKEN`, read
again for each request, so rotation requires no process restart. A `getToken`
callback can return a string or a promise of one; it overrides the environment.
No user's identity is forwarded.

`headers` adds request headers beside the bearer, such as a service token for an
edge in front of Connecta. Pass the same value to every factory. A function runs
for each request, so a rotated secret needs no restart. On guidance and skill
requests, the helper's own `Authorization` and MCP protocol headers always win.

```ts
const headers = () => ({ "X-Edge-Token": process.env.EDGE_TOKEN ?? "" });
export default connectaConnection({ pool: "assistant", headers });
```

## Choosing the pool at runtime

Pass the same selector to both factories when the pool depends on the chat.
For example, an app that sets trusted `direct` channel metadata can keep its
choice fixed for a turn:

```ts
import type { DynamicContext } from "eve/connections";

export const selectPool = (ctx: DynamicContext) =>
  ctx.memo(["connecta-pool", ctx.turn?.id ?? null], () =>
    ctx.channel.metadata.direct === true && ctx.session.auth.current?.principalId === "alice"
      ? "notes_alice"
      : "assistant",
  );
```

Use `pool: selectPool` in both `connectaConnection` and `connectaInstructions`.
Eve evaluates the dynamic connection before every model call; the selected
pool is its `instanceKey`, so a parked call cannot replay against a changed
pool. A string still creates the same static connection.

Both factories call the selector independently. The helper never memoizes its
result. Memoize selector I/O with `ctx.memo` for your policy's lifetime so the
connection and instructions agree and repeated evaluations avoid repeated
lookups. Eve scopes memos per definition, so the two factories each perform
their first lookup. A turn key fixes each choice for that turn; omit the memo
to choose again at every evaluation. Ensure both lookups use consistent
app-owned policy data.

Each selected name must match `[a-z0-9_-]+`. A throwing selector or an invalid
name fails the turn, even when guidance is cached. Handle lookup failures in
your selector if it should fall back to a least-privileged pool.

## Gating guidance and connections

Pass `when(ctx)` to load guidance only for eligible callers or turns. The helper
runs this predicate inside Eve's dynamic definition before selecting a pool,
reading a token, or using cached guidance. False or a thrown/rejected predicate
returns no guidance and performs no guidance fetch. It is evaluated before
every model call, including repeated evaluations within a turn.

```ts
export default connectaInstructions({
  pool: "assistant",
  when: (ctx) => ctx.session.auth.current?.principalId === "alice",
});
```

`connectaConnection` accepts the same predicate and returns a dynamic connection
when it is provided. False or a policy failure removes that connection for the
current evaluation. The two factories evaluate their predicates independently;
use consistent trusted policy data as with a dynamic pool selector. This policy
controls what the app offers; Connecta still enforces endpoint authorization.
No Eve dynamic-value unwrapping is required.

## Upgrading to Eve 1.0.0-rc.10

Update the app to `eve@1.0.0-rc.10`, reinstall to refresh its lockfile, then
rebuild and test it before deploying. The helper's connection, dynamic pool,
instructions and approval APIs use Eve's stable entry points and require no
authoring changes for this RC. Eve's
[1.0 stability policy](https://eve.dev/docs/reference/typescript-api#stability-policy)
does not cover `experimental` fields or internal modules.

From rc.4, review Eve's release notes for
[rc.5](https://github.com/vercel/eve/releases/tag/eve%401.0.0-rc.5) through
[rc.10](https://github.com/vercel/eve/releases/tag/eve%401.0.0-rc.10).
These change app-owned code and deployments the helper does not manage:

- **Subagent model choice.** `agentWithModel` is gone (rc.6). Replace
  `export { agentWithModel as default } from "eve/tools/agent"` with
  `export default agent({ models: { ... } })`, which lists the models a task may
  run on.
- **Workflow worlds.** New sessions claim their address atomically (rc.6). Eve
  now requires the local world, Vercel Workflow, or `@workflow/world-postgres`
  5.1.1 or later; run that package's `bootstrap` before deploying. Finish or end
  sessions owned by Eve before 0.83 first.
- **Schedules.** Agents deployed to Vercel run schedules with Vercel Schedules
  instead of Cron Jobs (rc.10). Building a `withEve` app needs Vercel CLI
  65.14.0 or later.
- **Workflow tool state.** Reading or updating a `defineState()` handle inside a
  workflow tool's `"use step"` function now throws (rc.9).

From rc.1, also review Eve's
[rc.2](https://github.com/vercel/eve/releases/tag/eve%401.0.0-rc.2),
[rc.3](https://github.com/vercel/eve/releases/tag/eve%401.0.0-rc.3) and
[rc.4](https://github.com/vercel/eve/releases/tag/eve%401.0.0-rc.4) release notes.
These change app-owned code and deployments the helper does not manage:

- **Rollback.** Session checkpoints move to version 19 (rc.3). A deployment from
  before rc.3 refuses to take over a session rc.3 or later wrote, so that session
  stays on the deployment that wrote it. New runs also use Workflow spec 9; set
  `WORKFLOW_SPEC_VERSION=8` to keep creating spec 8 runs.
- **File tools.** Every agent gets a default `edit_file` tool (rc.4) that changes
  sandbox files without `write_file`. If you disable, wrap or gate `write_file`,
  do the same for `edit_file`. Connecta's own tools are unaffected.
- **Builds.** Eve moves to a Nitro 3 release candidate and declares Rolldown
  itself (rc.3). Importing `nitro/storage`, `nitro/kv` or `nitro/database` from
  agent code now fails the build, as does an asset import that leaves the authored
  package.
- **Code extension.** `code__grep`, `code__worker` and `code__apply_patch` are gone
  (rc.3, rc.4). Follow Eve's notes if your app mounts `eve/extensions/code`.
- **Dynamic tools.** A dynamic tool no longer replaces a static tool of the same
  name (rc.3). Dynamic connections, including this helper's, still override a
  static connection of the same name.

From 0.90, also review the
[rc.1 release notes](https://github.com/vercel/eve/blob/eve%401.0.0-rc.1/packages/eve/CHANGELOG.md):
`session.clear()` now cancels running turns and tasks, and object-form connection
approvals are now preserved at runtime. RC.1 also requires `@vercel/connect`
`^2.7.0` when that optional integration is installed; older Connect releases
reject the prerelease Eve peer.

For older apps, follow Eve's [Upgrade to 1.0](https://eve.dev/docs/guides/upgrade)
guide for event consumers, saved history, extensions and client APIs.
Build and test the app before deploying it. The helper does not migrate those
app-owned surfaces.

## Upgrading from Eve 0.86

Eve 0.88.1 and later pin undici 8.12.3, so the app no longer needs its own undici
override. Remove `"eve": { "undici": "8.12.3" }` from an npm app's `overrides`, or
`"eve@0.86.0>undici": "8.12.3"` from a pnpm app's `pnpm-workspace.yaml`, then
reinstall, commit the lockfile and audit the app. The server's optional undici
6.29.1 peer is a separate dependency and keeps its exact pin.

Eve 0.87 through 0.90 also changed app code the helper does not own. Review every
intervening release in the
[Eve 0.90.0 changelog](https://raw.githubusercontent.com/vercel/eve/refs/tags/eve%400.90.0/packages/eve/CHANGELOG.md);
an app on Eve 0.84 or 0.85 must also review those releases. Notable changes:

- Builds reject connection definitions not made by Eve's own factories, and
  `defineDynamic()` values are opaque (0.87). `connectaConnection()` and
  `connectaInstructions()` already return values made by Eve's factories.
- Several client, workflow and channel APIs moved (0.87).
- Grant-bearing `vercelOidc` auth becomes `eveVercelOidc`, auth callbacks that
  returned `allowToolStubs` become `EveAuthFn`, and `/info` access is restricted
  (0.90). Identity-only `vercelOidc()` calls need no rename.

Build and test the app on the new Eve before deploying it.

## Approval and writes

The default policy is Eve's `never()`: authorized writes run unattended. Use a
read-only Connecta pool when the agent must never write. For an interactive
agent, add `gateWrites: true` to the connection to request user approval before
any tool whose `readOnlyHint` is not `true`, including writable `execute_code`.
`gateConnectaWrites` exports that policy for composition. An explicit Eve
`approval`, either a policy or an approval configuration, takes precedence over
`gateWrites`.

An agent-wide `approval` in Eve's `agent.ts` runs beside the connection's policy
and the stricter result wins. It can add a gate to Connecta tools, including under
the default `never()`, and cannot remove one that `gateWrites` set.

The gate uses the host's cached annotations. If a native tool becomes a write, its cached read name is refused before dispatch. Refresh `tools/list` and use the write's name; approval follows the host's policy. Read-only pools refuse writes.

## Endpoint instructions

Eve hides MCP tools behind `eve__tool` under a `<connection>__` prefix, and
`eve__search` covers listed tools only. Connecta's text is host-neutral, so the
helper places an Eve guide before it, built from the endpoint's
[facts](https://github.com/zackbart/connecta/blob/main/documentation/meta-tools.md#endpoint-facts):

- **Meta pools:** call `eve__tool({ name: "connecta__execute_code", input })`
  directly, with a short example program. `eve__search` sees the routing tools and
  never a downstream operation, so its empty result does not mean a capability is
  missing. Reachable connectors are listed by id.
- **Native pools:** a read is `connecta__<connector>__<tool>` and a write
  `connecta__<connector>__WRITE__<tool>`. Scope a search with
  `"connecta__<connector>__"`, use `execute_code` for several, dependent or reduced
  calls (omitted when the pool has none), and when tools are missing get a link from
  `connecta__authorize_connector` for the user or operator. Eve lists tools again on
  each step, so the repair needs no reconnect, unlike a host that keeps its first
  list.
- **Older servers without facts:** only the naming rule.

The guide adds about 600 bytes with three connectors. Its roster stays under 512
bytes: titles go first, then whole entries give way to a `+N more` count. Names
in Connecta's text and in `nextAction` stay unprefixed, and the guide says so.
The helper warns once per endpoint when a server named `connecta` is on a
different major or minor release from the helper.

Instructions use `server/discover` (MCP 2026-07-28), falling back to legacy
`initialize` when discovery returns a response without guidance, including a
non-OK status or an unsupported-method response. Network errors and timeouts
never trigger initialize. Both JSON and SSE replies are accepted. Each request
has a five-second timeout. Successful guidance is cached for ten minutes per
endpoint in each resolver; `ttlMs` overrides that duration. Eve evaluates
instructions before every model call; the helper keeps one result per endpoint
and turn in Eve's memo, with at most one refresh for that endpoint while its
memo is retained. Switching pools selects that endpoint's guidance, never the
previous pool's. A failed refresh keeps that endpoint's last copy, or adds
nothing if none has succeeded, and waits 30 seconds before retrying it. Other
endpoints keep their own TTL and backoff. Eve retains only memo keys used by the
latest evaluation; returning to a pool can refresh again if its cache expired.
When Eve cancels an evaluation, the helper rethrows the cancellation instead of
counting it as a failure: nothing is kept for that turn and no wait starts.
Tools remain usable. Instructions do not grant access.
Set `clientName` on `connectaInstructions` to identify its requests in server
logs; the default is `connecta-eve-instructions`.

## Vercel OIDC token source

This variant requires a **Connecta 0.35.0 or later** deployment with Vercel
workload admission configured for this agent. Workload admission was added in
[#975](https://github.com/zackbart/connecta/pull/975) and is available from 0.35.0.
Earlier releases require agent tokens.
Once configured, use Vercel's token resolver in **both** files:

```ts
import { getVercelOidcToken } from "@vercel/oidc";
import { connectaConnection } from "@zackbart/connecta-eve";

export default connectaConnection({
  pool: "assistant",
  description: "Shared CRM and tickets for the assistant.",
  getToken: getVercelOidcToken,
});
```

```ts
import { getVercelOidcToken } from "@vercel/oidc";
import { connectaInstructions } from "@zackbart/connecta-eve";

export default connectaInstructions({ pool: "assistant", getToken: getVercelOidcToken });
```

Install `@vercel/oidc` in the Eve app when using this variant. The helper has no
dependency on it and never switches credential types automatically.
Use the default workload audience: Connecta refuses tokens exchanged for a
custom audience, even when Vercel signed them.

## Contributor validation

In a source checkout with dependencies installed and both packages built, run
`pnpm --filter @zackbart/connecta-eve run probe:catalog --output /absolute/path/outside/checkout`
on Node 24. This boots real Eve 1.0.0-rc.10 with a packed, installed helper against
seeded local catalogs of 40, 100, 250, 500, and 1,000 downstream tools on the
meta, native, and native-plus-code surfaces. Native listings include three
Connecta tools beyond the downstream count. A 1,001-tool native catalog must
refuse listing. `--counts 40,1000` selects a smaller matrix.

The probe uses Eve's public language-model interface with a deterministic local
transport, without model credentials or paid calls. It measures construction,
cold and warm discovery, schema and result bytes, call counts, concurrent-call
isolation, bounded-result paging, and process memory. Fresh child processes
isolate each matrix cell; Eve startup is separate from turn latency. Each turn
also checks what the helper's guide claims about Eve: guidance arrives as its own
system message on every model call, `eve__search` on a meta pool reaches only
routing tools, native writes are named `connecta__<connector>__WRITE__<tool>`, and
every step lists tools again. Reports retain actual Eve events and transport inputs. Token usage and model task
quality remain unmeasured; these results establish local runtime contracts,
not live Vercel workload admission or production model performance.

For a disposable workload check, use the
[contributor fixture recipe](https://github.com/zackbart/connecta/blob/main/packages/connecta-eve/scripts/workload-fixture/README.md) from a source
checkout. Its preparation command packs and installs the current core/helper,
checks local signed controls and cancellation, and creates no live resources.
Live execution requires separate owner authorization for the concrete account,
project, bounds, cost ceiling and cleanup. Keep its evidence outside the checkout.

### Deferred connector guide (opt-in)

In `agent/skills/crm.ts`:

```ts
import { connectaSkill } from "@zackbart/connecta-eve";

export default connectaSkill({
  pool: "crm",
  name: "connector:crm",
  description: "Use when working with CRM person identifiers and conventions.",
  when: (ctx) => ctx.session.auth !== null,
});
```

This uses the pinned Eve 1.0.0-rc.10 public `defineSkill` and `defineDynamic`
APIs. Eve's deferred discovery searches the description; loading adds only
instructions. It never installs tools. Use the same caller predicate and pool
selector as the connection. A false or throwing predicate skips selection,
token resolution and fetching. The public API accepts content rather than a
load callback, so fetching happens once per endpoint/guide/turn through Eve's
session memo; inclusion in model context is lazy. Failed responses omit the
skill, including network, timeout and malformed-response failures; turn
cancellation still propagates. A successful guide can be reused while the same
endpoint/guide/turn memo is retained. A new turn fetches again; failure removes
the skill rather than serving the prior turn's guide. The guide must already be visible through that endpoint's `skills` tool.
