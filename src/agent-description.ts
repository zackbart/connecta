// Immutable construction-time facts. These descriptions grant no authority.
import type { ResolvedAgent } from "./agent-config.js";

export interface AgentCredentialDescription {
  readonly name: string;
  readonly credentialTypes: readonly ("access_token" | "vercel_oidc")[];
}
const empty: readonly AgentCredentialDescription[] = Object.freeze([]);
const descriptions = new WeakMap<object, readonly AgentCredentialDescription[]>();

export function registerAgentDescriptions(config: object, agents: readonly ResolvedAgent[], tokens: boolean): void {
  if (descriptions.has(config)) return;
  descriptions.set(
    config,
    Object.freeze(
      agents.map((agent) =>
        Object.freeze({
          name: agent.name,
          credentialTypes: Object.freeze([
            ...(tokens ? ["access_token" as const] : []),
            ...(agent.vercel ? ["vercel_oidc" as const] : []),
          ]),
        }),
      ),
    ),
  );
}

export function agentDescriptions(config: object): readonly AgentCredentialDescription[] {
  return descriptions.get(config) ?? empty;
}
