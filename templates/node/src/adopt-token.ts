/**
 * Trusted one-time migration: bind a machine token issued before agents to a
 * declared agent, so that machine's existing cta_ secret keeps working. Run
 * with no arguments to list the tokens that can be adopted. A token binds
 * once, only to an agent that has never been issued one; human-bound tokens
 * are refused and stop admitting.
 */
import { AccessTokenManager } from "@zackbart/connecta/auth/access-tokens";
import connectaConfig from "./connecta.config.js";

const [tokenId, agent] = process.argv.slice(2);
const { storage, agents } = connectaConfig(process.env);
const manager = new AccessTokenManager(storage!, { agents: agents ?? [] });
if (tokenId === undefined) {
  for (const token of await manager.unboundTokens()) {
    process.stdout.write(`${token.id}  ${token.createdAt}  ${token.name}\n`);
  }
} else if (!agent || process.argv.length !== 4) {
  throw new Error("Usage: npm run adopt-token -- [<token-id> <agent>]");
} else {
  await manager.adopt(tokenId, agent);
  process.stdout.write(`${agent} now uses token ${tokenId}\n`);
}
