import { Command, Component, Router, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Effect, Schema } from "effect";
import {
  activityOutcomeClass,
  activityReadable,
  activitySummary,
  contractRecovering,
  filterActivity,
  loadFailureCopy,
  type OperatorState,
  type UiActivityEvent,
} from "../../view.js";
import { productName } from "../config.js";
import { ActivityList } from "../components/activity-list.js";
import { Icon } from "../components/icons.js";
import { opaque } from "../components/projection.js";
import { ConnectorMark } from "../components/marks.js";
import { NoticeLine, StateBlock } from "../components/parts.js";
import { OperatorController } from "../services/controller.js";
import { RetryLoad } from "../shell/commands.js";
import { OperatorRoute } from "../shell/routes.js";

const Phase = Schema.Literals(["idle", "loading", "ready", "error"]);

export const ActivityData = UiSchema.TaggedEnum({
  Waiting: {},
  LoadFailure: { title: Schema.String, body: Schema.String },
  Unavailable: {},
  Ready: {
    events: opaque<ReadonlyArray<UiActivityEvent>>("ActivityEvents"),
    phase: Phase,
    notice: Schema.NullOr(Schema.Struct({ message: Schema.String, tone: Schema.Literals(["info", "error"]) })),
    more: Schema.Boolean,
    titles: opaque<ReadonlyMap<string, string>>("ConnectorTitles"),
  },
});
export type ActivityData = typeof ActivityData.Type;

type Ready = Extract<ActivityData, { readonly _tag: "Ready" }>;

const readyFor = (state: OperatorState): Ready => {
  const connectors = state.contract?.config?.connectors ?? state.data?.connectors ?? [];
  const titles = new Map(connectors.map((c) => [c.id, c.title ?? c.id]));
  titles.set("$operation", "Connecta");
  const notice = state.activityNotice;
  return ActivityData.Ready({
    events: state.activityEvents,
    phase: state.activityPhase,
    notice: notice ? { message: notice.message, tone: notice.tone } : null,
    more: state.activityCursor !== null,
    titles,
  }) as Ready;
};

const sameInputs = (a: OperatorState, b: OperatorState) =>
  a.activityEvents === b.activityEvents &&
  a.activityPhase === b.activityPhase &&
  a.activityNotice === b.activityNotice &&
  (a.activityCursor === null) === (b.activityCursor === null) &&
  a.contract?.config?.connectors === b.contract?.config?.connectors &&
  a.data?.connectors === b.data?.connectors;

export const activityProjection = () => {
  let last: { state: OperatorState; ready: Ready } | null = null;
  return (state: OperatorState): ActivityData => {
    if (!state.data) {
      return state.loadFailure
        ? ActivityData.LoadFailure(loadFailureCopy(state.loadFailure, productName))
        : ActivityData.Waiting();
    }
    if (!activityReadable(state) && !contractRecovering(state)) return ActivityData.Unavailable();
    if (!last || !sameInputs(last.state, state)) last = { state, ready: readyFor(state) };
    return last.ready;
  };
};

export class LoadActivity extends Command.Service<LoadActivity>()("operator/LoadActivity", {
  args: { reset: Schema.Boolean },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync(
      (controller) =>
        ({ reset }) =>
          Effect.as(controller.loadActivity(reset), Component.noop),
    ),
  );
}

export class RetryCollection extends Command.Service<RetryCollection>()("operator/RetryCollection", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync((controller) => () => Effect.as(controller.retryCollection, Component.noop)),
  );
}

const Filter = Schema.Literals(["q", "outcome", "connector", "source"]);
type Filter = typeof Filter.Type;

const ActivityMessage = UiSchema.TaggedEnum({
  UpdatedSearch: { value: Schema.String },
  ClickedFilter: { filter: Filter, value: Schema.String },
  ClickedClearFilters: {},
  ClickedRefresh: {},
  ClickedLoadOlder: {},
  ClickedRetryCollection: {},
  ClickedRetryLoad: {},
});
type ActivityMessage = typeof ActivityMessage.Type;

type H = Html.H<ActivityMessage>;

type OutcomeFilter = "" | "failed" | "succeeded";

const OUTCOME_OPTIONS: ReadonlyArray<{ readonly value: OutcomeFilter; readonly label: string }> = [
  { value: "", label: "All" },
  { value: "failed", label: "Failed" },
  { value: "succeeded", label: "Succeeded" },
];

const OUTCOME_CLASSES: Readonly<Record<string, readonly string[]>> = {
  failed: ["error", "timeout"],
  succeeded: ["success", "approved"],
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  native: "Native",
  call_tool: "Direct",
  call_destructive_tool: "Approved",
  execute_code: "Program",
  execute_read_code: "Read program",
  batch_call: "Batch",
  catalog_refresh: "Catalog",
};

const failedCall = (event: UiActivityEvent) =>
  event.kind === undefined && OUTCOME_CLASSES.failed!.includes(activityOutcomeClass(event.outcome));

function outcomeMatches(event: UiActivityEvent, outcome: string): boolean {
  if (!outcome) return true;
  if (event.kind === "catalog_drift") return false;
  const classes = Object.hasOwn(OUTCOME_CLASSES, outcome) ? OUTCOME_CLASSES[outcome] : undefined;
  return classes ? classes.includes(activityOutcomeClass(event.outcome)) : event.outcome === outcome;
}

const ChipGroup = (
  h: H,
  options: {
    readonly label: string;
    readonly filter: Filter;
    readonly value: string;
    readonly chips: ReadonlyArray<{ readonly value: string; readonly label: string; readonly mark?: string }>;
  },
) =>
  h.div
    .class("filter-chips")
    .attr("role", "group")
    .attr("aria-label", options.label)
    .children(
      options.chips.map((chip) =>
        h.button
          .key(chip.value)
          .attr("type", "button")
          .class("filter-chip")
          .attr("aria-pressed", String(options.value === chip.value))
          .on(
            "click",
            ActivityMessage.ClickedFilter({
              filter: options.filter,
              value: options.value === chip.value ? "" : chip.value,
            }),
          )
          .children(chip.mark === undefined ? null : ConnectorMark(h, chip.value, chip.mark, "sm"), chip.label),
      ),
    );

const Outcome = (h: H, value: string) =>
  h.div
    .class("segmented")
    .attr("role", "group")
    .attr("aria-label", "Outcome")
    .children(
      OUTCOME_OPTIONS.map((option) =>
        h.button
          .key(option.value || "all")
          .attr("type", "button")
          .attr("aria-pressed", String(value === option.value))
          .on("click", ActivityMessage.ClickedFilter({ filter: "outcome", value: option.value }))
          .children(option.label),
      ),
    );

const CallStrip = (h: H, events: ReadonlyArray<UiActivityEvent>) => {
  const calls = events
    .filter((event) => event.kind === undefined)
    .map((event) => ({ at: Date.parse(event.occurredAt), failed: failedCall(event) }))
    .filter((call) => Number.isFinite(call.at));
  if (calls.length < 2) return null;
  const first = Math.min(...calls.map((call) => call.at));
  const last = Math.max(...calls.map((call) => call.at));
  if (last - first < 60_000) return null;
  const bins = 32;
  const width = (last - first) / bins;
  const counts = Array.from({ length: bins }, () => ({ ok: 0, failed: 0 }));
  for (const call of calls) {
    const bin = counts[Math.min(bins - 1, Math.floor((call.at - first) / width))]!;
    if (call.failed) bin.failed++;
    else bin.ok++;
  }
  const peak = Math.max(...counts.map((bin) => bin.ok + bin.failed));
  const height = 28;
  const scale = (n: number) => (n ? Math.max(2, (n / peak) * height) : 0);
  const rect = (className: string, x: number, y: number, h2: number, rounded: boolean) =>
    h.el("rect").attrs({
      class: className,
      x: String(x),
      y: String(y),
      width: "4",
      height: String(h2),
      ...(rounded ? { rx: "1" } : {}),
    });
  return h
    .el("svg")
    .attrs({
      class: "call-strip",
      viewBox: `0 0 ${bins * 6} ${height}`,
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": `${calls.length} calls over the loaded window`,
    })
    .children(
      counts.map((bin, index) => {
        const failed = bin.failed ? scale(bin.failed) : 0;
        const ok = scale(bin.ok + bin.failed) - failed;
        return h
          .el("g")
          .key(String(index))
          .children(
            rect("strip-base", index * 6, height - 1, 1, false),
            bin.ok + bin.failed ? rect("strip-ok", index * 6, height - ok - failed, ok, true) : null,
            failed ? rect("strip-failed", index * 6, height - failed, failed, true) : null,
          );
      }),
    );
};

const Stats = (h: H, events: ReadonlyArray<UiActivityEvent>) => {
  const calls = events.filter((event) => event.kind === undefined);
  const failed = calls.filter(failedCall).length;
  const tools = new Set(calls.map((event) => event.address)).size;
  const changes = events.filter((event) => event.kind === "catalog_drift").length;
  const operations = events.filter((event) => event.kind === "operation").length;
  const stat = (key: string, value: number, one: string, many: string, tone?: string) =>
    h.div
      .key(key)
      .class("activity-stat", tone)
      .children(h.el("strong").children(String(value)), h.span.children(value === 1 ? one : many));
  return h.div.class("activity-stats").children(
    h.p
      .attr("id", "activitySummary")
      .class("visually-hidden")
      .attr("aria-live", "polite")
      .children(activitySummary([...events])),
    h.div
      .class("activity-stat-list")
      .attr("aria-hidden", "true")
      .children(
        stat("calls", calls.length, "call", "calls"),
        stat("failed", failed, "failed", "failed", failed ? "danger" : undefined),
        stat("tools", tools, "tool", "tools"),
        changes ? stat("changes", changes, "catalog change", "catalog changes") : null,
        operations ? stat("operations", operations, "operation", "operations") : null,
      ),
    CallStrip(h, events),
  );
};

const present = (values: ReadonlyArray<string>, selected: string) => [
  ...new Set([...values, ...(selected ? [selected] : [])]),
];

const Available = (h: H, data: Ready, route: OperatorRoute, connectorId: string | null) => {
  const params = route.search;
  const query = params.q ?? "";
  const connector = connectorId ?? params.connector ?? "";
  const outcome = params.outcome ?? "";
  const source = params.source ?? "";
  const exactOutcome = Boolean(outcome) && !OUTCOME_OPTIONS.some((option) => option.value === outcome);
  const loading = data.phase === "loading";
  const scoped = connectorId ? data.events.filter((event) => event.connectorId === connectorId) : data.events;
  const visible = filterActivity(
    scoped.filter(
      (event) =>
        (!connector || event.connectorId === connector) &&
        outcomeMatches(event, outcome) &&
        (!source || event.source === source),
    ),
    query,
  );
  const filtered = Boolean(query.trim() || outcome || source || (connector && !connectorId));
  const connectorChips = connectorId
    ? []
    : present(
        scoped.map((event) => event.connectorId),
        connector,
      );
  const sourceChips = present(
    scoped.map((event) => event.source),
    source,
  ).filter((value) => SOURCE_LABELS[value] || value === source);
  const showConnectors = connectorChips.length > 1 || Boolean(connector && !connectorId);
  const showSources = sourceChips.length > 1 || Boolean(source);
  const titleOf = (id: string) => data.titles.get(id) ?? id;
  return h.div
    .attr("id", "activityAvailable")
    .class("collection")
    .children(
      scoped.length === 0
        ? loading
          ? StateBlock(h, { busy: true, copy: "Loading activity…" })
          : data.phase === "error"
            ? StateBlock(h, {
                id: "activityError",
                tone: "error",
                title: "Activity couldn't be loaded",
                copy: data.notice?.message ?? null,
                action: { label: "Retry", message: ActivityMessage.ClickedRetryCollection() },
              })
            : StateBlock(h, {
                title: "No calls yet",
                action: { label: "Refresh", id: "refreshActivity", message: ActivityMessage.ClickedRefresh() },
              })
        : [
            Stats(h, scoped),
            h.div.class("activity-toolbar").children(
              h.div.class("activity-toolbar-row").children(
                h.label.class("activity-search").children(
                  Icon(h, "search", 15),
                  h.input
                    .attrs({
                      id: "activitySearch",
                      type: "search",
                      placeholder: "Search",
                      "aria-label": "Search loaded activity",
                    })
                    .value(query)
                    .on("input", ({ value }) => ActivityMessage.UpdatedSearch({ value })),
                ),
                Outcome(h, outcome),
                h.button
                  .attr("id", "refreshActivity")
                  .class("btn", "default", "sm", "activity-refresh")
                  .attr("type", "button")
                  .disabled(loading)
                  .on("click", ActivityMessage.ClickedRefresh())
                  .children(Icon(h, "refresh", 14), loading ? "Loading…" : "Refresh"),
              ),
              showConnectors || showSources || exactOutcome
                ? h.div.class("activity-toolbar-row", "chips").children(
                    exactOutcome
                      ? ChipGroup(h, {
                          label: "Exact outcome",
                          filter: "outcome",
                          value: outcome,
                          chips: [{ value: outcome, label: `Exact outcome: ${outcome}` }],
                        })
                      : null,
                    showConnectors
                      ? ChipGroup(h, {
                          label: "Connector",
                          filter: "connector",
                          value: connectorId ? "" : connector,
                          chips: connectorChips.map((id) => ({ value: id, label: titleOf(id), mark: titleOf(id) })),
                        })
                      : null,
                    showSources
                      ? ChipGroup(h, {
                          label: "Source",
                          filter: "source",
                          value: source,
                          chips: sourceChips.map((value) => ({ value, label: SOURCE_LABELS[value] ?? value })),
                        })
                      : null,
                  )
                : null,
            ),
            visible.length === 0
              ? StateBlock(h, {
                  title: "No matches",
                  ...(filtered
                    ? { action: { label: "Clear filters", message: ActivityMessage.ClickedClearFilters() } }
                    : {}),
                })
              : ActivityList(h, { events: visible, busy: loading, titles: data.titles, showConnector: !connectorId }),
          ],
      data.events.length > 0 ? NoticeLine(h, "activityNotice", data.notice, "meta") : null,
      data.more
        ? h.button
            .attr("id", "moreActivity")
            .class("btn", "default", "activity-more")
            .attr("type", "button")
            .disabled(loading)
            .on("click", ActivityMessage.ClickedLoadOlder())
            .children(loading ? "Loading…" : "Load older")
        : null,
    );
};

const filterPatch = (filter: Filter, value: string) => ({ [filter]: value || undefined });

export const ActivityViewNoDeps = Html.component({
  name: "ActivityView",
  props: Schema.Struct({ route: OperatorRoute, activity: ActivityData, connectorId: Schema.NullOr(Schema.String) }),
  model: Schema.Null,
  message: ActivityMessage,
  restore: false,
}).make({
  init: () => null,
  update: {
    UpdatedSearch: ($, { value }) =>
      $.run(
        Router.patchSearch(OperatorRoute, $.props.route, { q: value || undefined }, { history: "push" }).pipe(
          Command.asNoop,
        ),
      ),
    ClickedFilter: ($, { filter, value }) =>
      $.run(
        Router.patchSearch(OperatorRoute, $.props.route, filterPatch(filter, value), { history: "push" }).pipe(
          Command.asNoop,
        ),
      ),
    ClickedClearFilters: ($) =>
      $.run(
        Router.patchSearch(
          OperatorRoute,
          $.props.route,
          {
            q: undefined,
            outcome: undefined,
            source: undefined,
            ...($.props.connectorId ? {} : { connector: undefined }),
          },
          { history: "push" },
        ).pipe(Command.asNoop),
      ),
    ClickedRefresh: ($) => $.run(LoadActivity.make({ reset: true })),
    ClickedLoadOlder: ($) => $.run(LoadActivity.make({ reset: false })),
    ClickedRetryCollection: ($) => $.run(RetryCollection.make()),
    ClickedRetryLoad: ($) => $.run(RetryLoad.make()),
  },
  view: (h) => {
    const { activity, route, connectorId } = h.props;
    return h.section.attr("id", "activityView").children(
      connectorId
        ? null
        : h.div
            .class("page-heading")
            .children(h.div.children(h.h1.attr("id", "activityHeading").attr("tabindex", "-1").children("Activity"))),
      ActivityData.match(activity, {
        Waiting: () => StateBlock(h, { busy: true, copy: "Loading activity…" }),
        LoadFailure: ({ title, body }) =>
          StateBlock(h, {
            id: "loadFailure",
            tone: "error",
            title,
            copy: body,
            action: { label: "Retry", message: ActivityMessage.ClickedRetryLoad(), id: "retryLoad" },
          }),
        Unavailable: () => h.div.class("unavailable").children("Activity isn't available."),
        Ready: (ready) => Available(h, ready as Ready, route, connectorId),
      }),
    );
  },
});

export const ActivityView = ActivityViewNoDeps.pipe(
  Component.provide([LoadActivity.layer, RetryCollection.layer, RetryLoad.layer]),
);
