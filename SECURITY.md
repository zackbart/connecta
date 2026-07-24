# Security

## Supported versions

Security fixes are applied to the latest published minor release.

## Reporting a vulnerability

Please report suspected vulnerabilities through GitHub's private security
advisory flow for this repository. Do not include secrets, credentials, or
sensitive payloads in a public issue.

## Dependency policy

CI blocks high and critical production dependency advisories. Moderate findings
are reviewed for reachability and recorded when an upstream package has not yet
released a compatible fix.

The initial release has one such upstream finding:
`@modelcontextprotocol/sdk@1.29.0` declares `@hono/node-server` 1.x, which is
covered by `GHSA-frvp-7c67-39w9`. The advisory affects Hono's Windows
`serve-static` implementation. Connecta does not import that adapter or serve
static files through Hono. npm's suggested fix downgrades the MCP SDK below
security behavior Connecta relies on, so the package retains SDK 1.29.0 while
tracking an upstream compatible release.
