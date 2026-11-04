---
status: accepted
date: 2026-11-04
issues: [703]
supersedes: []
---

# Native names bind their classification

[0015](./0015-native-tools-and-agent-identity.md) accepted current-verdict
routing: a call to a tool cached as a read that had since become a write ran as a
write, without a fresh approval. That record weighed stale approval, one call
running under an out-of-date approval. It did not consider replay.

A real host can resend a call on its own. Claude Code 2.1.318 retries calls it
believes are read-only after a connection failure, including calls Connecta already
answered. Against a real Worker with a scripted model, a native tool cached as a
read that had become a write was written twice for some records, in 3 of 3 runs.
The evidence and matrix are in
[PR #1339](https://github.com/zackbart/connecta/pull/1339). Connecta never resent
anything, so INV-9's wording held, but the physical effect was a duplicate write.

Replayed calls restart their JSON-RPC ids and carry no session id, because the
protocol is stateless. Request-identity dedupe cannot separate them from a
deliberate second call.

## Decision

**A write has a different wire name from a read, and the name selects the route.**
A name is a pure function of connector id, tool name and classification. A cached
read name takes the `call_tool` route, which already refuses a current write before
dispatch. It is never routed to the write path, and resending it changes nothing.
The write runs by its own name, annotated destructive.

Writes are `<connector>__WRITE__<tool>`. Reads keep `<connector>__<tool>`, so
existing read recipes and pools keep working.

- **The marker sits before the tool.** Eve displays a name's last `__` segment, so
  a `__write` suffix would show every write as "write". The tool name stays the
  last segment, and the connector stays the first.
- **The marker cannot be a read's name.** Reads and writes share one namespace, so
  the two sets must be disjoint, or a cached read name could later select an
  unrelated write. A suffix such as `_w` or `_write` is a legal tool name, and
  `drive_api_write` is a real one. Connector ids have no uppercase and a plain tool
  has no `__`, so no plain read contains `__WRITE__`. A hashed read could, only for
  a tool whose own name contains that text, and it is lowercased there. That is the
  one read name this decision changes.
- **A tool claims both names** whichever it is now. A cached name then still finds
  its tool to refuse with a useful `nextAction`, and a collision does not appear
  and disappear with a classification.
- **Hashed writes keep the marker** within the 48-character budget, with up to 24
  characters of connector id and the same address hash as the read.

The other direction runs: a cached write name whose tool is now a read stays on the
`call_destructive_tool` route. The host approved more than the call needs and does
not resend it, so a refusal would only add a failure.

Alternatives rejected: refusing a stale read while keeping one name cannot work,
because a single name cannot say what the host cached. Version-bound approval
grants and request-identity dedupe need state the protocol does not carry.

## Evidence

Real Claude Code 2.1.318 against a real Worker with a scripted model and a fake
vendor counting physical calls, three runs per tree, identical in all three. Before
is main with the reproduction from PR #1339; after adds this change.

| Case                               | Before: host calls | Before: physical | Before: duplicated | After: host calls | After: physical | After: duplicated |
| ---------------------------------- | ------------------ | ---------------- | ------------------ | ----------------- | --------------- | ----------------- |
| Native, read flipped to write      | 6                  | 6                | 2 records          | 6                 | 0               | none              |
| Native, always a write             | 4                  | 4                | none               | 4                 | 4               | none              |
| `call_tool` with a flipped tool    | 8                  | 0                | none               | 8                 | 0               | none              |
| `execute_code` with a flipped tool | 4                  | 4                | none               | 4                 | 4               | none              |

The host still resends, and the refusal is what changed. The always-a-write case
ran under `crm__set_status` before and `crm__WRITE__set_status` after. Eve and Codex
were not run through this reproduction; Eve's name handling was read from its source.

## Consequences

This is breaking for anything hardcoding a native write's name. Hosts must refresh
their list before calling a write, and the refusal says so.

A deployment override of a source write to read is out of scope and unchanged: it
has a read's name, a host may replay it, and the same holds for `call_tool` on the
meta surface. An owner decision is pending. Connecta's verdict is also only as
fresh as its catalog, so a downstream flip is enforced once Connecta loads it.

Reconsider if a supported host case-folds or rewrites tool names, or adds its own
replay of destructive-annotated calls.
