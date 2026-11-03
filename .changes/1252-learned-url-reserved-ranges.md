---
type: security
---

Learned OAuth URLs naming reserved or transitional addresses are refused: IPv4 special-purpose ranges (`192.0.0/24`, `198.18/15`, multicast, reserved and broadcast among them), IPv6 outside global unicast, and IPv4 carried in compatible, translated, NAT64 or 6to4 form, judged by the address it carries. A public address in those forms stays public. A `publicUrl` on such an address no longer offers a self-hosted client metadata document.
