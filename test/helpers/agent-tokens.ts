import { api } from "../../src/connectors/api.js";
import { createTestConnecta } from "../helpers.js";
import { accessTokens, AccessTokenManager } from "../../src/access-tokens.js";
import type { KVStorage } from "../../src/types.js";

/** Issue a token for one agent through trusted provisioning; returns the secret. */
export async function issueAgentToken(storage: KVStorage, name: string): Promise<string> {
  return (await new AccessTokenManager(storage, { agents: [name] }).rotate(name, "test-provisioning")).token;
}

/** A real agent endpoint with no catalog I/O: ping isolates admission and observation. */
export function agentAdmissionFixture(storage: KVStorage) {
  const app = createTestConnecta({
    storage,
    connectors: [
      api("notes", {
        tools: [
          { name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: () => ({ ok: true }) },
        ],
      }),
    ],
    publicUrl: "https://connecta.test",
    logger: "silent",
    agents: ["assistant", "other"],
    accessTokens: accessTokens(storage),
    pools: {
      team: { tools: ["notes"], members: ["agent:assistant"] },
      other: { tools: ["notes"], members: ["agent:other"] },
    },
  });
  return {
    app,
    async ping(token: string, pool = "team") {
      const response = await app.fetch(
        new Request(`https://connecta.test/agent/${pool}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        }),
      );
      await response.text();
      return response;
    },
  };
}
