/**
 * Route wording: how Connecta-authored text names a route on the surface that
 * serves it. Text is built with that surface's wording when Connecta writes
 * it, never rendered afterwards: nothing scans or rewrites replies, program
 * values, downstream results, guides or caller data.
 *
 * Two tables per surface:
 * - `AgentRouteNames` (public, `ConnectorContext.routes`) names the tools. Use
 *   a name only in a sentence written for a surface that lists that tool.
 * - `RoutePhrases` holds complete phrases for sentences every surface shares,
 *   such as "for a direct call_tool only" against "when calling this tool
 *   directly". A message chooses whole phrases; it never splices a name into a
 *   sentence written for another surface, and it branches when the surface
 *   runs no programs (`program` is undefined).
 *
 * Where the wording comes from:
 * - Connector and provider code reads `routePhrases(ctx)`, or `Routes` from a
 *   call's Effect services. The registry stamps every context with the
 *   deployment's names, and a call carries the names of the request's surface.
 * - Request handlers (meta-tools, programs, native pools, authorization
 *   handoffs) receive the request's names from the MCP route.
 * - Instructions, tool descriptions and built-in guides are built per surface,
 *   or, when only one surface serves them, with the meta names.
 * - Static provider schema descriptions declare `routeDescription`. The meta
 *   text is the declared default; each request's catalog serves `api()`
 *   catalogs with the description built for its own surface.
 */

import { Context } from "effect";
import type { AgentRouteNames } from "./types.js";

/**
 * `meta`: the six meta-tools. `code`: in-program wording, selected only by the
 * eval code arm. `native` and `native-code`: native pools without and with
 * `execute_code`.
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

/** Complete phrases for sentences every surface shares. */
export interface RoutePhrases {
  /** The program tool, when this surface runs programs; branch on its absence. */
  readonly program: string | undefined;
  /** "Raise maxBytes, up to N {directOnly}, to read …": for a direct call_tool only. */
  readonly directOnly: string;
  /** "raise maxChars {forDirect}": for a direct call_tool. */
  readonly forDirect: string;
  /** "Raise it, to N, {onlyDirectRead}.": only for a direct call_tool read. */
  readonly onlyDirectRead: string;
  /** "Above the default, {callDirectlyAndPage}": the direct call and how it pages. */
  readonly callDirectlyAndPage: string;
  /** The sentence refusing a write sent on the read route. */
  readonly writeNeedsApproval: string;
  /** "Connector "x" requires authorization — {authorizeAndOpen(x)}." */
  authorizeAndOpen(connector: string): string;
  /** "Connector "x" has no stored credential — {authorizeAndFollow(x)}." */
  authorizeAndFollow(connector: string): string;
  /** A sentence without its full stop: "Call authorize_connector for {purpose}". */
  authorizeFor(purpose: string): string;
  /** A whole sentence: "Call authorize_connector({ connector: "x" })." or "Call authorize_connector." */
  authorizeCall(connector?: string): string;
  /** "then {authorizeAgain}.": what follows a configuration fix. */
  readonly authorizeAgain: string;
}

// Meta and code text authorize with authorize_connector, which both list. A
// native pool lists no authorization tool: its errors carry the handoff in
// nextAction, so the agent passes that on.
const metaAuthorize = {
  authorizeAndOpen: (connector: string) =>
    `call authorize_connector({ connector: "${connector}" }) and open the returned URL`,
  authorizeAndFollow: (connector: string) =>
    `call authorize_connector({ connector: "${connector}" }) and follow the operator handoff it returns`,
  authorizeFor: (purpose: string) => `Call authorize_connector for ${purpose}`,
  authorizeCall: (connector?: string) =>
    connector === undefined ? "Call authorize_connector." : `Call authorize_connector({ connector: "${connector}" }).`,
  authorizeAgain: "call authorize_connector again",
};
const nativeAuthorize = {
  authorizeAndOpen: () => "give this error's nextAction to the user or operator",
  authorizeAndFollow: () => "give this error's nextAction to the user or operator",
  authorizeFor: () => "Give this error's nextAction to the user or operator",
  authorizeCall: () => "Give this error's nextAction to the user or operator.",
  authorizeAgain: "retry the original native call",
};
const nativeDirect = {
  directOnly: "when calling this tool directly",
  forDirect: "when calling this tool directly",
  onlyDirectRead: "only when calling this tool directly",
  writeNeedsApproval: "Invoke it through its own native tool so the MCP host can request approval.",
};

const PHRASES: Readonly<Record<RouteSurface, RoutePhrases>> = {
  meta: Object.freeze({
    program: "execute_code",
    directOnly: "for a direct call_tool only",
    forDirect: "for a direct call_tool",
    onlyDirectRead: "only for a direct call_tool read",
    callDirectlyAndPage: "call directly (call_tool, connecta.result to page)",
    writeNeedsApproval: "Invoke it through call_destructive_tool so the MCP host can request approval.",
    ...metaAuthorize,
  }),
  // The eval code arm keeps the text its comparator protocol recorded.
  code: Object.freeze({
    program: "execute_code",
    directOnly: "for a direct connecta.call inside execute_code only",
    forDirect: "for a direct connecta.call inside execute_code",
    onlyDirectRead: "only for a direct connecta.call inside execute_code read",
    callDirectlyAndPage: "call directly (connecta.call inside execute_code, connecta.result to page)",
    writeNeedsApproval: "Invoke it through connecta.call inside execute_code so the MCP host can request approval.",
    ...metaAuthorize,
  }),
  native: Object.freeze({
    program: undefined,
    callDirectlyAndPage: "call this tool directly and page with read_result",
    ...nativeDirect,
    ...nativeAuthorize,
  }),
  "native-code": Object.freeze({
    program: "execute_code",
    callDirectlyAndPage: "call this tool directly and page with connecta.result in execute_code",
    ...nativeDirect,
    ...nativeAuthorize,
  }),
};

const SURFACES = new Map<AgentRouteNames, RouteSurface>(
  (Object.keys(NAMES) as RouteSurface[]).map((surface) => [NAMES[surface], surface]),
);

/** The surface a names table belongs to; meta for a table Connecta did not build. */
function routeSurface(routes: AgentRouteNames | undefined): RouteSurface {
  return (routes && SURFACES.get(routes)) ?? "meta";
}

/** The phrases for the surface an operation serves, from its names or its context. */
export function routePhrases(
  source: AgentRouteNames | { routes?: AgentRouteNames | undefined } | undefined,
): RoutePhrases {
  const routes = source && "read" in source ? source : routesOf(source);
  return PHRASES[routeSurface(routes)];
}

/**
 * The same names inside a call's Effect services, for provider code that has
 * no context in hand (an `authenticate` program, a vendor error table).
 */
export const Routes = Context.Reference<AgentRouteNames>("connecta/call/Routes", {
  defaultValue: () => META_ROUTES,
});

const descriptions = new Map<string, (phrases: RoutePhrases) => string>();

/**
 * A static schema description that names a route. Returns the meta text, which
 * the schema declares; a request on another surface lists the text built from
 * its own phrases. Declare it once, at module scope.
 */
export function routeDescription(build: (phrases: RoutePhrases) => string): string {
  const meta = build(PHRASES.meta);
  descriptions.set(meta, build);
  return meta;
}

const declaringConnectors = new WeakSet<object>();

/** Mark a connector whose catalog Connecta authors (`api()`), so its declared descriptions follow the surface. */
export function declaresRouteDescriptions(connector: object): void {
  declaringConnectors.add(connector);
}

type Path = readonly (string | number)[];
// Where an authored tool's declared descriptions sit, per connector and tool
// name: api() definitions are fixed at construction, while the registry
// publishes a fresh copy of each tool on every read.
const descriptionPaths = new WeakMap<object, Map<string, readonly Path[]>>();
const rendered = new Map<string, Map<RouteSurface, string>>();

function at(value: unknown, path: Path): unknown {
  let current = value;
  for (const key of path) current = (current as Record<string | number, unknown> | undefined)?.[key];
  return current;
}

function declaredPaths(tool: Record<string, unknown>): Path[] {
  const found: Path[] = [];
  const visit = (value: unknown, path: (string | number)[]): void => {
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, [...path, index]));
    else if (value !== null && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        if (key === "description" && typeof item === "string" && descriptions.has(item)) found.push([...path, key]);
        else visit(item, [...path, key]);
      }
  };
  for (const key of ["inputSchema", "outputSchema"]) visit(tool[key], [key]);
  return found;
}

/**
 * Give a request's own copy of one tool the declared descriptions of the
 * surface it serves, in place, so the copy keeps everything else it carries,
 * its source classification included. Only tools of connectors Connecta
 * authors change; downstream catalogs and the meta surface are left as given.
 */
export function routeToolInPlace(
  connector: object | undefined,
  tool: { readonly name: string },
  routes: AgentRouteNames,
): void {
  const surface = routeSurface(routes);
  if (surface === "meta" || descriptions.size === 0 || !connector || !declaringConnectors.has(connector)) return;
  let byName = descriptionPaths.get(connector);
  if (!byName) descriptionPaths.set(connector, (byName = new Map()));
  let paths = byName.get(tool.name);
  // Recompute when a path no longer holds declared meta text.
  if (!paths || !paths.every((path) => descriptions.has(at(tool, path) as string))) {
    paths = declaredPaths(tool as Record<string, unknown>);
    byName.set(tool.name, paths);
  }
  for (const path of paths) {
    const meta = at(tool, path) as string;
    let bySurface = rendered.get(meta);
    if (!bySurface) rendered.set(meta, (bySurface = new Map()));
    let text = bySurface.get(surface);
    if (text === undefined) bySurface.set(surface, (text = descriptions.get(meta)!(PHRASES[surface])));
    (at(tool, path.slice(0, -1)) as Record<string, unknown>)["description"] = text;
  }
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
