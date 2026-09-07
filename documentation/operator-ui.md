# Operator UI

The browser surface a human uses to see what a deployment exposes and to manage
the authentication material behind it. It is a small Preact app compiled by the
repository's own esbuild step and inlined into a data-free server shell.

Read [`ethos.md`](../ethos.md) first. Code declares capabilities and access;
the UI displays the current user's effective permissions and manages only
authentication material explicitly permitted by that code. It never edits the
connector set, tool catalog, annotations, OAuth scopes, or permission rules.

## Enable the UI

```ts
import { operatorUi } from "@zackbart/connecta/ui";

createConnecta({
  connectors,
  executor,
  auth,
  ui: operatorUi({ branding: { productName: "Team connections" } }),
});
```

The UI module owns its browser bundle and routes. Omit `ui` to omit those
routes and runtime imports. OAuth callbacks remain in core; authorized
interactive MCP callers can complete consent without the UI. Branding belongs
to `operatorUi` options, with neutral callback branding when no UI is mounted.

## Connections and activity

Connections is the main page. Each connection combines its status, effective
permissions, credential metadata, and permitted OAuth or credential actions.
There is no separate Credentials or Tokens tab. A user may see and invoke a
shared connector without permission to replace the grant everyone uses.
`identity.credentialAdministration` and `identity.personalConnection` select
shared and personal management rights, and both default to none.

Activity appears only when the optional history module has a readable store
and the caller passes `identity.activityAccess` and any additional read gate.
It is a global history, so permission to use one connector does not imply
permission to inspect that history. There is no member roster or policy editor.

The Node and Worker deployment READMEs show how to enable the modules and grant
the intended identities access. The configured bearer in the Node template can
read connection status but never mutate credentials as an interactive human.

## Loading and request lifetime

The server shell contains no connector or credential data. Authenticated
`/ui/data` returns the configured visible connection list without waiting for
provider status or tool discovery. Details load through `GET /ui/connectors/<id>`, independently,
under a bounded request lifetime. Unknown and loading states stay explicit;
a provider failure leaves the other connections usable.

A status read does not start OAuth or create authorization handoffs. Connect is
an explicit authorized POST. Successful save, reconnect, and disconnect actions
show their result without waiting for an unrelated full-catalog reload. Server
mutations still await catalog invalidation before replying, so another request
cannot consume a persisted catalog from before a credential change.

Each details request owns and closes its downstream connector scope. Never
cache a transport, request signal, or awaited promise in the UI module.

## Browser identity and security

Cloudflare Access is ambient browser auth. When the Worker invocation has
`ctx.access`, the shell emits no Clerk loader or browser-readable token.
Same-origin fetch carries the HttpOnly Access cookie, and the server uses the
trusted runtime identity. Sign out navigates to `/cdn-cgi/access/logout`.
Clerk deployments use their configured interactive provider.

Mutation requires exact same-origin `Origin`, an interactive identity,
connector visibility, and the relevant management permission. Personal actions
resolve only to the current principal's partition. Credential reads return
metadata, never saved values or masked fragments. Mutation cannot change any
declared capability. `test/operator-boundary.test.ts` checks that boundary.

The browser store fences responses by identity generation. Switching identity
clears the prior identity's state and discards its outstanding responses.
Components render elements, not HTML strings; links pass the shared URL gate.
Loading, failure, empty, and success states must all provide a useful next
step. A failed mutation preserves form input and does not masquerade as success.

Catalog drift remains counts and a timestamp. A missing observation means
"not observed", not that the downstream catalog is unchanged. The UI does not
expose tool schemas or raw payloads as diagnostics.

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
  Clerk loader order across its version redirect and a real load failure, plus
  credential and OAuth flows end to end, including their failure and
  empty states. Run it with `npm run test:browser`
  (`npm run test:browser:install` once, for Chromium). It is not part of
  `npm run check`.

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
