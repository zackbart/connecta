# Operator UI

The browser surface a human uses to see what a deployment exposes and to manage
the authentication material behind it. It is a small Preact app compiled by the
repository's own esbuild step and inlined into a data-free server shell.

Read [`ethos.md`](../ethos.md) first. The boundary this subsystem lives inside
is the operator row in its decisions table: **operator routes may manage
authentication material for capabilities declared in deployment configuration,
and may not change the connector set, the tool catalog or annotations, requested
OAuth scopes, admission policy, authorization rules, or caller tool scope.**
`test/operator-boundary.test.ts` proves it after every mutation route.

Both deployment shapes ship the whole feature set behind it, because pages for
things a deployment cannot do are worse than no pages
([#345](https://github.com/zackbart/connecta/issues/345)). The
[Node template](../templates/node/) carries sign-in, vault, tokens, and
activity as commented blocks in `src/index.ts` — plus a deployment-owned
`src/file-activity.ts` that is compiled rather than commented — and the
[Worker example](../examples/worker/) wires the first three and comments the
fourth, which needs a D1 database. Each README walks through its own
enablement.

## The shape

| Piece | What it owns |
| --- | --- |
| `src/ui.ts` | The served HTML: branding, gated URLs, CSP-nonced script tags, the four page titles, and `buildUiData` — the `/ui/data` payload. |
| `src/operator-ui/model.ts` | The transport types both sides share, plus connector filtering. |
| `src/operator-ui/view.ts` | The app's state shape and every pure rule over it. No DOM, so `test/ui.test.ts` calls it directly. |
| `src/operator-ui/app/` | The browser app: `store.ts` (state and every request), `main.tsx` (shell, gate, router), and one component file per page. |
| `src/operator-ui/browser.css` | One stylesheet, inlined into the shell. |
| `src/operator-ui/generated.ts` | The build output: the bundle and the stylesheet as two exported strings. |

The server renders a mount point, not a page. Branding, the Clerk loader, and
every operator-configured URL stay in `src/ui.ts`, where they are gated before
they can become an attribute; the bundle renders everything that has a state.
Two roots share one store: `#operatorNav` and `#operatorContent`.

## Rules that are not obvious

- **No operator data in the shell.** Every page serves the same markup. Connector,
  credential, token, and activity data arrives only through the authenticated
  `/ui/*` APIs, and the shell is identical whether or not a caller is signed in.
- **One store, one identity.** `store.ts` is the only file that touches `fetch`,
  `localStorage`, or Clerk. Every request carries the current session's token,
  and every response is dropped unless the identity that asked for it is still
  the one on screen. `resetIdentity` replaces all identity-scoped state at once
  and bumps a generation that work already in flight compares itself against.
- **Escaping is structural.** Components return elements; nothing builds HTML
  from strings. A value that could be a URL passes `safeHttpHref` before it may
  become an `href`, mirroring the server-side gate in `src/ui.ts`.
- **Secrets are shown once.** A created access token lives in state only, and
  leaving the page — by navigation or by `pagehide`, which covers the
  back-forward cache — unmounts it.
- **Every flow has four states.** Loading, error, empty, and success, with no
  dead end: a failed save keeps the form and its typed value, a failed list
  offers a retry, and an empty collection says what would fill it. A mutation
  that fails is still a resolved promise — `mutate` lands the failure in state
  rather than rejecting — so a caller that clears a form must clear it on a
  confirmed success, never on resolution. `createAccessToken` returns that
  answer as a boolean for exactly this reason.
- **Drift is counts, and absence is its own answer.** The connector card reads
  `catalogDrift` ([#343](https://github.com/zackbart/connecta/issues/343)) as
  four category counts and a timestamp. There is no drill-down, because a tool
  name or a schema here would make an operator page the payload surface the
  drift model refuses to be. A connector with no report renders as *not
  observed*, never as clean: this runtime having seen no refresh is not the
  same claim as a refresh having found nothing.

## Working on it

Source changes require a rebuild: `npm run build:operator-ui` regenerates
`src/operator-ui/generated.ts`, and `npm run check:operator-ui` fails when the
committed artifact is stale. Both run through the same esbuild call, so the
check compares byte for byte.

Tests split along the DOM line, because `test/ui.test.ts` runs in workerd as
well as Node and there is no DOM in either:

- `test/ui.test.ts` — the server shell, the `/ui/*` routes, and the app's pure
  state rules from `view.ts`.
- `test/operator-store.test.ts` — `store.ts` itself, against a fake browser: the
  Clerk listener, `gate()`, the generation fence, and the request path. The
  rules in `view.ts` prove what an identity change *erases*; this suite proves
  something calls them when the identity actually changes. It typechecks in the
  DOM-lib program (`tsconfig.operator-ui.json`) because it imports the store.
- `test/browser/operator-ui.spec.ts` — the wiring, in a real browser:
  credential, token, and OAuth flows end to end, including their failure and
  empty states. Run it with `npm run test:browser` (`npm run test:browser:install`
  once, for Chromium). It is not part of `npm run check`.

## Why the bundle is committed

`src/operator-ui/generated.ts` is generated and checked in. The alternatives
were considered and lost:

- **Build during `prepack`.** The artifact would still have to exist before
  `tsc` runs, so every contributor and every CI job would need the browser build
  before typechecking — and a published tarball would carry a build output
  nobody could diff against its source.
- **Exclude it from the tarball.** `dist/operator-ui/generated.js` is imported
  by `src/ui.ts`; a deployment that installs the package needs it. Excluding it
  ships a broken import.

Committing keeps one prebuilt string that Node and Workers read unchanged, with
no browser toolchain at install, pack, or deploy time. The cost is a large
generated diff on UI changes, paid deliberately: the bundle is not minified, so
what actually reaches an operator's page can be read in review, and
`check:operator-ui` is what keeps it honest.

Preact is a `devDependency` for the same reason. It is inlined into the bundle
at build time and never appears in a deployment's dependency tree — the package
has no runtime dependency on it, and `test/package-surface.test.ts` keeps the
published surface that way.
