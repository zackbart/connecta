import { assertAgentNames } from "./agent-identity.js";
import { array, ConfigError, object, opaque, required, text, type Field } from "./config-schema.js";

type VercelEnvironment = "production" | "preview" | "development";

/** Vercel workload binding: immutable team_ ID; prefer a prj_ project ID. */
interface VercelAgentCredential {
  team: string;
  project: string;
  environments?: readonly VercelEnvironment[] | undefined;
}

/** A string keeps the existing token-only declaration. */
export type AgentConfig = string | { name: string; vercel: VercelAgentCredential };

export interface ResolvedAgent {
  readonly name: string;
  readonly vercel?: {
    readonly team: string;
    readonly project: string;
    readonly environments: readonly VercelEnvironment[];
  };
}

const segment = (kind: "team" | "project") =>
  required(
    opaque<string>({
      check(value, path) {
        const pattern = kind === "team" ? /^team_[A-Za-z0-9]+(?![\s\S])/ : /^[A-Za-z0-9._-]+(?![\s\S])/;
        if (typeof value !== "string" || value.length > 128 || !pattern.test(value)) {
          throw new ConfigError(
            `${path} must be ${kind === "team" ? "an immutable Vercel team_ ID" : "an exact Vercel project ID or name"}.`,
          );
        }
      },
    }),
  );

const environments = opaque<readonly VercelEnvironment[], readonly VercelEnvironment[]>({
  check(value, path) {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((env) => !["production", "preview", "development"].includes(env)) ||
      new Set(value).size !== value.length
    ) {
      throw new ConfigError(`${path} must list unique production, preview or development environments.`);
    }
  },
  resolve: (value) => Object.freeze([...(value ?? ["production"])]),
});

const declaration = object({
  name: required(text()),
  vercel: required(object({ team: segment("team"), project: segment("project"), environments })),
});
const entry: Field<AgentConfig, ResolvedAgent, false> = {
  ...declaration,
  optional: false,
  parse: (value, path) => (typeof value === "string" ? Object.freeze({ name: value }) : declaration.parse(value, path)),
  absent: (path) => {
    throw new ConfigError(`${path} must declare an agent.`);
  },
};
const list = array(entry);

export const agentConfig: Field<readonly AgentConfig[], readonly ResolvedAgent[], true> = {
  ...list,
  parse(value, path) {
    const agents = list.parse(value, path)!;
    assertAgentNames(
      agents.map((agent) => agent.name),
      path,
    );
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]!.vercel;
      if (!a) continue;
      for (const prior of agents.slice(0, i)) {
        const b = prior.vercel;
        // A project name and an ID can designate the same project. Refuse possible
        // overlap rather than let declaration order select another identity.
        if (
          b &&
          a.team === b.team &&
          (a.project === b.project || a.project.startsWith("prj_") !== b.project.startsWith("prj_")) &&
          a.environments.some((env) => b.environments.includes(env))
        ) {
          throw new ConfigError(`${path}[${i}].vercel overlaps another agent's workload binding.`);
        }
      }
    }
    return agents;
  },
  absent: () => Object.freeze([]),
};
