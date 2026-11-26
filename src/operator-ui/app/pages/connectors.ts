import { Component, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Schema } from "effect";
import type { OperatorConnectorOverlay, OperatorUiContractV2 } from "../../contract.js";
import type { ConnectorHealth, SteadyHealth } from "../../health.js";
import { contractRecovering, formatDate, type OperatorState } from "../../view.js";
import {
  AuthScopeBadge,
  ConnectorCardSkeleton,
  ConnectorLink,
  ConnectorsSkeleton,
  ProblemAction,
  sinceLabel,
  StoredStatus,
  storedTools,
  ToolSplit,
  verdictFor,
  VerdictPill,
} from "../components/connector-parts.js";
import {
  ContractState,
  ContractStateView,
  contractLoading,
  contractStateView,
  maintainerContract,
} from "../components/contract-state.js";
import { Pill, SegmentedControl, StateBlock } from "../components/parts.js";
import { keepSame, keepSameContractState, keepShownHealth, opaque } from "../components/projection.js";
import { Skeleton } from "../components/skeletons.js";
import { NavigateToPage } from "../shell/commands.js";
import { LoadOperatorContract, RetryOperatorLoad, ShowConnectorView } from "./connector-commands.js";
import { ConnectorMatrix, type MatrixRow } from "./connector-matrix.js";

const ConnectorView = Schema.Literals(["list", "matrix"]);
type ConnectorView = typeof ConnectorView.Type;

export const ConnectorsData = Schema.Struct({
  health: opaque<ConnectorHealth>("ConnectorHealth"),
  loading: Schema.Boolean,
  contractState: ContractStateView,
  refreshDisabled: Schema.Boolean,
  recovering: Schema.Boolean,
  view: ConnectorView,
});
export type ConnectorsData = typeof ConnectorsData.Type;

export const connectorsProjection = () => {
  const health = keepShownHealth();
  const contractState = keepSameContractState();
  const stable = keepSame<ConnectorsData>();
  return (state: OperatorState, steady: SteadyHealth, view: ConnectorView): ConnectorsData =>
    stable({
      health: health(maintainerContract(state), steady),
      loading: contractLoading(state),
      contractState: contractState(contractStateView(state)),
      refreshDisabled: state.session !== "ready" || state.contractPhase === "loading",
      recovering: contractRecovering(state),
      view,
    });
};

const Filter = Schema.Literals(["all", "attention", "healthy"]);
type Filter = typeof Filter.Type;

const ConnectorsMessage = UiSchema.TaggedEnum({
  UpdatedQuery: { value: Schema.String },
  SelectedFilter: { filter: Filter },
  SelectedView: { view: ConnectorView },
  ClickedRefresh: {},
  ClickedRetryLoad: {},
  ClickedConnectorLink: { href: Schema.String },
});

type H = Html.H<typeof ConnectorsMessage.Type>;

type OperatorConfigConnector = NonNullable<OperatorUiContractV2["config"]>["connectors"][number];

type Row = OperatorConnectorOverlay & { title: string; authScope: string; readOnly: boolean; description?: string };

interface Entry {
  readonly config: OperatorConfigConnector;
  readonly row: OperatorConnectorOverlay | null;
}

const follow = (href: string) => ConnectorsMessage.ClickedConnectorLink({ href });

const rowOf = (config: OperatorConfigConnector, live: OperatorConnectorOverlay): Row => ({
  ...live,
  title: config.title ?? config.id,
  authScope: config.authScope,
  readOnly: config.readOnly === true,
  ...(config.description ? { description: config.description } : {}),
});

const LastCall = (h: H, row: Row) =>
  h.span
    .class("connector-card-last")
    .children(
      h.span.class("meta").children("Last call"),
      " ",
      row.lastCall
        ? h.span
            .attr("title", `${formatDate(row.lastCall.at)} · ${row.lastCall.outcome}`)
            .children(
              h.span.class("dot", row.lastCall.outcome).attr("aria-hidden", "true"),
              ` ${sinceLabel(row.lastCall.at)}`,
            )
        : h.span
            .class("meta")
            .attr("title", "Not observed")
            .children("—", h.span.class("visually-hidden").children("Not observed")),
    );

const ConnectorCard = (h: H, row: Row, health: ConnectorHealth) => {
  const verdict = verdictFor(row.id, row, health);
  const titleId = `connector-card-${row.id}`;
  return h.li
    .key(row.id)
    .class("connector-card", verdict.action && "attention", verdict.action && verdict.tone)
    .attr("aria-labelledby", titleId)
    .children(
      h.div.class("connector-card-top").children(
        h.div.class("connector-card-name").children(
          h.h3
            .attr("id", titleId)
            .attr("title", row.title)
            .children(ConnectorLink(h, row.id, row.title, follow)),
          h.span
            .class("connector-card-sub")
            .children(
              h.code.attr("title", row.id).children(row.id),
              AuthScopeBadge(h, row.authScope),
              row.readOnly ? Pill(h, "info", "Read-only") : null,
            ),
        ),
        VerdictPill(h, verdict),
      ),
      row.description ? h.p.class("connector-card-description").children(row.description) : null,
      ToolSplit(h, row.tools, storedTools(row)),
      h.div.class("connector-card-foot").children(
        LastCall(h, row),
        row.observedAt !== undefined
          ? StoredStatus(h, {
              key: row.id,
              props: { observedAt: row.observedAt, parked: row.problem === "connector_timeout" },
            })
          : null,
        verdict.action ? ProblemAction(h, { id: row.id, name: row.title, action: verdict.action, follow }) : null,
      ),
    );
};

const VIEWS = [
  { value: "list", label: "List" },
  { value: "matrix", label: "Matrix" },
] as const;

const Ledger = (h: H, data: ConnectorsData, query: string, filter: Filter) => {
  const { health } = data;
  const contract = health.contract!;
  const entries: ReadonlyArray<Entry> =
    contract.config?.connectors.map((config) => ({
      config,
      row: contract.live.connectors.find((c) => c.id === config.id) ?? null,
    })) ?? [];
  const rows = entries.flatMap(({ config, row }) => (row ? [rowOf(config, row)] : []));
  const total = entries.length;
  const attention = new Set(rows.filter((row) => verdictFor(row.id, row, health).action).map((row) => row.id));
  const q = query.trim().toLowerCase();
  const visible = entries.filter(
    ({ config, row }) =>
      (filter === "all" || (row !== null && (filter === "attention") === attention.has(config.id))) &&
      [config.id, config.title ?? config.id, row?.status ?? ""].some((value) => value.toLowerCase().includes(q)),
  );
  const matrixRows: ReadonlyArray<MatrixRow> = visible.map(({ config, row }) => ({
    id: config.id,
    title: config.title ?? config.id,
    readOnly: config.readOnly === true,
    live: row,
  }));
  return h.section
    .class("section")
    .attr("aria-labelledby", "connectorLedgerHeading")
    .children(
      total
        ? h.div.class("connector-toolbar").children(
            SegmentedControl(h, {
              label: "Show connectors",
              value: filter,
              options: [
                { value: "all", label: "All", count: total },
                { value: "attention", label: "Needs attention", count: attention.size },
                { value: "healthy", label: "Healthy", count: rows.length - attention.size },
              ],
              select: (filter) => ConnectorsMessage.SelectedFilter({ filter }),
            }),
            h.input
              .attr("id", "filter")
              .attr("type", "search")
              .class("input", "filter")
              .value(query)
              .attr("placeholder", "Search")
              .attr("aria-label", "Filter connectors")
              .on("input", ({ value }) => ConnectorsMessage.UpdatedQuery({ value })),
          )
        : null,
      visible.length && data.view === "matrix"
        ? ConnectorMatrix(h, { props: { contract, rows: matrixRows, health, recovering: data.recovering } })
        : visible.length
          ? h.ul
              .class("connector-grid")
              .attr("aria-label", "Connectors")
              .children(
                visible.map(({ config, row }) =>
                  row
                    ? ConnectorCard(h, rowOf(config, row), health)
                    : ConnectorCardSkeleton(h, {
                        key: config.id,
                        title: ConnectorLink(h, config.id, config.title ?? config.id, follow),
                        id: config.id,
                        ...(config.description ? { description: config.description } : {}),
                      }),
                ),
              )
          : StateBlock(h, { copy: total ? "No matches" : "No connectors." }),
    );
};

export const ConnectorsPageNoDeps = Html.component({
  name: "ConnectorsPage",
  props: Schema.Struct({ data: ConnectorsData }),
  model: Schema.Struct({ query: Schema.String, filter: Filter }),
  message: ConnectorsMessage,
  restore: false,
}).make({
  init: () => ({ query: "", filter: "all" as const }),
  update: {
    UpdatedQuery: ($, { value }) => $.evolve({ query: value }),
    SelectedFilter: ($, { filter }) => $.evolve({ filter }),
    SelectedView: ($, { view }) => $.run(ShowConnectorView.make({ view })),
    ClickedRefresh: ($) => $.run(LoadOperatorContract.make()),
    ClickedRetryLoad: ($) => $.run(RetryOperatorLoad.make()),
    ClickedConnectorLink: ($, { href }) => $.run(NavigateToPage.make({ page: "connector", href })),
  },
  view: (h, model) => {
    const { data } = h.props;
    const contract = data.health.contract;
    const total = contract?.config?.connectors.length ?? 0;
    return h.section.attr("id", "connectionsView").children(
      h.div.class("page-heading").children(
        h.div.children(
          h.h1.attr("id", "connectionsHeading").attr("tabindex", "-1").children("Connectors"),
          contract
            ? h.h2
                .attr("id", "connectorLedgerHeading")
                .class("meta")
                .attr("tabindex", "-1")
                .children(`${total} ${total === 1 ? "connector" : "connectors"}`)
            : data.loading
              ? h.h2.class("meta").attr("aria-hidden", "true").children(Skeleton(h, "sm"))
              : null,
        ),
        h.div.class("page-actions").children(
          contract
            ? SegmentedControl(h, {
                label: "Connector view",
                value: data.view,
                options: VIEWS,
                select: (view) => ConnectorsMessage.SelectedView({ view }),
              })
            : null,
          h.button
            .class("btn", "default")
            .disabled(data.refreshDisabled)
            .on("click", ConnectorsMessage.ClickedRefresh())
            .children("Refresh"),
        ),
      ),
      !contract
        ? data.loading
          ? ConnectorsSkeleton(h)
          : ContractState(h, data.contractState, ConnectorsMessage.ClickedRetryLoad())
        : Ledger(h, data, model.query, model.filter),
    );
  },
});

export const ConnectorsPage = ConnectorsPageNoDeps.pipe(
  Component.provide([
    NavigateToPage.layer,
    RetryOperatorLoad.layer,
    LoadOperatorContract.layer,
    ShowConnectorView.layer,
  ]),
);
