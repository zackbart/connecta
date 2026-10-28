# @zackbart/connecta-eve

Connect an Eve agent to a Connecta agent pool and load its endpoint instructions
once per turn. The helper runs in the Eve app; the Connecta server
runs separately. No `@zackbart/connecta` dependency is installed by this package.

Requires **Node 24+** and **Eve >=0.86.0 <0.87.0**. Development and consumer
checks use real Eve 0.86.0. The range covers its patch line; newer minor releases
need a compatibility check. Helper releases share Connecta's version and tag;
choose the helper version matching your server release.

## Install and add two files

```sh
npm install @zackbart/connecta-eve eve@0.86.0
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

## Eve 0.86.0 dependency override

Eve 0.86.0 pins undici 8.10.2. Connecta's development/test override does not ship
with this helper, so the Eve app must apply its own override to 8.12.3 before
installing. For an npm app, add this to its `package.json`, then reinstall and
commit the lockfile:

```json
{ "overrides": { "eve": { "undici": "8.12.3" } } }
```

For a pnpm app, add `overrides: { "eve@0.86.0>undici": "8.12.3" }` to its
`pnpm-workspace.yaml`. Check the resolved dependency graph and audit the app.
Remove this override after upgrading to an Eve release that pins a fixed version
and validating compatibility. The server's optional undici 6.29.1 peer is a
separate dependency and keeps its exact pin.

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
on Node 24. This boots real Eve 0.86.0 with a packed, installed helper against
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
