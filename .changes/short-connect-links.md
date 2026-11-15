---
type: changed
---

`/connect` links an MCP endpoint issues from a sealing vault are now short, such as `https://connecta.example.com/connect/notes_alice?h=<26 characters>`, so agents can relay them to people without corrupting them. The id is 128 random bits; Connecta stores the sealed, signed handoff in the connector's storage under the SHA-256 of the connector id and the id, so an id resolves only at its own connector's path, for the link's fifteen minutes and verifies a visit exactly as before: initiating user (another person gets 403), management permission, origin, expiry and single-use nonce. Unknown, altered, expired and spent ids get the same refusal after the same storage reads, whether or not the path names a configured connector or one sharing another's grant. When storage cannot record the handoff the link carries the sealed handoff itself, and sealed links already issued keep working until they expire.
