import { UiSchema, type Router } from "@effect/ui";
import { Schema } from "effect";
import type { Html } from "@effect/ui/html";
import type { SteadyHealth } from "../../health.js";
import { contractRecovering, type OperatorState } from "../../view.js";
import type { IssuedTokenHandle } from "../services/controller.js";
import type { ContentOwner } from "../shell/operator-view.js";
import { ConnectorData, ConnectorDetailPage, connectorProjection } from "./connector.js";
import { ConnectorsData, ConnectorsPage, connectorsProjection } from "./connectors.js";
import { EndpointsData, EndpointsPage, endpointsProjection } from "./endpoints.js";
import { TokensData, TokensPage, tokensProjection } from "./tokens.js";

export const PageData = UiSchema.TaggedEnum({
  Connectors: { data: ConnectorsData },
  Connector: { data: ConnectorData },
  Endpoints: { data: EndpointsData, recovering: Schema.Boolean },
  Tokens: { data: TokensData },
});
export type PageData = typeof PageData.Type;

const searchOf = (url: string) => new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?")) : "");

const connectorId = (route: Router.Location["route"]): string | null =>
  route._tag === "Connector" ? (route as unknown as { readonly params: { readonly id: string } }).params.id : null;

export const pageProjection = () => {
  const list = connectorsProjection();
  const detail = connectorProjection();
  const endpoints = endpointsProjection();
  const tokens = tokensProjection();
  let last: PageData | null = null;
  const keep = (next: PageData): PageData =>
    last?._tag === next._tag && last.data === next.data ? last : (last = next);
  return (
    content: ContentOwner,
    state: OperatorState,
    steady: (state: OperatorState) => SteadyHealth,
    location: Router.Location,
    issuedToken: () => IssuedTokenHandle | null,
  ): PageData | null => {
    if (content === "connectors")
      return keep(
        PageData.Connectors({
          data: list(state, steady(state), searchOf(location.url).get("view") === "matrix" ? "matrix" : "list"),
        }),
      );
    if (content === "connector")
      return keep(
        PageData.Connector({
          data: detail(state, steady(state), {
            id: connectorId(location.route),
            hash: location.hash,
            handoff: searchOf(location.url).get("h"),
          }),
        }),
      );
    if (content === "endpoints")
      return PageData.Endpoints({ data: endpoints(state, steady(state)), recovering: contractRecovering(state) });
    if (content === "tokens") return PageData.Tokens({ data: tokens(state, issuedToken()) });
    return null;
  };
};

export const PageView = <M>(h: Html.H<M>, page: PageData, view: ContentOwner) =>
  page._tag === "Connectors" && view === "connectors"
    ? ConnectorsPage(h, { props: { data: page.data } })
    : page._tag === "Connector" && view === "connector"
      ? ConnectorDetailPage(h, { props: { data: page.data } })
      : page._tag === "Endpoints" && view === "endpoints"
        ? EndpointsPage(h, { props: { data: page.data, recovering: page.recovering } })
        : page._tag === "Tokens" && view === "tokens"
          ? TokensPage(h, { props: { data: page.data } })
          : null;
