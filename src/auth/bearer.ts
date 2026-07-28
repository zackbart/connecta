import {
  resolveToolkitBinding,
  type ToolkitBindingOptions,
} from "../toolkits.js";
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

export interface BearerTokenOptions extends ToolkitBindingOptions {
  /** Stable identity for this credential, used on activity events. */
  subjectId?: string;
}

/**
 * Static bearer-token inbound auth. Constant-time compares the Bearer token
 * against `secret`. Checked BEFORE the Clerk gate in the server; a mismatch
 * falls through so a co-configured Clerk provider can still admit the request.
 *
 * `toolkits` binds the token to named toolkits (documentation/toolkits.md): one
 * `bearerToken(...)` per team credential, each naming the view that team may
 * open. Omit it and the token stays unbound — every declared toolkit plus the
 * full registry.
 */
export function bearerToken(
  secret: string,
  options: BearerTokenOptions = {},
): InboundAuth {
  const secretBytes = encoder.encode(secret);
  const toolkitBinding = resolveToolkitBinding(
    options.subjectId
      ? `bearerToken (subjectId "${options.subjectId}")`
      : "bearerToken",
    options,
  );
  if (toolkitBinding && !options.subjectId) {
    // A bound token stands for one team, and both surfaces that report on it —
    // the 403 refusal log (documentation/toolkits.md) and activity events
    // (documentation/operator-ui.md) — can only say "bearer" without a subjectId. With
    // several bound tokens that makes an operator unable to tell which
    // credential was refused, or whose call succeeded. console.warn (as the
    // Clerk adapter does) because an adapter is constructed before
    // `createConnecta` has a logger to hand it.
    console.warn(
      "[connecta] bearerToken is bound to toolkits " +
        `(${toolkitBinding.toolkits.join(", ") || "unscoped only"}) but has no ` +
        "subjectId: refusal logs and activity events cannot say which " +
        "credential they came from. Pass { subjectId: \"<team>\" }.",
    );
  }
  return {
    kind: "bearer",
    ...(toolkitBinding ? { toolkitBinding } : {}),
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
