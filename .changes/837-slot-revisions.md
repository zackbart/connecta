---
type: changed
breaking: true
---

Agent token slots carry an opaque `revision` that changes on every commit to the slot (issue, rotate, revoke, adopt). `GET /ui/access-tokens`, the slot each mutation returns, and operator contract v2's `OperatorAgent.token` list it. Breaking: `POST` (issue or rotate) and `DELETE` (revoke) `/ui/access-tokens/<agent>` now require `{ "expect": "<revision>" }` as a JSON body (`DELETE` also takes `?expect=<revision>`); a missing or malformed `expect` is 400, and a slot whose revision differs is 409 `{ error, code: "slot_changed" }` before anything is minted or written. The slot's compare-and-set commits only from the slot with that revision, so a change landing between the read and the commit refuses the same way instead of being overwritten or revoked. `AccessTokenManager.rotate`, `revoke`, and `adopt` take the same optional `expect`; without it they behave as before. Each revocation stores a random, non-secret `revocationId`, so no two revocations store the same slot and a call recognizes only its own: of two conditional revocations of one slot, exactly one succeeds and the other is 409 `slot_changed`.
