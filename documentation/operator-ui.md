# Operator UI

Use this guide to enable or maintain the optional operator interface. For
client tool calls use [Operating an endpoint](./operating.md); for identities,
credential ownership, and grants use [Auth](./auth.md).
[All agent routes](./README.md) are in the index.

## Task routes

| Task                                            | Read                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Enable UI, vault, or history in a deployment    | [Setup](#setup), then the platform template                                                                      |
| Consume config, provenance, status, or activity | [Operator data contract](#operator-data-contract)                                                                |
| Change a UI page or data route                  | [Source and tests](#source-and-tests), [browser verification](./operator-tests.md)                               |
| Diagnose permission refusals                    | [Management permissions](./auth.md#management-permissions), [activity disclosure below](#operator-data-contract) |

## Setup

Set `ui: operatorUi()` using `@zackbart/connecta/ui`. Branding belongs in
`operatorUi({ branding })`; the [Node template](../templates/node/README.md#select-optional-modules)
and [Worker example](../examples/worker/README.md#select-optional-modules)
own the runnable configuration, variables, and branding shape. The UI is an
explicit optional import and stays outside the root package import graph.

Endpoints, Connectors, Activity, Tokens, and Settings show only what the
caller may inspect. Endpoints is the default page at `/`: one row for `/mcp`
and each admitted pool, with a copyable URL, tool count, endpoint mode, and
client setup. Expanding a row lists each connector on that endpoint with who it
runs as (shared or personal) and its tools, marking write tools. Connector
health is not repeated per endpoint: a connector that needs attention gets a
status dot linking to its Connection tab. Counts intersect live tools with
grants, pool declarations, and read-only mode. Connectors lists each connector
with one status badge, auth scope, tool count, and last call; a problem adds one
action (Connect, Replace key, or Inspect) that opens Connection. Connector
detail has Tools, Connection, and Activity tabs. Connection combines
authentication (including the OAuth client mechanism), catalog diagnostics,
one fix prompt beside each problem it reports, and the connector snapshot with its source. Settings combines inbound-auth facts with the
configuration snapshot and labels values as default or configured. Deployment code owns connectors, grants, pools, and classification;
the UI changes only authorized authentication material.

Install the vault for declared credential slots and activity history for
persisted call records. Neither module grants permission to manage or read
it. Credential administration, personal connection, access-token management,
and activity access are separate identity decisions, denied by default where
specified in [auth](./auth.md#management-permissions). Token management
issues, rotates, and revokes the tokens of agents declared in code; it never
creates, renames, or binds an agent. Agent tokens never grant interactive
credential or token management authority.

## Operator data contract

`GET /ui/api/config`, owned by `operatorUi()`, returns `OperatorUiContract`
from `connecta/ui`. `src/operator-ui/contract.ts` is also the browser's type
source. The response has `schemaVersion: 1`, `config`, `configSources`, `live`, and `you`.
`config` is the construction-time `describeConfig()` snapshot, including
`maintainers` and each pool's `members`; only maintainers receive it. v1 alone
adds `config.hasGrant`, true whenever inbound auth is configured, because
`maintainers` then gate plain `/mcp`; Settings displays that fact.
`describeConfig()` itself no longer has `hasGrant`. Pool tools are the pool's
declared tools, never intersected.
`configSources` labels each serialized leaf as `default` or `config`, based on
option presence rather than equality with the default. Factory descriptions carry
relative `optionSources` paths so resolved module and transport defaults retain
their provenance. The snapshot copies only resolved values; the UI consumes
these presence facts separately. Its paths use connector
ids and pool names and are filtered after disclosure; hidden values leave no
provenance keys. It contains no source code or credential material.
Every response is private, `no-store` JSON. Only GET is allowed, with the
same auth gate and identity partition as `/ui/data` and `/ui/connectors/:id`.
These catalog reads, activity reads, connector auth routes, and access-token
routes require a maintainer. Anyone else gets a private JSON 404
`{ "error": "not found" }`; until the member view ships in P6b of
[#837](https://github.com/zackbart/connecta/issues/837), pool members who are
not maintainers have no operator UI. Public HTML shells and static assets carry
no catalog data. Access-token management also retains its interactive
permission gate.

`live.connectors` carries status and problem codes, complete registry tools
with their final read/write classification, catalog age in milliseconds, and
last-call time/outcome. Catalog descriptions and schemas are allowed for an
authenticated reader; grammar-failing names and addresses become `<withheld>`.
`auth.registrationPath` reports the selected downstream OAuth client mechanism when known.
Status prose, error text, credential values or suffixes, arguments, results,
and code are excluded. Static and unobserved catalogs have a null age;
persisted catalogs retain their original fetch time. Probes run with bounded
concurrency and the configured probe deadline, and release their scopes.

Last-call lookup requires the existing activity permission and read gate. It
scans up to 1,000 recent rows, filters connector/tool grants, and restricts
personal connectors to the caller's activity identity. Each retained fact
copies a validated timestamp and outcome only. A null call means unknown or
absent in that window, not proof of no calls. `live.activity` distinguishes
available, unconfigured, forbidden, and unavailable history. `you` names no
identity or auth material; for a maintainer `grants` is `"all"` on every
connector, `pools` lists every declared pool with its declared tools (no
`requireReadOnly` is ever true), and it reports whether each is read-only and
the effective activity, token, and per-connector auth permissions.

`contract.ts` also declares `OperatorUiContractV2` and its member, pool, agent,
connector and matrix types, frozen by
[decision 0006](https://github.com/zackbart/connecta/blob/main/decisions/0006-pools-are-the-access-model.md#operator-contract)
ahead of the server cutover in P6b of [#837](https://github.com/zackbart/connecta/issues/837). No route serves v2 yet;
`test/fixtures/operator-contract-v2.ts` holds maintainer and member fixtures,
and `test/helpers/operator-member-view.ts` checks a member response's exact
shape and compares its values with a projection built from config, membership,
the member's own partition status, and each personal connector's exact `manage`.

`GET /ui/api/config?connector=<id>` narrows the same contract to one admitted
connector before status and catalog probes. Config, provenance, grants, pool
tools, management permissions and live rows contain only that connector's
facts. An unknown or invisible id receives a no-store 404. The selector never
widens identity grants.

`connecta doctor --config` fetches this authenticated contract and prints only
`config` as indented JSON. It requires the UI module and the existing doctor
authentication environment variables; it runs no diagnostic program, follows
no redirects, and prints no raw HTTP failure body.

The operator shell uses React, TanStack Router/Query/Table, Radix, cmdk and
Tailwind v4. Geist Sans, Geist Mono, CSS, JavaScript and dependency notices are hashed assets
under `/ui/assets/*`, served identically with immutable cache headers on Node
and Workers. HTML contains only mount points and escaped inert configuration;
it remains uncached. `generated.ts` is ignored and generated before build and
test; `check:operator-ui` detects stale assets and shared page styles. The UI
stays behind `./ui`, outside the root import graph. The identity-fenced store
owns authenticated reads and existing mutations. An Access-only shell selects
Access even when the HTML request has no trusted context; only authenticated
API responses establish the session. A gated Access session offers Retry.
Focus, visibility, and timer-driven recovery share one admission-read schedule
with at least two seconds between passive attempts. An in-flight passive attempt
coalesces returns until its summary and matching catalog/auth cycle finish,
so slow successful reads can publish. Each admission summary and its matching
config/auth cycle share a 15-second deadline, including token acquisition,
fetches and response bodies. This is an admission deadline, not a request
lifetime limit: it releases the recovery guard and exposes Retry without aborting
the pending read or invalidating its identity/revision fence. A late healthy
response still publishes if that cycle is current. Passive timers and returns
coalesce onto the pending cycle, including after its deadline; they never start
duplicate summary, token, config, detail or body reads. The passive retry schedule
stays bounded and does not reset its budget on a deadline. Retry remains available
during recovery configuration loading and supersedes and aborts the old cycle;
identity changes, navigation and connector-page unmount also cancel it. Navigation
that cancels pending data schedules a bounded reread for the destination. Failed reads retry after
2, 2, 4, and 8 seconds. Refusals preserve the throttle and retry budget. After
those four automatic retries, a focus return can request one more read after
the eight-second backoff, without replenishing the automatic budget. Retry
resets the budget with a 150 ms click debounce. Successful reads and explicit
identity transitions also reset recovery. Identity changes
cancel pending retries and fence out responses from the previous identity.
Queued focus callbacks carry the same identity fence. Explicit sign-out
suppresses passive reads until an intentional sign-in or a new Clerk session.

Catalog and connector auth details share one revisioned refresh cycle. Each
completed connector publishes its catalog facts and auth controls together,
while a slow provider leaves other rows usable.
Catalog refresh, connector refresh, and mutation follow-up reads update both
consumers together. A later refresh or mutation invalidates an older cycle's publication fence
without aborting its read, and a failed contract read clears its old snapshot. After an explicit OAuth
start, visible tabs poll only that connector's read-only catalog and auth facts
every two seconds for up to 30 seconds. The scoped result replaces only that
connector's matching live row and auth controls. Success, a failed read or status,
disconnect, navigation away from the connector, unmount, or identity reset ends
polling and aborts its in-flight reads. The deadline also aborts a stalled read.
A later focus return can request another status read. Recovery never starts OAuth
or replays a mutation.
Unreadable credential metadata uses `configured: null`, including named fields,
and renders as unavailable with a retry prompt. It does not claim that the slot
is empty. Endpoints, Connectors, connector
detail, and Settings consume the typed contract. Activity retains
its authenticated data routes. Connector detail tabs live
in the URL hash; Activity filters live in the query string and apply to loaded
history. Both `/ui/activity` and `/ui/api/activity` require Activity access and
pass the optional activity `readGate`. Interactive operators and machine callers
admitted by `identity.activityAccess` share the same history disclosure rules.
Connector/tool grants and grants for the recorded pool filter each event. Shared
connector history can include other principals' events, with recorded request
IDs, validated client name/version and package version, and actor kind, ID and
namespace. Interactive reads may also add directory actor labels; machine reads
never add them. Personal connector history is owner-only: the event must have a
checked `principal` actor basis and actor ID/namespace matching the reader's
admitted principal. Rows without a provable personal owner are withheld. Activity
carries no arguments, results, code or raw downstream errors. The last-call
overlay uses the same event filter but returns only timestamp and outcome.
Calls group only by recorded request ids, with missing ids shown as
separate calls. Classification and result size are shown only when recorded. The verdict is
captured after registry resolution, and result size counts UTF-8 bytes of the
downstream value before paging or truncation. Nullable SQL columns preserve old
rows. Catalog changes use the same paging envelope with `kind: "catalog_drift"`,
`source: "catalog_refresh"` and a checked `catalog_changed` fact containing only
added, removed and changed tool counts. The first complete catalog is a baseline;
one refresh-publication hook emits each later change. It includes the request's
id and typed actor when available, otherwise a fresh id and system actor. No
names, descriptions or schemas enter the event. Private catalog changes require
a matching principal owner even when the connector uses shared auth. Empty credential declarations
report `credential_required` before running a connector status or catalog probe.
The top bar shows deployment branding and a name breadcrumb, then Search (the
command palette), Appearance, and the session action (Change token or Sign out)
at one quiet size. The tab row lists Endpoints, Connectors, Activity,
Tokens, and Settings. Activity and Tokens keep their permission gates; a gated
viewer sees no operator navigation. The command palette searches visible pages,
connectors and tools, opening connector results on Tools. `/access` redirects
to `/`, `/tools` to `/connectors`, and `/config` to `/settings` in the browser
with history replacement. Connector hashes `#config`, `#auth` and `#diagnostics`
redirect to `#connection`, preserving query parameters such as signed handoffs.
Token controls retain their existing permission gate.
Configuration remains in deployment code. The UI mutates only credentials,
OAuth connections and agent tokens through the existing routes.

## Source and tests

The contract type is [contract.ts](https://github.com/zackbart/connecta/blob/main/src/operator-ui/contract.ts).
[UI routes](https://github.com/zackbart/connecta/blob/main/src/routes/ui.ts) and
[UI implementation](https://github.com/zackbart/connecta/blob/main/src/ui.ts)
serve the authenticated shell and data. The browser lives in
[src/operator-ui](https://github.com/zackbart/connecta/tree/main/src/operator-ui).
[UI tests](https://github.com/zackbart/connecta/blob/main/test/ui.test.ts),
[credential-route tests](https://github.com/zackbart/connecta/blob/main/test/ui-credentials.test.ts),
[config snapshot tests](https://github.com/zackbart/connecta/blob/main/test/describe-config.test.ts),
and [browser flows](https://github.com/zackbart/connecta/blob/main/test/browser/operator-ui.spec.ts)
defend filtering and behavior. Use [Operator UI tests](./operator-tests.md)
for the browser state matrix and Linux snapshot procedure.
