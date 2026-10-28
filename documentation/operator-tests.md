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
Collections use their corresponding browser types. Real contract serialization,
member projection and secret withholding are exercised through
`test/operator-contract.test.ts` and `test/operator-contract-server.test.ts`.

`test/browser/operator-visual.spec.ts` intercepts API reads and serves the real
hashed assets and HTML with the production CSP. It captures populated Overview
and connector Connection pages in light and dark themes: four screenshots.
Each capture waits for the heading, page content and fonts, with a fixed clock,
and resets scrolling before the full-page image.

## Loading and recovery probes

`test/operator-contract-server.test.ts` counts physical legacy MCP initialize,
initialized, SSE GET and tools/list requests: cached admission and summary perform
none, then one detail per connector performs one session and complete listing.
The suite also checks default v2 compatibility, the unchanged member projection,
blocked custom connectors and bounded essential token-slot failure.
`test/ui.test.ts` checks complete detail schemas and independent sibling scope cleanup.

`test/operator-store.test.ts` counts scoped refresh/focus/mutation/poll requests,
coalescing and bounded retries, and verifies stale admission blocks privileged reads, connection writes and token actions while
retaining the snapshot. Late reads, role/identity changes and concurrent polls
exercise publication fences. Browser recovery and flow suites use real routes to
check a usable shell with a stalled connector, OAuth return and scoped Refresh.

## Browser behavior evidence

| Suite                                    | Assertions                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/browser/operator-matrix.spec.ts`   | Members see their own page on every path, get scoped setup links, and never request maintainer data.                                                                                       |
| `test/browser/operator-overview.spec.ts` | Overview health, counts and map edges; per-caller status and principal-refusal copy without secret fix prompts.                                                                            |
| `test/browser/operator-console.spec.ts`  | Token issue/rotate/revoke confirmations and once-only secret display; member credential fields and OAuth connect/reconnect/disconnect controls.                                            |
| `test/browser/operator-pages.spec.ts`    | Resolved read/write filters, inert schema text, Activity history/grouping, and legacy URL redirects.                                                                                       |
| `test/browser/operator-shell.spec.ts`    | Clerk loader and child-script behavior under CSP, with inline and foreign scripts blocked.                                                                                                 |
| `test/browser/operator-ui.spec.ts`       | Identity changes cancel reads and close popups, OAuth polling stays scoped, token mutations use real routes and distinct revisions, and declared agents show scoped credentials and usage. |

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
Visual comparisons run in their own Playwright project without retries, so a
mismatch fails on its first attempt. When any attempt fails, CI uploads
the HTML report, actual/expected/diff images and traces as `playwright-report`.
Set `OPERATOR_VISUAL_INSPECT=1` to retain local screenshots under ignored
`test-results/` for inspection, without updating committed baselines.

## Real-server flows

`test/browser/operator-flows.spec.ts` uses `listen()` from `src/node.ts` with
loopback TCP servers. It intercepts only Clerk provider traffic with a test
publishable key; server identity uses the existing `fakeClerkAuth` seam. The
OAuth provider validates the code exchange and PKCE. Credential Test calls a
loopback downstream endpoint. Operator APIs, cookie/bearer admission, CSRF,
assets, handoffs, callbacks, and encrypted storage use production code.

The flows use a real SQLite file and cover Clerk sign-in/reload/sign-out,
actual Settings provenance and asset cache validators; OAuth
connect/consent/callback/connected reread/disconnect; and credential
save/test/replace/remove. They close and reopen the app, database and vault
before rereading OAuth and credential state. A rejected SQL replacement leaves
the previous secret usable downstream after restart. Trigger rows read from an
independent SQL connection require one save, one replacement and one removal;
reads and the rejected save commit no credential writes. Actual MCP calls
check that credential edits preserve a reader pool's read access and refusal. Activity renders
successful calls recorded before the SQLite restart without exposing either
credential value. They collect
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
