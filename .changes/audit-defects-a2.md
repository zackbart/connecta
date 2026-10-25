---
type: security
breaking: true
---

Preserve one-attempt write behavior and conservative unknown outcomes across HTTP providers, custom connectors and remote MCP. Credential renewal, redirects and recovery handoffs cannot replay a dispatched write or erase its uncertainty. Reads retain their supported recovery paths. Apply the configured sensitive-field policy before returning provider results and retain caller, admission and redaction context across provider boundaries. See the [0.35 provider migration](https://github.com/zackbart/connecta/blob/main/documentation/provider-migration-0.35.md) for provider-specific behavior changes.
