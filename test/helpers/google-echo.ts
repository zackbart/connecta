// A Google Workspace product driven over a stubbed network, its delegated
// access token being SECRET, for tests that echo that token back.
import { vi } from "vitest";
import { attachCaller } from "../../src/connector-caller.js";
import { memoryStorage } from "../../src/storage/memory.js";
import type { AuthenticatedIdentity, ConnectorContext } from "../../src/types.js";
import { silentLogger } from "../helpers.js";
import { SECRET } from "./secret-echoes.js";

const keys = crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
) as Promise<CryptoKeyPair>;
let accounts = 0;

/** Options every Workspace product takes, with a service account of its own, so no token is cached. */
export async function workspaceOptions(): Promise<{
  purpose: string;
  serviceAccount: { clientEmail: string; privateKey: string };
  subject: string;
}> {
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", (await keys).privateKey)) as ArrayBuffer);
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  return {
    purpose: "Staff work",
    serviceAccount: {
      clientEmail: `echo-${++accounts}@project.iam.gserviceaccount.com`,
      privateKey: `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----\n`,
    },
    subject: "alice@org.example",
  };
}

/** A call by an admitted person. */
export function caller(): ConnectorContext {
  const identity: AuthenticatedIdentity = {
    actor: { kind: "test-users", id: "alice", namespace: "https://identity.test" },
    subject: { namespace: "https://identity.test", id: "alice" },
    principal: { namespace: "https://identity.test", id: "alice" },
    interactive: true,
  };
  const ctx: ConnectorContext = { storage: memoryStorage(), logger: silentLogger, baseUrl: "https://connecta.example" };
  return attachCaller(ctx, { identity, authenticated: true });
}

/** Google's token endpoint mints SECRET; every API request goes to `route`, a body or a Response. */
export function stubGoogle(route: (url: URL, init: RequestInit) => unknown): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: SECRET, expires_in: 3599, token_type: "Bearer" });
    const answer = route(url, init);
    return answer instanceof Response ? answer : Response.json(answer);
  });
}
