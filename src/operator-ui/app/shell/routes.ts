import { Route } from "@effect/ui";
import { Schema } from "effect";
import { canonicalOperatorPath } from "../../view.js";

const search = {
  view: Schema.optional(Schema.String),
  q: Schema.optional(Schema.String),
  connector: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  h: Schema.optional(Schema.String),
};

export const OperatorRoute = Route.union({
  Overview: Route.make("/", { search }),
  Endpoints: Route.make("/endpoints", { search }),
  Connectors: Route.make("/connectors", { search }),
  Connector: Route.make("/connectors/:id", { params: { id: Schema.String }, search }),
  Settings: Route.make("/settings", { search }),
  Tokens: Route.make("/tokens", { search }),
  Activity: Route.make("/activity", { search }),
  LegacyTools: Route.make("/tools", { search }),
  LegacyAccess: Route.make("/access", { search }),
  LegacyConfig: Route.make("/config", { search }),
});
export type OperatorRoute = typeof OperatorRoute.Type;

export const routePath = (route: OperatorRoute): string => canonicalOperatorPath(OperatorRoute.printPath(route));

export const LEGACY_CONNECTOR_TABS = ["config", "auth", "diagnostics"];
