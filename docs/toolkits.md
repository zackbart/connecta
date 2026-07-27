# Toolkits

## Toolkits (scoped views)

A connecta deployment belongs to one **org**. A **toolkit** is the scoped view
over that deployment's registry that one **group of team members** inside the
org gets: a `support` toolkit that sees Zendesk and Notion, an `exec` toolkit
that also sees Gmail. Before toolkits, the only way to give two teams different
tool subsets was to run two deployments.

Two halves, and both are needed for the boundary to protect rather than merely
organize: a toolkit **declares** a view, and a **binding** on an auth adapter
says which credential may select it.

A toolkit is **config as code**, like everything else — and each one is **bound
to the credential** of the team it belongs to:

```ts
createConnecta({
  connectors: [zendesk, notion, gmail],
  auth: [
    // Two teams, two credentials, two views. The support token can open
    // ?toolkit=support and nothing else.
    bearerToken(env.SUPPORT_TOKEN, {
      subjectId: "support-team",
      toolkits: ["support", "triage"],
    }),
    bearerToken(env.EXEC_TOKEN, {
      subjectId: "exec-team",
      toolkits: ["exec"],
    }),
    // The operator credential: every view plus the deployment-wide surfaces,
    // declared rather than left unbound so the exemption is deliberate.
    bearerToken(env.OPS_TOKEN, {
      subjectId: "ops",
      toolkits: ["support", "exec", "triage"],
      unscoped: true,
    }),
  ],
  toolkits: {
    support: { connectors: ["zendesk", "notion"] },
    exec: {
      connectors: ["zendesk", "notion", "gmail"],
      // Finer grain: full tool addresses, not just connector ids.
      excludeTools: ["gmail.send_message"],
    },
    triage: {
      connectors: ["zendesk"],
      includeTools: ["zendesk.search_tickets", "zendesk.get_ticket"],
    },
  },
});
```

A client selects one at connect time with a query parameter on the MCP URL:

```
https://connecta.example.com/mcp?toolkit=support
```

Two independent questions, answered in this order on every request: **who is
this** (the auth gate, [inbound auth](./auth.md#inbound-auth)), then **may this identity have that view** (the
binding), then **what does that view contain** (`ScopedRegistry`).

### Selecting a scope

For an **unbound** identity — no `toolkits` on the adapter that admitted it —
selection is self-service, exactly as it was before bindings existed:

| `?toolkit=` | Result |
| --- | --- |
| absent | The **full registry** — byte-identical to a deployment that declares no toolkits. |
| a declared name | A scoped session over that toolkit. |
| anything else (including `?toolkit=` with an empty value) | **404** with a JSON-RPC error. Never a silent fallback to everything. |

The unknown-toolkit error does not enumerate the configured toolkits, and it is
returned **after** the auth gate — an unauthenticated caller gets the same 401
for a real toolkit name as for an invented one, so `/mcp` is not a directory of
your teams.

For a **bound** identity, the binding is checked first and refusal is a flat
**403**:

| `?toolkit=` | Result |
| --- | --- |
| a name in the binding, declared by the deployment | A scoped session over that toolkit. |
| absent, with `unscoped: true` | The full registry. |
| absent, without `unscoped` | **403** — it must name a view it is bound to. |
| a declared name outside the binding | **403**, identical to the line below. |
| an undeclared or malformed name | **403**, identical to the line above. |

Those three 403s are **byte-identical**, status and body: a team credential must
not become a directory of the org's other teams, so "you may not have this" and
"that does not exist" are indistinguishable. The body names no toolkit at all.
The refusal happens before any `ScopedRegistry` is constructed and before the MCP
transport runs, so a refused request never touches a connector.

**A misspelled `?toolkit=` looks like a connection failure — check the server
log.** This is the predictable first-week failure mode of a hand-copied client
config, and clients built on the MCP SDK treat a 404 on the transport endpoint
as a transport-level error and discard the body, so the response's careful
"Unknown toolkit …" message never reaches the person reading their client. Every
rejected selection therefore also emits a `logger.warn`, which is the channel
that actually surfaces:

```
[connecta] rejected an /mcp connection asking for unknown toolkit "suport" with
404. Configured toolkits: support, exec. The client sees a transport-level
failure and never the reason, so check the ?toolkit= value in its MCP endpoint
URL.
```

The log line may name the configured toolkits because it is an operator surface;
the response still may not. The rejected value is echoed into the log bounded to
64 characters and escaped (JSON escaping plus U+2028/U+2029), so a caller cannot
flood the log or forge a line in it, and the line is written only after the auth
gate — so on a deployment with `auth` configured, a caller the gate rejects
cannot make it log anything. In open mode the gate admits everyone, so any caller
can, exactly as any caller can already reach every connector there ([inbound auth](./auth.md#inbound-auth)). A
deployment that declares no toolkits at all logs that instead of a list.

A **binding** refusal is logged the same way, and this is where the three cases
the response deliberately conflates are told apart — it is the operator surface,
so it names the identity, the reason, and the binding:

```
[connecta] refused an /mcp connection from bearer "support-team" with 403: it
asked for toolkit "exec", which its toolkit binding does not include. Bound
toolkits: support. …

[connecta] refused an unscoped /mcp connection from bearer "support-team" with
403: its toolkit binding does not allow the full registry. Bound toolkits:
support. …
```

`/mcp` is stateless ([architecture](./architecture.md#architecture)), so the scope is resolved from the URL of **every**
request rather than pinned at an `initialize` handshake. There is no scope
state on the server to go stale, and a client cannot widen its view mid-session
— each request carries its own `?toolkit=` and gets exactly that scope.

### What a toolkit selects

- **`connectors`** (required, at least one) — the connector ids this toolkit may
  see.
- **`includeTools`** (optional) — full tool addresses. Naming *any* address of a
  connector narrows that connector to exactly the addresses named. Connectors
  with no entry keep their whole tool list.
- **`excludeTools`** (optional) — tool addresses to hide, applied after
  `includeTools`.
- **`description`** (optional) — an operator note. It is never sent to clients.

### The boundary holds across the whole meta-tool surface

Scoping is not a display filter. Inside a toolkit-scoped session every
meta-tool behaves as if out-of-scope connectors and tools **do not exist**:

- `list_connectors` lists only in-scope connectors, with tool counts that
  reflect the scoped catalog.
- `search_tools` searches only in-scope catalogs; a `connector` filter naming an
  out-of-scope connector returns the same empty page an unknown id returns.
- `describe_tools`, `call_tool`, `call_destructive_tool`, and `batch_call` fail
  out-of-scope addresses **identically to nonexistent ones** — same error class,
  same message: an out-of-scope *connector* yields `Unknown address "<a>"`
  (`unknown_address`), an out-of-scope *tool* on an in-scope connector yields
  `Unknown tool "<t>" on connector "<c>"` (`unknown_tool`), which is exactly
  what a misspelled tool name already produced. There is no distinguishable
  "exists but hidden" response.
- `authorize_connector` reports `Unknown connector "<id>"`, the same as for an
  id that was never configured.
- `skills` lists only in-scope connector guides, and
  `skills({ name: "connector:<id>" })` for an out-of-scope connector returns the
  same error as for an unknown connector.
- `execute_code` builds sandbox globals only for in-scope connectors, and
  `connecta.call` / `connecta.batch` / `connecta.search` / `connecta.describe`
  raise the same unknown-address and unknown-tool errors as above.
- `get_result` pages only results stashed **by that toolkit**. A result id from
  another scope reads back as `Unknown or expired result id "<id>"` — a scoped
  session cannot page out a result it could not have produced.

**One enforcement point.** All of that lives in `ScopedRegistry`
(`src/registry.ts`): a filtered *view* of the one long-lived `Registry`.
`resolveToolkitScope` builds it in the fetch handler — after the auth gate, on
every request — and `serveMcp` then registers the meta-tools against whatever
view it was handed. Every meta-tool is typed
against `RegistryView`, so a meta-tool cannot reach past the boundary — and a
new one inherits it without writing a check. Reviewing the scope means reading
one class, not nine handlers.

Binding has its own single point, one step earlier in the same function: whether
a `ScopedRegistry` is built at all, and for which toolkit, is decided from the
caller's `ToolkitBinding` before any view exists. The two never overlap — the
binding cannot narrow a view, and a view cannot admit an identity.

### Decisions worth knowing

- **Tool descriptions follow the scope.** Meta-tools are registered per
  connection against that connection's view, so the conditional
  "per-connector guides" sentences ([connectors](./connectors.md#connectors)) — in the `skills`, `search_tools`, and
  `describe_tools` descriptions and in the built-in `usage` skill — reflect the
  **scoped** connector set. A scoped session whose connectors carry no guides
  sees the base text and never learns from a description that guides exist out
  of scope.
- **Operator surfaces are deliberately unscoped — and private data is closed to
  bound identities.** The canonical HTML routes (`/`, `/credentials`,
  `/activity`), `/ui/data`, `/ui/activity`, `/health`,
  `/oauth/callback/<id>`, the credential API, and connector-owned
  `handleRequest` routes ignore `?toolkit=` entirely. The three HTML routes are
  open, shared, **data-free shells**; loading one reveals no connector,
  credential, activity, actor, or deployment data. Everything displayed comes
  from a private operator API with its own gate
  ([inbound auth](./auth.md#inbound-auth), [storage](./storage-and-credentials.md#storage), [status UI](./operator-ui.md#status-ui)). Because their payloads are deployment-wide, the three that read
  or write deployment state behind the auth gate — `/ui/data`, `/ui/activity`,
  and the credential API — **refuse a toolkit-bound identity with 403**. A
  restricted credential cannot answer with connector health for the whole org
  through the back door, and cannot overwrite a credential every toolkit shares.
  A binding that carries `unscoped: true` is not restricted and keeps them, which
  is what an operator credential should look like. A bound identity may receive
  the same inert HTML shell as anyone else, but its data request is still
  refused. `/health` remains a public
  count with no names. The OAuth callback must also stay open so a downstream
  authorization server can redirect a browser to it, and it is not meant to
  answer "does this id exist": an unknown/non-OAuth id, a real connector with
  missing or mismatched state, one with no verifier, and one whose verifier
  throws all produce byte-identical failure responses, each paying the same
  generation read followed by an `oauth:state` read so the answer does not
  arrive measurably sooner for an id that names nothing. That is equal cost,
  not constant time — see
  [downstream OAuth](./connectors.md#downstream-oauth) for what remains
  distinguishable. Only a callback whose verifier accepts the valid one-shot
  state can reveal a connector by succeeding; the operator log, not the public
  failure page, preserves a real connector's precise state-failure diagnosis.
- **The operator can inspect config, never mutate it.** The Connections page
  renders a safe projection of the validated toolkit definitions returned by
  `/ui/data`, including connector membership, tool filters, and scoped MCP URLs.
  The config-only `description` is still never sent to clients. The page does
  not create, edit, delete, or persist a toolkit; `ConnectaConfig.toolkits`
  remains the only source of truth. The data route is deployment-wide and keeps
  the restricted identity refusal above, so the read-only view cannot become a
  directory of sibling teams.
- **Scoping filters views, never state.** The tool cache and the persisted
  catalog ([connectors](./connectors.md#connectors)) are shared and stay whole: a scoped read delegates to the
  registry and filters the array it gets back. Two toolkits over the same
  connector share one cached catalog and one downstream connection budget;
  neither can poison the other's view.
- **Result caps are a property of the connector, not of the view.** The
  per-connector → `calls.maxResultBytes` → default chain
  ([connectors](./connectors.md#the-connector-interface)) resolves identically in every scope, and
  `get_result`'s default page size stays on the deployment-wide value
  everywhere. A toolkit narrows *which* stashed results a session may page,
  never how large a page or an inline result is.
- **Connector health details are per view.** `list_connectors` returns recent
  real-call observations, and a failure's `lastError` is a downstream string
  that routinely names the tool that failed. Each toolkit therefore accumulates
  its **own** observations, and the returned details — `lastError`,
  `consecutiveFailures`, timings, and the `error` state derived from them —
  come only from the calls that toolkit made. A sibling toolkit's failure never
  shows up as this toolkit's connector health, and never names a tool out of
  scope. Every call is *also* recorded in a deployment-wide log, which the
  unscoped `list_connectors` reads so an operator sees the whole deployment.
  (Two things are deliberately not isolated, because they are facts about the
  connector rather than about a team's traffic: the `ok` vs. `unknown`
  classification leans on whether *any* view has ever had a successful call —
  a bare boolean, no details — and `toolCount` reads the shared catalog cache
  below, so a scoped view can tell that some scope warmed a remote catalog.)
- **`authorize_connector` stays deployment-wide.** Downstream OAuth state
  belongs to the connector, not to a view, so an in-scope
  `authorize_connector({ force: true })` re-consents that connector for *every*
  toolkit that can see it. This is not new — before toolkits, any authenticated
  client could do it to any connector — but a toolkit narrows *which* connectors
  a session can do it to, not the blast radius on the ones it can.
- **Operator OAuth changes stay deployment-wide.** The Connections page's
  Disconnect/Reconnect actions are refused to toolkit-restricted identities,
  just like vault mutation: replacing a connector's grant affects every view
  that includes it.
- **Activity records normally.** Calls through a toolkit produce the same events
  as unscoped calls, plus `toolkitId` on the event ([activity history](./operator-ui.md#activity-history)) so an operator can see
  which team's view a call came through.

### Binding a toolkit to an identity

A toolkit on its own scopes **visibility**. A **binding** is what makes it also a
membership boundary: which credential may select which view. It lives on the auth
adapter that mints the identity, next to the secret it applies to, rather than in
a separate table keyed by an id you could typo — a typo in such a key would
silently mean *unbound*, which fails open.

```ts
bearerToken(env.SUPPORT_TOKEN, {
  subjectId: "support-team",
  toolkits: ["support", "triage"], // the only views this token may open
  // unscoped: true,               // ...and also the full registry
});
```

The same two options exist on `clerkAuth` ([inbound auth](./auth.md#inbound-auth)), where they bind every user that
provider admits; one `clerkAuth` per team, each with its own admission rule
(`allowedDomains` and/or `gate`), splits users by team. Admission and binding
answer different questions — who gets into the org, versus what they see once
they are in. Both adapters build the same `ToolkitBinding`, which is the only
shape the server enforces:

```ts
interface ToolkitBinding {
  readonly toolkits: readonly string[]; // names this identity may select
  readonly unscoped?: boolean;          // may also connect with no ?toolkit=
}
```

**It is a mapping, not a policy engine** — deliberately. One identity → the
toolkits it may open. No roles, no hierarchies, no expressions, no per-request
conditions. That is the whole feature; anything more belongs outside connecta.

Semantics:

- **Unbound is unchanged.** An identity whose adapter declares no `toolkits` gets
  exactly the pre-binding behavior: any declared toolkit, the full registry, and
  a 404 for an unknown name. Bindings are per *identity*, not per deployment, so
  a legacy token beside two bound ones keeps working exactly as it did.
- **Bound means bound.** `unscoped` defaults to false: binding a credential to
  the `support` view also stops it from connecting with no `?toolkit=` and
  reading the whole registry (including the deployment-wide connector health
  `list_connectors` returns). Pass `unscoped: true` for a credential that should
  keep both — an operator's, typically.
- **Refusal is authentication-shaped and uniform.** 403 at connect time, never a
  fallback to another scope, with the same body for "not yours", "does not
  exist", and "you may not go unscoped" (see the table above).
- **Deployment-wide operator surfaces are closed to a restricted identity**
  (`/ui/data`, `/ui/activity`, the credential API) — see *Decisions worth
  knowing* above.
- **A provider may resolve a binding per identity, but only downward.** An
  `InboundAuth.authorize` result can return its own `toolkitBinding` — the seam
  for an adapter that maps its own users (or an IdP claim) to views. When the
  provider *also* declares one, the declaration is a **ceiling**: connecta
  intersects the two, and grants `unscoped` only if both do. A per-identity
  binding can narrow the credential's view, never widen it, so an adapter reading
  a user-writable claim cannot let the user name their own toolkits. When the
  provider declares nothing, the per-identity binding is used as given — that
  provider is asserting it owns membership. Only *declared* bindings are checked
  against the configured toolkits at startup; a per-identity one does not exist
  until a request arrives.
- **A binding that does not type-check refuses the request.** Both halves are
  re-validated on every request rather than trusted from the TypeScript type,
  because `InboundAuth` is an open interface: `unscoped` must be a real boolean
  (a truthy `"false"` string must not grant the registry), `toolkits` must be a
  real array (a bare string would reach `String.prototype.includes`, where
  `?toolkit=sup` "matches" `support`), and every name must fit the grammar. A
  malformed binding is a **403**, logged operator-side — never silently dropped,
  which would read as "unbound" and hand over everything.

Startup warnings track the three shapes where the boundary organizes but does not
protect (each fires at most once, and never changes behavior):

| Deployment shape | Warning |
| --- | --- |
| toolkits, no `auth` at all | there is no identity to bind, so binding is not the fix — configure `auth` first |
| toolkits + `auth`, but no provider declares a binding | every credential can select every view; bind them |
| toolkits + *some* providers bound | names the unbound ones — this is the shape where an operator believes the deployment is separated while one forgotten credential still opens every view |
| toolkits + every provider bound | silent |

An intentionally unrestricted credential should therefore **say so** —
`toolkits: [...], unscoped: true` — rather than being left unbound: same access,
but the exemption is now a decision in the config instead of an omission, and the
warning stops. Note the warnings read the *declared* bindings only: a deployment
that binds purely through `AuthResult.toolkitBinding` looks unbound at
construction and will see the middle warning. That is a deliberate limit rather
than a bug to suppress — connecta cannot know at startup what an adapter will
return per request, so the honest report is "nothing here is declared". Read it
as a prompt to check that adapter, not as a claim that nothing is enforced.

### Validation

Toolkit definitions **and** the bindings that name them are validated when
`createConnecta` runs, and structural mistakes **throw** rather than warn — a
typo'd id is a scope you did not write, and a scope nobody wrote is not one an
operator can reason about:

- an unknown toolkit name grammar (names are `[a-z0-9_-]+`, like connector ids),
- a toolkit selecting no connectors,
- an unknown connector id,
- an `includeTools`/`excludeTools` entry that is not a `<connectorId>.<toolName>`
  address, or that names a connector outside that toolkit's own list,
- an entry naming a tool that an **in-code** connector (`api()`, which declares
  `staticTools`) does not have — an `excludeTools` typo that would silently
  exclude nothing,
- a present-but-empty `includeTools`. It reads as "only these tools" and would
  behave as "all of them" — the one shape here that fails *open*. An empty
  `excludeTools` is an honest no-op and is allowed.

A binding is checked in three places, each seeing a mistake the others cannot.
The adapter itself (`bearerToken(...)`, `clerkAuth(...)`) throws on a binding
that does not say what it means:

- a name outside the toolkit name grammar, which could never match a declaration,
- `unscoped` with no `toolkits` — it reads like a permission but grants nothing an
  unbound identity does not already have, so it is a half-written binding,
- `toolkits: []` with no `unscoped` — a credential that could authenticate but
  never connect. (`toolkits: []` *with* `unscoped: true` is a real
  configuration: full registry only, no toolkit selection.)

Then `createConnecta` cross-checks the names against `toolkits`, and throws on a
binding that names a toolkit this deployment does not declare, on any binding at
all when the deployment declares none, and on a structurally malformed
declaration (only reachable from a hand-written `InboundAuth`, which skips the
adapter check above). A typo there fails *closed* — that credential would be
refused every connection, with a 403 its client reports as a transport failure —
which is exactly the kind of mistake that should never reach production.

Finally, **every request re-validates the binding it is about to enforce**, both
the declaration and anything `authorize` returned, and refuses with 403 if either
is malformed. The static checks cannot cover a per-identity binding (it does not
exist yet) or a provider object mutated after construction, and a binding is the
one place where "assume the type is honest" fails open.

`bearerToken` additionally emits a `console.warn` when a **bound** token has no
`subjectId`: the refusal log and activity events can then only say `bearer`, so
with two bound tokens an operator cannot tell which credential was refused.

Tool names on **remote** connectors cannot be validated at construction: their
catalogs are fetched lazily over the network and are unknown until first use. An
entry for a tool a remote connector does not have simply matches nothing.
