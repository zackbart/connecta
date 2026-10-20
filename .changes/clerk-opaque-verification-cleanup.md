---
type: fixed
---

`clerkAuth`'s extra Backend API verification of an opaque OAuth access token now ends its request and response body on every outcome, including an error status, an oversized body, a caller that leaves, and the ten-second deadline. It previously left the request open and the body unread after an error status, and read a body of any size; the response is now read as bytes and refused past 64 KiB.
