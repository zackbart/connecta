/**
 * Syntactic destination checks for URLs a downstream hands connecta to fetch.
 *
 * A remote MCP server's OAuth metadata names further URLs — authorization
 * servers, token and registration endpoints — that connecta then requests
 * server-side. Config is the security model: the connector's configured
 * origin is trusted because an operator wrote it down. Everything else was
 * learned from the downstream, and a compromised downstream must not be able
 * to steer connecta at the host's own network (cloud metadata, a LAN admin
 * panel, a sidecar on loopback).
 *
 * The check is by syntax only. The WHATWG URL parser has already folded every
 * legacy IPv4 spelling (`2130706433`, `0x7f.1`, `0177.0.0.1`) into dotted
 * decimal and every IPv6 literal into compressed hex, so one canonical form is
 * all this module reads. It never resolves a name: that needs DNS, which the
 * Workers-safe core cannot do, and a name that resolves somewhere private — or
 * rebinds after the check — is out of scope. Pure Web API, no `node:` import.
 */

/**
 * `loopback` reaches this host; `private` reaches this host's networks or is
 * not a global destination (RFC 1918, link-local, carrier-grade NAT,
 * unique-local, unspecified, and special-purpose or reserved space); `public`
 * is everything else, including every name that is not `localhost`.
 */
export type HostClass = "loopback" | "private" | "public";

function classifyIpv4(octets: readonly number[]): HostClass {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 127) return "loopback";
  if (
    a === 0 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol, documentation
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224 // multicast, reserved, broadcast
  ) {
    return "private";
  }
  return "public";
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET = /^[0-9a-f]{1,4}$/;

function ipv4Octets(host: string): number[] | undefined {
  const match = IPV4.exec(host);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

/** Eight 16-bit pieces of a bracketed IPv6 literal, or undefined. */
function ipv6Pieces(host: string): number[] | undefined {
  const body = host.slice(1, -1);
  const halves = body.split("::");
  if (halves.length > 2) return undefined;
  const pieces = (part: string | undefined): number[] | undefined => {
    if (!part) return [];
    const parsed = part.split(":").map((piece) => (HEXTET.test(piece) ? Number.parseInt(piece, 16) : Number.NaN));
    return parsed.some(Number.isNaN) ? undefined : parsed;
  };
  const head = pieces(halves[0]);
  const tail = pieces(halves[1]);
  if (!head || !tail) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return undefined;
  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}

function classifyIpv6(pieces: readonly number[]): HostClass {
  const [p0 = 0, p1 = 0, p2 = 0, p3 = 0, p4 = 0, p5 = 0, p6 = 0, p7 = 0] = pieces;
  const v4 = (high: number, low: number) => classifyIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  // A transitional form reaches, at most, the IPv4 address it carries. Only a
  // mapped address can reach this host, so only it stays `loopback`; every
  // other non-public carrier is `private`, keeping it out of a loopback
  // connector's learned URLs.
  const carried = (high: number, low: number): HostClass => (v4(high, low) === "public" ? "public" : "private");
  const zeros = p0 === 0 && p1 === 0 && p2 === 0 && p3 === 0;
  if (zeros && p4 === 0) {
    if (p5 === 0xffff) return v4(p6, p7); // ::ffff:a.b.c.d mapped
    if (p5 === 0) {
      if (p6 === 0 && p7 === 1) return "loopback"; // ::1
      return carried(p6, p7); // :: and ::a.b.c.d compatible
    }
  }
  if (zeros && p4 === 0xffff && p5 === 0) return carried(p6, p7); // ::ffff:0:a.b.c.d translated
  if (p0 === 0x64 && p1 === 0xff9b && p2 === 0 && p3 === 0 && p4 === 0 && p5 === 0) return carried(p6, p7); // NAT64
  if (p0 === 0x2002) return carried(p1, p2); // 6to4
  // Global unicast is 2000::/3. Outside it: unique-local, link-local,
  // site-local, multicast, local-use NAT64, reserved. Inside it, special-purpose
  // 2001::/23 and documentation 2001:db8::/32 and 3fff::/20 are not destinations.
  if ((p0 & 0xe000) !== 0x2000 || (p0 === 0x2001 && (p1 < 0x200 || p1 === 0xdb8)) || (p0 === 0x3fff && p1 < 0x1000)) {
    return "private";
  }
  return "public";
}

/**
 * The hostname the WHATWG parser settles on. Idempotent for a `URL.hostname`;
 * anything else — a bare IPv6 literal, a legacy IPv4 spelling — is folded the
 * same way the parser would fold it on the way to a fetch.
 */
function canonicalHost(hostname: string): string | undefined {
  if (/[/\\?#@]/.test(hostname)) return undefined;
  const bracketed = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  try {
    return new URL(`http://${bracketed}/`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Classify a URL host by syntax. A host that does not parse is `private`:
 * the check fails closed rather than guessing.
 */
export function classifyHost(hostname: string): HostClass {
  const host = canonicalHost(hostname);
  if (!host) return "private";
  if (host.startsWith("[")) {
    const pieces = ipv6Pieces(host);
    return pieces ? classifyIpv6(pieces) : "private";
  }
  const octets = ipv4Octets(host);
  if (octets) return classifyIpv4(octets);
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (name === "localhost" || name.endsWith(".localhost")) return "loopback";
  return "public";
}

/**
 * Why connecta must not fetch `target`, a URL the downstream advertised, for a
 * connector configured at `configured` — or undefined when it may.
 *
 * - The configured origin is trusted outright: the operator chose it.
 * - Anything else must be `https` on a host that is not private by syntax.
 * - A loopback-configured connector (local development) may also learn
 *   loopback URLs, over `http` too, so a local MCP server with a local
 *   authorization server keeps working. It still may not learn a LAN or
 *   link-local address.
 *
 * The reason names only the host, never the path, query, or credentials a
 * learned URL may carry.
 */
export function learnedUrlRefusal(configured: URL, target: URL): string | undefined {
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return `${target.host || "the target"} uses ${target.protocol}, not HTTPS`;
  }
  if (target.origin === configured.origin) return undefined;
  const targetClass = classifyHost(target.hostname);
  if (targetClass === "loopback" && classifyHost(configured.hostname) === "loopback") {
    return undefined;
  }
  if (targetClass !== "public") {
    return `${target.host} is a private, loopback, or link-local address`;
  }
  if (target.protocol !== "https:") return `${target.host} is not HTTPS`;
  return undefined;
}
