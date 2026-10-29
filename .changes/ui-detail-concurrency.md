---
type: changed
---

The operator page now reads up to eight connector details at once instead of four, so a page of up to eight connectors loads in one round. With 500 ms of downstream latency, a 10-connector page settles in about 2.4 s warm and 3.6 s cold instead of 3.0 s and 5.0 s. Each tab still reads every connector once per load, and detail reads do not count against `admission.requests`.
