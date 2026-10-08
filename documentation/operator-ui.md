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

Overview, Connectors, Tools, Access, Activity, and Config show only what the
caller may inspect. Connector detail tabs cover configuration, schemas,
authentication, activity, and diagnostics. Config labels values as default or
configured. Deployment code owns connectors, grants, pools, and classification;
the UI changes only authorized authentication material.

Install the vault for declared credential slots and activity history for
persisted call records. Neither module grants permission to manage or read
it. Credential administration, personal connection, access-token management,
and activity access are separate identity decisions, denied by default where
specified in [auth](./auth.md#management-permissions). Machine tokens never
grant interactive credential or token management authority.

## Operator data contract

`GET /ui/api/config`, owned by `operatorUi()`, returns `OperatorUiContract`
from `connecta/ui`. `src/operator-ui/contract.ts` is also the browser's type
source. The response has `schemaVersion: 1`, `config`, `configSources`, `live`, and `you`.
`config` is the construction-time `describeConfig()` snapshot, filtered to
visible connectors, granted tools, classification overrides, and admitted
pools. Pool tools are the intersection with the caller's identity grants.
`configSources` labels each serialized leaf as `default` or `config`, based on
option presence rather than equality with the default. Factory descriptions carry
relative `optionSources` paths so resolved module and transport defaults retain
their provenance. The snapshot copies only resolved values; the UI consumes
these presence facts separately. Its paths use connector
ids and pool names and are filtered after disclosure; hidden values leave no
provenance keys. It contains no source code or credential material.
Every response is private, `no-store` JSON. Only GET is allowed, with the
same auth gate and identity partition as `/ui/data` and `/ui/connectors/:id`.

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
identity or auth material; it reports grants, root and admitted-pool trust,
and effective activity, token, and per-connector auth permissions.

`connecta doctor --config` fetches this authenticated contract and prints only
`config` as indented JSON. It requires the UI module and the existing doctor
authentication environment variables; it runs no diagnostic program, follows
no redirects, and prints no raw HTTP failure body.

The operator shell uses React, TanStack Router/Query/Table, Radix, cmdk and
Tailwind v4. Inter, CSS, JavaScript and dependency notices are hashed assets
under `/ui/assets/*`, served identically with immutable cache headers on Node
and Workers. HTML contains only mount points and escaped inert configuration;
it remains uncached. `generated.ts` is ignored and generated before build and
test; `check:operator-ui` detects stale assets and shared page styles. The UI
stays behind `./ui`, outside the root import graph. The identity-fenced store
owns authenticated reads and existing mutations. Overview, Connectors, connector
detail, Tools, Access and Config consume the typed contract. Activity retains
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
The Access adapter reports inbound provider kinds, admitted pools, grants, trust
and endpoint setup; token controls retain their existing permission gate.
Configuration remains in deployment code. The UI mutates only credentials,
OAuth connections and client tokens through the existing routes.

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
