# Operator UI

Use this guide to enable or maintain the optional operator interface. For
client tool calls use [Operating an endpoint](./operating.md); for identities,
credential ownership, and grants use [Auth](./auth.md).
[All agent routes](./README.md) are in the index.

## Task routes

| Task                                            | Read                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Enable UI, vault, or history in a deployment    | [Setup](#setup), then the platform template                                                                      |
| Find a member's endpoint or set up their client | [Use the member page](#use-the-member-page)                                                                      |
| Consume config, provenance, status, or activity | [Operator data contract](#operator-data-contract)                                                                |
| Change a UI page or data route                  | [Source and tests](#source-and-tests), [browser verification](./operator-tests.md)                               |
| Diagnose permission refusals                    | [Management permissions](./auth.md#management-permissions), [activity disclosure below](#operator-data-contract) |

## Setup

Set `ui: operatorUi()` using `@zackbart/connecta/ui`. Branding belongs in
`operatorUi({ branding })`; the [Node template](../templates/node/README.md#select-optional-modules)
and [Worker example](../examples/worker/README.md#select-optional-modules)
own the runnable configuration, variables, and branding shape. The UI is an
explicit optional import and stays outside the root package import graph.

Endpoints, Connectors, Activity, Tokens, and Settings are the maintainer's
pages. Endpoints is the default page at `/`: one row for `/mcp` and each pool,
with a copyable URL, tool count, endpoint mode, and client setup. A pool with
agent members also shows its agent URL, muted. Expanding a row lists each
connector on that endpoint with what it runs as and its tools, marking write
tools. The runs-as label comes from that endpoint's matrix cell. A shared connector
names its credential's source: "Shared · saved <date>" (vault), "Shared ·
connected <date>" (OAuth), "Shared · not configured", "Shared · set in
deployment", or "Shared · no credential needed"; a vault or OAuth cell without a
date omits it. The others read "Personal · N of M connected", "Workspace · people:
self · agents: <owner>" (or "none"), or "Everyone acts as <subject>" for a
fixed-subject Workspace connector. Connector health is not repeated per
endpoint: a connector that needs attention gets a status dot linking to its
Connection tab. Counts intersect live tools with the pool's declared tools
(the `/mcp` matrix cells for the root), guarded grants' live verdicts, and
read-only mode. Connectors lists each connector with one status badge, auth
scope, tool count, and last call; a problem adds one action (Connect, Replace
key, or Inspect) that opens Connection. A List / Matrix toggle (`?view=matrix`)
switches to a table of connectors by endpoint, `/mcp` first: each cell reads
"all", a tool count, or a dash, read-only columns are tinted, and a Runs as
column summarizes the `/mcp` cell, else the first pool's. A cell with tools is
a button named like "GitHub on /mcp/support: 1 tool, read-only"; Enter, Space or
a click opens a popover listing exactly that cell's tool names, write tools
marked, with the cell's runs-as. Escape or Tab returns focus to the cell. The
popover opens below its cell, or above when the viewport has more room there,
with a capped height that scrolls; CSS anchor positioning places it, and the
page sets no inline styles. A browser without anchor positioning gets the same
list, with the same keys, in an expansion row under the connector. `GET /ui/api/config` is the browser's one gate: a 401
shows sign-in, the private 404 shows a "No access" page naming who to ask, with
Sign out or Change token, and a 200 renders by `role`. `/ui/data`, connector
details, activity and tokens are requested only after the contract says
`maintainer`, and every such read checks the role again when it is sent, focus
returns included. Until a role is confirmed, the page shows its loading or
error state and no navigation. The store keeps the last confirmed role through
a failed refresh: a maintainer's page stays mounted, inert and dimmed, under
one shell banner with Retry, whichever page it is, and sends nothing
maintainer-only until a contract confirms the role again. Recovery closes the
page's dialogs, drawers and popovers and the command palette, and moves focus
to Retry. Credential and OAuth writes also wait for a contract that agrees
with the confirmed role: a maintainer's for a connector it shows, a member's
for a personal connector their contract lists with that action in `manage`;
otherwise the write is not sent and its row says so. An
answer with a different role clears everything read under the old one and
admits the viewer again. A
pool member sees one page on every path: their pools with each URL and
client setup, and the Endpoints tab alone. Connector
detail has Tools, Connection, and Activity tabs. Connection combines
authentication (including the OAuth client mechanism), catalog diagnostics,
one fix prompt beside each problem it reports, and the connector snapshot with its source. Settings combines inbound-auth facts with the
configuration snapshot and labels values as default or configured. Deployment code owns connectors, grants, pools, and classification;
the UI changes only authorized authentication material.

Install the vault for declared credential slots and activity history for
persisted call records. Neither module grants permission to manage or read
it: [auth](./auth.md#management-permissions) does. Interactive maintainers
administer shared credentials and agent tokens, maintainers read activity, and
pool members connect their own accounts on personal connectors in their pools.
Token management issues, rotates, and revokes the tokens of agents declared in
code; it never creates, renames, or binds an agent. Agent tokens never grant
interactive credential or token management authority.

## Use the member page

With `operatorUi()` enabled, sign in at the deployment's public URL using
Clerk (Node) or Cloudflare Access (Workers). A person listed in a pool's
`members` can open the page without becoming a maintainer. The current member
page shows **Your endpoints**, with each admitted `/mcp/<pool>` URL and a
**Client setup** button. For example, Bob in pool `team` copies
`https://connecta.example.com/mcp/team` into his MCP client and authenticates
as himself. Every browser path shows that same member page; it does not
expose maintainer connector-detail, activity, token, or settings pages.

The page reads `GET /ui/api/config`: 200 with `role: "member"` confirms
membership; 401 means sign in; a private 404 means the signed-in person has
no maintainer role or human pool membership. A `cta_` agent token gets 401
and cannot sign in to this page. Use the agent's `/agent/<pool>` endpoint
for machine access instead.

The member contract also describes the tools in the person's pools and
supported actions on their own personal connections. The current member page
renders endpoint setup only. For personal OAuth, use `authorize_connector`
from the person's `/mcp/<pool>` connection and finish its signed browser link.
Trusted clients that manage personal credentials use only the actions listed
in the connector's `manage` field; the API contract below describes their
routes and preconditions. Shared credentials always require a maintainer.

## Operator data contract

`GET /ui/api/config`, owned by `operatorUi()`, returns `OperatorUiContract`
(`OperatorUiContractV2`) from `@zackbart/connecta/ui`, `schemaVersion: 2`.
Its declarations ship in `dist/operator-ui/contract.d.ts` in the installed package. Schema
version 1, `hasGrant`, `you.grants`, and `you.permissions` were removed;
v2 keeps `you.interactive` to describe whether the session is interactive. It is the page's
only gate: a signed-out caller gets the auth provider's 401 challenge, and a
`cta_` agent token the machine-only 401 Bearer challenge every human route
gives it; a maintainer, or a person listed in a pool's `members`, gets 200
with `role` `"maintainer"` or `"member"`; anyone else gets the private JSON 404
`{ "error": "not found" }`. An open deployment's anonymous caller is
a maintainer. Every response is private, `no-store` JSON, and only GET is
allowed. One shape serves both roles; a field a role does not receive is
`null` or empty, never omitted.

The maintainer view carries:

- `config`, the construction-time `describeConfig()` snapshot, including
  `maintainers` and each pool's `members`, and `configSources`, which labels
  each serialized leaf as `default` or `config` from option presence rather
  than equality with the default. Factory descriptions carry relative
  `optionSources` paths so resolved module and transport defaults retain their
  provenance. Paths use connector ids and pool names and are filtered after
  disclosure; hidden values leave no provenance keys. Neither contains source
  code or credential material.
- `root`: plain `/mcp`, its `readOnly`, and its `maintainers`, people only.
- `pools`: every declared pool with `humanPath` (`/mcp/<name>`), `agentPath`
  (`/agent/<name>`), `readOnly`, `owner` (the Workspace address its agents act
  as), its declared `tools` (never intersected; no `requireReadOnly` is ever
  true), and its `members`, agents as `{ kind: "agent", name }`. Every listed
  person carries a `label` from the same directory lookup activity actor
  labels use, on an interactive read only, and `null` without a directory
  (Cloudflare Access) or an entry. An open deployment's anonymous maintainer
  reads every `owner` as `null`.
- `agents`: every agent declared in code, with its pools, its token slot
  (`state`, `issuedAt`, `revokedAt`, `revision`) exactly as
  `GET /ui/access-tokens` lists it, and `lastSeenAt`, the newest visible
  activity row recorded for that agent, or `null` when activity is off or
  none is visible. A slot read that fails answers 503 rather than drop agents.
- `matrix`: a cell per connector for plain `/mcp` (`pool: null`) and for each
  pool that serves it, with that endpoint's tool names or `"all"` and
  `runsAs`. A Workspace connector with a subject mapping is
  `{ kind: "workspace", humans: "self", agents }`, `agents` being the pool's
  owner, or `null` on plain `/mcp` and in an ownerless pool; a fixed subject is
  `{ kind: "workspaceFixed", subject }`. A personal connector counts the
  endpoint's people (the maintainers on plain `/mcp`) and how many have
  connected in their own partition: a stored credential of the declared shape,
  or an `ok` status. A shared connector names its `source`: `vault` (a saved
  slot, with `savedAt`), `missing` (a slot with nothing saved, or shared OAuth
  reporting it needs authorizing), `oauth` (a shared grant; grants carry no
  saved time, so `savedAt` is `null`), `unauthenticated` (a remote MCP server
  that declares no auth), or `config` (everything else, held by deployment
  code).
- `live.connectors`: status and problem codes, complete registry tools with
  their final read/write classification, catalog age in milliseconds, and
  last-call time/outcome. Catalog descriptions and schemas are allowed;
  grammar-failing names and addresses become `<withheld>`.
  `auth.registrationPath` reports the selected downstream OAuth client
  mechanism when known. Static and unobserved catalogs have a null age;
  persisted catalogs retain their original fetch time.
- `live.activity`: available, unconfigured, forbidden, or unavailable history.
  Last-call and last-seen lookups need the activity permission and read gate,
  scan up to 1,000 recent rows, filter connector/tool grants, restrict personal
  connectors to the caller's activity identity, and copy a validated timestamp
  and outcome only. A null means unknown or absent in that window.
- `connectors: []`.

The member view is exactly that member's projection: `config`,
`configSources` and `root` are `null`, `live.connectors`, `agents` and
`matrix` are empty, and `live.activity` is `"forbidden"`. `pools` lists only
their pools, each with `owner: null` and `members: []`. `connectors` lists
each connector in those pools with its title, the member's pools that serve
it, its auth scope, the tools those pools grant with their classification,
`connection` (their own partition's state and problem code for a personal
connector, `null` for a shared one) and `manage`. `manage` is derived on the
server. A shared connector is always `{ kind: "none" }`. For a personal one,
the member's own permission (an interactive person in a pool that holds it)
gates every action. A credential slot offers `save` when a vault is
configured, `clear` when a value is stored in the member's partition, and
`test` when one is stored in the declared shape and the connector has the
matching test hook; an unreadable partition offers `save` alone, so the page
reads stored-ness from `actions`. OAuth offers `connect` and `restart` when
the connector has `startAuth`, `finishAuth` and `verifyState` and the
deployment can sign the connect hand-off, and `disconnect` when it has
`disconnectAuth`. No actions is `{ kind: "none" }`. The view carries no shared
credential status, catalog ages, last calls, other members, agents, owners or
activity. Status prose, error text, credential values or suffixes, arguments,
results, and code are excluded from both views. Probes run with bounded
concurrency and the configured probe deadline, and release their scopes. Every
vault, token-slot and activity read the view makes runs under that same
deadline and the request's signal, so a stalled store never hangs the page: it
degrades fail-closed, to `save` alone for a member's credential, `missing` or
an unconnected person in a matrix cell, unavailable activity, and a 503 for
the token slots.

`/ui/data`, `/ui/connectors/:id`, activity reads and access-token routes
require a maintainer and give anyone else the same private 404. The connector
auth routes, `/ui/oauth/<id>` and `/ui/credentials/<id>`, also admit a pool
member for a personal connector in one of their pools, in their own
partition. `/ui/oauth/<id>` gates each verb on its own hooks: a connect needs
`startAuth`, `finishAuth` and `verifyState`, a disconnect only
`disconnectAuth`. `/ui/credentials/<id>` refuses to clear an empty partition,
the caller's own for a personal connector or the shared slot, with 409
`{ "error": "no credential is stored to clear", "problem": "credential_required" }`,
as its test route refuses to test one; a value that cannot be read can still be
cleared. The routes thus accept what `manage` lists, with one recovery
exception: clearing a stored value that cannot be read is accepted although
`manage` lists only `save` in that state. Public HTML shells and static assets carry no catalog data.
Access-token management also requires an interactive session.

`GET /ui/api/config?connector=<id>` narrows the same contract to one connector
before status and catalog probes. For a maintainer, config, provenance, live
rows and matrix cells contain only that connector's facts; for a member,
`connectors` does. Pools keep their declared tools. An id outside the
caller's view receives a no-store 404. The selector never widens access.

`connecta doctor --config` fetches this authenticated contract and prints only
a maintainer's `config` as indented JSON; a member's view has none, and doctor
says the snapshot is for maintainers. It requires the UI module and the
existing doctor authentication environment variables; it runs no diagnostic
program, follows no redirects, and prints no raw HTTP failure body.

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
with at least two seconds between passive attempts. An admission read takes
the contract first and, for a maintainer, then `/ui/data` and the connector
details, which reuse that contract rather than read it again. An in-flight
passive attempt coalesces returns until its admission read finishes, so slow
successful reads can publish. Each admission read shares one 15-second
deadline, including token acquisition, fetches and response bodies. This is an admission deadline, not a request
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
without aborting its read, and a failed contract read clears its old snapshot;
the next refresh then reads the contract before any connector detail. After an explicit OAuth
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
detail, Settings, and the member page consume the typed contract; Activity opens
only to a maintainer whose contract reports readable history. Connector detail
reads auth permissions from its `/ui/data` connector. Activity retains
its authenticated data routes. Connector detail tabs live
in the URL hash; Activity filters live in the query string and apply to loaded
history. Both `/ui/activity` and `/ui/api/activity` require a maintainer
principal, interactive or not, and pass the optional activity `readGate`.
Interactive and machine maintainer reads share the same history disclosure rules.
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

## Contributor reference

### Source and tests

The browser store reads only v2 and checks `role` before reading a
maintainer-only field. `test/fixtures/operator-contract-v2.ts` holds
maintainer and member fixtures, and `test/helpers/operator-member-view.ts`
checks a member response's exact shape and compares its values with a
projection built from config, membership, the member's own partition status,
and each personal connector's exact `manage`;
`test/operator-contract-server.test.ts` runs it against real responses.

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
