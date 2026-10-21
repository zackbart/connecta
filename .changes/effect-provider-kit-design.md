---
type: changed
---

Record the Effect provider kit design as decision 0010, with an internal prototype under `src/http/` that no entry reaches and the build does not emit, and guard the root graph against the kit, Effect's unstable area modules, and Effect members not tagged stable.

Fix the prototype's write capacity at tool construction, reserve each step/item atomically before preparation, and constrain every dispatched failure by its raw outcome. Preserve recorded 401 handoffs through body and auxiliary failures, and refuse suspended inexact or unsupported input schemas.

Adopt the core refusal contract while preserving whole-call write uncertainty across every step and blocked retry. Bind bulk item identities to snapshotted requests, abort pending transport when leases close, and require byte-identical B.5 step-1 migration after prerequisite back-ports.

Preserve duplicate query, form and JSON identifying keys in bulk bindings, rejecting undeclared multi-value semantics before dispatch. Settle pending capabilities and interrupt renewal on call/request closure.

Delete the temporary adapter: the prototype's transport enters every request in the core ledger before `fetch` and marks each failure with its own request's provenance, so `api()`'s boundary decides every kit write with #902's contract and the kit keeps only the decided 401 rule. A committed case table runs the kit and today's `api()` core over the same cases and requires the same verdicts; resend advice is a structured segment, the prototype declares decision 0011's `ProviderKitFacts`, and only the separate write-401 back-port remains before B.5.
