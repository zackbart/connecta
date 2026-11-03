---
type: changed
breaking: true
---

`createConnecta` throws when a configured vault lacks `seal` or `open` and any connector has `startAuth`, replacing a startup warning that left downstream OAuth tokens, client registrations and PKCE verifiers as plaintext beside encrypted credentials. To migrate, use `encryptedCredentialVault(storage, key)` or add both methods to the custom vault; grants already stored as plaintext are sealed on first read. `encryptedCredentialVault`, deployments with no vault, and non-sealing vaults with no OAuth connector are unaffected.
