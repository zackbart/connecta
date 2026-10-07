---
type: fixed
---

End `execute_code` at the first host call beyond its budget with one typed
`budget_exceeded` error, even when the program catches and ignores failures.
The host suspends the refusing bridge call, closes further host access, and
releases the sandbox lease. The failure reports payload-free attempted,
admitted, succeeded, and failed host-call counts (#704).
