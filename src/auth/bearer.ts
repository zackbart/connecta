import { validIdentityReference } from "../identity.js";
import { assertNoRetiredToolkitOptions } from "../retired-toolkits.js";
import type { AuthResult, InboundAuth } from "../types.js";

const encoder = new TextEncoder();

/** Constant-time byte comparison. Differing lengths still iterate to reduce leak. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    let r = 1;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) r |= (a[i] ?? 0) ^ (b[i] ?? 0);
    return false;
  }
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return r === 0;
}

/**
 * Lets the holder of this one secret name the user each request acts for.
 * Meant for a trusted agent platform that sets the header from its own
 * authenticated session, outside model control.
 */
export interface AssertedPrincipalOptions {
  /**
   * Request header carrying the principal id, matched case-insensitively as
   * every HTTP header is. Must be an RFC 9110 token and not a header another
   * layer already owns (`Authorization`, `Cookie`, `Host`, `Origin`, …).
   */
  header: string;
  /**
   * Identity namespace the asserted ids land in. It becomes the principal's,
   * the subject's, and the activity actor's namespace, so keep it stable:
   * changing it selects different personal partitions.
   */
  namespace: string;
  /**
   * Deployment policy for which ids this secret may act for, e.g. one email
   * domain. Receives the id verbatim (surrounding whitespace aside); only a
   * literal `true` admits, and a throw refuses. An id containing a comma is
   * refused before this runs, because a comma is how HTTP joins a repeated
   * header.
   */
  accept(id: string): boolean | Promise<boolean>;
}

export interface BearerTokenOptions {
  /** Stable identity for this credential, used on activity events. */
  subjectId?: string;
  /**
   * Honor a principal named in `header`, but only on requests carrying this
   * secret. A matching secret with a missing, malformed, or unaccepted
   * principal is refused outright rather than admitted as the bare credential.
   * Exclusive with `subjectId`: the asserted user is the subject.
   */
  assertedPrincipal?: AssertedPrincipalOptions;
}

// The RFC 9110 token grammar (section 5.6.2).
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Headers whose meaning another layer already owns. Reading an identity out of
// one would let that layer's value double as a principal.
const RESERVED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "origin",
]);
const ASSERTED_PRINCIPAL_KEYS = new Set(["header", "namespace", "accept"]);

function assertedPrincipalHeader(options: AssertedPrincipalOptions): string {
  if (typeof options !== "object" || options === null) {
    throw new Error("bearerToken assertedPrincipal must be an object");
  }
  for (const key of Object.keys(options)) {
    if (!ASSERTED_PRINCIPAL_KEYS.has(key)) {
      throw new Error(`bearerToken assertedPrincipal has unknown option "${key}"`);
    }
  }
  const { header, namespace, accept } = options;
  if (typeof header !== "string" || !HEADER_NAME_RE.test(header)) {
    throw new Error("bearerToken assertedPrincipal.header must be an HTTP header name");
  }
  const name = header.toLowerCase();
  if (RESERVED_HEADERS.has(name)) {
    throw new Error(
      `bearerToken assertedPrincipal.header cannot be "${header}"; that header already means something else`,
    );
  }
  if (!validIdentityReference({ namespace, id: "x" })) {
    throw new Error(
      "bearerToken assertedPrincipal.namespace must be 1-256 printable, non-space ASCII characters",
    );
  }
  if (typeof accept !== "function") {
    throw new Error(
      "bearerToken assertedPrincipal.accept is required; an assertion with no policy would admit any id",
    );
  }
  return name;
}

function unauthorized(): AuthResult {
  return {
    ok: false,
    response: new Response(
      JSON.stringify({ error: "unauthorized" }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          // A configured secret has no OAuth metadata or issuer to
          // advertise; interactive adapters own resource discovery.
          "WWW-Authenticate": "Bearer",
        },
      },
    ),
  };
}

// The secret matched, so this is a verdict on the request rather than a
// non-match: `final` stops the server from asking the next provider, which
// might otherwise admit the same request under some other identity.
function assertionRefused(error: string): AuthResult {
  return {
    ok: false,
    final: true,
    response: new Response(JSON.stringify({ error }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

/**
 * Static bearer-token inbound auth. Constant-time compares the Bearer token
 * against `secret`. Checked before interactive providers in the server; a
 * mismatch falls through so another configured provider can admit the request.
 */
export function bearerToken(
  secret: string,
  options: BearerTokenOptions = {},
): InboundAuth {
  assertNoRetiredToolkitOptions("bearerToken", options);
  const secretBytes = encoder.encode(secret);
  const matches = (request: Request): boolean => {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return Boolean(match && timingSafeEqual(encoder.encode(match[1]), secretBytes));
  };
  const asserted = options.assertedPrincipal;
  if (asserted === undefined) {
    return {
      kind: "bearer",
      authorize(request): AuthResult {
        if (matches(request)) {
          return {
            ok: true,
            ...(options.subjectId ? { subjectId: options.subjectId } : {}),
          };
        }
        return unauthorized();
      },
    };
  }
  const headerName = assertedPrincipalHeader(asserted);
  if (options.subjectId !== undefined) {
    throw new Error(
      "bearerToken subjectId and assertedPrincipal are exclusive; the asserted user is the subject",
    );
  }
  const { namespace, accept } = asserted;
  return {
    kind: "bearer",
    // Activity attributes each call to the asserted user, in this namespace.
    activityActorNamespace: namespace,
    // A refused assertion must also stop human routes, which skip other
    // non-interactive providers.
    finalRefusals: true,
    async authorize(request): Promise<AuthResult> {
      // Without the secret the header means nothing and is never read.
      if (!matches(request)) return unauthorized();
      const raw = request.headers.get(headerName);
      if (raw === null || raw.trim() === "") {
        return assertionRefused("asserted principal required");
      }
      // Fetch joins a repeated header with ", ". Trimming would turn
      // `alice` plus an empty second value into the different id `alice,`,
      // so any comma is refused before trimming; no id may contain one.
      if (raw.includes(",")) return assertionRefused("asserted principal refused");
      const principal = { namespace, id: raw.trim() };
      if (!validIdentityReference(principal)) {
        return assertionRefused("asserted principal refused");
      }
      let accepted: unknown;
      try {
        accepted = await accept(principal.id);
      } catch {
        accepted = false;
      }
      if (accepted !== true) return assertionRefused("asserted principal refused");
      return { ok: true, subjectId: principal.id, principal };
    },
  };
}
