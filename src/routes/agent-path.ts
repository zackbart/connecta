// Agent endpoint paths (#837, decisions/0006). Cloudflare Access bypasses
// `/agent/*` at the edge after resolving dot segments, folding case, decoding
// unreserved escapes, and collapsing a leading `//`, while the Worker sees
// the raw pathname. So connecta claims every path Access might treat as
// `/agent/*`, and admits only the one exact, raw spelling of a pool.

/** Pool names, as `createConnecta` validates them. */
const POOL_NAME_RE = /^[a-z0-9_-]+$/;
/** Escapes decoded before giving up and treating the path as an agent path. */
const MAX_DECODE_ROUNDS = 8;

/**
 * The pool an agent endpoint names, or undefined. The raw pathname must be
 * byte-equal to `/agent/` plus a well-formed pool name: no decoding, case
 * folding, slash collapsing, trailing slash, extra segment, or `%`.
 */
export function agentEndpointPool(path: string): string | undefined {
  if (!path.startsWith("/agent/")) return undefined;
  const pool = path.slice("/agent/".length);
  return POOL_NAME_RE.test(pool) ? pool : undefined;
}

/**
 * Whether a pathname belongs to the agent namespace: anything that starts
 * with `/agent` once every escape is decoded, case is folded, and slashes are
 * collapsed. This is deliberately wider than Access's own matching, so no
 * path the edge bypasses can fall through to a human route.
 */
export function isAgentPath(path: string): boolean {
  let value = path;
  for (let round = 0; value.includes("%"); round++) {
    // Still encoded after the bound: refuse it with the agent 404.
    if (round === MAX_DECODE_ROUNDS) return true;
    const decoded = value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (decoded === value) break;
    value = decoded;
  }
  return value
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .toLowerCase()
    .startsWith("/agent");
}
