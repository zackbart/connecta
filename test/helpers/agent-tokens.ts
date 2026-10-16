import { AccessTokenManager } from "../../src/access-tokens.js";
import type { KVStorage } from "../../src/types.js";

/** Issue a token for one agent through trusted provisioning; returns the secret. */
export async function issueAgentToken(storage: KVStorage, name: string): Promise<string> {
  return (await new AccessTokenManager(storage, { agents: [name] }).rotate(name, "test-provisioning")).token;
}
