import { Component, Subscription, UiSchema } from "@effect/ui";
import { Tabs } from "@effect/ui-kit";
import { Html } from "@effect/ui/html";
import { Schema, Stream } from "effect";
import { connectorSummary } from "../../config-summary.js";
import type { ConnectorHealth, SteadyHealth } from "../../health.js";
import type { UiConnector } from "../../model.js";
import { activityReadable, type OperatorState } from "../../view.js";
import {
  AuthScopeBadge,
  StoredStatus,
  storedTools,
  ToolSplit,
  verdictFor,
  VerdictPill,
} from "../components/connector-parts.js";
import {
  ContractState,
  ContractStateView,
  contractStateView,
  maintainerContract,
} from "../components/contract-state.js";
import { Icon } from "../components/icons.js";
import { Card, StateBlock } from "../components/parts.js";
import { keepSame, keepSameContractState, keepShownHealth, opaque } from "../components/projection.js";
import { OperatorController } from "../services/controller.js";
import { HostConnectorActivity, HostConnectorConfig } from "../shell/island.js";
import { Catalog } from "./catalog.js";
import { ConnectorAuth, ConnectorAuthProps, ConnectorDiagnostics } from "./connector-auth.js";
import { RefreshConnector, RetryOperatorLoad, ShowConnectorTab } from "./connector-commands.js";

const TABS = ["tools", "connection", "activity"] as const;
const Tab = Schema.Literals(TABS);
type Tab = typeof Tab.Type;

export const ConnectorData = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  tab: Tab,
  health: opaque<ConnectorHealth>("ConnectorHealth"),
  contractState: ContractStateView,
  refreshDisabled: Schema.Boolean,
  activityReadable: Schema.Boolean,
  auth: Schema.NullOr(ConnectorAuthProps),
});
export type ConnectorData = typeof ConnectorData.Type;

export interface ConnectorLocation {
  readonly id: string | null;
  readonly hash: string;
  readonly handoff: string | null;
}

const withoutUnmanagedCredential = () => {
  let last: { raw: UiConnector; shown: UiConnector } | null = null;
  return (raw: UiConnector): UiConnector => {
    if (last?.raw === raw) return last.shown;
    const shown = { ...raw };
    if (!shown.permissions?.manageSharedAuth && !shown.permissions?.connectPersonal) delete shown.credential;
    last = { raw, shown };
    return shown;
  };
};

export const connectorProjection = () => {
  const health = keepShownHealth();
  const contractState = keepSameContractState();
  const connector = withoutUnmanagedCredential();
  const auth = keepSame<ConnectorAuthProps>();
  const stable = keepSame<ConnectorData>();
  return (state: OperatorState, steady: SteadyHealth, location: ConnectorLocation): ConnectorData => {
    const { id } = location;
    const raw = id === null ? undefined : state.data?.connectors.find((row) => row.id === id);
    const fragment = location.hash.replace(/^#/, "");
    return stable({
      id,
      tab: (TABS as ReadonlyArray<string>).includes(fragment) ? (fragment as Tab) : "tools",
      health: health(maintainerContract(state), steady),
      contractState: contractState(contractStateView(state)),
      refreshDisabled: !state.admissionValid || raw?.status === "loading",
      activityReadable: activityReadable(state),
      auth:
        raw && id !== null
          ? auth({
              connector: connector(raw),
              handoff: location.handoff,
              confirming: state.confirming?.connectorId === id ? state.confirming.action : null,
              failure: Object.hasOwn(state.connectorFailures, id) ? (state.connectorFailures[id] ?? null) : null,
              oauthBusy: state.oauthBusy === id,
              oauthBlocked: state.oauthBlocked === id,
              oauthNotice: state.oauthNoticeFor === id ? state.oauthNotice : null,
              editing: state.credentialEditing === id,
              untested: state.credentialUntested === id,
              credentialBusy: state.credentialBusy === id,
              credentialNotice: state.credentialNoticeFor === id ? state.credentialNotice : null,
            })
          : null,
    });
  };
};

const ConnectorMessage = UiSchema.TaggedEnum({
  SelectedTab: { value: Schema.String },
  ClickedRefreshCatalog: {},
  ClickedRetryLoad: {},
});

type H = Html.H<typeof ConnectorMessage.Type>;

const stopReadsOnLeave = (id: string) =>
  Stream.unwrap(
    OperatorController.useSync((controller) => Stream.never.pipe(Stream.ensuring(controller.stopConnectorReads(id)))),
  );

const ConnectionTab = (h: H, data: ConnectorData, id: string) => {
  const contract = data.health.contract!;
  const config = contract.config!.connectors.find((c) => c.id === id)!;
  const live = contract.live.connectors.find((c) => c.id === id)!;
  const summary = connectorSummary(config, contract.configSources ?? {});
  const name = config.title ?? id;
  return h.div.class("collection", "connection-sections").children(
    Card(h, {
      className: "",
      label: "Authentication",
      title: "Authentication",
      children: [
        data.auth
          ? ConnectorAuth(h, { props: data.auth })
          : StateBlock(h, { busy: true, copy: "Authentication details are loading." }),
      ],
    })
      .attr("id", `auth-${id}`)
      .attr("tabindex", "-1"),
    Card(h, {
      className: "",
      label: "Diagnostics",
      title: "Diagnostics",
      children: [ConnectorDiagnostics(h, live, data.auth?.connector ?? null)],
    }),
    h.div.class("island").onMount(HostConnectorConfig({ summary, name })),
  );
};

const DetailTabs = (h: H, data: ConnectorData, id: string) => {
  const live = data.health.contract!.live.connectors.find((c) => c.id === id)!;
  return Tabs(h, {
    props: { value: data.tab, tabs: TABS.map((value) => ({ value })), activateOnFocus: true },
    onEmit: { Selected: ({ value }) => ConnectorMessage.SelectedTab({ value }) },
    view: (tabs) =>
      tabs.root(h.div).children(
        tabs.list(h.div.class("tabs-list").attr("aria-label", "Connector detail")).children(
          ...(
            [
              ["tools", "Tools"],
              ["connection", "Connection"],
              ["activity", "Activity"],
            ] as const
          ).map(([value, label]) =>
            tabs
              .tab({
                element: h.button
                  .key(value)
                  .class("tabs-trigger")
                  .attr("data-state", data.tab === value ? "active" : "inactive"),
                value,
              })
              .children(label),
          ),
        ),
        tabs.panel({ element: h.div.class("tabs-content"), value: "tools" })?.children(
          live.observedAt !== undefined && live.tools.length === 0
            ? StateBlock(h, {
                busy: live.problem !== "connector_timeout",
                title: "Tools awaiting live read",
                copy:
                  live.problem === "connector_timeout"
                    ? "This status is stored. Refresh to read the connector and its tools."
                    : "This status is stored. The tools appear when the live read answers.",
              })
            : Catalog(h, { key: id, props: { tools: live.tools, connectorId: id } }),
        ) ?? null,
        tabs
          .panel({ element: h.div.class("tabs-content"), value: "connection" })
          ?.children(ConnectionTab(h, data, id)) ?? null,
        tabs
          .panel({ element: h.div.class("tabs-content"), value: "activity" })
          ?.children(
            h.div
              .class("connector-activity")
              .children(
                data.activityReadable
                  ? h.div.class("island").onMount(HostConnectorActivity({ connector: id }))
                  : StateBlock(h, { copy: "Activity isn't available." }),
              ),
          ) ?? null,
      ),
  });
};

export const ConnectorDetailPageNoDeps = Html.component({
  name: "ConnectorDetailPage",
  props: Schema.Struct({ data: ConnectorData }),
  model: Schema.Null,
  message: ConnectorMessage,
  restore: false,
}).make({
  init: () => null,
  update: {
    SelectedTab: ($, { value }) => $.run(ShowConnectorTab.make({ tab: value })),
    ClickedRefreshCatalog: ($) =>
      $.props.data.id === null ? $.model : $.run(RefreshConnector.make({ connector: $.props.data.id })),
    ClickedRetryLoad: ($) => $.run(RetryOperatorLoad.make()),
  },
  subscriptions: ({ props }) =>
    props.data.id === null ? [] : [Subscription.make("connectorReads", props.data.id, stopReadsOnLeave)],
  view: (h) => {
    const { data } = h.props;
    const { id, health } = data;
    const contract = health.contract;
    const config = id === null ? undefined : contract?.config?.connectors.find((c) => c.id === id);
    const live = id === null ? undefined : contract?.live.connectors.find((c) => c.id === id);
    const verdict = live && id !== null ? verdictFor(id, live, health) : null;
    return h.section.attr("id", "connectorView").children(
      h.a
        .attr("href", "/connectors")
        .class("back-link")
        .children(Icon(h, "back", 14), "All connectors"),
      h.div.class("page-heading", "conn-heading").children(
        h.div.class("conn-head").children(
          h.div.class("conn-title").children(
            h.h1
              .attr("id", "connectorHeading")
              .attr("tabindex", "-1")
              .attr("title", config?.title ?? "Connector")
              .children(config?.title ?? "Connector"),
            verdict ? VerdictPill(h, verdict) : null,
          ),
          config && live && id !== null
            ? h.div
                .class("conn-badges")
                .children(
                  h.code.attr("title", id).children(id),
                  AuthScopeBadge(h, config.authScope),
                  ToolSplit(h, live.tools, storedTools(live)),
                )
            : null,
          live?.observedAt !== undefined
            ? StoredStatus(h, { props: { observedAt: live.observedAt, parked: live.problem === "connector_timeout" } })
            : null,
          config?.description ? h.p.class("conn-description").children(config.description) : null,
        ),
        h.button
          .class("btn", "default")
          .disabled(data.refreshDisabled)
          .on("click", ConnectorMessage.ClickedRefreshCatalog())
          .children("Refresh catalog"),
      ),
      !contract
        ? ContractState(h, data.contractState, ConnectorMessage.ClickedRetryLoad())
        : id !== null && !config
          ? StateBlock(h, { title: "Connector unavailable", copy: "Not visible to you." })
          : id === null || !live
            ? StateBlock(h, { busy: true, title: "Loading connection…", copy: "Waiting for connection details." })
            : DetailTabs(h, data, id),
    );
  },
});

export const ConnectorDetailPage = ConnectorDetailPageNoDeps.pipe(
  Component.provide([RetryOperatorLoad.layer, RefreshConnector.layer, ShowConnectorTab.layer]),
);
