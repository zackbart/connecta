# Operator UI tests

Use this repository-maintenance guide when changing operator pages, data routes,
or browser evidence. Read the [operator UI contract](./operator-ui.md) first.
[The agent index](./README.md) routes deployment and endpoint tasks.

`test/fixtures/operator-visual.ts` owns the visual data. It builds the config,
live overlay, and legacy auth details through the current server routes, using
the types in `src/operator-ui/contract.ts` and `model.ts`. Until P6b of
[#837](https://github.com/zackbart/connecta/issues/837) serves contract v2,
`test/fixtures/operator-contract-v2-bridge.ts` turns the server's v1 answer into
the maintainer's v2 view, with fixed pool members and runs-as facts; it passes
a v2 body through unchanged and is deleted once the server serves v2. The
restricted state is the frozen member fixture from
`test/fixtures/operator-contract-v2.ts`, and the endpoint and matrix variants
use its maintainer fixture, which covers every runs-as kind and agent pools.
Collections use their corresponding browser types.
`test/operator-visual-fixtures.test.ts` validates contract versions, connector
IDs, granted tools, matrix cells, classification, provenance, and secret
exclusion on Node and Workers, and runs `expectMemberViewWithholds` on the
member body. A fixture's config cannot silently become a stale copy of the
server serializer.

`test/browser/operator-visual.spec.ts` intercepts API reads and serves the real
hashed assets and HTML with the production CSP. Loading responses wait on an
explicit gate. Error responses use fixed HTTP failures. Screenshots use a fixed
clock, UTC, en-US, locally hosted fonts, disabled animations, hidden carets,
and a 1280 × 900 viewport. Narrow fixtures use 390 × 844. Every test waits for
its state and fonts before capturing.

## Page and state matrix

Each row runs empty, loading, error, populated, and restricted-viewer fixtures
in both light and dark themes, for 80 screenshots. The restricted viewer is a
pool member, who gets the member page on every path.

| Page or tab          | Empty state                          | Loading/error request | Restricted viewer (member)          |
| -------------------- | ------------------------------------ | --------------------- | ----------------------------------- |
| Endpoints            | Root endpoint without tools          | Config                | Their pools and client setup only   |
| Connectors           | No connectors                        | Config                | Member page, Endpoints tab only     |
| Connector Tools      | Empty catalog                        | Config                | Member page, Endpoints tab only     |
| Connector Connection | Deployment-managed auth              | Config                | Member page, Endpoints tab only     |
| Connector Activity   | No calls                             | Activity              | Member page, no activity request    |
| Tokens               | No client tokens                     | Token list            | Member page, no token request       |
| Activity             | No calls                             | Activity              | Member page, no activity request    |
| Settings             | Snapshot without connectors or pools | Config                | Member page, no configuration facts |

Another 48 screenshots cover configured, mismatched, unreadable and multifield
credentials; all three OAuth client mechanisms; clean and unobserved drift;
historical Activity; client setup; schema dialog; read/write filters; expanded
config provenance; narrow sign-in and Connection; deployment branding; `/mcp`
and an agent pool expanded with every runs-as kind; command search; narrow
endpoints; the connector × endpoint matrix, one cell's open popover, and the
narrow matrix. The base
populated Activity fixture includes grouped calls, an ungrouped legacy row,
classification/result size/client facts, and a catalog-change event.

`test/browser/operator-matrix.spec.ts` serves the frozen v2 fixtures to the
real shell. It covers the matrix's table semantics, cell names and runs-as
labels, popover keyboard behavior, placement at a short viewport, the in-flow
fallback without CSS anchors, and the absence of `style` attributes, agent URLs on Endpoints, the member page (its
received body checked with `expectMemberViewWithholds`, `/ui/data` answering 404
and never requested, no maintainer fact rendered, no maintainer request sent),
the 401 sign-in and 404 no-access gates on `/ui/api/config` with no maintainer
navigation, payload sentinels, CSP, and the refusal of a v1 body. `test/operator-endpoints.test.ts` covers the view model.
`test/operator-store.test.ts` serves `/ui/api/config` from its own mock, so
each test's data and detail answers stay separate, and covers role changes: a
maintainer demoted after a failed refresh keeps no maintainer state and sends
no maintainer request, and a promoted member loads maintainer data fresh.

Screenshots cover presentation. Keep unit and server tests for INV-6 sentinels,
secret disclosure, auth and grant boundaries, CSRF, identity fences, cancellation,
request lifetime, and error sanitization. Keep browser tests for keyboard/focus,
XSS, real CSP enforcement, and popup lifetimes. A screenshot
cannot prove these rules.

## Updating Linux snapshots

The source of truth is `*-linux.png`, produced on `ubuntu-latest` with the
lockfile's Playwright Chromium. Both CI workflows use the same runner, Node 22,
and `npm run test:browser:install -- --with-deps`. macOS runs fixture routing and
readiness checks but omits screenshot comparison. The update script refuses
non-Linux hosts. Do not commit Darwin baselines.

When Docker is unavailable, use the **Operator snapshots** workflow:

```sh
git push --force-with-lease origin ui/834-shell
gh workflow run operator-snapshots.yml --ref ui/834-shell
# Read the completed run ID from the Actions page or gh run list.
gh run download RUN_ID --name operator-linux-snapshots \
  --dir test/browser/operator-visual.spec.ts-snapshots
```

The workflow uploads all generated baselines and never commits them. Review the
images and changed files, commit the intentional changes, and push again. The
normal CI browser job must compare and pass against that commit. Snapshot
updates run only through `workflow_dispatch`.

On a matching Linux runner, `npm ci`, install Chromium with the command above,
then run `npm run test:browser:snapshots`. The normal command is
`npm run test:browser`. Missing baselines fail CI; retries cannot bless them.
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
operator routes with a trusted Worker Access context, bridging the server's v1
contract to v2 until P6b (test-only). Each admission reads the contract first,
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
