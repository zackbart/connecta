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
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

/**
 * Static bearer-token inbound auth. Constant-time compares the Bearer token
 * against `secret`. Checked BEFORE the Clerk gate in the server; a mismatch
 * falls through so a co-configured Clerk provider can still admit the request.
 */
export function bearerToken(
  secret: string,
  options: { subjectId?: string } = {},
): InboundAuth {
  const secretBytes = encoder.encode(secret);
  return {
    kind: "bearer",
    authorize(request): AuthResult {
      const header = request.headers.get("authorization") ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (match && timingSafeEqual(encoder.encode(match[1]), secretBytes)) {
        return {
          ok: true,
          ...(options.subjectId ? { subjectId: options.subjectId } : {}),
        };
      }
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ error: "unauthorized" }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              "WWW-Authenticate": "Bearer",
            },
          },
        ),
      };
    },
  };
}
