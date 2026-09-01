# Vercel

Import `vercel()` independently from `@zackbart/connecta/providers/vercel`.
It is a hand-written `api()` connection over Vercel's public REST API. The
connection owns 18 named operations and three provider-relative REST hatches.
It adds no provider dependency, imports no `node:` builtin, and is not reachable
from Connecta's root entry.

```ts
import { vercel } from "@zackbart/connecta/providers/vercel";

const hosting = vercel("hosting", {
  purpose: "Production web applications for the product team",
  teamId: "team_1a2b3c4d5e6f7g8h9i0j1k2l",
});
```

The deployment stores one Vercel access token in Connecta's credential vault.
Create the token in Vercel Account Settings under Tokens. Scope it to the
personal account or team this connection needs and give it an expiration date.
The operator UI's Test action calls `GET /v2/user` and reports the authenticated
username, email, name, or id. Connecta never probes it in the background.

## Why this uses REST instead of Vercel MCP

Vercel MCP provides useful project, deployment, and log reads, but it does not
cover the public API. This connection keeps those common reads and adds project
domains, value-safe environment-variable management, deployment promotion and
deletion, and direct access to versioned REST endpoints. The three hatches mean
a newly published Vercel endpoint does not require a Connecta release before an
agent can use it.

This is still authored rather than generated. No OpenAPI document creates tools
at runtime. The named operations are reviewed, projected, classified, and
tested by hand. The published OpenAPI document is used only by
`npm run drift:check` to compare the 19 named endpoints this connection calls.

## Configuration

```ts
vercel("hosting", {
  title: "Production hosting",
  authScope: "shared",
  purpose: "Customer-facing sites owned by Platform",
  teamId: "team_...",
  defaultPageSize: 20,
  instructions: "Never promote the docs project from this connection.",
  maxResultBytes: 512_000,
  callAdmission: {
    rules: [{ maxConcurrency: 6 }],
  },
});
```

`purpose` is required and blank text throws at construction. `teamId` is a
default, not a hidden lock. Named account-scoped tools accept a `teamId`
override; pass `null` to target the token owner's personal account explicitly.
Without a configured default or an override, Vercel uses that personal account.
`list_teams` returns the ids needed to reach a team.

`defaultPageSize` defaults to 20 and must be a whole number from 1 through 100.
Vercel meters endpoints separately, so the connection invents no global request
budget. A deployment may supply `callAdmission` when it has its own concurrency
or call-rate requirement.

`baseUrl` exists for a test double or an HTTPS proxy. The guarded transport
confines every path under that base, refuses redirects, prevents request headers
from replacing `Authorization`, passes `ctx.signal`, and stops reading at 8 MiB.
The runtime-log read also returns at most 500 rows and stops a stream that stays
open past 10 seconds. HTTP is accepted only for a loopback test double.

## Named tools

| Tool | What it does |
| --- | --- |
| `list_teams` | Lists teams the token can reach. |
| `list_projects` | Searches or lists lean project summaries. |
| `get_project` | Reads build settings, Git identity, and the production deployment. |
| `list_deployments` | Filters deployments by project, target, state, branch, or SHA. |
| `get_deployment` | Reads one deployment by id or hostname. |
| `get_build_logs` | Reads at most 1,000 existing build events with live following disabled. |
| `get_runtime_logs` | Reads a 1–500 row runtime-log snapshot and stops a stream open past 10 seconds. |
| `list_project_domains` | Lists verification, redirect, branch, and custom-environment state. |
| `add_project_domain` | Adds a regular, redirect, branch, or custom-environment domain. |
| `verify_project_domain` | Rechecks a pending domain after its DNS challenge is complete. |
| `remove_project_domain` | Removes a project domain, optionally with domains redirecting to it. |
| `list_project_env_vars` | Lists metadata without asking Vercel to decrypt values. |
| `upsert_project_env_var` | Creates or replaces one variable. |
| `update_project_env_var` | Patches one variable by its id. |
| `delete_project_env_var` | Removes one variable from future deployments. |
| `promote_deployment` | Promotes an existing build to production without rebuilding. |
| `cancel_deployment` | Cancels work that is queued, initializing, or building. |
| `delete_deployment` | Permanently removes a deployment and its URL. |

Every read returns a lean projection by default. Projects drop security,
billing, and presentation settings. Deployments keep state, target, timestamps,
creator, and Git identity. Domain reads keep the verification challenge because
dropping it would make an unverified result unusable. The project, deployment,
domain, and build-log reads accept `raw: true` when a Vercel field omitted by
the projection matters.

`raw: true` preserves unprojected list items while keeping the named tool's
declared envelope: list calls still return their item key and `page`, and build
logs still return `{ events }`.

## Environment values are write-only here

`list_project_env_vars` sends `decrypt=false`, then drops `value` even if
Vercel returns one anyway. It returns the key, id, storage type, visibility,
targets, branch, custom-environment ids, comment, and timestamps. The create and
update tools accept a value as input, but their result projection drops it too.

That boundary is deliberate. An agent can audit placement and make a requested
change without filling its context with database URLs or API keys. Sensitive
values cannot be read back from Vercel in any case. The generic
`vercel_api_get` hatch returns the endpoint's untouched response, so a caller
that deliberately requests an endpoint capable of decrypting a non-sensitive
value has asked to cross the named tool's safer boundary.

Environment changes affect future deployments. They do not rewrite a value
already embedded in an existing deployment, and none of the environment tools
triggers a deployment on its own.

## REST hatches

Vercel's API is too large and changes too often for every operation to deserve
a permanent named tool.

- `vercel_api_get` accepts only GET and is explicitly read-only.
- `vercel_api_mutate` accepts JSON POST, PUT, PATCH, and DELETE. It always
  crosses `call_destructive_tool`.
- `vercel_api_upload` accepts POST or PUT with exactly one explicit UTF-8 or
  base64 body. It also crosses `call_destructive_tool`.

All three take a path beginning with `/` and including Vercel's version, such
as `/v1/edge-config`. Query parameters are name/value rows rather than a string
to parse. They use the configured default team unless the caller passes
`personalAccount: true`; that flag cannot be combined with a `teamId` or `slug`
query row. The upload hatch accepts endpoint-specific headers such as a digest,
but refuses credential, cookie, host, content-type, content-length, and
transfer-encoding headers. It reads no local file. The caller supplies the
bytes, content type, and any checksum the endpoint requires.

Use a named tool when one exists. A named tool wins on argument validation,
result size, or safety routing. The hatch is for products such as Edge Config,
feature flags, drains, checks, security, and team settings that are not worth a
large permanent catalog.

## Pagination

The four list families expose one connector-wide contract:

```ts
{
  items: [],
  page: { hasMore: true, nextCursor: "opaque" }
}
```

The item key is `teams`, `projects`, `deployments`, or `domains`. Pass
`nextCursor` back as `cursor` unchanged. Vercel uses different parameter names
and cursor types behind the four endpoints. The connector owns that mapping so
programs do not parse timestamps or branch on provider-specific pagination.

Environment-variable listing has no pagination in Vercel's published contract
and returns `{ variables }` without a false page object.

## Typed failures

- HTTP 401 and 403 become `auth_required`. Vercel uses 403 both for a bad token
  and for a token outside the requested team or operation scope.
- HTTP 404 becomes `not_found`. Re-list the owning project, deployment, domain,
  or environment variable before using the id again.
- HTTP 400, 409, and 422 become `invalid_args`.
- HTTP 429 becomes `rate_limited`. `Retry-After` wins; otherwise the connector
  derives the delay from `X-RateLimit-Reset`.
- HTTP 5xx becomes `unavailable`.

The error text keeps Vercel's error code and message. It never parses prose to
invent a class.

## No SDK on purpose

The connection imports only Connecta modules and Web APIs. `@vercel/sdk` is not
a dependency or optional peer. Direct fetch keeps the root Workers-safe, avoids
shipping the generated model graph, and lets the reviewed named operations and
the REST hatches share one guarded transport.

The trade is API drift, handled explicitly. `scripts/drift/vercel-endpoints.json`
records the method, versioned path, specification revision, and request/response
digest for every fixed endpoint. Before a release, `npm run drift:check` compares
those rows with Vercel's published OpenAPI document at
`https://openapi.vercel.sh/`. The hatches are intentionally absent from that
list because their endpoint is chosen by deployment code at call time.
