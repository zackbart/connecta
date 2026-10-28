---
status: accepted
date: 2026-10-23
issues: [703]
supersedes: []
---

# Keep the REST family's pinned operation index

## Decision

Stripe, Vercel, Cloudflare, Notion and Mixpanel retain their pinned, compact
operation indexes during C.6. Adapt dispatch, errors, value safety and tool
construction to the Effect provider kit. Typed operations serve probes and
named dispatch where the adapter uses the typed client. Stripe's probe uses
`getAccount`; its named account and balance tools use `sendStripe` and
`Connection.sendPath`, as its generic hatches do. Its `getBalance` declaration
does not imply typed dispatch. Generic hatches retain
`OperationIndex.resolve/check`. Derive manifest operations from the same index,
with canonical vendor parameter names and no second operation list.

Do not adopt `@effect/openapi-generator` as the family's contract compiler.
Keep the existing shrink settings, full-document pins, response-based safety
candidate generation and endpoint contract digests. Value-safety reviews remain
independent of the schema compiler. Step 1 preserves the existing catalog,
wire and result bytes; surface changes belong to step 2.

## Evidence

The spike compared the 64 shipped Notion operations and 14 Cloudflare
operations using Effect and generator 4.0.5. The generator supports the kit's
`effect/http-api` imports, but unmodified vendor inputs failed on request
intersections. A single Cloudflare DNS-list control generated code with 21
strict TypeScript errors from a literal TTL branch's example.

Normalizing the actual shipped compact request contracts allowed generation,
but 30 targeted cases still showed 10 accept/reject differences with strict
excess-property checks (12 with default decoding). Scalars, extra properties,
path parameters and encoded JSON property order differed. Both adapters kept
the index to preserve hatch validation and wire bytes. Generated source grew
4.37–5.70 times; marginal API-entry gzip grew 11,371 bytes for Notion and
1,982 for the Cloudflare slice. Size alone does not decide this.

Cloudflare's full document matched its pin and reproduced the shipped index.
Notion's unversioned URL had drifted, so raw-input trials used the current
document restricted to the original operations; successful comparisons used
the shipped index's actual contracts. These were scratch adapter experiments,
not complete provider migrations or evidence of full-family parity.

## Consequences

The shared bridge must preserve index search, repair hints, ordering, framing,
cursors and redaction before projection. Check manifest/index operation-set
equality and keep bulk declaration construction lazy; measure full Cloudflare
catalog and first-call costs before its migration merges. Existing provider
goldens and an independent edge matrix remain the migration evidence.

Reconsider generation for a smaller new API, or when the generator can consume
the pinned contracts and preserve their behavior without another compatibility
compiler. Keep Effect pinned exactly: its HTTP area modules remain unstable.
