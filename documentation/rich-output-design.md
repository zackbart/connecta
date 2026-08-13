# Rich MCP output from programs — design record

The decision record for [#267](https://github.com/zackbart/connecta/issues/267):
whether and how an `execute_code` program may deliver MCP-native output — text,
images, audio — instead of only a single JSON return value. The verdicts live in
[`ethos.md`](../ethos.md); this document carries the argument, the contract
precisely enough to implement, and the shapes that were considered and refused.
The implementation landed via
[#270](https://github.com/zackbart/connecta/issues/270): the contract clauses
below (`M1`–`M10`) are now normative in [`code-mode.md`](./code-mode.md)'s
"Emitted output" section, which wins where the two disagree. This document
remains the argument and the record of rejected shapes.

## The problem

A program returns one JSON value, bounded at 24,000 serialized characters
(`R2`). That is the right contract for data: compose, project, return only what
you need. It is no contract at all for an image. Base64 is not projectable — a
program cannot "return less" of a screenshot — so any rich block a downstream
tool produces dies at the exit guard, converted to a truncation envelope whose
preview is the head of a base64 string, which is of use to no one.

The asymmetry is already visible in the direct-call surface. `call_tool` forwards
non-text downstream blocks to the client untouched when they fit the result cap
(the fix for issue #43 made the guard measure every block, then pass them
through in original order). And on the intake side, a host call **inside** a
program is not size-capped at all: `unwrapMcpResult` hands mixed content
through as a raw object, base64 and all. So today a downstream image survives
the trip *into* the sandbox and survives the explicit tool boundary — the one
place it cannot survive is the exit of the surface connecta calls primary.

## The shape: `connecta.emit(block)`

One new provider function. A program emits zero or more validated MCP content
blocks during its run; the host collects them request-locally and appends them
to the final `execute_code` result, after the JSON envelope, in emission order.

The single most load-bearing fact about this shape: **it does not touch the
executor contract.** `Executor.execute()` still returns
`{ result, error?, logs? }`, which is what keeps the interface structurally
compatible with `DynamicWorkerExecutor` from `@cloudflare/codemode` — a class
connecta does not control and must not fork. `emit` is a provider function like
`connecta.call`: both executors already bridge provider calls (QuickJS over
child-process IPC, the Dynamic Worker over isolate RPC), so emitted bytes cross
the guest boundary exactly once, as an argument, and are never seen again by
the sandbox, the `ExecuteResult`, or the `R2` guard. Executor parity is not a
test obligation bolted on afterward; it is structural. A third-party executor
that correctly bridges provider functions gets emission without writing a line.

### Contract (drafts for code-mode.md)

**M1.** `connecta.emit(block)` accepts exactly one MCP content block of type
`text`, `image`, or `audio`:

```
{ type: "text",  text: string }
{ type: "image", data: string /* base64 */, mimeType: string }
{ type: "audio", data: string /* base64 */, mimeType: string }
```

The shape is validated strictly at the call — required fields present, no
extra fields, no `annotations`, no `_meta`. An invalid block throws a
catchable error and nothing is accepted. Rejected, not stripped: silently
deleting fields would deliver something the program did not ask to emit.
There is no sugar form (`emit("text")` is invalid); sugar is how a
one-shape contract grows hair.

**M2.** Emitted blocks are collected on the host in emission order and
delivered only with a successful result: the response's `content` array is the
JSON envelope text block first, then the emitted blocks. When at least one
block was emitted the envelope gains `emitted: N`; when none were, the
response is byte-for-byte the ordinary path (the `R6` discipline).
`structuredContent` remains the JSON envelope alone — emission is a
presentation channel, not a second data channel.

**M3.** The return value and emission are independent. `R2` applies to the
return value exactly as before and never measures emitted bytes; a truncated
return value does not suppress emitted blocks, and emitted blocks do not
shrink the return budget.

**M4.** A program that ends in an error delivers no emitted blocks. The error
envelope reports `emittedDiscarded: N` when N > 0, so the discard is visible
rather than silent. Partial rich output from a failed program is ambiguity,
not a deliverable.

**M5.** Two budgets, both deployment-configurable, both failing loudly at the
`emit` call: an aggregate serialized-byte budget (default 4,000,000 bytes) and
a block count (default 32). An emit that would exceed either throws a
catchable error naming the budget and the room remaining; the block is not
partially accepted, and prior accepted blocks are unaffected. There is no
`get_result` stash and no paging: the program learns it is over budget while
it can still choose differently, which is `R4`'s spirit applied to bytes that
genuinely cannot be shrunk — refuse at the door instead of paging after the
fact.

**M6.** Connecta claims no provenance. Every emitted block is program output,
trusted exactly as much as the program's return value — no more because its
bytes happen to have come from a downstream call, no less because they were
assembled in the sandbox. Preserving a downstream image means re-emitting it:
the program selects the block from the raw downstream result (which reaches it
uncapped) and emits it. The host attaches no attribution.

**M7.** `emit` does not spend the host-call budget (`L4`). Its bounds are
`M5`'s and only `M5`'s.

**M8.** `ExecuteResult` is unchanged. Neither QuickJS, Dynamic Worker, nor a
third-party executor needs modification, and the parity suite runs the same
emitting program through both vitest projects and asserts identical delivered
content.

**M9.** Emission is request-local and unstreamed. Blocks exist only in the
finished response; nothing is pushed early, nothing survives the request, and
`emit` resolving means "accepted into the collection," never "delivered."

**M10.** Activity remains payload-free by construction. With
`diagnostics: true` the diagnostics block gains one aggregate — emitted block
count and serialized bytes — numbers only, per `R8`.

### Intake, specified

`unwrapMcpResult`'s current behavior becomes contract rather than accident: an
all-text downstream result is JSON-parsed when possible (as today), and a
result carrying non-text blocks passes through as the raw object, `content`
array intact, uncapped. That raw fallthrough is the preservation path `M6`
depends on. Bounding it would kill re-emission at intake; projecting it would
repeat the mistake `R1` refuses.

## Sizing rationale

The 24,000-character return boundary is a *context* budget — the return value
lands in the model's window as text. Emitted image and audio blocks do not:
MCP-aware hosts deliver them as media, which models ingest at media prices,
not base64-text prices. So the emission budget is a *transport* bound, not a
context bound, and 4,000,000 serialized bytes (roughly a 3 MB binary after
base64's 4/3 inflation — two or three real screenshots) is deliberately far
above `R2` without being a file-hosting ambition. Deployments that know their
client's limits tune it; the default just has to make `emit` useful for the
motivating case without inviting anyone to ship video through an MCP response.

## Security posture

- **Nothing is minted.** `emit` grants no authority: it cannot cause a fetch,
  reference a credential, or make the host serve anything. It moves bytes the
  program already had into the response.
- **Strict typing is the lure defense.** The block validator accepting only
  `text`, `image`, and `audio` is what keeps a program from emitting a
  `resource_link` whose URI a helpful client might dereference. The refused
  types are refused precisely because they are pointers, and pointers get
  followed.
- **Image-borne injection is the existing class.** A downstream screenshot
  containing hostile text is the same hazard through `emit` as through
  `call_tool`'s block passthrough today; connecta's posture is unchanged — all
  tool output is untrusted input to the client, and connecta adds no claim
  otherwise.

## Considered and refused

**A sentinel return shape** (`return { $mcpContent: [...] }`). Overloads the
one data channel with a magic key that collides with honest data, subjects
rich blocks to the `R2` guard they cannot survive, and turns "what did this
program return" into a parse question. The return value stays a value.

**Widening `ExecuteResult` or the `Executor` interface.** The obvious place
and the wrong one: the interface's value is that `@cloudflare/codemode`'s
executor already satisfies it. A `content` field connecta added would either
fork the Workers executor or wait on a vendor; and every third-party executor
would need matching surgery. Refused as a class, not just deferred.

**Provenance-preserving handles** (downstream blocks stay host-side; the guest
gets `{ $ref }` tokens to pass to `emit`). Honest attribution, but it creates
host-side object identity that generated code holds references to —
capability-shaped machinery in the one place the ethos says generated code
mints nothing. And the label buys nothing: no MCP client trusts a tool result
more because an aggregator vouches for its lineage. Re-emission delivers the
same bytes with a simpler story: everything a program emits is program output.

**`resource` and `resource_link` emission.** Connecta already refuses to
aggregate resources; letting programs emit them would introduce through the
back door a surface the front door refused, and a guest-minted URI is a lure
(see the posture above). A future argument would have to be a new one.

**A `get_result` stash for over-budget emissions.** Paging exists for
downstream payloads a model could not shrink; an over-budget emission is a
program decision that has not happened yet. Failing the `emit` call while the
program can still adapt beats stashing megabytes nobody may page.

**Streaming or partial delivery.** Standing invariant — no server push,
nothing request-bound survives the request. Emission is collect-then-deliver
by construction (`M9`).

**Delivering emissions from failed programs.** The blocks may describe a world
the error contradicts. Failure delivers the error, the logs, and an honest
count of what was discarded (`M4`).

## Verification sketch

- Parity: one emitting program, both vitest projects (`WORKERS_SUITES`),
  identical delivered content arrays.
- Validation: each rejected shape (missing field, extra field, `annotations`,
  unknown type, bare string) throws catchably and accepts nothing.
- Budgets: byte and count budgets fail at the crossing call, prior blocks
  intact; error names the budget.
- Independence: over-`R2` return value + emitted blocks → truncation envelope
  *and* delivered blocks in one response.
- Discard: throwing program with prior emits → error envelope with
  `emittedDiscarded`, no blocks in `content`.
- Byte-for-byte: a program that never emits produces today's exact response.

The implementation issue carries these as acceptance criteria; the clauses
fold into `code-mode.md` under a new "Emitted output" section when it closes,
and the suite takes its row in the [test map](./operations.md#the-test-map).
