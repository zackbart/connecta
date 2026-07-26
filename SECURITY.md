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

`@modelcontextprotocol/sdk@1.29.0` declares `@hono/node-server` 1.x, which is
covered by `GHSA-frvp-7c67-39w9`. The advisory affects Hono's Windows
`serve-static` implementation. Connecta does not import that adapter or serve
static files through Hono. npm's suggested fix downgrades the MCP SDK below
security behavior Connecta relies on, so the package instead pins
`@hono/node-server` to 2.x through an `overrides` entry and keeps SDK 1.29.0.

Because npm only applies `overrides` to the root project, that pin governs this
repository's own installs rather than trees built by consumers of the published
package. The override is removed once the SDK declares `@hono/node-server` ^2
upstream.
