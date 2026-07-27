# Operator UI

## Status UI

A minimal, read-only dashboard for operators with no build step. Two routes
(`src/ui.ts`, served by `src/server.ts`):

- **`GET /ui`** — a single HTML shell. It is served **open**, with no auth gate,
  because it carries **no data**. When the optional `clerkAuth(...)` adapter is
  configured, the shell
  loads ClerkJS from that instance's Frontend API, redirects signed-out users to
  Clerk's hosted sign-in, and retrieves the active session's short-lived token.
  A bearer-only deployment retains the manual `localStorage` token prompt.
- **`GET /ui/data`** — the JSON the page fetches, behind the **same auth gate as
  `/mcp`** (static bearer, Clerk OAuth token, or Clerk session token admit), and
  refused with 403 for an identity bound to a toolkit
  ([toolkits](./toolkits.md#toolkits-scoped-views)) — this payload is deployment-wide.
  Shape: `{ serverInfo, activityEnabled,
  connectors: [{ id, title?, description?, status, message?, authorizationUrl?,
  toolCount, tools: [{ name, address, description? }], credentialCheck?,
  credential? }] }`. Broken
  connectors are isolated — they surface `status: "error"` with `tools: []`
  rather than failing the whole payload. Tools are listed only for a connector
  whose `status` is `ok`: probing `listTools` on an unauthorized remote
  connector would start a second OAuth flow and invalidate the URL the operator
  was just handed.
- **`/ui/credentials/<connectorId>[/test]`** — the credential vault API
  ([storage](./storage-and-credentials.md#storage)), driven by the card's Add / Replace / Test / Remove controls.
- **`GET /ui/activity`** — paged activity events for the Activity tab
  ([activity history](#activity-history)).

`authorizationUrl` is forwarded only when it is an absolute `http(s)` URL —
a downstream connector cannot turn the operator's one-click authorization link
into a `javascript:` or `data:` payload. `credential` is present only for a
connector that declares one **and** only for a Clerk-authenticated operator; the
static bearer may read connector health but never credential metadata. It carries `{ label, description?, placeholder?,
fields?, configured, removable?, lastFour?, updatedAt?, testable, error?,
notice? }` — masked metadata only, never a value. `testable` is true only when
the connector implements the test hook its declared credential shape selects
([storage](./storage-and-credentials.md#storage)), so the card never offers a
Test button whose click cannot succeed. `error` means the credential cannot be
used (unreadable, or drifted from the current declaration); `notice` is the
non-blocking counterpart — today, that the vault still holds fields the
connector has stopped declaring
([storage](./storage-and-credentials.md#storage)), which is worth saying because
the field list renders declared fields only.

The page renders the instance name/version, one card per connector (display title
when configured, stable id, description, a status dot — green `ok` / amber `auth_required` / red `error`,
tool count, any status message, a clickable authorization link when
`auth_required`, and — for a connector holding a stored credential — a
"Credential check" line with the last liveness verdict, when it was taken, and
why ([credential health](./storage-and-credentials.md#credential-health-proactive-liveness-checks))), a collapsible
`<details>` list of each connector's tools
(address in a `<code>` tag + description), and a client-side text filter over
tool names/descriptions. A connector that declares a credential also renders
Add / Replace / Test / Remove controls in its card for a Clerk operator ([storage](./storage-and-credentials.md#storage)),
and an Activity tab appears when the deployment configures a readable activity
store ([activity history](#activity-history)). The current token is sent only as the
`Authorization: Bearer` header on `/ui/data`. Clerk session tokens are kept in
Clerk's session state and refreshed by ClerkJS; they are never copied into
`localStorage`.

### Branding

Nothing about the operator is baked into the package: every deployment-facing
label and image on `/ui` and the OAuth result pages comes from
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
    description: "Tools Acme exposes to agents.",  // dashboard intro + meta description
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
path is rejected because `/ui` and `/oauth/callback/<id>` sit at different
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
- **The three `uiAuth` URLs** — `frontendApiUrl`, the origin `/ui` fetches its
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
  than failing: without `frontendApiUrl` `/ui` renders no loader and reports that
  Clerk could not load; without `signInUrl`/`signUpUrl` it signs operators in
  through Clerk's own defaults. Construction logs one warning naming the provider
  and each dropped field — the same fallback-and-warn shape the branding gates
  use. `signInUrl`/`signUpUrl` are optional, so a field the operator never set —
  absent, or blank, which reads the same way a branding URL's blank does — is not
  a drop and is never warned about; a value that *was* supplied and then rejected
  always is, non-strings included. Only the provider `/ui` actually renders is checked, since
  a later provider's `uiAuth` never reaches the page.

Gating the two navigation targets closes the invariant rather than a live vector:
`/ui`'s nonce CSP already blocks a `javascript:` navigation in browsers that
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

Implementing `list` enables both `GET /ui/activity` and the Activity tab in
`/ui`. The route sits behind the same auth gate as `/mcp`, refuses an identity
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
