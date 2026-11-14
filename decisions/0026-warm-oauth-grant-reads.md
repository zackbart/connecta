---
status: accepted
date: 2026-11-14
issues: [1424, 1220]
supersedes: []
---

# One fresh grant read per acting stage on warm OAuth calls

Production traces (#1220) showed a warm OAuth `remoteMcp()` call making 11
sequential D1 reads in its catalog span against 3 for a non-OAuth connector.
The extra reads were downstream OAuth grant reads. The request-read budget
fixture counted 9 on a modern downstream and 12 on a legacy (session) one. Each
was fresh, but several did not protect anything the next fresh read did not
already protect.

## Decision

Every guarantee rests on the last fresh grant read before the action it
protects: serving a catalog, admitting a call, sending a message, keeping a
client whose handshake sent a token. A read that only addresses an entry or
binds an epoch reuses a fresh read this request already made, with nothing sent
in between. A read that sits beside another read of a different key at the
same moment joins it in one statement.

| Read (before)                              | Modern | Legacy | Guarantee                                                 | Now                                       |
| ------------------------------------------ | -----: | -----: | --------------------------------------------------------- | ----------------------------------------- |
| Partition snapshot in the catalog read     |      1 |      1 | None: derives cache and negotiation addresses             | Kept                                      |
| Connectionless listing address identity    |        |      1 | None: addresses only, acceptance re-reads                 | Pinned to the snapshot's digest           |
| Connect `beginFlow` epoch                  |      1 |      1 | Restriction: later bound reads refuse another epoch       | Bound from the snapshot or admission read |
| Post-connect epoch check                   |      1 |      1 | Discard a client whose handshake crossed a re-auth        | Only after a connect that sent a message  |
| Connection listing address identity        |      1 |        | None: addresses only, acceptance re-reads                 | Pinned to the snapshot's digest           |
| Acceptance identity, then generation fence |      1 |      1 | Rotated or disconnected grant never serves its catalog    | Joined to the fence in one statement      |
| Admission disconnect check                 |      1 |      1 | Disconnect refuses the next call, typed                   | Merged with the admission token read      |
| Admission token read                       |      1 |      1 | Absent tokens refuse; expiry, scope, replacement renew    | One admission read                        |
| Open connection's epoch check              |      1 |        | Reconnect a client from an older epoch                    | Uses the admission read                   |
| SDK token read before each message         |      1 |      5 | The sent credential is current; disconnect refuses a send | Kept, every message                       |

Warm round trips fall from 12 to 6 (modern) and 15 to 11 (legacy); non-OAuth
calls are unchanged. The remaining extra trips over a non-OAuth call are the
partition snapshot, admission, and one SDK read per message.

The arguments:

- **Binding only restricts.** A bound flow's every read and write fails once
  another epoch is live, and epochs never recur. A binding older than storage
  can therefore only refuse with a retryable "authorization changed", never
  send another epoch's grant. A connectionless acceptance that finds a
  different grant than its snapshot drops the snapshot, so the fallback connect
  reads the epoch and recovers transparently, as before.
- **Addresses authorize nothing.** The listing's identity already only located
  entries; acceptance and publication compared it with a fresh read. Using the
  snapshot's digest changes which entry is probed, never what is served.
- **One statement is one moment.** Acceptance read the identity and then the
  generation; reading both in one SELECT is a consistent snapshot at the
  earlier read's time, with nothing acted on in between.
- **Merged admission.** #1227 kept a separate token read because a token
  removed between it and the SDK's read made the SDK send without
  Authorization. #1230 then made the transport refuse every tokenless MCP send
  on a passive OAuth path, with typed recovery and undispatched provenance.
  Two adjacent reads with nothing between them only narrowed a window the
  transport now closes; the token read alone carries the disconnect check.
- **Nothing sent, nothing to discard.** A modern connect with a stored verdict
  sends no message, so no credential left with it and the post-connect epoch
  check has nothing to protect.

Rejected:

- **Reusing admission's read for the SDK's dispatch read.** It would move the
  bound for a revoked or invalidated token from the send to admission.
- **An isolate hint for the partition snapshot**, in the manner of #1382's
  revision hints: remember the last epoch and token digest per grant, put the
  grant row in the locating statement, and fall back on a mismatch. It would
  save one more trip but holds credential-derived state across requests and
  adds a speculative path to the catalog read. It stays open for a later PR
  with production numbers that justify it.
- **An epoch-only fence.** Token removal, expiry, scope and replacement change
  without advancing the epoch, so an epoch read cannot replace a token read.

## Consequences

A rotation, disconnect or same-epoch invalidation is still refused or adopted
at the same stages, before anything is sent with a stale credential. The window
between a binding and its first fresh read is now wider. A rotation that lands
in it is refused as retryable instead of reconnected transparently, as one
landing just after the old binding read already was. Budgets in
`test/request-reads.node.test.ts` pin the new counts and inject changes at the
acceptance, admission and dispatch boundaries. A production trace after an
authorized deployment should show the lower `d1.read` count; if a deployment
sees retryable "authorization changed" refusals after rotations, revisit the
binding reuse.
