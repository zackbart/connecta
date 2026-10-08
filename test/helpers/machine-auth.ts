import type { AuthResult, InboundAuth } from "../../src/types.js";

/** Machine identity fixture for route tests, without a human principal. */
export function machineAuth(secret: string, { subjectId }: { subjectId?: string } = {}): InboundAuth {
  const matches = (request: Request): boolean => request.headers.get("authorization") === `Bearer ${secret}`;
  const auth = {
    kind: "access_token",
    recognizesCredential: matches,
    authorize(request: Request): AuthResult {
      if (matches(request)) {
        return { ok: true, ...(subjectId === undefined ? {} : { subjectId }) };
      }
      return {
        ok: false,
        response: Response.json(
          { error: "unauthorized" },
          {
            status: 401,
            headers: { "WWW-Authenticate": "Bearer" },
          },
        ),
      };
    },
  };
  return auth;
}
