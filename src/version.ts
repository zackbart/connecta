/**
 * The package version, as a Workers-safe constant — no filesystem read, no
 * import assertion. `test/version.test.ts` asserts it matches package.json, so
 * a bump that forgets this file fails the build rather than shipping a stale
 * version to `/health` and to downstream MCP handshakes.
 */
export const CONNECTA_VERSION = "0.22.0";
