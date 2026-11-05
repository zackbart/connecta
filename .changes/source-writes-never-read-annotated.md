---
type: changed
breaking: true
---

A deployment `classification` override to `"read"` no longer applies to a tool whose source explicitly declares a write (`readOnlyHint: false`, `destructiveHint: true`, or contradictory hints). Such a tool stays a write on every surface and is never served read-annotated, because a host may resend a read-annotated call after a connection failure, which duplicated physical writes. Where the source is silent, `"read"` still serves as a read, and setting it asserts the call is safe to repeat.

**Migration:** if you overrode a vendor-declared write to `"read"`, an operator warning now names that override once per catalog change. Its calls prompt on hosts that prompt, and a direct `call_tool` is refused with the next step, naming `call_destructive_tool`. Native pools list it as destructive. Read-only endpoints and connectors omit and refuse it, so a read-only pool loses it. Remove the override, or, if you have checked the tool and a repeat is harmless, change it to `"read-repeatable"`. `"write"` and `"hidden"` overrides are unchanged.
