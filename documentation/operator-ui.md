# Operator UI

Use this guide to enable or maintain the optional operator interface. For
client tool calls use [Operating an endpoint](./operating.md); for identities,
credential ownership, and grants use [Auth](./auth.md).
[All agent routes](./README.md) are in the index.

## Task routes

| Task                                            | Read                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Enable UI, vault, or history in a deployment    | [Setup](#setup), then the platform template                                                                      |
| Find what a page shows or where a route goes    | [Pages](#pages)                                                                                                  |
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

Install the vault for declared credential slots and activity history for
persisted call records. Neither module grants permission to manage or read
it: [auth](./auth.md#management-permissions) does. Interactive maintainers
administer shared credentials and agent tokens, maintainers read activity, and
pool members connect their own accounts on personal connectors in their pools.
Token management issues, rotates, and revokes the tokens of agents declared in
code; it never creates, renames, or binds an agent. Agent tokens never grant
interactive credential or token management authority.

## Pages

The UI shows configuration and never edits it. Deployment code owns
connectors, grants, pools, agents and classification. The UI changes only
credentials, OAuth connections and agent tokens, through the existing routes.
No select menu displays configuration. Copy is short labels; a failure names
what to do next in one or two sentences and never quotes a route's or
downstream's text.

| Path               | Page                                                         | Who        |
| ------------------ | ------------------------------------------------------------ | ---------- |
| `/`                | Overview (a member gets the member page)                     | Maintainer |
| `/endpoints`       | Endpoints; `#mcp/<pool>` opens that row                      | Maintainer |
| `/connectors`      | Connectors list; `?view=matrix` for the matrix               | Maintainer |
| `/connectors/<id>` | Connector detail; `#tools`, `#connection`, `#activity`       | Maintainer |
| `/activity`        | Activity                                                     | Maintainer |
| `/tokens`          | Tokens, when agents are declared or token management is open | Maintainer |
| `/settings`        | Settings                                                     | Maintainer |

`/access` redirects to `/endpoints`, `/tools` to `/connectors`, and `/config`
to `/settings`, replacing the history entry. Connector hashes `#config`,
`#auth` and `#diagnostics` redirect to `#connection` and keep query
parameters such as signed handoffs. A pool member sees the
[member page](#use-the-member-page) on every path.

### Overview

- **Status pill.** "N need attention" (red when a connector is failing) or
  "All healthy". No pill without connectors.
- **Stat tiles.** Connectors (healthy of total, a bar with one segment per
  connector in its health color), Endpoints (count, a bar split read-only and
  read-write), and People · Agents (both counts, up to eight avatars and agent
  marks; a tokenless agent's mark is hollow). A dot legend counts each segment
  kind; the first two tiles link to their pages. At 760px and below the tiles
  sit two up, with People · Agents as one row across both.
- **Needs attention.** One row per connector whose health is not ok, in
  configuration order, then one per agent in a pool whose token is missing or revoked. A
  row names the problem ("crm needs authorization"), the endpoints it
  affects ("Affects /mcp and /mcp/team") or the agent URL it can't connect at,
  and links to the existing fix: Connect, Replace key or Inspect on
  the connector's Connection tab, or Issue token on Tokens. A row with a
  problem code also has Copy fix prompt. A problem keeps its row and
  prompt when the connector's detail read failed, prefixed "Details didn't
  load". Surviving connector rows retain their order as individual reads settle,
  even when their severity changes. With no rows it reads "All clear".
- **Who reaches what.** The [connection map](#connection-map).

### Connection map

An SVG flow of callers (people in contract order, then declared agents) to
endpoints (`/mcp`, then pools) to connectors in config order, with a last
column of each connector's read and write tool counts. A connector whose
catalog is unknown (failed or not yet observed) draws a muted dash there
instead of "0 tools".

- A grant link takes its connector's health color. Grants on a read-only
  endpoint are dashed; an agent's link to its pool is dotted while it has no
  issued token. Plain `/mcp` admits no agents. A read-only endpoint carries a
  read-only chip.
- Hovering or focusing a node dims everything off its paths and replaces the
  legend with one sentence, such as "alice reaches 2 connectors through /mcp
  and /mcp/team: 6 tools, 1 write." The sentence is also the node's accessible
  name. Hover wins while both are set.
- The map is one tab stop. Arrow keys move within a column and to the nearest
  node in the next one; Home and End go to the first and last node.
- Click or Enter opens the node's page: a connector's Tools tab (Connection
  when it needs attention), an endpoint's row on Endpoints, a person's first
  endpoint, or Tokens for an agent when that page is open. A node without a
  page is a `group`.
- The drawing never scales below 880px; a narrower card scrolls it sideways.
  At 960px and below it becomes a list with one entry per endpoint: its mode,
  its callers as chips that link like map nodes, and its connectors with
  health. With no connectors it reads "Nothing to map yet".

### Endpoints

Pool endpoint rows show the effective surface (`meta` or `native`) and whether
code is on. These are read-only facts from deployment configuration; change
`surface` and `executeCode` in deployment code.

One row each for `/mcp` and every pool: the path, a read-only pill on a
read-only endpoint, a copyable URL, who can use it, its connectors as colored
monograms (four, then "+N"), its tool count over a read and write bar, and a
Setup button.

- Who can use it is `root.maintainers` on `/mcp` and the pool's `members`
  elsewhere, as an avatar stack named on hover and to screen readers (label,
  raw id when the label is null, or agent name). Four show, then a "+N"
  button. A pool with agent members labels its two URLs People and Agents.
- Expanding a row lists everyone by name, then each connector with what it
  runs as and its tools, write tools amber with a pencil. Runs-as comes from
  the endpoint's matrix cell: "Shared · saved <date>", "Shared · connected
  <date>", "Shared · not configured", "Shared · set in deployment", "Shared ·
  no credential needed", "Personal · N of M connected", "Workspace · people:
  self · agents: <owner>" (or "none"), or "Everyone acts as <subject>".
- A connector that needs attention gets a status dot on its monogram and
  beside its name, linking to its Connection tab.
- Setup opens a drawer with the URL and a Claude Code, Codex or JSON snippet
  with a copy button. No snippet carries a token.

Counts intersect live tools with the pool's declared tools (the `/mcp` matrix
cells for the root), guarded grants' live verdicts, and read-only mode.

### Connectors

One card per connector: title and id, one status pill, a Shared or Per person
badge, a Read-only badge when connector `readOnly` is enabled, its tool count over a read and write bar, and when it was last called.
All, Needs attention and Healthy filter the cards, with counts, beside a
search field. A connector that is not fine adds one action (Connect, Replace
key or Inspect) that opens its Connection tab.

Every view shares one verdict per connector: the server's problem code first
(a failed catalog reads "Catalog failed", never "Connected"), then a failed
detail read ("Couldn't load", with no fix prompt), then a non-ok status.
Catalog drift is informational: it stays in the connector's Connection panel
with its fix prompt and in Activity, and never affects health or attention.

Health does not bounce while details load. A connector whose detail read is
in flight (its `/ui/data` row is `loading`, during sign-in, Retry or a
connector's Refresh) keeps the verdict the page last showed for it on every
view (cards, filter counts, the Overview headline, bar, attention list and map,
Endpoints and the connector page) until that read settles, never "Loading
details" or an in-between verdict. A connector with no earlier verdict shows
its contract status. Each connector changes only when its own read settles,
so one slow read never holds back the others and no row moves for an
in-between verdict. A new signed-in identity starts fresh. Cards reserve the action footer
even when no action is needed and the tool bar row even when the catalog is
empty. Each card header keeps its title, status and id/scope badges on single
lines; long text truncates with ellipsis and retains its full value on hover
and for screen readers. The connector detail header and Overview attention
text follow the same rule, and truncated links remain keyboard focusable.
Wider status labels never change the card height.

The top bar uses an icon-only Search button (⌘K or Ctrl+K opens the palette).
Deployment names stay on one line with ellipsis and their full name on hover;
a name matching the product label is omitted. Tabs scroll horizontally when
needed, moving to a second row on narrow screens.

A List / Matrix toggle (`?view=matrix`) switches to a table of connectors by
endpoint, `/mcp` first. A row header is the connector's monogram and name, plus
a status dot linking to Connection when it needs fixing. Each cell is a pie of
how much of the live catalog it grants, with "all", a count, or a dash for
none; read-only columns are hatched. Only granted names still in the live
catalog count. An unknown catalog shows a dashed empty ring and "?". A cell
with grants is a button named like "GitHub on /mcp/support: 1 of 2 live
tools, read-only"; it opens a popover of that cell's tools, each with a read
or write pill (a write struck through on a read-only endpoint), and its
runs-as. Escape or Tab returns focus to the cell. CSS anchor positioning
places the popover below the cell, or above when there is more room, and the
page sets no inline styles. Without anchor support the same list opens as a
row under the connector.

### Connector detail

The title, status pill, id, auth badge and read and write bar, then three
tabs:

- **Tools.** Each tool by its mono address with a Read or Write badge and
  annotation badges (Destructive, Open world), filtered by search and All,
  Read and Write. A tool opens its schema in a side drawer.
- **Connection.** An Authentication card (mode, OAuth client mechanism, who
  manages it, OAuth actions, and the credential card with masked last four,
  field states, and Replace, Test and Remove); a Diagnostics card of tiles
  (catalog age and last call) with a fix prompt beside each
  problem; and a Configuration card. Its badges name the kind (Remote MCP,
  HTTP API or Custom), provider, auth scope, endpoint host and usage guide.
  The auth row names the mode and draws each auth fact as a mono badge
  (credential fields, header and scheme, static header names, OAuth scope, API
  origins as `→ api.crm.example`, OAuth endpoints, client metadata host,
  token auth method, Client secret, PKCE, extra parameter and header names).
  Tiles follow for the result cap, call admission rules and transport. Any
  other key becomes a tile labelled from its name.
- **Activity.** The [Activity](#activity) page for that connector, without
  connector chips or monograms.

#### Read catalog changes

Catalog refresh activity reports added, removed, and changed tool counts within
its identity partition. The UI no longer compares tools with a release-reviewed
manifest or shows schema-pin coverage. Check live annotations and deployment
classification in the catalog when reviewing exposure.

### Settings

The configuration snapshot as tiles, tagged "Defined in code", with no
editing controls. An empty section is not drawn.

- **Deployment.** Fact chips: name and version (`Production · v1`), Writes
  allowed or Read-only, connecta version, public URL, allowed origins,
  sandbox, storage, activity store, deployment ID, website, icon count and
  `deploymentInfo` keys. Default memory storage reads "Memory · default" as a
  warning: on Node a restart loses it.
- **Sign-in.** One tile per inbound auth provider in the order they are tried,
  with its mark and whether it admits people or machines; the agent-token
  tile counts agents ("3 agents"). Then a Maintainers tile with the `/mcp`
  maintainers, or "None". With no providers an Open tile comes first.
- **Features.** Vault ("Seals OAuth" when it does), activity, agent tokens
  and any other module, on or off.
- **Limits.** Each limit as a value over a short label: durations in their
  largest whole unit, sizes in decimal KB or MB with exact bytes as a
  tooltip, counts with separators, "No limit", and On or Off. A null tool
  timeout shows the host-call timeout it falls back to. Headline limits and
  any limit set in code draw large. The rest sit behind one disclosure
  ("17 defaults") with Discovery, Results, Programs and Requests groups. A
  value set in code (by `configSources`) has an accent dot; a default reads
  muted. Activity retention counts as set only when the activity store
  reports `optionSources.retentionDays` as `"config"`, as the shipped D1 and
  SQLite stores do.
- **Overrides.** Each classification override as tool address and verdict.
- **Other.** Any snapshot key Settings does not map, as a tile labelled from
  its name, set only when its value carries `source: "config"`.

### Tokens

One row per agent declared in code, including OIDC-only agents when the token
module is absent: agent mark and name, supported credentials (Agent token,
Vercel OIDC, or both), pools as chips, a token state pill (Not configured, No
token, Issued or Revoked), the issue or revoke date, and last seen ("never"
when unknown). Not configured means the managed token module is absent and
has no token controls; No token means that module has an unissued slot.
An OIDC binding works independently of the token's state. The heading note
reads "Declared in code"; nothing creates or renames an agent. Narrow screens
stack each row into a card.

- Issue appears for a slot with no token or a revoked one; Rotate and a quiet
  red Revoke for an issued one. Rotate and Revoke ask first in a row under the
  agent, with focus on Cancel.
- Every mutation sends `{ "expect": "<revision>" }` with the slot revision the
  operator saw. A new secret opens once in a dialog with a copy button and
  "You won't see this token again."; closing it drops the secret, and
  recovery never closes it.
- A 409 `slot_changed` reads "Changed since you looked. Refresh." A 503
  `outcome_unknown` or 499 `aborted` is a failure notice and is never
  retried.
- A sent mutation leaves its slot unresolved until its successful response is
  validated. Any other outcome, a contract whose `agents[].token` disagrees
  with the list (revision included) or drops the agent, or a failed read
  leaves it unresolved until a later slot-list read succeeds. Until then its
  controls are off with "Refresh to continue", and each action is checked
  again just before it is sent.
- Under the recovery banner Tokens has no Refresh or list Retry of its own,
  and an open rotate or revoke question closes.

### Activity

Counts for the loaded history (calls, failed, tools, catalog changes), also
in its accessible summary, and a strip of calls over time with failures in
red when the calls span more than a minute.

- **Filters.** One bar: search, All / Failed / Succeeded (`?outcome=failed`
  keeps errors and timeouts, `?outcome=succeeded` successes and approvals),
  and chips for each loaded connector and source (`?connector=`, `?source=`).
  Pressing a pressed chip clears it, and a selected value keeps its chip.
  Another `?outcome=` value matches exactly and shows as a clearable Exact
  outcome chip.
- **Rows.** Grouped by recorded request id on a shared rail. Each shows a
  status dot, time, caller (a person by label or id with initials, an agent
  by name with its mark, anything else by kind), connector monogram and tool
  address, a write tag, the failure reason, and duration and size. Opening a
  row lists what was recorded: result, how it ran, classification, exact
  duration and size, caller, stable caller id, request id, client, and
  connecta version. Unrecorded fields are left out. Catalog changes are rows
  with added, removed and changed counts.
- **Empty.** "No calls yet" with Refresh, or "No matches" with Clear filters.

### Navigation, gates and recovery

The top bar is one row: the mark, branding and deployment name, the section
links (Overview, Endpoints, Connectors, Activity, Tokens, Settings), then
icon-only Search (the command palette, also ⌘K or Ctrl+K), Appearance, and Account
(the signed-in account with Sign out or Change token). The mark is connecta's
drawn "C" only when no product name, owner or favicon is configured; with
`branding.favicon.svg` it is that SVG; otherwise there is none. The sign-in
gate shows the same mark above "Sign in". Below 820px the section links move
to a second row that scrolls sideways and keeps the current section in view,
with Search remaining an icon. A member's top bar has only branding and
Account. The command palette searches visible pages, connectors and tools,
opening connector results on Tools.

`GET /ui/api/config` is the browser's one gate: a 401 shows sign-in, the
private 404 shows "No access" with who to ask and Sign out or Change token,
and a 200 renders by `role`. `/ui/data`, connector details, activity and
tokens are requested only after the contract says `maintainer`, and each read
checks the role again when it is sent. Until a role is confirmed the page
shows its loading or error state and no navigation. Activity and Tokens keep
their own permission gates.

The store keeps the last confirmed role through a failed refresh: a
maintainer's page stays mounted, inert and dimmed, under one shell banner
("Couldn't load configuration" with Retry), and sends nothing maintainer-only
until a contract confirms the role again. Recovery closes the page's dialogs,
drawers, popovers and the command palette, and moves focus to Retry.
Credential and OAuth writes also wait for a contract that agrees with the
confirmed role: a maintainer's for a connector it shows, a member's for a
personal connector whose `manage` lists that action. Otherwise the write is
not sent and its row says so. An answer with a different role clears
everything read under the old one.

## Use the member page

With `operatorUi()` enabled, sign in at the deployment's public URL using
Clerk (Node) or Cloudflare Access (Workers). A person listed in a pool's
`members` can open the page without becoming a maintainer. The page, **Your
connections**, has no tabs; its heading shows the signed-in email when the
sign-in exposes one (Clerk's primary email), and its top bar shows branding and
an **Account** button with Sign out or Change token. It lists:

- **Your endpoints**: one card per admitted `/mcp/<pool>` URL with a copy button
  and **Client setup**. For example, Bob in pool `team` copies
  `https://connecta.example.com/mcp/team` into an MCP client and authenticates
  as Bob.
- **Your accounts**: the personal connectors in their pools, each with a
  monogram, tool count, one status badge in an aligned column, and only the
  controls its `manage.actions` lists. A saved credential that no longer fits
  or does not work adds a short note beside the tool count. An OAuth connector
  offers Connect, Reconnect or Disconnect; Reconnect and Disconnect ask first.
  A credential connector offers **Add credential** when only `save` is listed,
  and Replace, Test and Clear once a value is stored; Clear asks first.
- **Shared with you**: shared connectors by name and tool count, without status.

Every browser path shows that same member page; it does not expose maintainer
connector-detail, activity, token, or settings pages, and it never sends a
maintainer request. After an action, and when the tab regains focus while an
authorization it started is still outstanding (up to ten minutes), it re-reads
`GET /ui/api/config`. Each action is checked against the current `manage`
again immediately before it is sent, and a refresh that drops an action closes
its open confirmation or form. If a refresh fails or misses its deadline, the
page shows its own error with Retry and moves focus to its heading; members
never see the maintainer recovery banner.

The page reads `GET /ui/api/config`: 200 with `role: "member"` confirms
membership; 401 means sign in; a private 404 means the signed-in person has
no maintainer role or human pool membership. A `cta_` agent token gets 401
and cannot sign in to this page. Use the agent's `/agent/<pool>` endpoint
for machine access instead.

Personal OAuth can also start from the person's `/mcp/<pool>` connection with
`authorize_connector`, finishing its signed browser link. Trusted clients that manage personal credentials use only the actions listed
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
`{ "error": "not found" }`. An open deployment's anonymous caller gets
`role: "maintainer"` but has no principal: activity is `"forbidden"`, the
activity and access-token routes answer 404, and owners are `null`. Every response is private, `no-store` JSON, and only GET is
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
  (`/agent/<name>`), `readOnly`, effective `surface` (`meta` or `native`),
  `executeCode` (whether code is enabled), `owner` (the Workspace address its agents act
  as), its declared `tools` (never intersected; no `requireReadOnly` is ever
  true), and its `members`, agents as `{ kind: "agent", name }`. Every listed
  person carries a `label` from the same directory lookup activity actor
  labels use, on an interactive read only, and `null` without a directory
  (Cloudflare Access) or an entry. An open deployment's anonymous maintainer
  reads every `owner` as `null`.
- `agents`: every agent declared in code, in deployment order, with its pools
  and `credentialTypes` (`access_token`, `vercel_oidc`, or both). These are
  immutable deployment descriptions: the token kind requires the managed
  access-token module, and OIDC requires that agent's own workload binding.
  They grant nothing. `token` is `null` when the token module is absent;
  otherwise its slot (`state`, `issuedAt`, `revokedAt`, `revision`) is exactly
  what `GET /ui/access-tokens` lists, including an unissued `state: "none"`.
  A failed or incomplete slot read answers 503 rather than drop agents.
  `lastSeenAt` is the newest successful agent-endpoint admission or visible
  historical activity timestamp, or `null` when unknown or withheld.
  Admission means credential verification and membership in that declared pool
  succeeded; it does not promise a completed call. Invalid credentials,
  refused/undeclared pools and human routes record nothing. The observation
  stores only the declared name and timestamp, independently of activity.
  It uses at most two atomic storage attempts under the existing probe deadline
  and request lifetime; failure or contention can lose an observation, never
  refuse admission, replay work or move the timestamp backwards.
- `matrix`: a cell per connector for plain `/mcp` (`pool: null`) and for each
  pool that serves it, with that endpoint's tool names or `"all"` and
  `runsAs`. A Workspace connector with a subject mapping is
  `{ kind: "workspace", humans: "self", agents }`, `agents` being the pool's
  owner, or `null` on plain `/mcp` and in an ownerless pool, where agents do
  not see the connector at all; a fixed subject is
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
  Historical last-call and last-seen lookups need the activity permission and read gate,
  scan up to 1,000 recent rows, filter connector/tool grants, restrict personal
  connectors to the caller's activity identity, and copy a validated timestamp
  and outcome only. Admission last-seen reads require a maintainer and honor
  the configured activity read gate, including when history is unavailable;
  they work with no activity module. A null means unknown or withheld.
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
Tailwind v4. Hanken Grotesk, JetBrains Mono, CSS, JavaScript and dependency notices are hashed assets
under `/ui/assets/*`, served identically with immutable cache headers on Node
and Workers. HTML contains only mount points and escaped inert configuration;
it remains uncached. Ahead of the stylesheet, every operator page (sign-in
gate, member page, maintainer pages) loads a blocking hashed scheme initializer
of under 200 bytes, `src/operator-ui/app/scheme-init.ts`, with a plain
`<script src>` and no inline code. When the server set no `html[data-scheme]`
from a pinned `branding.theme.colorScheme`, it copies a saved `light` or `dark`
from local storage key `connecta:scheme` onto that attribute, ignoring storage
errors, so the first frame already has the viewer's scheme. The deferred bundle
learns of a pin from `schemePinned` in the inert configuration; Appearance
writes the key and moves the attribute live, and is read-only under a pin. Every
local and session storage access in the UI tolerates storage that throws, as in
private browsing: a read finds nothing stored and a write keeps nothing, so a
bearer token is not remembered there. `generated.ts` is ignored and generated before build and
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
that cancels pending data schedules a bounded reread for the destination. A scoped OAuth poll publishes only its connector's detail and live row. It does
not supersede a pending full admission or catalog/auth cycle, release its
recovery guard, or clear its deadline. That full cycle still publishes other
connectors as they settle and decides recovery, retaining the newer polled row
even when its summary was pending or its deadline exposed Retry. Only a newer
full cycle, mutation, identity change, or sign-out fences older work. Owed
publication neither spends nor resets the failed-read retry budget and adds no
timer. Failed reads retry after
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
is empty. Overview, Endpoints, Connectors, connector
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

Activity label resolvers receive an optional `AbortSignal`. Pass it to user-directory
fetches and stop work when it aborts: the reader has left or the label lookup
budget has expired. Clerk label lookups follow the same lifetime and discard
late answers after cancellation.

## Contributor reference

### Source and tests

The browser store reads only v2 and checks `role` before reading a
maintainer-only field. `test/fixtures/operator-contract-v2.ts` holds
maintainer and member fixtures, and `test/helpers/operator-member-view.ts`
checks a member response's exact shape and compares its values with a
projection built from config, membership, the member's own partition status,
and each personal connector's exact `manage`;
`test/operator-contract-server.test.ts` runs it against real responses.

The Overview's map and attention rows are pure functions of the contract in
[connection-map.ts](https://github.com/zackbart/connecta/blob/main/src/operator-ui/connection-map.ts)
and [overview.ts](https://github.com/zackbart/connecta/blob/main/src/operator-ui/overview.ts),
covered by `test/operator-connection-map.test.ts` and
`test/operator-overview.test.ts`; `src/operator-ui/styles/overview.css` holds
the page's styles.

`src/operator-ui/config-summary.ts` maps the snapshot and its provenance to
those tiles: one table of limit labels, the formatters, and the walk that turns
an unmapped key into an Other tile. `app/config-tiles.tsx` draws them, and
`test/operator-config-summary.test.ts` checks formatting, provenance, unknown
keys, an empty deployment, and that a real deployment's snapshot leaves no key
unmapped.

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
