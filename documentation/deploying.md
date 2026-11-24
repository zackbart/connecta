# Deploying Connecta

Use this guide when creating or maintaining a deployment. For changes to the
Connecta package itself, follow [repository policy](https://github.com/zackbart/connecta/blob/main/AGENTS.md).
For work through an already connected endpoint, use [Operating an endpoint](./operating.md).
[All agent routes](./README.md) are in the index. For a cursor signing-key error,
follow [cursor-key recovery](#recover-a-cursor-signing-key).

## Choose a deployment

| Platform           | Runnable instructions                                                                     | Required runtime and state                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Node               | [Node template](../templates/node/README.md)                                              | Node 22.13 or later, QuickJS peer, one SQLite file                           |
| Docker             | [Container setup in the same Node template](../templates/node/README.md#run-it-in-docker) | Same source and config, persistent named volume                              |
| Cloudflare Workers | [Worker example](../examples/worker/README.md#deploy)                                     | Workers Paid plan, Worker Loader binding, one D1 database, Cloudflare Access |

These are the two deployment shapes. Docker packages the Node project, and
Alchemy deploys the Worker.
Templates and their configuration files own the full runnable steps and
environment-variable names; follow them rather than rebuilding their setup
from the contract reference.

## Start on Node

Create a new deployment directory with the CLI. `init` refuses an existing
path and pins the generated project's Connecta dependency to the CLI version:

```sh
npx @zackbart/connecta init my-connecta
cd my-connecta
npm install
npm run --silent rotate-token -- local-machine
# Save the returned cta_ token privately. It is shown only once.
npm start
```

The agent connects to its pool's agent endpoint,
`http://localhost:8787/agent/local-machine`, with
`Authorization: Bearer <returned-cta-token>`. People use plain `/mcp`, which
refuses `cta_` tokens. Machine clients are the agents
declared in `agents` in `src/connecta.config.ts`; the generated project declares
`local-machine` and always installs `accessTokens(storage)`. An agent with no
issued token admits no MCP caller even though `/health` works. Rotating with the
same command replaces the token immediately. `CONNECTA_TOKEN` is only a client/doctor variable;
it never configures server authentication. The generated `npm start`,
`rotate-token` and `adopt-token` scripts read `.env` from the project directory
when it exists (Node's `--env-file-if-exists`), and `npm run doctor` reads it
through doctor's `--dotenv .env`; in both, a variable already set in the
process environment wins over the file. Docker Compose reads `.env`
itself and passes values to the container, where no `.env` is copied.

Edit `src/connecta.config.ts` for connectors, public URL, auth, maintainers,
agents, pools, and optional modules. Lay out each agent's pools by
[Organizing an agent's pools](./auth.md#organizing-an-agents-pools). `src/index.ts` only constructs and starts the deployment.
Follow the [template README](../templates/node/README.md) for storage paths,
backups, Docker provisioning, secrets, and optional modules. Run the deployment's
`npm run typecheck` after configuration changes.

Retain the Node template's `undici` dependency and serve with `listen` from
`@zackbart/connecta/node`. `listen()` installs the owned sender for every
maintained-provider request, reads included, remote MCP writes, and downstream
OAuth token exchange/refresh, dynamic registration and revocation POSTs.
Its separate pre-auth request buffer defaults to 4 MiB, matching core's
authenticated `admission.requests.maxBodyBytes` default. To accept larger MCP
bodies, configure both core and `listen(..., { maxBodyBytes })`; a smaller
platform, proxy or adapter cap still wins. See
[request body limits](./architecture.md#admission-in-two-places).
`listen(..., { maxInFlightBodyBytes })` caps the body bytes all in-flight
requests hold together, counted from the first chunk until the response finishes
or the client leaves. It defaults to 64 MiB, or `maxBodyBytes` when that is
larger, and may not be set below `maxBodyBytes`. Past it a request gets `503` with
`Retry-After: 1` and `Connection: close`. Raise it when legitimate concurrent
large bodies are refused, keeping it within the process's memory budget.
`listen()` keeps an idle keep-alive connection open for 100 seconds and
advertises it as `Keep-Alive: timeout=100`. That outlasts the 90-second idle
pools of common HTTP clients and tunnels, so the client closes an idle socket
before the server does. Node's own 5-second default closes sockets that clients
still hold, and a request sent on one as it closes fails as `ECONNRESET` without
reaching Connecta. Set `listen(..., { keepAliveTimeoutMs })`, a whole number of
milliseconds up to one day, to change it. Behind a reverse proxy or load
balancer, keep it above that proxy's upstream idle timeout. Idle time does not
count toward Node's header and request timeouts, which bound only the arrival
of a request, never a streamed or SSE response.
Calling `close()` on the server `listen()` returns, directly or through the
shutdown below, ends keep-alive at once: idle connections and accepted sockets
without a first HTTP request close, and a connection closes as soon as all its
admitted responses finish. Admission follows Node's `request` event, which
fires once a request's headers are parsed: a request whose headers were parsed
before `close()` is admitted and answered normally, including one pipelined
behind an active response, even if its body is still arriving. A request whose
headers are parsed after `close()`, even one already waiting unread on the
socket, never reaches the application: once every earlier response on that connection has been written,
it is answered `503` with `Retry-After: 1` and `Connection: close`, and the
connection ends. A client that keeps pipelining therefore cannot hold `close()`
open. The `close()` callback waits only for admitted responses, never for the
keep-alive timeout.
`listen()` answers `400` with `Connection: close`, before reading any body, when
`Host` is anything but a host with an optional port, when `X-Forwarded-Proto` is
anything but `http` or `https`, or when the request target does not start with
`/`. A reverse proxy must overwrite `X-Forwarded-Proto` with one value; a
comma-separated chain such as `https,http` is refused.
A Node host serving `connecta.fetch` without `listen()` has no owned sender:
every maintained-provider write, every reviewed POST read and every remote MCP
write is refused before sending. Downstream OAuth credential POSTs also require
that sender. For example, an `assistant` using
`vercel_api_read` to POST `/v1/registrar/domains/availability` needs that
transport even on a read-only endpoint. Workers use their native fetch transport.

By default, Node's `listen()` handles SIGTERM and SIGINT: it stops accepting
connections, closes idle connections and accepted sockets without a first HTTP
request, closes request and code admission, reaps sandbox children, and drains
active responses and deferred work. A connection serving an active response
closes as soon as all its admitted responses finish, including SSE, without
waiting for the keep-alive timeout or for the client to close. Requests arriving
on it after the signal are refused as described above. Its shutdown deadline defaults to ten seconds
(`shutdownTimeoutMs`). For example, retain the template's `listen(connecta, port)` when running it under
Docker Compose so `docker compose stop` uses this cleanup.

The owned Node sender connects directly by default. For HTTP(S) CONNECT proxy
egress, set `proxy` explicitly on `listen`:

```ts
listen(connecta, { port: 3000, proxy: "http://proxy.example.com:8080" });
```

The URL must have an HTTP or HTTPS scheme and no path, query or fragment.
Optional URL username/password credentials authenticate CONNECT only; they are
never forwarded to the destination. Load credential-bearing URLs from the
host's secret configuration. The sender validates the option before listening,
uses an owned proxy dispatcher for each send, and closes it when the response
ends or is canceled. TLS certificates for both proxy and destination use Node's
normal trust configuration; TLS interception requires operator-configured trust.

The sender ignores `NODE_USE_ENV_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY` and global
dispatchers. Remote MCP reads retain native fetch and its proxy settings; the
explicit `proxy` option controls only owned sends. Set the host's native-fetch
proxy policy too if the remote server requires proxy egress for discovery and
reads. CONNECT failure before destination dispatch is a known unsent failure;
a connection failure after a write dispatch is unknown and non-retryable.
Neither case automatically repeats the write. A credential POST is never
replayed by the sender, including after HTTP 421, a reset or a 503. An uncertain
refresh requires authorization again; Connecta blocks the spent refresh
fingerprint rather than redeeming it twice. Once a refresh claim has been
submitted, that protection remains conservative even if proxy setup later fails.
Use a fresh authorization flow to reconcile.

## Start on Workers

Use the [Worker example](../examples/worker/README.md) as the canonical runnable
setup and upgrade guide. Alchemy deploys that example's stack; it owns the
Worker, D1 database, Worker Loader, secrets, and Access applications.

| Task                                 | Canonical procedure                                                                                                                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copy and install a deployment        | [Separate-project installation](../examples/worker/README.md#copied-into-its-own-repository), including exact versions, peers, ignore files, and trusted tooling                                               |
| Deploy or update the stack           | [Deploy](../examples/worker/README.md#deploy), including account permissions and consistent stage selection                                                                                                    |
| Protect secrets and retain data      | [Secrets and state](../examples/worker/README.md#secrets-and-state) and [destroying and recovering](../examples/worker/README.md#destroying-and-recovering)                                                    |
| Configure human and agent access     | [Cloudflare Access](../examples/worker/README.md#cloudflare-access), [agent bypass](../examples/worker/README.md#let-agents-through-access), and [machine tokens](../examples/worker/README.md#machine-tokens) |
| Move an existing Wrangler deployment | [Take over existing resources](../examples/worker/README.md#moving-a-wrangler-deployed-worker-to-alchemy)                                                                                                      |
| Run locally and verify a deploy      | [Local development](../examples/worker/README.md#local-development) and [verification](../examples/worker/README.md#verify-after-deploying)                                                                    |

Retain the example's [compatibility flags and entrypoint wiring](../examples/worker/README.md#files).
The [agent bypass notes](#agent-endpoints-behind-cloudflare-access) below record
verified ingress behavior and the cases that still require verification.

## Agent endpoints behind Cloudflare Access

Agents use `/agent/<pool>`, which connecta authenticates with the `cta_` token
alone and which ignores Access context entirely
([agent endpoints](./auth.md#agent-endpoints)). Behind Access, the edge must
let those requests through without an Access login or service token.
The Worker example's `alchemy.run.ts` declares both applications:

1. Keep the Worker-level application, whose destination is
   `{ "type": "worker", "worker_id": "<the Worker script tag>" }`, exactly as
   [Cloudflare Access on Workers](./auth.md#cloudflare-access-on-workers)
   describes. It still protects every other path and supplies `ctx.access` to
   human routes.
2. For each hostname agents use (the `workers.dev` hostname, each Custom
   Domain, each route host), add one more **self-hosted** Access application.
   In the dashboard, set the domain to that hostname and the path to
   `agent/*`. Give it a single policy whose action is **Bypass** and whose
   include rule is **Everyone**. Through the API:

   ```json
   {
     "type": "self_hosted",
     "name": "connecta agents",
     "destinations": [{ "type": "public", "uri": "connecta.example.com/agent/*" }],
     "policies": [{ "name": "agents bypass", "decision": "bypass", "include": [{ "everyone": {} }] }]
   }
   ```

   The more specific hostname-and-path application takes precedence over the
   Worker-level one on matching paths only. Do not use a Worker destination
   for it: a Worker destination belongs to one application, and a second one
   is refused with 409 `destination belongs to another application`. For the
   same reason a second hostname without Access is not an alternative.

3. Point each agent at `https://<host>/agent/<pool>` with
   `Authorization: Bearer cta_…` and drop its `CF-Access-Client-Id` and
   `CF-Access-Client-Secret` headers. The pool must list `"agent:<name>"`.
4. Verify after the change has settled. Do not rely on a fixed wait: repeat
   these checks until they agree for several consecutive rounds. Without
   credentials, `/agent/<pool>`
   reaches connecta (its 401 carries `WWW-Authenticate: Bearer`, not Access's
   403 page), while `/mcp` and `/` still get Access's refusal. Then run
   `connecta doctor --pool <pool>` with the agent's token.

The bypass makes `/agent/*` reachable from the internet without Access.
Connecta answers there only an issued token of an agent listed in the pool,
and gives every other spelling of the agent namespace a 404 before auth,
because Access matches `/agent/*` after resolving dot segments, folding case,
decoding unreserved escapes, and collapsing a leading `//`, while the Worker
sees the raw path. Connecta never reads `ctx.access` at `/agent/*`.
Pinning the Worker-level application's AUD on human routes is
recommended hardening that connecta does not yet do.

## Compose capabilities and access

Both configurations use `defineConfig((env) => …)`, a required executor, and a required `readOnly` choice.
[Integrating services](./integrating.md) explains the `connectors` array.
Configuration selects optional factories through explicit slots:

| Slot           | Factory/import                                                       | Purpose                                            |
| -------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| `ui`           | `operatorUi()` from `@zackbart/connecta/ui`                          | Operator pages and scoped config inspection        |
| `vault`        | `encryptedCredentialVault()` from `@zackbart/connecta/credentials`   | Encrypted operator-managed credentials             |
| `activity`     | `activityHistory()` from `@zackbart/connecta/activity`               | Payload-free history over the platform's SQL store |
| `auth`         | Clerk or Cloudflare Access from `@zackbart/connecta/auth/*`          | Interactive inbound authentication                 |
| `accessTokens` | `accessTokens(storage)` from `@zackbart/connecta/auth/access-tokens` | Stored machine-token authentication                |

Omitting an optional module leaves its implementation inactive. Invalid or
unknown configuration refuses construction; do not catch it and silently
fall back. [Configuration](./architecture.md#configuration) owns validation
and `describeConfig()`, and [optional modules](./architecture.md#optional-deployment-modules)
owns their composition contracts.

Enable `encryptedCredentialVault(storage, key)` before persisting downstream
OAuth credentials. With no vault, OAuth grants are stored as plaintext. A
configured vault without `seal` and `open` refuses construction when any connector
uses OAuth.
The platform templates describe the base64 32-byte encryption key. Keep it
outside the database and source control, and preserve it across upgrades.
[OAuth state at rest](./auth.md#downstream-oauth-state-at-rest) owns sealing and
existing-record migration.

One deployment serves one tenant and may admit several people. Node uses Clerk
for human auth; Access is Workers-only. With inbound auth, `maintainers` is
required: they receive the whole catalog at plain `/mcp` and the operator UI.
Maintainers belong to no pool. Every other person is listed in at most one
pool's `members` and reaches it at plain `/mcp` too, so one client URL serves
every person; a person in no pool gets the 404 there. Agents reach each pool
that lists them at `/agent/<pool>`. A maintainer listed in a pool, or a person
listed in two pools, throws `ConfigError` at construction; give a person who
needs a different reach a pool of their own. Maintainers alone administer shared credentials, manage
agent tokens, and read activity; members connect their own accounts on
personal connectors in their pool.
[Auth](./auth.md#principals-visibility-and-operators) owns maintainers and members;
[Clerk setup](./auth.md#clerk-oauth-tokens-and-operator-sessions) owns resource-bound
tokens and `aud_claim_enabled`. A person's operator session is not an MCP token.
Several deployments can share one Clerk instance with one Organization each;
[Clerk Organizations](./auth.md#one-clerk-instance-one-organization-per-deployment)
owns that setup and its isolation tradeoff.

Public deployments require ingress rate limiting on all authenticated routes,
including agent, operator, connection-start, and callback paths. Connecta's
fixed bound of 16 active inbound authorizations per loaded core/process or
isolate queues up to 16 more for at most two seconds, then refuses with
retryable 503 `authentication_busy` and `Retry-After: 1`.
A separate allowance of 16 abandoned operations holds stalled work after its
hard deadline plus one second of grace. While it is full, new authentication
receives the same 503, the log records `authentication_abandoned_saturated`,
and `/health` reports `admission.authentication.abandonedSaturated: true`.
Stalled work counts until it settles or until the garbage collector frees
everything that could settle it, as after Cloudflare cancels an invocation.
That second release is eventual, never timed, and needs `FinalizationRegistry`:
on Workers, `enable_weak_ref` or a compatibility date of 2025-05-05 or later.
`/health` reports `admission.authentication.unreachableRelease`.
These bounds limit outstanding work, not requests per second or a quota shared by several
isolates or deployments. Budget ingress across the identity-provider account;
see [authentication capacity](./auth.md#authentication-capacity-and-ingress-limiting)
for route coverage and the interaction with MCP execution admission.

Every deployment must set `readOnly` in its configuration; startup fails without
it, and the template and Worker example set `readOnly: false`. Each named pool
inherits that value unless it sets its own. A writable endpoint (`false`) allows
writes through `call_destructive_tool` and programs and marks `execute_code` as
a write; the client decides what to approve. A read-only endpoint (`true`) omits
write tools from search and describe and refuses every write call; provider
guides may still name those tools. A pool serves exactly its `tools` to its
`members`. See [pools](./auth.md#pools) before changing `readOnly`.

## Connect an MCP host

Every host gets the pool's endpoint URL and one credential: an agent token at
`/agent/<pool>`, or the host's own OAuth sign-in at plain `/mcp`.
The rules below cover what differs between hosts. The examples name the
host's server entry `crm`.

Host behavior below was observed in November 2026. Hosts change it without
notice, so check the host's current documentation before you rely on a limit
or a version.

### Hosts that run their own code mode

Some hosts put every MCP tool inside their own JavaScript runner: opencode's
code mode (on by default in v2), Codex models whose tool mode is
`code_mode_only`, Goose's code mode, and the OpenAI Responses API's
programmatic tool calling. On the default meta surface the model then writes
a Connecta program inside the host's program. Let only one layer run programs:

- **Serve the host a native pool.** Set `surface: "native"` on the pool in
  deployment code, as shown in [Native tool surface](./meta-tools.md#native-tool-surface).
  The host's own runner then calls each downstream tool directly. Add
  `executeCode: false` to leave Connecta's `execute_code` out of the list.
- **Or take the server out of the host's code mode.** opencode: set
  `"codemode": false` on the server. Codex: list the server's namespace
  under `direct_only_tool_namespaces`.

The surface is set per pool in deployment code. Connecta ignores URL query
parameters such as `?codemode=false`, which opencode adds to remote URLs, so
neither a URL nor a host can choose the surface. A person reaches one pool at
plain `/mcp`, so every host they use gets that pool's surface; give an agent's
code-mode harness its own native agent pool if other harnesses share the meta
pool.

A paired Worker evaluation compared the three surfaces on the same 23 tasks
with two models: Claude Sonnet 5.5 at five repeats and GPT-6-Luna at three
([notes](https://github.com/zackbart/connecta/blob/main/eval/baselines/notes-surface-decision-w5-1.md)).
Treat its results as guidance from that run, not a guarantee for other models:

- **Keep `execute_code` on native pools.** Sonnet runs in a host without its
  own code mode. With code off, its result paging took about twice the turns
  and about 14 times the input tokens (a median of about 280,000 against
  20,000), and it passed no more tasks.
- **`executeCode: false` is a reasonable opt-in for hosts with their own code
  mode.** Under Codex code mode it matched native's pass rate. It used fewer
  tokens on joins and more on paging.
- **The meta surface remains the default.** Native is the token-efficient
  opt-in. It used fewer input tokens and less wall time at a similar pass
  rate, but it did not take fewer turns.

**opencode (v2).** Every tool runs unprompted by default, because the default
permission rule allows everything. Add `ask` rules for the tools that can
write. A tool's action is `<server>_<tool>`, and the last matching rule wins.
Set `"protocol": "auto"` so opencode uses MCP 2026-07-28. On its default
legacy protocol, opencode never receives Connecta's sign-in prompts. For a
meta pool:

```json
{
  "mcp": {
    "servers": {
      "crm": {
        "type": "remote",
        "url": "https://connecta.example.com/mcp",
        "codemode": false,
        "protocol": "auto"
      }
    }
  },
  "permissions": [
    { "action": "crm_call_destructive_tool", "resource": "*", "effect": "ask" },
    { "action": "crm_execute_code", "resource": "*", "effect": "ask" }
  ]
}
```

On a native pool, native write tools contain `__WRITE__`, so ask for
`crm_*__WRITE__*` and, unless the pool sets `executeCode: false`,
`crm_execute_code`. These rules also apply to calls made inside opencode's
code mode. Choosing "Always allow" saves an allow rule for that tool at
project scope.

**Codex.** The namespace is `mcp__` plus the server's name in the Codex
configuration:

```toml
[features.code_mode]
direct_only_tool_namespaces = ["mcp__crm"]
```

**Goose code mode.** Calls made inside a Goose program can skip Goose's
per-call approval (this comes from reading Goose's source, not from a test).
Rely on the pool's `readOnly` and `writes` for protection.

### claude.ai and Claude Code

- **Choose a descriptive connector display name.** claude.ai chat never shows
  the model server instructions. It always defers tools and lists them as
  `mcp__<DisplayName>__<tool>`, so the display name is the main clue the
  model has before it searches. Name the work, such as `Customer records and
  tickets` rather than `crm`. Never put an apostrophe or a dot in the name:
  either one has stopped the connector's tools from appearing.
- **Expect approvals to reset when the roster changes.** `execute_code`'s
  description lists the connector roster, and a native pool's
  `authorize_connector` description lists granted connector ids. Adding,
  removing or retitling a connector changes that text. claude.ai keys "Always
  allow" grants to a tool's description, so users may need to approve again.
- **Expect stale tool lists after a deploy.** claude.ai caches a connector's
  tool list for up to about a day and ignores change notifications.
  "Refresh tools list" fetches the list again, but conversations that are
  already open keep the old one.
- **Cowork** gets connector sign-in as a link in the result, not a prompt it
  would never show. This needs no configuration; see
  [authorization recovery](./meta-tools.md#authorization-recovery).
- **Claude Code** shows only tool names and server instructions before tool
  search, and cuts instructions at 4,096 characters. Connecta puts a pool's
  `description` first, so keep it short and specific.

### Cursor

- **OAuth registers dynamically or uses a pre-registered client.** Without
  client settings, Cursor registers itself through dynamic client
  registration. To use a client you registered yourself, set its
  `auth.CLIENT_ID` (and `CLIENT_SECRET` and `scopes` if needed) in the server
  entry; see [Cursor's MCP documentation](https://cursor.com/docs/mcp).
  Either way, allow the callback for each Cursor surface you use:
  `http://localhost:8787/callback` for the desktop app and
  `https://www.cursor.com/agents/mcp/oauth/callback` for web and cloud
  agents. With dynamic registration, add them to your authorization server's
  registration settings, for example
  [Managed OAuth's allowed redirect URIs](./auth.md#cloudflare-access-on-workers).
- **Give a static agent token only at `/agent/<pool>`.** When OAuth discovery
  succeeds, Cursor starts OAuth and ignores a configured `Authorization`
  header. Agent endpoints publish no OAuth metadata, so the header is used.
  At `/mcp`, use Cursor's OAuth sign-in instead.
- **Keep the server name short.** Cursor staff have reported a limit of 60
  characters for the server name plus the tool name; current Cursor
  documentation does not state one. On a meta pool the longest tool is
  `call_destructive_tool` (21 characters), so a server name of at most 38
  stays under it. On a native pool tool names reach 48 characters, so use at
  most 11.
- Cursor staff have also reported that Cursor's CLI ends a tool call after
  about 60 seconds. Keep program work short, as for ChatGPT.

### VS Code and GitHub Copilot

- **Use Copilot CLI 1.0.110 or later.** VS Code's default agent runs on the
  same Copilot runtime. Earlier versions failed every result with a top-level
  `skills`, `tools` or `messages` key, which includes Connecta's `skills` and
  `search_tools` results.
- The default agent does not show server instructions unless the server is
  on its allowlist. The Copilot CLI flag
  `--allow-all-mcp-server-instructions` includes them; VS Code has no such
  setting. Tool descriptions carry Connecta's routing either way.

### Gemini CLI

- The `wait_for_previous` argument Gemini CLI adds to every call is dropped
  before validation, as described under [host-injected keys](./meta-tools.md#the-meta-tools).
- Gemini CLI adds server instructions to the model's context only in trusted
  folders. Trust the project folder for Connecta's routing text to reach the
  model.
- OAuth uses a provisioned client when the server's `oauth.clientId` is set,
  and dynamic client registration otherwise; see
  [Gemini CLI's MCP server documentation](https://geminicli.com/docs/tools/mcp-server/).
  Without a configured client id, Gemini CLI registers again on each
  `/mcp auth`. Configure the exact endpoint URL: the advertised `resource`
  must match it, so watch for trailing slashes.
- Gemini CLI runs tool calls in parallel by default, so two writes can run at
  the same time.

### ChatGPT

- **Keep each call short.** OpenAI staff have reported that ChatGPT ends a
  tool call after about 60 seconds and may send it again; OpenAI's
  documentation does not state a limit. Connecta's default response ceiling of
  55 seconds (`execute.watchdogMs`) stays under that, so do not raise it on an
  endpoint ChatGPT uses. Keep program work short, and never resend a write
  after a timeout ([response ceiling](./code-mode.md#cancellation-and-limits)).
- ChatGPT treats any tool without `readOnlyHint: true` as a write and asks
  for confirmation. Connecta's read tools carry the hint. `call_destructive_tool`,
  native write tools, a writable endpoint's `execute_code` and
  `authorize_connector` do not, so they can ask, `authorize_connector` even on
  a read-only endpoint.

## Verify and diagnose

With the deployment running, replace the placeholder with its saved agent
token and run doctor against a pool that lists the agent:

```sh
CONNECTA_TOKEN='<stored-cta-token>' npx connecta doctor --url http://localhost:8787 --pool local-machine
```

Doctor checks health, the required executor, and the current meta-tool set, running a harmless program on each listed program route. A
`cta_` token is checked at `/agent/<pool>` and needs `--pool`. `--pool` is for
agent tokens only: with a person's credential doctor always checks plain
`/mcp` and refuses `--pool`.
`--dotenv <path>` reads `CONNECTA_TOKEN`, `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET` from that file when it exists; a variable already set
in the process environment wins, and a missing file changes nothing. The Node
template's `npm run doctor` passes `--dotenv .env`.
For a Worker protected by Access, `/health` still needs edge admission even
though `/agent/*` bypasses Access. Use an Access service token admitted by the
Worker-level policy for that check, alongside the agent token:

```sh
CF_ACCESS_CLIENT_ID='<access-service-id>' CF_ACCESS_CLIENT_SECRET='<access-service-secret>' CONNECTA_TOKEN='<stored-cta-token>' npx connecta doctor --url https://connecta.example.com --pool assistant
```

The service headers admit the health probe at the edge; only the `cta_` token
authenticates the agent endpoint inside Connecta. If the operator UI is enabled, maintainer-authenticated
`connecta doctor --config --url <public-url>` (on Node, `CONNECTA_TOKEN` set to a
maintainer's current Clerk session token issued for this deployment's origin;
Clerk OAuth access tokens are refused here, and Access on Workers has no
non-browser maintainer credential, so otherwise use the UI's Settings page) prints the caller-scoped
configuration snapshot as JSON. It runs no diagnostic program and prints no
raw HTTP failure body. [Operator UI](./operator-ui.md) describes the returned
configuration, live facts, and permission rules. The config route is a human
endpoint: an agent token cannot authenticate it.

Health success alone does not prove a client can authenticate or reach an
integration. Check client connection and a bounded read through a chosen
connector; resolve credentials using [authorization recovery](./meta-tools.md#authorization-recovery).

Use the failed check to choose the next step:

| Symptom                             | Action                                                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection refused or timeout       | Check the public URL, listening process/port, proxy, and Worker deployment.                                                                                                                                                                                |
| `/health` fails behind Access       | Check the Worker-level Access policy and the two service headers above. Do not broaden the agent bypass.                                                                                                                                                   |
| Executor check fails                | Retain `quickJsExecutor()` and its peer on Node, or `workerExecutor({ loader })`, the codemode peer, and `LOADER` on Workers.                                                                                                                              |
| MCP 401                             | Check the saved token, declared agent, and slot state; rotated/revoked tokens refuse. Use `/agent/<pool>` with `--pool`.                                                                                                                                   |
| MCP 404                             | Check the pool name and `members: ["agent:assistant"]`; an existing but inaccessible pool is deliberately indistinguishable from a missing one. For a person at `/mcp`, check they are a maintainer or in one pool's `members`; `/mcp/<pool>` always 404s. |
| Doctor passes but a connector fails | Discover its tools in that pool, check credential status/account ownership, and perform a bounded read. Doctor does not prove downstream access.                                                                                                           |
| `Native discovery degraded`         | The named connectors did not answer and are listed from an older catalog. Check them with a scoped search; tools stay listed but calls check the live catalog.                                                                                             |

After a fix, repeat doctor with the same client credentials and pool. Never
paste a token or raw downstream failure body into a committed diagnostic log.

## Upgrade an existing deployment

Bump the exact package pin, read the [changelog](../CHANGELOG.md) for every
intervening release, and apply the relevant migration before startup. `init`
does not merge changes into an existing deployment.

A custom vault without `seal` and `open` now refuses construction when any
connector has OAuth. Before upgrading, add both methods or switch to
`encryptedCredentialVault(storage, key)`. Existing plaintext grants are sealed on
first read; see [OAuth state at rest](./auth.md#downstream-oauth-state-at-rest).

A deployment using `clerkAuth` must set a fixed URL before upgrading:
`ConnectaConfig.publicUrl`, or `clerkAuth({ publicUrl })`. Startup otherwise fails
with a configuration error. Use the origin clients reach, because tokens' `resource`
must match it exactly; see
[Clerk OAuth tokens](./auth.md#clerk-oauth-tokens-and-operator-sessions).

Before upgrading past 0.37.1 with pre-0.29 state, follow
[Retired layout migrations](./migration-retired-layouts.md). Version 0.37.1 is
the last bridge for KV → D1, JSON → SQLite, and OAuth layout-2 conversions.

For an existing Node deployment, add the Node entry's pinned optional peer
before starting the upgraded package: `npm install --save-exact undici@6.29.1`.
The current Node template already declares this dependency.

For Node upgrades, retain the template's `listen` entrypoint and apply the
[Node transport and proxy requirements](#start-on-node).

Authenticated MCP bodies now default to 4 MiB through
`admission.requests.maxBodyBytes`; Node's separate pre-auth buffer also defaults
to 4 MiB. Configure both core and `listen(..., { maxBodyBytes })` if a deployment
must accept larger bodies. Smaller platform or proxy limits still apply.

Gmail connections now request full mailbox access and both settings scopes
(`https://mail.google.com/`, `https://www.googleapis.com/auth/gmail.settings.basic`
and `https://www.googleapis.com/auth/gmail.settings.sharing`) and can send,
delete and change settings by default. What works before the re-grant depends
on the mode:

- **Delegation mode:** the token request names every configured scope, so every
  Gmail call, reads included, fails `provider_permission_denied` until the
  domain-wide delegation entry grants the three new scopes. Avoid the outage by
  adding them before upgrading: a Workspace super administrator opens Admin
  console → Security → Access and data control → API controls → Domain-wide
  delegation, edits the service account's client id entry, and adds the three
  scopes while keeping `gmail.readonly`, `gmail.compose` and the other Workspace
  products' scopes. Changes can take up to 24 hours. After the upgrade is
  serving, remove `gmail.readonly` and `gmail.compose` from the entry.
- **OAuth mode:** an existing `gmail.readonly` and `gmail.compose` grant keeps
  working after the upgrade for reading mail, labels, filters and settings
  through the named reads, and `gmail.compose` already authorizes
  `messages.send`, `drafts.send` and `drafts.delete`. Sending, replying,
  forwarding, `send_draft`, `delete_draft` and draft creation and updates
  therefore work immediately, without a new consent. Relabeling, archiving,
  marking read, starring, trash and restore, permanent deletes, label and filter
  changes, the vacation responder and other settings, and message import and
  insert fail `provider_permission_denied` until the connection reconnects and
  consents to the new scopes. Each person reconnects a personal connection, and
  a maintainer reconnects a shared one, from the member Connect page or the
  `authorize_connector` handoff. An External consent screen may need Google's
  verification for these scopes.

To keep an agent from sending or deleting, set `readOnly: true` on the Gmail
connection or list only the tools it may use in its pool; see
[Gmail](./providers.md#gmail).

After a dispatched write reports an unknown outcome, read the target before
making another write. Programs retain that outcome even when guest code catches
the error; see [Writes](./code-mode.md#writes). Provider
continuations now bind their connection, credential owner and read arguments;
connections with caller-dependent downstream identities also bind the admitted
caller and pool owner. Follow each provider's migration rules for old cursors.
No database conversion or agent-token rotation is required solely for 0.35.0.

Native pools and code-off result paging are optional; existing pools keep the
meta-tool surface. See [Native tool surface](./meta-tools.md#native-tool-surface).
Vercel workload admission and the separate Eve helper are also opt-in; existing
agent tokens keep working. See [Vercel workload credentials](./auth.md#vercel-workload-credentials)
and [Eve agents](./meta-tools.md#eve-agents).

- [Move people to plain `/mcp`](./plain-mcp-upgrade.md) before starting a deployment that lists a maintainer in a pool or a person in several pools; both now throw at construction, and `/mcp/<pool>` answers 404.
- [Provider migration for 0.35](./provider-migration-0.35.md) collects provider upgrade actions for 0.35.0, including removal of Infisical, Notion, and Mixpanel factories.
- [Migration to 0.34](./migration-0.34.md) covers the Overview landing page, Endpoints at `/endpoints`, default browser titles, and Workspace discovery in owner-less agent pools. No storage migration or token rotation is needed from 0.33.
- [Split mixed pools](./pool-membership-upgrade.md) before starting a deployment that lists people and agents together; mixed membership now throws at construction.
- [Migration to 0.33](./migration-0.33.md) maps every removed access option to `maintainers`, pool `members`, and `agents`, moves agents to `/agent/<pool>`, and covers pool owners, token revisions, operator contract v2 with its operator route changes, and the pre-auth listen fix.
- [Tokens issued before agents](./auth.md#agent-tokens-and-upgrading-from-earlier-tokens) stop admitting until each machine's token is bound once to a declared agent with `npm run adopt-token -- <token-id> <agent>` (Node) or `AccessTokenManager.adopt`, which keeps its secret. Human-bound tokens stay refused; issue those agents new tokens. Pool members name `"agent:<name>"` instead of matching token record ids.
- [Retired layout migrations](./migration-retired-layouts.md) requires completing Node JSON → SQLite, Workers KV → D1, and every OAuth layout-2 grant conversion on 0.37.1 before upgrading. The new package no longer supplies those migrations.
- [Worker deployments on Wrangler](../examples/worker/README.md#moving-a-wrangler-deployed-worker-to-alchemy) move to Alchemy once, adopting the Worker, D1 database, and Access applications so the script tag and Access AUD stay unchanged.
- [Notion, Vercel, and Cloudflare for 0.29](./provider-migration-0.29.md) records historical defaults and retained API tool names.
- [Executor wiring](./code-mode.md#deploy-time-capability) requires branded shipped executors or a self-managed custom executor.

## Recover a cursor signing key

Paged API discovery and bound list continuations use one signing key in the
deployment store. A load failure returns retryable `unavailable` and names the
cursor signing key without revealing its value. Restore database connectivity
first, then retry the call. A valid key already cached by a process keeps working.

If the stored key is corrupt, pause incoming traffic and stop every Node process
(or prepare a fresh Worker version), then delete only this row from the
existing SQLite/D1 database:

```sql
DELETE FROM connecta_kv WHERE key = 'continuation-key:v1:signing';
```

Restart all Node processes or switch all traffic to the fresh Worker version
before accepting requests again, so no instance retains an older cached key.
The next paged call creates one replacement key atomically. Do not print or
inspect its value. Outstanding cursors signed with the old key fail
`invalid_args`; start each affected search, details walk or list at its first
page. Other deployment state and credentials remain in the database.

## Contributor reference

### Implementation and evidence

Check the [CLI](https://github.com/zackbart/connecta/blob/main/bin/connecta.mjs),
[Node configuration](../templates/node/src/connecta.config.ts), and
[Worker configuration](../examples/worker/src/connecta.config.ts) when changing
setup. [Deployment-shape tests](https://github.com/zackbart/connecta/blob/main/test/deployment-shapes.node.test.ts),
[config tests](https://github.com/zackbart/connecta/blob/main/test/config.test.ts),
and [package smoke](https://github.com/zackbart/connecta/blob/main/scripts/check-package.mjs)
check the deployment and published package boundaries. Repository verification
requirements remain in AGENTS.md.
