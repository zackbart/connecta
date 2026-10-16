import type { AuthResult, IdentityReference, InboundAuth } from "../../src/types.js";

/** Namespace of the principal `machineAuth` admits by default. */
export const TEST_MACHINE_NAMESPACE = "connecta:test-machine";

const testMaintainers = new WeakMap<InboundAuth, IdentityReference>();

/**
 * The principal a test auth fixture admits, which `createTestConnecta` lists
 * in `maintainers` when a test names none (#837).
 */
export function testMaintainerOf(provider: InboundAuth): IdentityReference | undefined {
  return testMaintainers.get(provider);
}

/** Record the principal a test auth fixture admits, for `createTestConnecta`'s default maintainers. */
export function registerTestMaintainer<T extends InboundAuth>(provider: T, principal: IdentityReference): T {
  testMaintainers.set(provider, principal);
  return provider;
}

/**
 * Route-test identity behind a static bearer secret. By default it carries a
 * non-interactive principal (`connecta:test-machine`, the `subjectId` or
 * `"machine"`), so `createTestConnecta` can list it as a maintainer and it
 * reaches plain `/mcp`. `principal: false` keeps it a principal-less machine.
 */
export function machineAuth(
  secret: string,
  { subjectId, principal = true }: { subjectId?: string; principal?: boolean } = {},
): InboundAuth {
  const matches = (request: Request): boolean => request.headers.get("authorization") === `Bearer ${secret}`;
  const reference = { namespace: TEST_MACHINE_NAMESPACE, id: subjectId ?? "machine" };
  const auth = {
    kind: "access_token",
    recognizesCredential: matches,
    authorize(request: Request): AuthResult {
      if (matches(request)) {
        return {
          ok: true,
          ...(subjectId === undefined ? {} : { subjectId }),
          ...(principal ? { principal: reference } : {}),
        };
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
  return principal ? registerTestMaintainer(auth, reference) : auth;
}
