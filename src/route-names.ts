import type { RouteSurface } from "./agent-routes.js";
import type { AgentRouteNames } from "./types.js";

/**
 * `meta`: the six meta-tools. `read-route`: those plus `execute_read_code`, which
 * then takes read follow-ups, so they cost no write approval. `code`: in-program
 * wording, selected only by the eval code arm. `native` and `native-code`: native
 * pools without and with `execute_code`.
 */

const NAMES: Readonly<Record<RouteSurface, AgentRouteNames>> = {
  meta: Object.freeze({
    search: "search_tools",
    read: "call_tool",
    write: "call_destructive_tool",
    program: "execute_code",
    authorize: "authorize_connector",
    skills: "skills",
  }),
  "read-route": Object.freeze({
    search: "search_tools",
    read: "call_tool",
    write: "call_destructive_tool",
    program: "execute_read_code",
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

/** The meta surface's names: the default wherever no other surface applies. */
export const META_ROUTES: AgentRouteNames = NAMES.meta;

export function routeNames(surface: RouteSurface): AgentRouteNames {
  return NAMES[surface];
}
