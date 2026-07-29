# Security

## Supported versions

Security fixes are applied to the latest published minor release.

## Reporting a vulnerability

Please report suspected vulnerabilities through GitHub's private security
advisory flow for this repository. Do not include secrets, credentials, or
sensitive payloads in a public issue.

## Dependency policy

CI blocks moderate, high, and critical production dependency advisories. Lower
findings are reviewed for reachability and recorded when an upstream package has
not yet released a compatible fix.

The MCP TypeScript SDK 2.x packages are exact-pinned. The split client and
server packages no longer install Hono or `@hono/node-server`, so the temporary
root-project override used with SDK 1.x is gone. A dependency bump must pass
both `npm run release:check` and the Node/Workers runtime suites before the pin
moves.
