// Legacy auth selectors are retained only to provide a construction-time migration error.
import type { ProviderContext, ProviderOptions } from "../../../provider.js";
import type { Connector } from "../../../types.js";

type AuthTyped = ProviderOptions & { auth: { type: string } };

type AuthCases<O extends AuthTyped> = {
  readonly [T in O["auth"]["type"]]: (
    id: string,
    options: Readonly<Extract<O, { auth: { type: T } }>>,
    provider: ProviderContext,
  ) => Connector;
};

/**
 * A provider `create` that dispatches on `options.auth.type`. Pair it with
 * `variants(["auth", "type"], …)` options, which refuse a missing or unknown
 * type, and options the selected case does not accept, before this runs.
 */
export function byAuth<O extends AuthTyped>(
  cases: AuthCases<O> & Partial<Record<Exclude<"oauth", O["auth"]["type"]>, typeof removedHostedMcp>>,
): (id: string, options: Readonly<O>, provider: ProviderContext) => Connector {
  return (id, options, provider) => {
    const type = options.auth?.type;
    const create =
      typeof type === "string" && Object.hasOwn(cases, type) ? cases[type as keyof AuthCases<O>] : undefined;
    if (!create) {
      throw new Error(
        `auth.type must be one of ${Object.keys(cases)
          .map((name) => JSON.stringify(name))
          .join(", ")}.`,
      );
    }
    return create(id, options as never, provider);
  };
}

export function removedHostedMcp(): never {
  throw new Error(
    "Hosted MCP connections require remoteMcp() with ConnectaConfig.classification; use a distinct id beside the API connector.",
  );
}
