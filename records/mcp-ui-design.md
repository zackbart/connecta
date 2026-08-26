# MCP UI from programs — design record

The decision record for
[#266](https://github.com/zackbart/connecta/issues/266): whether and how an
`execute_code` program may deliver a *rendered view* to the client, and what a
program is allowed to hand the host in order to get one. The verdicts live in
[`ethos.md`](../ethos.md); this document carries the argument, the contract
precisely enough to implement, and the shapes that were considered, refused, or
gated.

It extends the [rich-output design record](./rich-output-design.md)
([#267](https://github.com/zackbart/connecta/issues/267)) rather than restating
it. That record's contract clauses (`M1`–`M10`, now normative in
[`code-mode.md`](../documentation/code-mode.md)'s "Emitted output" section) are cited here,
not repeated; where the two overlap — provider-bridge delivery, budgets,
success-only delivery, payload-free diagnostics — this record follows the
precedent instead of inventing a parallel one. The implementation landed via
[#277](https://github.com/zackbart/connecta/issues/277): the clauses below
(`U1`–`U11`) are now normative in [`code-mode.md`](../documentation/code-mode.md)'s "Rendered
output" section, which wins where the two disagree. This document remains the
argument and the record of rejected shapes.

## The problem

`connecta.emit` gave programs pixels. It did not give them a *view*. A program
that assembles a comparison table, a chart, or a diffed record can emit it as
text the model re-reads, or as an image it can no longer inspect; what it
cannot do is hand the client something the human looks at directly while the
model keeps its cheap textual summary. That is a real gap for the surface
connecta calls primary: the program is where composition already happens, and
composed output is exactly the output worth rendering.

MCP grew an answer to this, and the ethos anticipated it. The gated row for
guest-emitted `resource` / `resource_link` blocks reserved MCP UI as the one
possible carve-out, with the constraint written in advance: *programs supply
only content, connecta mints the `ui://` address outside the sandbox.* The
lure defense is the whole reason for the gate — a guest-minted URI is an
address a helpful client may dereference, and generated code mints nothing.

### The spec moved

The gate was drafted against the shape mcp-ui had at the time: the server mints
a per-request `ui://` URI and embeds a `UIResource` block inline in the tool
result. That shape is now the *legacy* path, explicitly superseded upstream and
still rendered by hosts that also support the official path — Goose, Postman,
MCPJam — plus a few that do not: Nanobot, LibreChat. The claim that matters is
narrower and unaffected: Claude.ai, ChatGPT, and VS Code Copilot render only
the official shape.

The official replacement is the **MCP Apps extension**
(`io.modelcontextprotocol/ui`, launched 2026-01-26,
[specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx),
[overview](https://modelcontextprotocol.io/extensions/apps/overview)), and it
inverts the delivery model in a way that happens to suit a stateless
aggregator:

- A tool **pre-declares a static UI template** through tool metadata,
  `_meta.ui.resourceUri`, pointing at a `ui://` URI. (The flat form
  `_meta["ui/resourceUri"]` is deprecated.)
- The template's mimeType MUST be `text/html;profile=mcp-app` and its body MUST
  be a valid HTML5 document. External URLs (`text/uri-list`) are the one type on
  the spec's deferred list; remote-DOM was never adopted into the official spec
  at all.
- The host MUST use `resources/read` to fetch the referenced URI, and MAY
  prefetch and cache it. A permission the spec hands hosts is a permission to
  assume they use, so a template change means a new URI — version the address.
- Servers MAY omit UI-only resources from `resources/list` entirely — the
  omission is from the *listing*, not from the method. A handler that answers
  exactly one static URI and lists nothing needs no state: the URI reaches the
  host through tool metadata, so the listing has nothing to carry and there is
  no session to keep.
- Per-call data reaches the rendered view over postMessage: the host delivers
  the full tool result to the view via `ui/notifications/tool-result`. Result
  `_meta` is delivered to the view and, per the spec's best practices, is data
  "not intended for model context" — the established Apps convention, and how
  ChatGPT's Apps SDK behaves too. It is guidance, not a MUST.
- Rendering is sandboxed by the host. Hosts MUST render in sandboxed iframes,
  and a template that declares no CSP domains gets the host's restrictive
  default: `default-src 'none'`, `connect-src 'none'`, `frame-src 'none'`. An
  undeclared template has no network, and no nested frame it could load by URL.
- The extension MUST be explicitly negotiated. Servers declare it in their
  capability declaration, and per the client matrix a client acts on an
  extension only when both sides have declared it.
- Support for the official shape spans Claude.ai, Claude Desktop, ChatGPT, VS
  Code Copilot, M365 Copilot, Goose, Postman, and Cursor, among others
  ([client matrix](https://modelcontextprotocol.io/extensions/client-matrix)).

So the gate's premise dissolved on both ends. The shape it envisioned is the
one nobody renders, and the shape everyone renders does not require connecta to
mint anything per request — which turns out to be a *stricter* posture than the
gate asked for, not a looser one.

## The shape: `connecta.ui(html)` and one static shell

One new provider function, `connecta.ui(html)`, plus one static, connecta-
authored MCP Apps shell template. The program supplies HTML content and nothing
else. The only `ui://` URI anywhere in the system is connecta's shell, minted
at build time and identical for every deployment and every request; the
program's HTML never becomes a URI at all. It rides the tool result in `_meta`,
which hosts keep out of model context, and the shell renders it inside the
client's sandboxed iframe.

That is the whole design, and it satisfies the gate's constraint more strongly
than the gate's own sketch did. The gate would have allowed connecta to mint an
address per request from program-supplied bytes; here the program's content
never becomes addressable at all. Nothing a client could dereference is derived
from anything a program said.

Two structural consequences follow, both borrowed rather than invented. First,
`connecta.ui` is a provider function in the same `fns` object as
`connecta.emit`, so `ExecuteResult` stays `{ result, error?, logs? }` and the
`Executor` contract is untouched — the parity guarantee `M8` describes applies
verbatim. Second, the shell ships as a build-time string constant in core, not
a file read at startup: import-graph purity means no `node:fs`, and the same
bytes have to serve on Workers.

### Contract (drafts for code-mode.md)

**U1.** `connecta.ui(html)` accepts exactly one argument: a non-empty string of
HTML. Anything else — a non-string, an empty string, an options bag, an MCP
block object — throws a catchable error and nothing is accepted. There is no
options parameter and no sugar form, for `M1`'s reason: sugar is how a
one-shape contract grows hair.

**U2.** At most one payload per run. A second `connecta.ui` call throws
catchably, naming the constraint; the first accepted payload stands. One tool
result renders one view, and last-wins would silently discard a payload the
program deliberately supplied.

**U3.** The payload is delivered on success only, and out of model context: the
tool result gains `_meta["connecta/ui"] = { html }`, and the JSON envelope
gains `ui: true` so the model learns a view rendered without seeing its bytes.
`_meta` is where the Apps spec's best practices put data "not intended for
model context", and it is how shipped hosts behave — guidance plus observed
behavior, not a protocol property; nothing in the spec makes it a MUST.
`structuredContent` remains the envelope alone. The wire key is a plain
single-label prefix rather than the reverse-DNS form MCP's SHOULD prefers, and
that is a choice: connecta has no domain to reverse, and fabricating one to
satisfy a SHOULD would be a worse answer than the single-label prefix the key
format's MUST already permits. A program that never calls `connecta.ui`
produces today's byte-for-byte response (`R6`). A program that ends in an error
delivers no payload; the error envelope reports `uiDiscarded: true` only when a
payload had been accepted — a field on the structured envelope, a trailing line
on the plain-text paths — and it coexists with `emittedDiscarded: N` when one
failure discards both.

**U4.** The payload spends the existing aggregate emit byte budget
(`ConnectaConfig.execute.maxEmittedBytes`, default 4,000,000), measured at the
call as the serialized bytes of `{ html }` — the same measurement `M5` applies
to a block. Over budget throws catchably, naming the budget and the room
remaining, with nothing partially accepted. It does not spend the block-count
budget (`maxEmittedBlocks`) — it is not a block — and it does not spend the
host-call budget (`L4`). One transport bound covers everything rich a program
delivers; no new knob.

**U5.** One static shell: a connecta-authored HTML5 document at
`ui://connecta/program-ui/v3`, mimeType `text/html;profile=mcp-app`, declared
on `execute_code` via `_meta.ui.resourceUri` together with an explicit
`_meta.ui.visibility: ["model"]`, and served by a `resources/read` handler that
answers exactly that URI and fails on any other. The handler registers on the
`McpServer` in `src/routes/mcp.ts`, which is what puts the `resources`
capability into the discovery response — so `resources/list` is served too, and
returns an empty list. That is the Apps spec's permitted omission of UI-only
resources from listing, taken exactly: the capability stays honest because the
method answers, and nothing downstream is ever listed or aggregated.
The other six tools declare the same model-only visibility without a resource
URI. `visibility` is declared rather than left to default because the default
`["model","app"]` would tell hosts the display-only view it may call every tool
over `tools/call`. It may not. The version
segment bumps whenever the shell's bytes change, because hosts cache templates
by URI.

**U6.** The shell is display-only. It renders the payload in a nested iframe
(`srcdoc`, `sandbox="allow-scripts"`, no `allow-same-origin`) and declares no
CSP domains, so the host applies its restrictive default. That default includes
`frame-src 'none'`, which forbids nested frames loaded from a *URL* — which is
exactly why the payload frame is `srcdoc` and not an address. `about:srcdoc` is
not matched by `frame-src`; it inherits the embedding document's policy
instead. So the inner frame is *permitted* by the documented behavior of the
directive that would otherwise forbid it, and *offline* by the same
inheritance: it gets the shell's `default-src 'none'; connect-src 'none'`.
Program UI therefore gets scripts and local interactivity and nothing else: no
network, no tool calls, no conversation messages, no host-mediated links. The
shell participates in the Apps lifecycle — initialize, tool-result,
size-changed — and forwards no channel whatsoever from the inner frame to the
host.

**U7.** Structural executor parity, per `M8`. `connecta.ui` is a provider
function; `ExecuteResult` and the `Executor` interface are unchanged; QuickJS
and the Dynamic Worker get it through the bridge they already have, without
modification.

**U8.** Request-local and unstreamed, per `M9`. The payload exists only in the
finished response, and `connecta.ui` resolving means "accepted," never
"rendered."

**U9.** With `diagnostics: true` the diagnostics block gains a distinct `ui`
aggregate carrying the payload's byte size — a number, nothing else — present
only when a payload was accepted. UI bytes are not folded into the `emitted`
aggregate `M10` describes: that one pairs a block count with the bytes those
blocks cost, and adding bytes without a block would desync the pair. Activity
stays payload-free by construction (`R8`, `M10`).

**U10.** `_meta.ui.resourceUri` is declared on `execute_code` unconditionally.
A host without the extension ignores unknown `_meta` and sees the ordinary
envelope, which *is* the text fallback the Apps spec mandates. `connecta.ui`
never fails because a client cannot render: a stateless aggregator cannot
reliably know, and connecta is not a nanny.

**U11.** connecta declares `io.modelcontextprotocol/ui` in its server
capability declaration — `capabilities.extensions` on the `initialize` path,
the `server/discover` response on the 2026-07-28 one — and that is the one
extension it advertises. The Apps extension must be explicitly negotiated, and
a conforming client acts on an extension only when both sides declare it: with
no declaration from connecta, no host reads `_meta.ui.resourceUri`, no host
fetches the shell, and the whole design is inert. The declaration is part of
the contract, not an implementation option.

Negotiation runs in two directions, and this design takes one and refuses the
other. **Declaring** is required — `U11` — and it is what makes the
[revision inventory](./mcp-2026-07-28.md)'s decline of the versioned extensions
framework a decline of that framework *as a general surface*, not a blanket
refusal to name an extension. **Reading the client's** declaration in order to
register tool metadata conditionally stays refused ("Capability-conditional
tool metadata", below), and that refusal declines a spec SHOULD — servers
SHOULD check client capabilities before registering UI-enabled tools — which is
worth saying out loud rather than eliding. A per-request stateless aggregator
has no dependable place to hold the check; unknown `_meta` is ignored by spec;
and `U10`'s envelope is already the fallback the spec mandates. The SHOULD
would buy a guarantee the protocol gives away.

## Sizing rationale

The [rich-output record](./rich-output-design.md#sizing-rationale) draws the
line that matters here: the 24,000-character return bound is a *context*
budget, and the emit byte budget is a *transport* bound. A UI payload is
transport in the purest form yet — it rides `_meta`, which hosts deliver to the
view and, following the spec's best-practice guidance, keep out of the model's
window. On a host that behaves that way, the `ui: true` marker is the entire
context cost of a rendered view: one boolean.

Which is why it does not get its own budget. The reason `emit` has one is
transport, not context, and a UI payload competes for the same wire; giving
it a second knob would ask operators to reason about a distinction that does
not exist downstream of the response body. It spends the aggregate and leaves
the block count alone, because a payload that is not a block should not consume
a block.

## Security posture

- **Nothing is minted — more strictly than the gate demanded.** The gate would
  have permitted connecta to mint a per-request URI over program bytes. Here
  the program's content never becomes an addressable resource at all. The one
  `ui://` URI in the system is a build-time constant with no program input in
  it, so there is no address a program can influence and nothing for a client
  to dereference on a program's behalf.
- **No bridge means no capability path.** `U6`'s shell forwards nothing from
  the inner frame to the host. A program-authored UI cannot call tools, reach
  the network, post conversation messages, or open host-mediated links, so
  hostile emitted HTML is inert beyond its own pixels. The invariant holds by
  construction rather than by validation: there is no channel to abuse.
- **The restrictive default CSP is the offline guarantee, and the inner frame
  lives inside it rather than around it.** Declaring no CSP domains means
  `default-src 'none'`, `connect-src 'none'`, and `frame-src 'none'` — that
  last directive forbids the nested frame the design depends on if the frame
  has a URL, which is why it has none. `about:srcdoc` is not matched by
  `frame-src` and inherits the embedding document's policy, so the payload
  frame is permitted and offline by the same rule. That is a dependency on
  documented behavior, not something connecta enforces: hosts MAY tighten
  further, and MAY override the inner `sandbox` attribute, either of which
  could close the gap the shell rides through. If one does, the `v3` segment in
  the shell URI is the escape hatch — a new shell at a new address is a version
  bump, not a redesign. Program UI is offline because the host makes it
  offline, not because connecta scanned the HTML for `fetch`.
- **Model-invisibility is host behavior, not a protocol guarantee.** The spec's
  only statement on it is a non-normative best practice — `_meta` carries data
  "not intended for model context" — with no MUST and no enforcement. Shipped
  hosts honor it. A host that does not receives up to the full byte budget of
  program-authored HTML as model context, which is an expensive turn rather
  than a capability leak, but it is the honest failure mode of `U3` and the
  reason the sizing argument rests on transport rather than on a promise of
  free context.
- **HTML-borne injection is the existing class.** Hostile text inside a
  rendered view is the same hazard as hostile text inside an emitted
  screenshot (`M6`, and `call_tool`'s block passthrough before it). All program
  output is untrusted input to the client; connecta claims no provenance and
  adds no claim otherwise.
- **The lure defense stands.** Guest emission of `resource` and
  `resource_link` blocks becomes refused — it was gated on exactly this
  carve-out, and the carve-out did not need it. This design is not the
  exception that opens that door; it is the demonstration that the door was not
  needed.

## Considered, refused, and gated

**Legacy embedded `UIResource` delivery** (a per-request minted `ui://` URI
plus an inline resource block). Refused. It is superseded upstream and
unrendered by Claude.ai, ChatGPT, and VS Code Copilot — the clients connecta
deployments actually face — so it buys reach only with hosts that also support
the official path. It also fights the caching model: per-request URIs are
precisely what hosts are told they may prefetch and cache by URI. Building the
carve-out the gate imagined would mean minting addresses from guest content in
order to reach fewer clients.

**Extending `connecta.emit` with a `{ type: "ui", html }` shape.** Refused.
`M1` would need an asterisk (not an MCP block type), `M2` another (not appended
to `content`, delivered through `_meta` instead), and `M5` a third (its own
multiplicity, its own share of the budgets). Three exceptions to a settled
contract to avoid one new function is a bad trade; a separate function leaves
`M1`–`M10` exactly as they are.

**Guest-supplied external URL frames** (`text/uri-list`). Refused. A
guest-supplied URL is precisely the lure the gate exists to prevent — a program
choosing what the client loads is a program minting an address by another
route. The official spec deferred the type anyway, so the refusal costs
nothing today and would cost the whole posture tomorrow.

**Remote-DOM payloads.** Refused. Legacy-path-only, and never adopted into the
official spec at all — it survives there as background prose, not as a deferred
item with a queue position. Adopting a payload format the official spec never
took, on the path the official spec superseded, is two bets on one square.

**View-initiated tool calls from program UI.** Removed by
[#484](https://github.com/zackbart/connecta/issues/484) on 2026-08-26. Issue
[#287](https://github.com/zackbart/connecta/issues/287) accepted bounded reads
for refresh, pagination, and drill-down, but the declaration validator,
host-call protocol, tool metadata, and focused tests did not earn their cost.
Program UI is display-only again. The superseded evidence and contract remain
in [`program-ui-read-calls.md`](./program-ui-read-calls.md) so the reversal does
not erase why the bridge once looked reasonable.

**Downstream MCP Apps template passthrough** (downstream connectors declaring
their own `ui://` templates, proxied through connecta's `resources/read`).
Gated. It is a coherent shape, and it earns its way in when a downstream
connector actually ships Apps templates. Until then it would be aggregation
machinery for a population of zero — and `U5`'s narrow handler is deliberately
narrow so that widening it later is a decision, not a diff.

**Delivering UI from failed programs.** Refused, for `M4`'s argument: a view
assembled before the failure may describe a world the error contradicts.
Failure delivers the error, the logs, and an honest `uiDiscarded: true`.

**Capability-conditional tool metadata** (declaring `_meta.ui.resourceUri` only
when the client negotiated the extension). Refused, and knowingly against a
spec SHOULD. Per-request statelessness makes the check unreliable, unknown
`_meta` is ignored by spec, and the JSON envelope is already the fallback the
Apps spec mandates. Conditional metadata would add a negotiation dependency to
buy a guarantee the protocol already gives away.

## Verification sketch

- Parity: one `connecta.ui` program through both vitest projects, identical
  `_meta` payload and envelope.
- Validation: non-string, empty string, options bag, and a second call each
  throw catchably and accept nothing.
- Budget: an over-budget payload fails at the call, naming the budget; emitted
  blocks and the UI payload draw on one aggregate.
- Byte-for-byte: a program that never calls `connecta.ui` produces today's
  exact response.
- Discard: a throwing program that had an accepted payload yields the error
  envelope with `uiDiscarded: true` and no `_meta` payload; a throwing program
  that never called `connecta.ui` reports no `uiDiscarded` at all.
- Diagnostics: an accepted payload adds a `ui` byte aggregate distinct from
  `emitted`, and no aggregate appears when nothing was accepted.
- Independence: a truncated return value, emitted blocks, and a UI payload
  coexist in one response.
- `resources/read` serves exactly the shell URI with the correct mimeType and a
  valid HTML5 body, and fails on every other URI; `resources/list` is served
  and returns an empty list.
- The server capability declaration carries exactly one extension identifier,
  `io.modelcontextprotocol/ui`.
- `execute_code`'s metadata declares `_meta.ui.resourceUri` pointing at the
  shell URI, and all seven tools declare exact model-only visibility.
- The shell renders payload HTML in a sandboxed inner frame and exposes no
  bridge — asserted however the implementation can, at minimum that the shell
  source carries the `srcdoc` and sandbox attributes and contains no
  message-forwarding path from the inner frame to the host.
- `U1`–`U11` fold into `code-mode.md`, the `execute_code` description documents
  `connecta.ui`, and the suite takes its row in the
  [test map](../documentation/operations.md#the-test-map).
- `npm run check` passes.

The implementation issue (#277) carries these as acceptance criteria.
