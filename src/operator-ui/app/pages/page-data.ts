import { UiSchema, type Router } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import type { SteadyHealth } from "../../health.js";
import type { OperatorState } from "../../view.js";
import type { ContentOwner } from "../shell/operator-view.js";
import { ConnectorData, ConnectorDetailPage, connectorProjection } from "./connector.js";
import { ConnectorsData, ConnectorsPage, connectorsProjection } from "./connectors.js";

export const PageData = UiSchema.TaggedEnum({
  Connectors: { data: ConnectorsData },
  Connector: { data: ConnectorData },
});
export type PageData = typeof PageData.Type;

const searchOf = (url: string) => new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?")) : "");

const connectorId = (route: Router.Location["route"]): string | null =>
  route._tag === "Connector" ? (route as unknown as { readonly params: { readonly id: string } }).params.id : null;

export const pageProjection = () => {
  const list = connectorsProjection();
  const detail = connectorProjection();
  let last: PageData | null = null;
  const keep = (next: PageData): PageData =>
    last?._tag === next._tag && last.data === next.data ? last : (last = next);
  return (
    content: ContentOwner,
    state: OperatorState,
    steady: (state: OperatorState) => SteadyHealth,
    location: Router.Location,
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
    return null;
  };
};

export const PageView = <M>(h: Html.H<M>, page: PageData, view: ContentOwner) =>
  page._tag === "Connectors" && view === "connectors"
    ? ConnectorsPage(h, { props: { data: page.data } })
    : page._tag === "Connector" && view === "connector"
      ? ConnectorDetailPage(h, { props: { data: page.data } })
      : null;
