/**
 * Trusted local provisioning: issue or rotate one declared agent's token
 * against the same configuration and database the server uses. The previous
 * secret stops working on its next request.
 */
import { AccessTokenManager } from "@zackbart/connecta/auth/access-tokens";
import connectaConfig from "./connecta.config.js";

const agent = process.argv[2];
if (!agent || process.argv.length !== 3) {
  throw new Error("Usage: npm run --silent rotate-token -- <agent>");
}
const { storage, agents } = connectaConfig(process.env);
const manager = new AccessTokenManager(storage!, { agents });
const { token } = await manager.rotate(agent, "local-provisioning");
// The secret is returned once. Keep stdout private; storage holds its hash.
process.stdout.write(`${token}\n`);
