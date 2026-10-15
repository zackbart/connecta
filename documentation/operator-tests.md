# Operator UI tests

Use this repository-maintenance guide when changing operator pages, data routes,
or browser evidence. Read the [operator UI contract](./operator-ui.md) first.
[The agent index](./README.md) routes deployment and endpoint tasks.

`test/fixtures/operator-visual.ts` owns the visual data. It builds the config,
live overlay, viewer, and legacy auth details through the current server routes,
using the types in `src/operator-ui/contract.ts` and `model.ts`. Collections use
their corresponding browser types. `test/operator-visual-fixtures.test.ts`
validates contract versions, connector IDs, granted tools, classification,
permissions, provenance, and secret exclusion on Node and Workers. A fixture's
config cannot silently become a stale copy of the server serializer.

`test/browser/operator-visual.spec.ts` intercepts API reads and serves the real
hashed assets and HTML with the production CSP. Loading responses wait on an
explicit gate. Error responses use fixed HTTP failures. Screenshots use a fixed
clock, UTC, en-US, locally hosted fonts, disabled animations, hidden carets,
and a 1280 × 900 viewport. Narrow fixtures use 390 × 844. Every test waits for
its state and fonts before capturing.

## Page and state matrix

Each row runs empty, loading, error, populated, and restricted-viewer fixtures
in both light and dark themes, for 80 screenshots.

| Page or tab          | Empty state                          | Loading/error request | Restricted viewer                                   |
| -------------------- | ------------------------------------ | --------------------- | --------------------------------------------------- |
| Endpoints            | Root endpoint without tools          | Config                | Scoped endpoints, no privileged navigation          |
| Connectors           | No connectors                        | Config                | Read grant and credential slot, no other connectors |
| Connector Tools      | Empty catalog                        | Config                | Read tool only                                      |
| Connector Connection | Deployment-managed auth              | Config                | Scoped auth, diagnostics and snapshot               |
| Connector Activity   | No calls                             | Activity              | Unavailable                                         |
| Tokens               | No client tokens                     | Token list            | No token management                                 |
| Activity             | No calls                             | Activity              | Unavailable                                         |
| Settings             | Snapshot without connectors or pools | Config                | Scoped snapshot and inbound-auth facts              |

Another 42 screenshots cover configured, mismatched, unreadable and multifield
credentials; all three OAuth client mechanisms; clean and unobserved drift;
historical Activity; client setup; schema dialog; read/write filters; expanded
config provenance; narrow sign-in and Connection; deployment branding; an expanded endpoint (per-connector runs-as and tool chips); command search; and narrow endpoints. The base
populated Activity fixture includes grouped calls, an ungrouped legacy row,
classification/result size/client facts, and a catalog-change event.

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
operator routes with a trusted Worker Access context. It covers transient and
rejected identity reads, missing shell context, delayed OAuth grant commits,
catalog/auth reconciliation, and unreadable credential metadata, all without
reloading the document. Store tests defend bounded recovery and OAuth polling,
atomic refresh publication, identity cancellation, and late-response fencing.
