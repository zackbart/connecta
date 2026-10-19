# Operator UI tests

## Contributor reference

This guide describes Connecta implementation and repository verification.
It is optional for deployment operators. Start with the
[operator task index](./README.md#operator-tasks) for package-local procedures.

Use this repository-maintenance guide when changing operator pages, data routes,
or browser evidence. Read the [operator UI contract](./operator-ui.md) first.
[The agent index](./README.md) routes deployment and endpoint tasks.

`test/fixtures/operator-visual.ts` owns the visual data. It builds the
maintainer's contract v2, live overlay, and legacy auth details through the
current server routes, using the types in `src/operator-ui/contract.ts` and
`model.ts`; its people carry labels from a fake directory. It sets a few
limits, an activity retention, one classification override and a GitHub call
admission rule in code, so Settings and the connector Configuration card show
set values beside defaults; Slack describes OAuth facts (scope, endpoints, an
API origin, client secret, PKCE) for the card's auth row. Its Tokens agents
(`claude-desktop` issued, `triage` none, `nightly` revoked) are real slots
committed through the deployment's own store, so the contract's `agents` and
`GET /ui/access-tokens` agree, revisions included; only their timestamps and
last seen are fixed. The restricted state is the member fixture from
`test/fixtures/operator-contract-v2.ts`, and the endpoint and matrix variants
use its maintainer fixture, which covers every runs-as kind and agent pools,
with `test/fixtures/operator-console.ts` crowding the team pool so its avatar
stack collapses to "+3".
Collections use their corresponding browser types.
`test/operator-visual-fixtures.test.ts` validates contract versions, connector
IDs, granted tools, matrix cells, classification, provenance, and secret
exclusion on Node and Workers, and runs `expectMemberViewWithholds` on the
member body. A fixture's config cannot silently become a stale copy of the
server serializer.

`test/browser/operator-visual.spec.ts` intercepts API reads and serves the real
hashed assets and HTML with the production CSP. Loading responses wait on an
explicit gate. Error responses use fixed HTTP failures. The map trace focuses its
node instead of hovering it: the capture scrolls to the top first, which would
move the node out from under a pointer and drop the highlight, so the test waits
for `.map-svg.tracing` before capturing. Screenshots use a fixed
clock, UTC, en-US, locally hosted fonts, disabled animations, hidden carets,
and a 1280 × 900 viewport. Narrow fixtures use 390 × 844. Every test waits for
its state and fonts before capturing.

## Page and state matrix

Each row runs empty, loading, error, populated, and restricted-viewer fixtures
in both light and dark themes, for 90 screenshots. The restricted viewer is a
pool member, who gets the member page, with no tabs, on every path.

| Page or tab          | Empty state                          | Loading/error request | Restricted viewer (member)          |
| -------------------- | ------------------------------------ | --------------------- | ----------------------------------- |
| Overview             | No connectors: nothing to map        | Config                | Member page at `/`                  |
| Endpoints            | Root endpoint without tools          | Config                | Member page: endpoints, accounts    |
| Connectors           | No connectors                        | Config                | Member page, no connector request   |
| Connector Tools      | Empty catalog                        | Config                | Member page, no connector request   |
| Connector Connection | Deployment-managed auth              | Config                | Member page, no connector request   |
| Connector Activity   | No calls                             | Activity              | Member page, no activity request    |
| Tokens               | No declared agents                   | Token list            | Member page, no token request       |
| Activity             | No calls                             | Activity              | Member page, no activity request    |
| Settings             | Snapshot without connectors or pools | Config                | Member page, no configuration facts |

Populated Overview has a failing connector, auth and credential problems
and a tokenless agent in its attention list. Populated Endpoints shows who can use each endpoint; populated Tokens has one
agent per slot state, with pools and last seen.

Another 60 screenshots cover the Overview map on the frozen v2 maintainer, one
person's trace, and the narrow map list; configured, mismatched, unreadable and multifield
credentials; all three OAuth client mechanisms; clean and unobserved drift;
historical Activity; client setup; schema dialog; read/write filters; narrow
Settings; narrow sign-in and Connection; deployment branding; `/mcp`
and an agent pool expanded with every runs-as kind; command search; narrow
endpoints; the connector × endpoint matrix, one cell's open popover, and the
narrow matrix; a new token's one-time secret dialog; and the member page, wide
and narrow. `endpoints-expanded` and `narrow-endpoints` include the team row
collapsed to "+3". The base
populated Activity fixture includes grouped calls, an ungrouped legacy row,
classification/result size/client facts, and a catalog-change event.

`test/browser/operator-matrix.spec.ts` serves the frozen v2 fixtures to the
real shell. It covers the matrix's table semantics, cell names, status dots,
runs-as labels in each kind's popover, popover keyboard behavior, placement at a short viewport, the in-flow
fallback without CSS anchors, and the absence of `style` attributes, agent URLs on Endpoints, the member page (its
received body checked with `expectMemberViewWithholds`, `/ui/data` answering 404
and never requested, no maintainer fact rendered, no maintainer request sent),
the 401 sign-in and 404 no-access gates on `/ui/api/config` with no maintainer
navigation, the shared recovery banner on Tokens and Activity through a failed
refresh that stalls past its deadline (one focusable Retry, no maintainer
request until Retry succeeds), an open client setup drawer closed by a failed
refresh with focus on Retry, Tokens under recovery (an open rotate question
closes with focus on Retry and nothing sent; an unseen secret dialog stays open
over the banner until dismissed), payload sentinels, CSP, and the refusal of a v1 body. Matrix coverage excludes retired grants from
its live counts and pie, keeps their names inspectable in the popover, and
renders an unavailable catalog as a dashed empty ring with "?" and an unknown
accessible name. Cell names distinguish equal grants against different live
catalog sizes. `test/operator-endpoints.test.ts` covers those view-model cases,
including a known empty catalog versus an unavailable one.
`test/operator-connection-map.test.ts` also checks that a failed or unobserved
catalog counts no tools, which the map draws as a muted dash, while a known
empty catalog counts zero.
`test/browser/operator-overview.spec.ts` covers the Overview on the frozen v2
fixtures: the status pill, stat labels and numbers, map columns, dashed read-only grants and dotted
tokenless access; attention rows with their fix links, a copied fix prompt equal
to the catalogue's text, config order through a staggered full refresh, prototype-named
connector IDs during loading and failure, and stable single-card height when
its catalog empties, plus a long-title card at 390px across every status label; the hover
sentence replacing the legend, and dimming; keyboard focus in column order with each node's sentence
as its accessible name, Enter opening an endpoint's row and a connector; the
narrow list, whose caller chips link where their map nodes do; an empty deployment; and a member at `/` getting the member page
with no maintainer read, plus CSP and no `style` attributes.
`test/browser/operator-console.spec.ts` covers UI-3: who-can-use chips by
label, raw id and agent mark and "+N" from the keyboard; Tokens rows,
issue with the once-only secret dialog, in-row rotate and revoke questions,
503, 499 and 409 failures that send exactly one request, slots missing from
the list or left unresolved shown with disabled controls until Refresh; and the
member page (its received body checked with `expectMemberViewWithholds`, no
tabs, Search or maintainer fact, OAuth Connect, Reconnect and Disconnect sent as
`?mode=continue`, `?mode=restart` and `DELETE`, the credential `actions`
shapes, a refresh that drops an action closing its confirmation, a failed or
stalled refresh keeping member chrome with Retry, a consent that outlasts the
OAuth poll window), plus keyboard, sentinels, CSP and no `style` attributes.
`test/operator-console.test.ts` covers the chip, slot-row and member-page view
models. `test/browser/operator-scheme.spec.ts` holds the main bundle and checks the
first painted background: saved dark on a light system paints dark, a pinned
light deployment paints light over saved dark, and throwing storage keeps the
system scheme while the released bundle settles on the normal bearer gate, and a
sign-in there raises no error. The real-route token test in `test/browser/operator-ui.spec.ts` serves
the contract, `/ui/data` and the slot routes from one real v2 deployment and
checks that each mutation sent a distinct 22-character `expect`.
`test/operator-store.test.ts` serves `/ui/api/config` from its own mock, so
each test's data and detail answers stay separate, and covers role changes: a
maintainer demoted after a failed refresh keeps no maintainer state and sends
no maintainer request, and a promoted member loads maintainer data fresh. It
also drives UI-3's slot fence with a session-token read held open: reloads and
contract refreshes that move or drop a slot before dispatch, late results that
cannot overwrite newer evidence, unknown and unreadable outcomes that only a
later list read settles, revisions sent as `expect` and compared with the
contract, an identity change that leaves the next identity's fence alone, and
member actions whose `manage` a refresh changes.

Screenshots cover presentation. Keep unit and server tests for INV-6 sentinels,
secret disclosure, auth and grant boundaries, CSRF, identity fences, cancellation,
request lifetime, and error sanitization. Keep browser tests for keyboard/focus,
XSS, real CSP enforcement, and popup lifetimes. A screenshot
cannot prove these rules.

## Updating Linux snapshots

The source of truth is `*-linux.png`, produced on `ubuntu-latest` with the
lockfile's Playwright Chromium. Both CI workflows use the same runner, Node 22,
and `pnpm run test:browser:install --with-deps`. macOS runs fixture routing and
readiness checks but omits screenshot comparison. The update script refuses
non-Linux hosts. Do not commit Darwin baselines.

When Docker is unavailable, use the **Operator snapshots** workflow:

```sh
git push --force-with-lease origin <branch>
gh workflow run operator-snapshots.yml --ref <branch>
# Read the completed run ID from the Actions page or gh run list.
gh run download RUN_ID --name operator-linux-snapshots \
  --dir test/browser/operator-visual.spec.ts-snapshots
```

The workflow uploads all generated baselines and never commits them. Review the
images and changed files, commit the intentional changes, and push again. The
normal CI browser job must compare and pass against that commit. Snapshot
updates run only through `workflow_dispatch`.

On a matching Linux runner, `pnpm install --frozen-lockfile`, install Chromium with the command above,
then run `pnpm run test:browser:snapshots`. The normal command is
`pnpm run test:browser`. Missing baselines fail CI; retries cannot bless them.
Set `OPERATOR_VISUAL_INSPECT=1` to retain local screenshots under ignored
`test-results/` for inspection, without updating committed baselines.

## Real-server flows

`test/browser/operator-flows.spec.ts` uses `listen()` from `src/node.ts` with
loopback TCP servers. It intercepts only Clerk provider traffic with a test
publishable key; server identity uses the existing `fakeClerkAuth` seam. The
OAuth provider validates the code exchange and PKCE. Credential Test calls a
loopback downstream endpoint. Operator APIs, cookie/bearer admission, CSRF,
assets, handoffs, callbacks, and encrypted storage use production code.

The flows cover Clerk sign-in/reload/sign-out; OAuth connect/consent/callback/
connected reread/reload; and credential save/test/replace/remove. They collect
CSP violations across every document and popup, and fail on unexpected network
traffic. No credentials enter visual fixtures or screenshot baselines.

`test/browser/operator-auth-recovery.spec.ts` serves the production UI and real
operator routes with a trusted Worker Access context, serving the server's own
contract v2. Each admission reads the contract first,
so its read counts include one contract read per admission. It covers transient and
rejected identity reads, missing shell context, delayed OAuth grant commits,
catalog/auth reconciliation, and unreadable credential metadata, all without
reloading the document. The repeated-refusal browser case drives ten focus and visibility returns
160 ms apart with a controlled clock, checks the shared backoff and exhausted
retry budget, then recovers without reloading. Store tests cover the same
state transitions for 401, 403, and 503 refusals and debounced explicit Retry.
Delayed config/detail cases in both runtimes and Chromium keep returning focus
every 2.1 seconds, require eventual catalog/auth publication, and assert one
recovery cycle. Store cases also preserve explicit Retry and sign-out while
that cycle is pending. The Retry focus browser case uses a controlled clock to
check click coalescing inside 150 ms and heading focus after a later Retry.
Store tests defend bounded recovery and OAuth polling,
atomic refresh publication, identity cancellation, and late-response fencing.
Multi-connector browser cases assert scoped polling and cancellation after
navigation, successful authorization, and failed status. The Clerk browser
fixture holds sign-out pending to check that queued focus and later passive
returns cannot restore operator data.
