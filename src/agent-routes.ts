/**
 * Route names: how Connecta-authored text names a route on the surface that
 * serves it. Text is built with the names for its surface when Connecta
 * writes it, never rendered afterwards: nothing scans or rewrites replies,
 * program values, downstream results, guides or caller data.
 *
 * Where the names come from:
 * - Connector and provider code reads `routesOf(ctx)` from its
 *   `ConnectorContext`, or `Routes` from a call's Effect services. The registry stamps every context with the
 *   deployment's names, and a call carries the names of the request's surface.
 * - Request handlers (meta-tools, programs, native pools, authorization
 *   handoffs) receive the request's names from the MCP route.
 * - Instructions, tool descriptions and built-in guides are built per surface,
 *   or, when only one surface serves them, with the meta names.
 * - Static provider schema descriptions declare `routeDescription`; their
 *   meta text is the default, and `api()` resolves the deployment's names
 *   when it lists tools.
 */

import { Context } from "effect";
import type { AgentRouteNames } from "./types.js";

/**
 * `meta`: the six meta-tools. `code`: in-program wording, selected only by the
 * eval code arm. `native` and `native-code`: the native contract's recovery
 * wording, without and with `execute_code`.
 */
export type RouteSurface = "meta" | "code" | "native" | "native-code";

const NAMES: Readonly<Record<RouteSurface, AgentRouteNames>> = {
  meta: Object.freeze({
    search: "search_tools",
    read: "call_tool",
    write: "call_destructive_tool",
    program: "execute_code",
    authorize: "authorize_connector",
    skills: "skills",
  }),
  code: Object.freeze({
    search: "connecta.search inside execute_code",
    read: "connecta.call inside execute_code",
    write: "connecta.call inside execute_code",
    program: "execute_code",
    authorize: "authorize_connector",
    skills: "skills",
  }),
  native: Object.freeze({
    search: "your host's tool search",
    read: "the original native tool",
    write: "the original native tool",
    program: "your host's tool search",
    authorize: "the returned authorization handoff",
    skills: "skills",
  }),
  "native-code": Object.freeze({
    search: "your host's tool search",
    read: "the original native tool",
    write: "the original native tool",
    program: "execute_code",
    authorize: "the returned authorization handoff",
    skills: "skills",
  }),
};

/** The six-tool surface's names: the default wherever no other surface applies. */
export const META_ROUTES: AgentRouteNames = NAMES.meta;

export function routeNames(surface: RouteSurface): AgentRouteNames {
  return NAMES[surface];
}

/** The names for the surface a connector operation serves; meta for contexts Connecta did not build. */
export function routesOf(ctx: { routes?: AgentRouteNames | undefined } | undefined): AgentRouteNames {
  return ctx?.routes ?? META_ROUTES;
}

/**
 * The same names inside a call's Effect services, for provider code that has
 * no context in hand (an `authenticate` program, a vendor error table).
 */
export const Routes = Context.Reference<AgentRouteNames>("connecta/call/Routes", {
  defaultValue: () => META_ROUTES,
});

const descriptions = new Map<string, (routes: AgentRouteNames) => string>();

/**
 * A static schema description that names a route. Returns the meta text, which
 * the schema declares; `api()` lists the deployment's own text instead when it
 * serves other names. Declare it once, at module scope.
 */
export function routeDescription(build: (routes: AgentRouteNames) => string): string {
  const meta = build(META_ROUTES);
  descriptions.set(meta, build);
  return meta;
}

/**
 * A static catalog with each declared route description built for `routes`.
 * Only Connecta's own `api()` definitions pass through here; the meta catalog
 * is returned as it is.
 */
export function routeCatalog<T extends object>(tools: readonly T[], routes: AgentRouteNames): readonly T[] {
  if (routes === META_ROUTES || descriptions.size === 0) return tools;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const build = key === "description" && typeof item === "string" ? descriptions.get(item) : undefined;
        return [key, build ? build(routes) : visit(item)];
      }),
    );
  };
  return tools.map((tool) => visit(tool) as T);
}

const programRouteConfigs = new WeakMap<object, true>();

/**
 * Eval only: serve this configuration's text with program-form route names.
 * No package entry exports it and no configuration key selects it; the eval
 * code arm marks the configuration object it passes to createConnecta.
 */
export function renderRoutesAsPrograms(config: object): void {
  programRouteConfigs.set(config, true);
}

/** The names every reply of a deployment built from `config` uses outside native pools. */
export function deploymentRoutes(config: object): AgentRouteNames {
  return programRouteConfigs.has(config) ? NAMES.code : NAMES.meta;
}
