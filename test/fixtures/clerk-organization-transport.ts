// Stands in for src/auth/clerk-transport.ts inside the `clerk-organization`
// Worker. The bearer token is taken as already verified by the SDK: a JWT
// names its user in `sub`, and `oat_<user>` is an opaque token for <user>.
import { decodeJwt } from "@clerk/backend/jwt";

export function createByteReadingClerkClient() {
  return {
    async authenticateRequest(request: Request) {
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const userId = token.startsWith("oat_") ? token.slice("oat_".length) : decodeJwt(token).payload.sub;
      return {
        toAuth: () => ({
          isAuthenticated: true,
          tokenType: "oauth_token",
          userId,
          clientId: "client_connecta",
          getToken: async () => token,
        }),
      };
    },
    users: {
      getUser: async () => {
        throw new Error("No user lookups in this Worker.");
      },
    },
  };
}
