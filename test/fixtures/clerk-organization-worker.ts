// The `clerk-organization` Worker in the workers project (vitest.config.ts):
// one organization-mode clerkAuth that every request to this Worker shares,
// as a deployment's isolate does. Each request is authorized as it arrives,
// and the reply carries its status and the denial reasons logged for it.
// The SDK's authentication is replaced at bundle time by
// clerk-organization-transport.ts; the Backend API calls are real fetches.
import { AsyncLocalStorage } from "node:async_hooks";
import { clerkAuth } from "../../src/auth/clerk.js";
import type { InboundAuth } from "../../src/types.js";
import { ORGANIZATION_ID, PUBLIC_URL } from "./clerk-organization-deployment.js";

let auth: InboundAuth | undefined;
const denials = new AsyncLocalStorage<unknown[]>();

function authorization(): InboundAuth {
  if (auth) return auth;
  const warn = console.warn.bind(console);
  console.warn = (event: unknown, ...rest: unknown[]) => {
    const logged = denials.getStore();
    if (logged && event === "[connecta] Clerk request denied") logged.push(rest[0]);
    else warn(event, ...rest);
  };
  auth = clerkAuth({
    publishableKey: `pk_test_${btoa("clerk.example.com$")}`,
    secretKey: "sk_test_fake",
    publicUrl: PUBLIC_URL,
    organizationId: ORGANIZATION_ID,
  });
  return auth;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const logged: unknown[] = [];
    const result = await denials.run(logged, () => authorization().authorize(request, PUBLIC_URL));
    return Response.json({ status: result.ok ? 200 : result.response.status, denials: logged });
  },
};
