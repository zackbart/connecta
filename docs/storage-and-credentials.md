# Storage and credentials

## Storage

The `KVStorage` interface is the only state seam (`src/types.ts`):

```ts
interface KVStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
```

| Impl | Import from | Notes |
| --- | --- | --- |
| `memoryStorage()` | `@zackbart/connecta` | Default; in-memory with expiry. Dev / ephemeral. |
| `fileStorage(path, { logger? })` | `@zackbart/connecta/node` | JSON file; atomic write (tmp + rename). Node only. |

The package intentionally does not ship platform-specific storage. The Worker
example implements `cloudflareKvStorage(ns)` over the same interface; Workers
KV has a **60 s minimum TTL**, so that example stores shorter TTLs without
expiry.

Or implement the three methods over anything you like.

**What actually needs persistence:** **downstream OAuth tokens /
registrations / pending flows** ([downstream OAuth](./connectors.md#downstream-oauth)), serializable tool catalogs, result pages,
**credential-liveness verdicts** (`credhealth:<connectorId>`, so a scheduled check
in one isolate is visible to the isolates answering status reads —
[credential health](#credential-health-proactive-liveness-checks)),
and any **connector-private state** a custom connector chooses to store. If you
use no OAuth connectors and no custom
persisted state, `memoryStorage()` is fine.

### Operator-managed connector credentials

Token-backed API connectors may declare either a single `credential` slot or
multiple named fields. Configure
`createConnecta({ credentials: { encryptionKey } })` with a base64-encoded
32-byte AES key from the runtime's secret store. Connecta encrypts the credential set with AES-GCM
and connector-specific authenticated data before writing it to the same
`KVStorage` used by OAuth and result paging.

The key spaces do not overlap:

| Data | Effective key prefix |
| --- | --- |
| Connector credential | `conn:<id>:credential:v1` |
| Downstream MCP OAuth | `conn:<id>:oauth:*` |
| Paged meta-tool results | `results:*` |

The encryption key stays outside KV. `/ui/data` returns only `configured`,
masked per-field metadata, and the update time to an eligible Clerk operator.
Mutation endpoints require a
Clerk-authenticated, gate-approved operator, reject the static inbound bearer,
reject an identity bound to a toolkit ([toolkits](./toolkits.md#toolkits-scoped-views)) — a
credential is deployment-wide, so writing one reaches every view — require a
same-origin request, disable wildcard CORS, and never return the credential after
saving it.

The private routes the Credentials page at `/credentials` drives (all under the
same rules above):

| Route | Effect |
| --- | --- |
| `PUT /ui/credentials/<connectorId>` | store or replace the credential set |
| `DELETE /ui/credentials/<connectorId>` | remove it (works even when the stored ciphertext can no longer be decrypted, e.g. after an encryption-key rotation) |
| `POST /ui/credentials/<connectorId>/test` | run the hook the credential shape selects server-side and return only `{ ok, message? }` |
| `OPTIONS /ui/credentials/*` | 405 — these routes never take part in CORS preflight |

**Testing a credential.** The declared shape picks the hook — named
`credential.fields` are tested as a set by `testCredentials`, a single-value
`credential` by `testCredential` on the vault's reserved `value` field — and the
other hook is never substituted, because it would be handed a shape the
connector never declared. That one rule (`credentialTestRule`,
`src/credentials.ts`) is what `/ui/data`'s `testable` flag, the test route's hook
selection, and the credential liveness checks
([credential health](#credential-health-proactive-liveness-checks)) all read, so the button,
the route, and the background sweep cannot disagree: a connector implementing
only the mismatched hook is not testable, `/credentials` renders no Test action, a direct
`POST` to the route answers **400** naming the mismatch — never a 409 telling an
operator to configure a credential they already configured — and a liveness sweep
reports it `not_checkable` rather than probing it through a hook its shape cannot
use.

**Stored-shape drift.** A credential written by an older connector declaration
stays compatible as long as it **contains every field the declaration currently
names** — the reserved `value` key for a single credential, every declared name
for a named one (`storedCredentialShape`, `src/credentials.ts`). Containment,
not equality, and the difference matters in both directions:

- **A missing declared field is drift.** A rename, a newly added field, or a
  redeploy that swaps between the single-value and named shapes all land here:
  the declaration asks for a key the vault does not have, so no hook could be
  handed the shape it expects. `/credentials` marks the credential unconfigured but
  removable, hides Test, and shows an operator-safe replacement message; a
  direct test answers **409** with that same message and invokes no hook; a
  liveness check records it as an `error`
  ([credential health](#credential-health-proactive-liveness-checks)). Replacing
  or removing the credential is the recovery — connecta never guesses how to
  migrate secret values between declarations.
- **An extra stored field is not.** Dropping a field from the declaration leaves
  its secret behind in the vault, but `ctx.credential.get("apiKey")` and
  `getAll().apiKey` keep returning exactly what they returned before, so every
  tool call keeps working and the credential stays configured, testable, and
  healthy. `/credentials` prints one non-blocking line naming the leftover fields (the
  field list itself renders declared fields only, so this is the only place they
  appear); replacing the credential drops them. Nothing else changes.

An empty stored map — reachable only through a hand-written plaintext — contains
nothing, so it is drift.

`createConnecta` **throws at construction** when any connector declares
`credential` and no `credentials.encryptionKey` is configured, naming the
connectors involved — a deployment cannot silently boot with an unusable vault.
It **warns at construction** — the same warning-only channel as the other
insensible-config checks — for each connector whose only test hook cannot test
its declared credential shape, so the gap is visible at boot rather than
discovered by clicking.

---

## Credential health (proactive liveness checks)

A stored downstream credential can die quietly. Before this existed, a
connector's status only flipped when something **observed** a failure — an
agent's real call erroring `auth_required`, or an operator running
`list_connectors({ probe: true })` — so a revoked grant surfaced at the worst
possible moment: mid-task, as a failed call.

Credential health closes that gap. Connecta periodically asks each connector
whether the credential **connecta itself stores** for it still works, records the
verdict, and serves it from the cheap status surfaces. An agent calling
`list_connectors({ probe: false })` sees `auth_required` — with the URL to open —
*before* it tries a call, and can run `authorize_connector` up front instead of
discovering the problem halfway through a task.

### What gets checked, and how

Only connectors holding a credential connecta manages, asked only through the
hooks that exist to answer this question:

| Credential | Checked with | A failure reads as |
| --- | --- | --- |
| Operator-managed (`credential`, in the vault — [storage](#storage)) | the hook the **declared credential shape** selects — `testCredentials(values)` for named `fields`, `testCredential(value)` for a single value — literally the same call the Credentials page's Test button makes ([storage](#operator-managed-connector-credentials)) | `auth_required` with the connector's message; replace the value in `/credentials` |
| Downstream OAuth (`remoteMcp({ auth: { type: "oauth" } })`, [downstream OAuth](./connectors.md#downstream-oauth)) | `status(ctx)`, which refreshes the grant — that *is* the liveness question for a token | `auth_required` with the consent `authorizationUrl` |

Everything else is skipped, by design:

- **A check never calls a downstream tool** and never fetches a catalog. It
  cannot mutate downstream state, and no destructive tool is reachable from it.
- **A probe closes the scope it opens.** `status()` on a remote MCP connector
  connects a client; the credential-health sweep,
  `list_connectors({ probe: true })`, and `/ui/data` end their probe-only scope
  through `closeScope` when finished — terminating the downstream session, not
  just dropping the local client, so a stateful provider is not left aging out
  one session per sweep. Cleanup is best-effort and cannot change the verdict or
  request outcome ([connectors](./connectors.md#the-connector-interface)).
- **A connector with nothing stored is not probed.** `hasStoredCredential`
  ([connectors](./connectors.md#the-connector-interface)) answers for OAuth connectors and the vault
  answers for credential connectors; with nothing stored there is no credential
  whose liveness is in question, and a `status()` probe would kick off DCR +
  consent for a connector nobody has authorized yet.
- **A static-token connector stores nothing here** (`auth: { type: "headers" }`),
  so it is never put on a timer.
- A connector exposing neither `status()` nor a credential test hook has no way
  to be asked, and is reported as `not_checkable`. So is one whose **declared
  credential shape cannot use the hook it implements** — named `fields` with only
  `testCredential`, or a single value with only `testCredentials`. The check
  selects the hook through the same rule the Credentials page and credential API read
  ([storage](#operator-managed-connector-credentials)), and never substitutes the
  other one: handing `testCredential` a `value` field named fields never wrote
  would test the empty string and record a confident `auth_required` about a
  credential nothing examined, and handing `testCredentials` the vault's reserved
  `{ value }` map would call a hook with a shape its connector never declared. A
  credential no operator can test by hand is not one a sweep tests behind their
  back — `createConnecta` warns about the mismatch at construction, and until it
  is fixed the connector carries no verdict at all. It still gets probed through
  `status()` if it has one: that question never involves the mismatch.
- **Stored keys must still fit the current declaration.** The vault may outlive
  the code that declared it. Before any hook or `status()` runs, the same pure
  classifier used by `/ui/data` and the credential test route asks whether the stored
  set still *contains* every declared field ([storage](#storage)): the reserved
  `value` for a single credential, every current name for a named one. A missing
  declared field records an explicit `error` verdict and invokes neither hook nor
  `status()`; this validation happens before the freshness shortcut so even a
  still-fresh historical `ok` cannot mask a redeploy mismatch. Leftover
  undeclared keys are not drift and change nothing here — the credential is
  checked normally. Replace or remove the credential in `/credentials` to recover.

### When checks run

Nothing in the core schedules itself: connecta has to run unchanged on
Cloudflare Workers, where there are no long-lived timers and no background
daemon. There are two triggers instead, and they share one budget.

**1. Opportunistically, on traffic connecta already serves.** After an
authenticated `/mcp` or `/ui/data` request is admitted — past the auth gate and
past the toolkit binding, so a request that is refused triggers nothing
([toolkits](./toolkits.md#toolkits-scoped-views)) — connecta hands a *due* sweep to
`ctx.waitUntil` (the Node adapter shims one) and returns the response
immediately. It never adds latency to the request and never changes its result.
Unauthenticated requests trigger nothing. Turn it off with
`credentials: { health: { onRequest: false } }`.

**2. On a schedule you own** — `Connecta.checkCredentials()`, an ordinary
awaited call that returns one outcome per connector:

```ts
// Cloudflare Workers — wrangler.jsonc: "triggers": { "crons": ["*/15 * * * *"] }
export default {
  async fetch(request, env, ctx) { return build(env).fetch(request, env, ctx); },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(build(env).checkCredentials());
  },
};

// Node
setInterval(() => void connecta.checkCredentials(), 15 * 60_000).unref();
```

Both examples ship this wiring (`examples/worker/src/index.ts` +
`examples/worker/wrangler.jsonc`, `examples/node/src/index.ts`,
`examples/docker/server.ts`). `checkCredentials()` needs a base URL for connector
contexts: `publicUrl` supplies it — the value downstream OAuth callbacks already
require — or pass `{ baseUrl }`. It takes `{ force }` to ignore the freshness
budget and `{ ids }` to check named connectors (an id naming no connector comes
back as `skipped: "not_found"` rather than silently checking nothing), and never
rejects on a connector failure. Missing base URL is a rejected promise, not a
throw, so `ctx.waitUntil(...)` and `.catch(...)` can both see it.

The two triggers are complements, not alternatives: opportunistic checks make a
*busy* deployment self-maintaining with no setup, and a scheduler covers an
*idle* one, where nothing arrives to piggyback on.

On Node, deferred work is drained on SIGTERM within `listen({ shutdownTimeoutMs })`
([running connecta](./operations.md#running-it)), which defaults to 10 s — shorter than a check's 30 s
`timeoutMs`. A sweep in flight when the container is recycled is therefore cut
off at the deadline; nothing is corrupted (a verdict is either written or not),
but if you want sweeps to finish across a restart, pair the two: raise
`shutdownTimeoutMs` above `credentials.health.timeoutMs`, or lower the latter.

### Bounded cost

A status surface an agent may poll must never become a way to hammer a
downstream auth endpoint, so the cost is bounded four ways:

1. **Eligibility** — only connectors holding a credential of ours, only when
   something is actually stored.
2. **Freshness, across isolates** — a verdict younger than `intervalSeconds`
   (default 900) short-circuits the check and is reported as `skipped: "fresh"`.
   Verdicts are persisted, so a Worker cron isolate and every request isolate
   share one budget. **Repeated status reads never each trigger a check** — a
   read reads the verdict, it does not produce one. For vault credentials, the
   local stored-key shape check runs before this shortcut; it performs no
   downstream call and prevents a pre-redeploy `ok` from hiding declaration
   drift. A drift verdict then re-enters the budget: once the *same* error is
   stored and still fresh it is reported `skipped: "fresh"` rather than written
   again, because drift persists until an operator acts and re-settling it every
   sweep would spend a metered write per isolate to learn nothing.
3. **Sweep gate, per isolate** — one traffic-triggered sweep per interval per
   isolate, never two at once: a burst of requests costs one sweep.
4. **Deadline and fan-out** — `timeoutMs` per check (default 30 000, the probe
   default) with at most `concurrency` (default 4) in flight, the same shape as
   `discovery.probeTimeoutMs` bound on the discovery fan-out.

A `list_connectors({ probe: true })` and `/credentials`' credential **Test**
button record
their verdicts too — they are the same check, run by hand — which also means an
operator who just probed live is not swept again moments later. A live probe
records only a definite `ok`/`auth_required` from the connector's **status**
phase. The catalog refresh that follows is not a credential check (the sweep
never fetches one), it is already counted in the health log, and letting its
failure land here would spend the freshness budget on it; a status probe that
itself errored is left to the health log for the same reason.

Two caveats worth knowing:

- **Cold start is not rate-limited by the persisted budget until something has
  been written.** The freshness gate reads a *recorded* verdict, so a deployment
  that has never run a check will run one on the first authenticated request in
  each cold isolate. Isolates starting together can therefore each check the
  same connector once before the first verdict lands. It is bounded (one check
  per connector per isolate, then the persisted budget takes over) but it is not
  one. A scheduled `checkCredentials()` warms the budget and avoids it.
- **Storage failures degrade to "no verdict".** Reads and writes here never
  throw: a store that is down means status surfaces fall back to observed
  real-call health exactly as they did before this feature, and checks re-run
  (only the per-isolate sweep gate still limits them). It fails toward doing
  nothing, not toward wrong answers.

### Where the verdict shows up, and how it clears

| Surface | What it shows |
| --- | --- |
| `list_connectors({ probe: false })` | `credentialCheck`, and the `status` it sets ([meta-tools](./meta-tools.md#list_connectors)) |
| `list_connectors({ probe: true })` | live status as always, plus `credentialCheck` refreshed by that probe |
| `/` and `/credentials` | a "Credential check" line: verdict, when, and why |

Verdicts live in the deployment's own storage under `credhealth:<connectorId>`,
alongside the `conn:<id>:*` and `catalog:<id>` keys ([storage](#storage)). They are
read through a few-second in-memory mirror, so a burst of status reads costs one
storage read rather than one per read.

Recovery does not wait for the next check. A verdict is **dropped** the moment
the credential it judged is replaced — a completed `/oauth/callback/<id>`, a
`PUT`/`DELETE` on the credential API — and `authorize_connector`'s own answer
overwrites it, so a connector that reports `ok` again is `ok` again immediately,
with no restart.

That clear also **fences checks already in flight**. A check that started before
the credential was replaced would otherwise finish afterwards and write a verdict
about a credential that no longer exists — resurrecting a stale `auth_required`,
and a stale consent URL, for a whole interval right after the operator fixed it.
Clearing advances a per-connector generation counter (`credhealth:gen:<id>`, the
same pattern as the OAuth force-reauth generation in [downstream OAuth](./connectors.md#downstream-oauth)),
which a check captures when it starts and re-reads before writing; a mismatch
drops the verdict and reports it as `discarded: true`. It fences across isolates,
not just within one, because the counter is in storage.

**What a verdict is allowed to decide.** Only `auth_required` ever sets the
cached status. Three rules, all in one function (`credentialVerdictApplies`):

- **`error` is not credential evidence.** A check that timed out, threw, or got a
  502 from the provider's status endpoint failed to *complete* — it learned
  nothing about the credential. Letting it set the status would flip a connector
  whose calls are fine to `error` for a whole interval on a DNS blip. Error
  verdicts stay visible in `credentialCheck`, because an operator wants to know
  checks are failing, but the status keeps coming from observed real calls.
- **A successful real call retires an `auth_required` verdict.** Traffic beats a
  background probe: a `lastSuccessAt` at or after `checkedAt` means the
  credential demonstrably works whatever the check concluded. Deployment-wide,
  like `hasObservedSuccess` — a sibling toolkit's success proves the same shared
  credential, and a verdict retired in one scope but not another would make one
  connector read two ways for a reason that has nothing to do with scope.
- **`auth_required` outranks an observed real-call failure**, even a newer one.
  Both say something is wrong and only one carries the URL that fixes it; the
  call failure stays visible as `lastError` and `consecutiveFailures`. An `ok`
  verdict, by contrast, only upgrades `unknown` — it never argues with a failure.

Automatic re-authorization is **out of scope**: refresh-token rotation is already
the OAuth flow's job ([downstream OAuth](./connectors.md#downstream-oauth)), and interactive re-consent
stays manual through `authorize_connector`. This feature makes the need visible
early; it does not act on it.
