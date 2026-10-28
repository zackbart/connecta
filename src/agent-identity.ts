// Code-declared agents: the names deployment code lists in `agents`,
// the identity an admitted agent carries, and the built-in providers trusted
// to assert it. Pure, so core reads it without reaching credential modules.

import { ConfigError } from "./config-schema.js";
import type { InboundAuth } from "./types.js";

/** Agent names: lowercase letters, digits, `_` and `-`. */
const AGENT_NAME_RE = /^[a-z0-9_-]+$/u;
/** Longest accepted agent name, so a name always fits a storage key. */
const MAX_AGENT_NAME_LENGTH = 64;
/** Directory namespace of agent subjects and activity actors. */
export const AGENT_NAMESPACE = "connecta:access-tokens:v1";

/** Whether `value` is an acceptable agent name. */
export function isAgentName(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_AGENT_NAME_LENGTH && AGENT_NAME_RE.test(value);
}

/**
 * The subject id that partitions an agent's per-caller state, such as result
 * handles. The `agent:` prefix keeps it apart from the UUID subjects older
 * tokens used in the same namespace.
 */
export function agentSubjectId(name: string): string {
  return `agent:${name}`;
}

/** Validate a declared agent list: an array of unique, well-formed names. */
export function assertAgentNames(value: unknown, path: string): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw new ConfigError(`${path} must be an array of agent names.`);
  const seen = new Set<string>();
  value.forEach((name, index) => {
    if (!isAgentName(name)) {
      throw new ConfigError(
        `${path}[${index}] must be an agent name: 1 to ${MAX_AGENT_NAME_LENGTH} characters of ` +
          "lowercase letters, digits, _ and -.",
      );
    }
    if (seen.has(name)) throw new ConfigError(`${path}[${index}] repeats the agent name "${name}".`);
    seen.add(name);
  });
}

const agentProviders = new WeakSet<InboundAuth>();

/** Mark a built-in credential adapter as trusted to assert `agent`. */
export function trustAgentProvider<T extends InboundAuth>(provider: T): T {
  agentProviders.add(provider);
  return provider;
}

/** Whether `provider` is a trusted built-in agent credential adapter. */
export function assertsAgents(provider: InboundAuth): boolean {
  return agentProviders.has(provider);
}
