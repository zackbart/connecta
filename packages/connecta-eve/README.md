# @zackbart/connecta-eve

Connect an Eve agent to a Connecta agent pool and load its endpoint instructions
once per turn. The helper runs in the Eve app; the Connecta server
runs separately. No `@zackbart/connecta` dependency is installed by this package.

Requires **Node 24+** and **Eve 1.0.0-rc.1**. Development and consumer
checks use that exact release candidate. The peer stays pinned during the RC
period; later candidates and stable 1.0 need a compatibility check. Helper
releases share Connecta's version and tag; choose the helper version matching
your server release.

## Install and add two files

```sh
npm install @zackbart/connecta-eve eve@1.0.0-rc.1
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

export default connectaConnection({
  pool: "assistant",
  description: "Shared CRM and tickets for the assistant.",
});
```

Create `agent/instructions/connecta.ts`:

```ts
import { connectaInstructions } from "@zackbart/connecta-eve";

export default connectaInstructions({ pool: "assistant" });
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

## Upgrading to Eve 1.0 RC

Update the app to `eve@1.0.0-rc.1` and reinstall to refresh its lockfile.
The helper's connection, dynamic pool, instructions and approval APIs use Eve's
stable entry points and require no authoring changes for this RC. Eve's
[1.0 stability policy](https://eve.dev/docs/reference/typescript-api#stability-policy)
does not cover `experimental` fields or internal modules.

From 0.90, review the intervening
[release notes](https://github.com/vercel/eve/blob/eve%401.0.0-rc.1/packages/eve/CHANGELOG.md):
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

The gate uses the host's cached annotations. If a read becomes a write before
dispatch, Connecta applies its current classification; a writable pool can
execute the write without a fresh approval. A read-only pool refuses it.

## Endpoint instructions

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
on Node 24. This boots real Eve 1.0.0-rc.1 with a packed, installed helper against
seeded local catalogs of 40, 100, 250, 500, and 1,000 downstream tools on the
meta, native, and native-plus-code surfaces. Native listings include two
Connecta tools beyond the downstream count. A 1,001-tool native catalog must
refuse listing. `--counts 40,1000` selects a smaller matrix.

The probe uses Eve's public language-model interface with a deterministic local
transport, without model credentials or paid calls. It measures construction,
cold and warm discovery, schema and result bytes, call counts, concurrent-call
isolation, bounded-result paging, and process memory. Fresh child processes
isolate each matrix cell; Eve startup is separate from turn latency. Reports
retain actual Eve events and transport inputs. Token usage and model task
quality remain unmeasured; these results establish local runtime contracts,
not live Vercel workload admission or production model performance.

For a disposable workload check, use the
[contributor fixture recipe](https://github.com/zackbart/connecta/blob/main/packages/connecta-eve/scripts/workload-fixture/README.md) from a source
checkout. Its preparation command packs and installs the current core/helper,
checks local signed controls and cancellation, and creates no live resources.
Live execution requires separate owner authorization for the concrete account,
project, bounds, cost ceiling and cleanup. Keep its evidence outside the checkout.
