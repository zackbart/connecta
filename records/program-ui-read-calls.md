# Bounded reads from program UI — evidence and decision

Decision note for [#287](https://github.com/zackbart/connecta/issues/287),
2026-08-02. The implementation contract is [#289](https://github.com/zackbart/connecta/issues/289)
and the normative clauses are `V1`–`V8` in [code-mode.md](../documentation/code-mode.md).

## Verdict

Accept explicitly bound, host-mediated **read-only** calls for refresh,
pagination, and drill-down. Keep mutations gated. Keep the one-string
`connecta.ui(html)` call display-only.

This is not an acceptance of interactive applications in general. It adds no
persistence, artifact catalog, sharing, component runtime, generated-code
library, deep link, direct network, conversation channel, or write path. One
successful program still delivers one request-local view and one ordinary text
result.

## What display-only could not do

The current shell and the read-bound browser fixture were walked through with
the same three shapes. In the display-only arm, local JavaScript could sort,
filter, chart, expand already-delivered fields, and rerender indefinitely; every
attempt to obtain bytes not present in the original HTML stopped at the nested
frame. The read-bound arm exercised the same-origin-free nested frame, two
concurrent refreshes, fixed and view-supplied arguments, a refused fabricated
binding, a refused extra argument, and a host error.

| Workflow | Display-only attempt | Is a fresh program run adequate? | Decision |
| --- | --- | --- | --- |
| Refresh a current status or metrics view | A button can repaint only the original snapshot. Putting a timer around it changes no data. | No. It spends another model turn, reruns composition, and creates another view merely to repeat the same read. | Accept an exact named read with optional filter or cursor keys. |
| Page a cursor-backed list | The initial program can include the known next cursor, but the view cannot exchange it for the next page. Fetching every page up front defeats projection and can cross call/result budgets. | No. The model is an expensive pagination controller and has to reconstruct UI state it did not need. | Accept a binding whose declared `viewArgs` includes the cursor field. |
| Drill from a projected list into one record | Local expansion can show only fields prefetched for every row. Prefetching every detail multiplies calls and payload for records the human never opens. | Usually no. A new prompt can fetch the record, but loses the direct row selection and creates a second result instead of filling the existing view. | Accept a binding whose declared `viewArgs` includes the record identifier. |
| Sort, filter, chart, compare, or expand delivered data | Local HTML/JavaScript completes the interaction. | Yes; usually no new run is needed at all. | No call capability earned. |
| Change, delete, approve, send, or deploy | Display-only correctly cannot act. | Yes. The ordinary `call_destructive_tool` path keeps the proposed effect and host approval in the transcript. | Remain gated. A click is not approval, and this decision adds no mutation bridge. |

The accepted utility is therefore *live reads*, not “interactivity.” Local
interactivity already existed.

## Executor comparison

Executor's inspected revision demonstrates a useful separation:

- its generated iframe disables direct `fetch`, XHR, WebSocket, EventSource,
  workers, and related network primitives;
- declarative `tools.*` operations become one proxy-shaped call through a
  trusted shell and an app-only action tool;
- integration roles resolve against server-owned saved bindings, and writes
  can pause for shell-owned interaction handling.

That is evidence that a narrow bridge can keep untrusted markup away from raw
network and credentials. It is not evidence for Executor's React runtime,
saved artifacts, editing, previews, persistence, or deep-link fallback; those
features provide longevity and authoring ergonomics, not the refresh,
pagination, or drill-down read itself.

Connecta takes the smaller shape. The trusted shell maps names to the already
existing `call_tool`; bindings live in the completed result, not a database;
and the ordinary fail-closed read path remains the authority. No app-only tool
or eighth meta-tool is needed.

Inspected Executor sources:

- [artifact and app-only action registration](https://github.com/UsefulSoftwareCo/executor/blob/837e404acbebdf32924059d6b76f715565329307/packages/hosts/mcp/src/tool-server.ts#L1906-L2157)
- [single proxy-shaped action grammar](https://github.com/UsefulSoftwareCo/executor/blob/837e404acbebdf32924059d6b76f715565329307/packages/hosts/mcp-apps-shell/src/shell/proxy.ts#L38-L140)
- [disabled direct network primitives](https://github.com/UsefulSoftwareCo/executor/blob/837e404acbebdf32924059d6b76f715565329307/packages/hosts/mcp-apps-shell/src/shell/inner-renderer.tsx#L84-L131)

## Contract in one pass

```js
await connecta.ui(html, {
  reads: {
    refresh: {
      address: "metrics.current",
      fixedArgs: { service: "api" },
      viewArgs: ["window", "cursor"],
    },
    detail: {
      address: "incidents.get",
      viewArgs: ["id"],
    },
  },
});
```

Program markup calls `await connecta.read("detail", { id })`. It never receives
the address table. The outer shell checks the frame source, resolves `detail`,
rejects keys other than `id`, merges the arguments, and asks the host to call
the existing `call_tool` with `resultMode: "value"`.

The declaration-time catalog lookup proves the view was not born broken or
write-capable. The use-time `call_tool` lookup proves it is still read-only now.

## Normative contract

**V1. Manifest.** The second argument is exactly
`{ reads: { name: { address, fixedArgs?, viewArgs? } } }`: 1–32 names matching
`[A-Za-z][A-Za-z0-9_-]{0,63}`, one non-empty address per name, optional fixed
arguments, and at most 32 distinct view-supplied keys. Extra fields, unsafe
control names (`__proto__`, `constructor`, `prototype`), a view key colliding
with a fixed key, and non-serializable content throw before acceptance.

**V2. Declaration admission.** Every address resolves through the request-local
catalog and passes the fail-closed `isExplicitlyReadOnly` classification before
the payload is accepted. The lookup dispatches nothing and spends no host-call
budget. `call_tool` repeats resolution and classification at use time.

**V3. Delivery.** Bindings ride beside `html` under `_meta["connecta/ui"]`,
share the existing emitted-byte aggregate, appear on success only, and never
enter `content` or `structuredContent`. The one-string payload stays exactly
`{ html }`.

**V4. Inner bridge.** A manifest alone installs `connecta.read(name, args?)`.
The outer shell accepts only its nested frame's exact `WindowProxy`, rejects an
unknown name, non-object arguments, undeclared keys, and more than eight
concurrent reads, then merges supplied keys into a null-prototype copy of fixed
arguments. The inner frame receives no address table or raw JSON-RPC.

**V5. Seven-tool boundary.** The shell calls only existing `call_tool` with
`resultMode: "value"`. That tool alone is app-visible; the other six are
explicitly model-only. No new MCP tool exists and the view cannot reach the
destructive boundary.

**V6. Ordinary admission.** A view read is a new MCP request crossing inbound
auth, request admission, current catalog and credentials, fail-closed safety,
connector admission, timeout, retry, result-size, and payload-free activity
exactly as ordinary `call_tool` does. No server-side grant or pending promise
survives the originating request.

**V7. Stale and replayed views.** A stale view retains no frozen authority:
removed tools, changed annotations, revoked credentials, lost inbound auth, and
new policy fail current admission. Replay repeats a read and may spend rate
limits, but cannot write. Cross-caller use is admitted as the current caller on
the host's originating connection; deployment remains the audience boundary.

**V8. Context, fallback, and parity.** Reads update only the human-visible view;
the return summarizes the initial snapshot and refreshed data must be labelled
as such. A host without app server tools keeps the ordinary result and initial
view while a read fails locally. The existing provider bridge carries the
manifest identically on both executors without changing `ExecuteResult`.

## Threat and consent trace

1. **Untrusted program declaration.** The guest supplies HTML and a strictly
   shaped read manifest. The host rejects extra fields, unsafe control names,
   fixed/view collisions, overlarge lists, unknown addresses, and anything not
   explicitly read-only. This lookup executes nothing.
2. **Result delivery.** On successful program completion only, HTML and
   bindings ride result `_meta` under the existing aggregate byte budget. A
   failed program delivers neither. The model sees only `ui: true` and the
   program's initial summary.
3. **Nested-frame request.** Only the exact payload `WindowProxy` may send the
   `connecta/read` dialect to the trusted shell. A fabricated name fails before
   a host call. Fabricated or prototype-shaped argument keys fail unless they
   are explicitly declared; fixed keys cannot be overridden. Direct JSON-RPC
   from the nested frame is ignored.
4. **Host mediation.** The shell checks that the host advertised server-tool
   calls, caps concurrent work, and emits one `tools/call` for `call_tool`.
   `execute_code`, discovery, authorization, result paging, and the destructive
   tool are model-only. The Apps host accepts calls only on the originating MCP
   server connection.
5. **Connecta admission.** The app call is a new authenticated request with a
   fresh request scope. It crosses request admission, current catalog and
   credential resolution, fail-closed read classification, connector call
   admission, timeout, retry policy, result-size handling, and payload-free
   activity recording. There is no UI bypass below the shell.
6. **Result delivery.** The shell unwraps the ordinary value result and settles
   only the matching inner-frame promise. Protocol errors and tool errors
   reject it. It sends no result to model or conversation context.

### Named failures

- **Fabricated address:** markup cannot submit an address; raw JSON-RPC is not
  forwarded. A declaration-time invented address fails catalog resolution.
- **Fabricated binding name:** rejected by own-property lookup in the shell.
- **Fabricated argument:** an undeclared key or non-object argument is rejected;
  a declared value still faces the downstream input schema and policy.
- **Stale view:** the later request reauthenticates and re-resolves the catalog.
  A removed tool, newly unsafe annotation, revoked credential, or changed
  admission policy fails current checks. No frozen grant exists server-side.
- **Replay:** it repeats a read and may consume rate limits, but cannot cross to
  a write. The view should disable duplicate controls while its promise is
  pending; the shell also bounds concurrency.
- **Cross-caller use:** the later request is admitted as the caller behind the
  host's current originating connection. Connecta does not use identity to
  scope tools inside one deployment; separate audiences remain separate
  deployments. A copied manifest is no credential and grants nothing outside
  ordinary inbound auth.
- **Destructive call:** the shell names only `call_tool`, and that handler
  refuses missing, false, or contradictory read-only annotation. The
  destructive meta-tool is not app-visible. No human gesture is interpreted as
  write consent.

## Invariants and parity

- **Seven tools:** unchanged; metadata makes one existing tool app-callable and
  makes the other six explicitly model-only.
- **Stateless request scope:** binding state survives only in the client's
  completed result and trusted shell. The server stores no grant or pending
  promise.
- **Import-graph purity:** the shell remains a build-time string using browser
  and Web APIs only.
- **Workers/Node parity:** the second argument crosses the existing provider
  bridge, leaving `Executor` and `ExecuteResult` unchanged; the same contract
  case runs on both executors and both Vitest projects.
- **Payload-free activity:** later reads use ordinary `call_tool` events, whose
  schema has no arguments or results.
- **Fallback:** hosts without Apps keep the ordinary result; Apps hosts without
  server-tool calls keep the initial view and fail a read locally.

The remaining gate is intentionally crisp: a mutation proposal needs real
workflow evidence plus a host-tested consent and replay story. Read utility is
not permission to smuggle that decision into this bridge.
