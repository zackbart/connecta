---
type: security
---

The Node adapter answers `400` for a `Host` that is not a host with an optional port, an `X-Forwarded-Proto` other than `http` or `https`, or a request target that does not start with `/`, before reading any body. No such value can change the path or host routes see. A malformed value used to fail as a `500` or be parsed into another URL.
