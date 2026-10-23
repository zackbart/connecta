# @zackbart/connecta-eve

Connect an Eve agent to a Connecta agent pool and load its endpoint instructions
at the start of each turn. The helper runs in the Eve app; the Connecta server
runs separately. No `@zackbart/connecta` dependency is installed by this package.

Requires **Node 24+** and **Eve >=0.83.0 <0.84.0**. Development and consumer
checks use real Eve 0.83.0. The range covers its patch line; newer minor releases
need a compatibility check. Helper releases share Connecta's version and tag;
choose the helper version matching your server release.

## Install and add two files

```sh
npm install @zackbart/connecta-eve eve@0.83.0
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

## Approval and writes

The default policy is Eve's `never()`: authorized writes run unattended. Use a
read-only Connecta pool when the agent must never write. For an interactive
agent, add `gateWrites: true` to the connection to request user approval before
any tool whose `readOnlyHint` is not `true`, including writable `execute_code`.
`gateConnectaWrites` exports that policy for composition. An explicit Eve
`approval` policy takes precedence over `gateWrites`.

The gate uses the host's cached annotations. If a read becomes a write before
dispatch, Connecta applies its current classification; a writable pool can
execute the write without a fresh approval. A read-only pool refuses it.

## Endpoint instructions

Instructions use `server/discover` (MCP 2026-07-28), falling back to legacy
`initialize` when discovery returns a response without guidance, including a
non-OK status or an unsupported-method response. Network errors and timeouts
never trigger initialize. Both JSON and SSE replies are accepted. Each request
has a five-second timeout. Successful guidance is cached for ten minutes per
resolver; `ttlMs` overrides that duration. A failed refresh keeps the last copy,
or adds nothing if no fetch has succeeded, and waits 30 seconds before retrying.
Tools remain usable. Instructions do not grant access.

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
