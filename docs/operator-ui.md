# Operator UI

## Status UI

Connecta serves one lightweight operator application through three canonical,
direct-linkable pages. It has no frontend build step:

| Route | Page | Responsibility |
| --- | --- | --- |
| `GET /` | **Connections** | MCP endpoint, server identity, connector health, downstream OAuth links, and tool counts/lists |
| `GET /credentials` | **Credentials** | masked operator-managed credential state and Add/Replace/Test/Remove actions |
| `GET /activity` | **Activity** | payload-free activity history |
| `GET /ui` | compatibility only | permanent `308` redirect to `/` |

The canonical routes are real entry points: direct navigation, refresh,
bookmarks, and browser Back/Forward all retain the requested page. The
navigation is ordinary links, the current link carries `aria-current="page"`,
and each page has a path-specific title such as
`Credentials — Acme Connecta`. Change token and Sign out remain session actions
in the masthead rather than pages.

All three canonical routes serve the **same open, data-free HTML shell**
(`src/ui.ts`, routed by `src/server.ts`). Choosing a route changes only the
initial page and title. The response contains no connector, credential,
activity, actor, or deployment data; it is safe to serve before authentication.
It receives the same nonce CSP, framing denial, no-referrer policy,
content-type protection, URL gates, escaping, and HTTPS/HSTS behavior on every
canonical path.

The shell uses these existing private routes; `/ui` remains their namespace
even though it is no longer the HTML page:

| Route | Access and result |
| --- | --- |
| `GET /ui/data` | inbound auth, then 403 for a toolkit-restricted identity; returns deployment-wide operator data |
| `GET /ui/activity` | the same auth and toolkit refusal, then optional `activity.readGate`; returns paged activity events |
| `PUT` / `DELETE /ui/credentials/<connectorId>` | eligible Clerk operator, stable user id, unrestricted toolkit binding, and same-origin request |
| `POST /ui/credentials/<connectorId>/test` | the same credential-mutation boundary; runs the shape-selected test hook |

Do not expose these APIs cross-origin or treat their `/ui` prefix as a public
page URL. Credential `OPTIONS` requests return 405 and never opt into wildcard
CORS.

### What each page shows

**Connections (`/`)** keeps the MCP URL and Copy URL action, the configured
server name/version, and the connector ledger. Each connector shows its display
title and stable id, description, status and message, tool count/list, a
credential-liveness verdict when relevant, and a downstream OAuth authorization
link when one is required. The local filter searches connector and tool
names/descriptions. Broken connectors are isolated as `status: "error"` with
`tools: []`; tools are listed only after status is `ok`, because probing a
second OAuth flow could invalidate the authorization URL just returned.
Connections also projects the validated
[toolkit](./toolkits.md#toolkits-scoped-views) config as a read-only ledger:
each view's connectors, explicit tool inclusions/exclusions, currently loaded
effective tool count, and copyable scoped MCP URL. The config-only
`description` remains on the server and is never included. Connector rows name
the toolkits that include them. This is visibility into
`ConnectaConfig.toolkits`, not a second source of truth: the page has no toolkit
mutation controls, and changing a view still means changing deployment config
and redeploying. Connections never contains vault Add/Replace/Test/Remove
controls.

**Credentials (`/credentials`)** renders one focused entry for each connector
that declares an operator-managed credential slot. It shows the declared
label/description, configured state, masked last-four and update metadata,
latest liveness verdict, and an operator-safe error when stored keys no longer
match the declaration. Add/Replace, Test, Remove, confirmations, and named-field
forms keep their existing behavior. A secret value is never returned to or
rendered by the browser. `testable` is true only when the connector implements
the hook selected by its declared credential shape
([storage](./storage-and-credentials.md#operator-managed-connector-credentials)).

**Activity (`/activity`)** preserves the ledger, actor labels, outcome,
duration, attempts, pagination, refresh, and local filtering. It always states
that arguments and results are never stored. The navigation link appears only
when `activityEnabled` is true; opening `/activity` directly when it is false
explains that activity history is not configured instead of redirecting or
showing a blank page. See [activity history](#activity-history).

### Capabilities and authentication states

`GET /ui/data` returns:

```ts
{
  serverInfo,
  connectors,
  toolkits: [{
    name,
    connectors,
    includeTools,
    excludeTools,
    toolCount
  }],
  activityEnabled,
  credentialManagement:
    | "available"
    | "requires_clerk"
    | "vault_not_configured"
    | "no_slots"
}
```

`connectors` contains status and tool data for every admitted operator.
`toolkits` is the serializable, read-only projection of the already validated
deployment config; `toolCount` counts the tools currently loaded through healthy
connectors that the toolkit would expose. An unavailable connector therefore
still appears in `connectors` but contributes no loaded tools. Because toolkit
names and membership describe the whole deployment, the existing
toolkit-restricted-identity refusal runs before this payload is built. The
operator-only `description` field is deliberately absent.
`credential` metadata appears only for a connector with a declared slot and
only when the request belongs to an eligible Clerk operator with a vault. The
static bearer may read connector health but never credential metadata.
`authorizationUrl` is included only when it is an absolute `http(s)` URL, so a
downstream connector cannot turn the authorization action into a
`javascript:` or `data:` navigation.

The credential object carries `{ label, description?, placeholder?, fields?,
configured, removable?, lastFour?, updatedAt?, testable, error?, notice? }` —
masked metadata only, never a value. `testable` is true only when the connector
implements the test hook its declared credential shape selects
([storage](./storage-and-credentials.md#storage)), so Credentials never offers a
Test button whose click cannot succeed. `error` means the credential cannot be
used (unreadable, or missing a field the declaration now names); `notice` is the
non-blocking counterpart — today, that the vault still holds fields the
connector has stopped declaring, which is worth saying because the field list
renders declared fields only.

The credential capability is an auth-gated, non-secret explanation for page
availability:

| Value | Navigation and direct `/credentials` behavior |
| --- | --- |
| `available` | show Credentials and its controls |
| `requires_clerk` | hide the link; explain that browser credential management requires an eligible Clerk operator |
| `vault_not_configured` | hide the link; explain that `credentials.encryptionKey` is not configured |
| `no_slots` | hide the link; explain that no connector declares an operator-managed credential slot |

In ordinary `createConnecta` use, a declared credential slot without
`credentials.encryptionKey` fails construction, so
`vault_not_configured` mainly keeps the lower-level server boundary explicit.
A Clerk identity denied by its provider gate, or any toolkit-restricted
identity, receives the existing 401/403 operator-access state rather than
capabilities it is not allowed to read.

When `clerkAuth(...)` is configured, the shell loads ClerkJS from that
instance's Frontend API, sends signed-out users through Clerk's hosted sign-in,
and retrieves the active session's short-lived token. Authentication returns to
the page originally requested. Clerk session tokens remain in Clerk's session
state and are never copied into `localStorage`. A bearer-only deployment keeps
the manual token prompt; its token is stored locally and sent only in the
`Authorization` header to the private operator APIs. Changing the token and
signing out retain the current canonical route while immediately clearing
loaded connector, credential, and activity state. Responses from an earlier
session generation are discarded, so an in-flight request cannot repopulate
the page after the identity changes.

### Branding

Nothing about the operator is baked into the package: every deployment-facing
label and image on the three canonical operator pages and the OAuth result pages comes from
`ConnectaConfig.branding`, and each field falls back to a neutral Connecta
default when omitted.

```ts
createConnecta({
  connectors,
  branding: {
    productName: "Acme MCP",              // default "Connecta"
    productUrl: "https://acme.example",   // makes the product label a link
    ownerName: "Acme Inc",                // shown beside the product label
    ownerUrl: "https://acme.example/about",
    description: "Tools Acme exposes to agents.",  // operator-page intro + meta description
    pageTitle: "Acme Tools",              // default "<productName> — <ownerName>"
    themeColor: "#101010",                // default "#ffffff"
    favicon: {
      svg: "<svg …>",                     // served at /favicon.svg
      ico: acmeIcoBytes,                  // Uint8Array, served at /favicon.ico
      href: "https://cdn.acme.example/icon.svg", // or link an icon you host
    },
  },
});
```

The top-left corner reads `<ownerName> <productName>` when an owner is set, and
just `<productName>` otherwise; each half becomes a link when its matching URL
is configured. `favicon.svg` and `favicon.ico` are independent — override one
and the other keeps connecta's default mark. `favicon.href` only changes what
the page's `<link rel="icon">` points at; the `/favicon.*` routes keep serving
whatever `svg`/`ico` provide.

Every branding value that becomes an `href` is scheme-gated before it reaches
the page. `productUrl` and `ownerUrl` must be absolute `http(s)` URLs — anything
else (a `javascript:` or `data:` payload) is dropped and the label renders as
plain text. `favicon.href` accepts an absolute `http(s)` URL **or** a
root-relative path such as the default `/favicon.svg`. "Root-relative" means
exactly one leading `/` followed by neither `/` nor `\`: a document-relative
path is rejected because the canonical operator routes and
`/oauth/callback/<id>` sit at different
depths, and anything carrying an authority (`//host`, `/\host`, or a
tab-obfuscated variant) is rejected because it points at an origin this server
does not control. A rejected value falls back to the default rather than failing
the page, and construction logs one warning naming each field that was dropped.
Malformed branding never fails construction: a non-string where a string belongs
is read as unset, so it takes the same fallback-and-warn path.

**The completed invariant: every operator-config value that reaches the browser
in a URL position — a URL-valued attribute or a navigation target — is
validated, and every one served as an active content type is neutralized.** Two
positions sit outside the branding hrefs and are worth naming, because both are
closed the same way.

- **`favicon.svg` bodies** are served at `/favicon.svg` as `image/svg+xml` — an
  *active* content type, so a `<script>` inside an operator-supplied SVG would
  run **on the deployment origin** the moment anyone navigated straight to that
  URL. The route therefore answers with `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  sandbox`: `sandbox` puts the document in an opaque origin with scripting off,
  `default-src 'none'` denies script, network, and framing, and inline **styles**
  stay allowed because the default mark uses one to follow the OS colour scheme
  (CSS cannot script). The body is not inspected or rewritten, so every valid
  static SVG — the built-in mark included — is served byte-identically.
  `favicon.ico` bodies are inert bytes rather than active content, but they are
  deliberately in scope of the same headers, so the rule is "every favicon route
  is neutralized" rather than "whichever route got attention".
- **The three `uiAuth` URLs** — `frontendApiUrl`, the origin the operator shell
  fetches its
  browser sign-in loader from, and `signInUrl`/`signUpUrl`, the hosted Account
  Portal addresses handed to `Clerk.load` — must each be an absolute **`https:`**
  URL. One gate, one strictness, stricter than the branding ones: no `http:`, no
  loopback carve-out, no relative form. `frontendApiUrl` is never typed by hand
  (`clerkAuth` derives it from the publishable key, and Clerk's Frontend API is
  always https), and while `signInUrl`/`signUpUrl` *are* operator-typed, what
  belongs in them is an Account Portal address (`https://accounts.<domain>` or
  `https://<slug>.accounts.dev`) — https as well, so a looser gate would buy
  nothing: `http:` would carry a sign-in over cleartext, and a path relative to
  this origin is meaningless because connecta hosts no sign-in page of its own.
  A rejected value never reaches the page in any position — not the
  `<script src>`, not the inline `AUTH` object — and rendering falls back rather
  than failing: without `frontendApiUrl` the shell renders no loader and reports that
  Clerk could not load; without `signInUrl`/`signUpUrl` it signs operators in
  through Clerk's own defaults. Construction logs one warning naming the provider
  and each dropped field — the same fallback-and-warn shape the branding gates
  use. `signInUrl`/`signUpUrl` are optional, so a field the operator never set —
  absent, or blank, which reads the same way a branding URL's blank does — is not
  a drop and is never warned about; a value that *was* supplied and then rejected
  always is, non-strings included. Only the provider the operator shell actually
  renders is checked, since
  a later provider's `uiAuth` never reaches the page.

Gating the two navigation targets closes the invariant rather than a live vector:
The operator shell's nonce CSP already blocks a `javascript:` navigation in browsers that
honour it, and only the `'unsafe-inline'` legacy fallback would not. The point is
that the sentence above now needs no exception read alongside it.

---

## Activity history

Connecta can record **which** resolved downstream tool was invoked, by whom, and
how it went — without storing arguments, results, generated code, search text,
or raw error messages. That exclusion is structural, not a redaction pass: the
event type has nowhere to put a payload.

It is off unless a deployment supplies a store. The seam is vendor-neutral, so
D1, Postgres, Analytics Engine, or an array in memory all work:

```ts
import type { ActivityStore, ToolCallActivityEvent } from "@zackbart/connecta";

const events: ToolCallActivityEvent[] = [];

const activity: ActivityStore = {
  record(event) {                       // write side — required
    events.push(event);
  },
  async list({ cursor, limit }) {       // read side — optional
    return { events: events.slice(-limit).reverse() };
  },
};

createConnecta({
  connectors,
  activity: { store: activity, deploymentId: "production" },
});
```

### The event

```ts
interface ToolCallActivityEvent {
  schemaVersion: 1;
  id: string;                 // uuid
  occurredAt: string;         // ISO 8601
  requestId: string;          // shared by every call in one inbound request
  actor: { kind: string; id?: string };
  connectorId: string;
  toolName: string;
  address: string;            // `${connectorId}.${toolName}`
  source: "call_tool" | "call_destructive_tool" | "batch_call" | "execute_code";
  outcome: "success" | "error" | "timeout";
  durationMs: number;
  attempts: number;
  errorCode?: string;         // the ConnectorCallError code, never its message
  serverName: string;
  serverVersion: string;
  deploymentId?: string;      // from activity.deploymentId
  toolkitId?: string;         // the ?toolkit= this connection selected (toolkits.md)
}
```

One final event per **resolved connector call** — retries collapse into a single
event with an `attempts` count, and a batch of five produces five events sharing
one `requestId`. `source` is the meta-tool the call actually entered through, so
an approved destructive call is recorded as `call_destructive_tool` rather than
being folded into the ordinary path.

### Actor identity

`actor.id` is deliberately optional: a shared secret cannot honestly identify a
person. Clerk-authenticated calls carry the Clerk user ID
(`{ kind: "clerk", id: "user_…" }`); static-bearer calls are labeled
`{ kind: "bearer" }` with no id unless `bearerToken(secret, { subjectId })`
assigns that credential a stable subject ([inbound auth](./auth.md#inbound-auth)). An open deployment (no `auth`
configured) records `{ kind: "anonymous" }`.

### Writes are best-effort

Activity storage can never change a tool result. A sink that throws or rejects
is logged and swallowed. Synchronous sinks complete inline; async ones are
attached to `ctx.waitUntil` when the runtime provides it — which is why the
Worker example passes `ctx` through to `connecta.fetch(request, env, ctx)`.
Without it, a Worker may cancel the pending write when the response returns.

### Reading it

Implementing `list` enables both private `GET /ui/activity` and the Activity
page at `/activity`. The API route sits behind the same auth gate as `/mcp`, refuses an identity
bound to a toolkit with 403 (the log is deployment-wide —
[toolkits](./toolkits.md#toolkits-scoped-views)), and then applies the optional
`activity.readGate(actor)` for narrowing reads further (an admin allowlist, say):

```ts
createConnecta({
  connectors,
  activity: {
    store: activity,
    readGate: (actor) => actor.kind === "clerk" && admins.has(actor.id!),
  },
});
```

Query params: `?limit=` (1–100, default 50) and `?cursor=` (opaque, ≤500
chars). The response is `{ events, nextCursor? }`. A reader that cannot decode a
cursor throws the exported `InvalidActivityCursorError` and the route answers
400; any other read failure is logged and answered 503, and a deployment with no
`list` answers 404.

[`examples/worker/src/d1-activity.ts`](../examples/worker/src/d1-activity.ts) is
a complete deployment-owned implementation over Cloudflare D1 — keyset paging on
`(occurred_at_ms, id)` plus a batched `pruneActivity(db, retentionDays)`
retention pass. It lives in the example, not the package: storage backends are
deployment-owned, exactly like `KVStorage`.
