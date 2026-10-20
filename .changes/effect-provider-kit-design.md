---
type: changed
---

Record the Effect provider kit design as decision 0010, with an internal prototype under `src/http/` that no entry reaches and the build does not emit, and guard the root graph against the kit, Effect's unstable area modules, and Effect members not tagged stable.

Fix the prototype's write capacity at tool construction, reserve each step/item atomically before preparation, and constrain every dispatched failure by its raw outcome. Preserve recorded 401 handoffs through body and auxiliary failures, and refuse suspended inexact or unsupported input schemas.

Adopt the core refusal contract while preserving whole-call write uncertainty across every step and blocked retry. Bind bulk item identities to snapshotted requests, abort pending transport when leases close, and require byte-identical B.5 step-1 migration after prerequisite back-ports.

Preserve duplicate query, form and JSON identifying keys in bulk bindings, rejecting undeclared multi-value semantics before dispatch. Settle pending capabilities and interrupt renewal on call/request closure. Delegate write verdicts to #902's core contract through one temporary adapter; keep 404/409/timeout fields and privacy descriptions identical, leaving only the separate write-401 back-port before B.5.
