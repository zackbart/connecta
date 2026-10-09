---
type: security
---

Redact submitted `writeOnly` argument values, including property names inside private objects and their encoded forms, from downstream results, errors, program returns, logs, and emits before they reach agents or result paging storage. JSON results stay valid, with matching numbers and booleans replaced by a placeholder string. Short private values redact only equal structured fields and withhold prose that contains them, so identifiers and approval state remain; empty strings are exempt. Matching is linear in the scanned text regardless of how many values are registered, and one bounded work budget per redaction withholds only the affected field.
