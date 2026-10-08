---
type: changed
breaking: true
---

**Downstream OAuth state is one grant record per owner and one flow record per
consent.** Each OAuth connector's owner has one `oauth:grant` record (epoch,
the latest consent's state digest, and one authorization server's client,
tokens, and discovery, sealed as one body with the vault), and each consent
has an `oauth:flow:<sha256(state)>` record expiring with its link. Every grant
write is a compare-and-set against the record it read, and Restart and
Disconnect replace the epoch in one, so the epoch namespaces, cleanup lineage
(`oauth:generation`, `oauth:cleanup:`, `oauth:cleanup-at:`), grace sweeps, and
flow-entry grant retirement are gone. A grant holds one server: saving
discovery, a client, or tokens for another replaces it. The refresh
coordinator stores an accepted rotation before releasing anyone and hands
later readers that result; the 503 "previous credentials commit" answer is
gone. The first read of each owner's grant migrates the 0.28 layout once and
deletes it: issuer-stamped client, tokens, and discovery carry over (sealed
values reopen under their old keys); a disconnected connector stays
disconnected; grants from v0.8.1 and earlier and pending consents do not, so
reissue pending Connect links after upgrading. Rolling back needs consent
again. A programmatic `finishAuth` names its consent by the callback's
`state`; one that names no pending consent is refused before anything is sent
(#707).
