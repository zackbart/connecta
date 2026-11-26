import { Command, Component, Mount, Router, Subscription, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Effect, Schema, Stream } from "effect";
import { endpointFromHash } from "../../connection-map.js";
import type { OperatorUiContractV2 } from "../../contract.js";
import {
  endpointRows,
  runsAsLabel,
  toolSplit,
  toolsPending,
  visibleChips,
  type AccessChip,
  type EndpointAudience,
  type EndpointGroup,
  type EndpointRow,
} from "../../endpoints.js";
import { shownHealth, type SteadyHealth } from "../../health.js";
import { clientServerName, clientSetupCommands, type ClientSetupCommand } from "../../setup-commands.js";
import { connectorVerdict, type ConnectorSignals, type OperatorState, type Tone } from "../../view.js";
import { mcpUrl } from "../config.js";
import {
  ContractState,
  ContractStateView,
  contractStateView,
  maintainerContract,
} from "../components/contract-state.js";
import { CopyButton } from "../components/copy-button.js";
import { Dialog } from "../components/dialog.js";
import { opaque } from "../components/projection.js";
import { Icon } from "../components/icons.js";
import { EndpointName, Monogram, RunsAs, SplitBar } from "../components/marks.js";
import { MemberMark, Pill, SegmentedControl, StateBlock } from "../components/parts.js";
import { OperatorController } from "../services/controller.js";

export const EndpointsData = UiSchema.TaggedEnum({
  Contract: { contract: ContractStateView },
  Ready: {
    rows: opaque<ReadonlyArray<EndpointRow>>("EndpointRows"),
    signals: opaque<Readonly<Record<string, ConnectorSignals>>>("ConnectorSignals"),
    serverName: Schema.NullOr(Schema.String),
  },
});
export type EndpointsData = typeof EndpointsData.Type;

type Ready = Extract<EndpointsData, { readonly _tag: "Ready" }>;

export const endpointsProjection = () => {
  let last: { contract: OperatorUiContractV2; steady: SteadyHealth; ready: Ready } | null = null;
  return (state: OperatorState, steady: SteadyHealth): EndpointsData => {
    const contract = maintainerContract(state);
    if (!contract) return EndpointsData.Contract({ contract: contractStateView(state) });
    if (last?.contract !== contract || last.steady !== steady) {
      const shown = shownHealth(contract, steady);
      const ready = EndpointsData.Ready({
        rows: endpointRows(shown.contract!),
        signals: shown.signals,
        serverName: contract.config?.server.name ?? null,
      }) as Ready;
      last = { contract, steady, ready };
    }
    return last.ready;
  };
};

export const endpointUrl = (path: string): string => new URL(path, mcpUrl).href;

const SetupTarget = Schema.Struct({ label: Schema.String, url: Schema.String, name: Schema.String });
type SetupTarget = typeof SetupTarget.Type;

const ClientId = Schema.Literals(["claude", "codex", "json"]);
type ClientId = ClientSetupCommand["id"];

const CLIENT_LABELS: Record<ClientId, string> = { claude: "Claude Code", codex: "Codex", json: "JSON" };

export class RetryEndpointsLoad extends Command.Service<RetryEndpointsLoad>()("operator/RetryEndpointsLoad", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync(
      (controller) => () => Effect.as(Effect.forkDetach(controller.retryLoad), Component.noop),
    ),
  );
}

const EndpointsPageMessage = UiSchema.TaggedEnum({
  ClickedEndpointToggle: { key: Schema.String },
  ClickedShowMoreAccess: { key: Schema.String },
  ClickedSetup: { target: SetupTarget },
  PickedClient: { client: ClientId },
  RequestedCloseSetup: {},
  ChangedLocationHash: { hash: Schema.String },
  StartedRecovery: {},
  ClickedRetryLoad: {},
});

type H = Html.H<typeof EndpointsPageMessage.Type>;

const RevealEndpoint = Mount.make("RevealEndpoint", { args: {} }, (section: HTMLElement) =>
  Effect.sync(() => {
    section.scrollIntoView({ block: "nearest" });
    return Component.noop;
  }),
);

const FocusWhenExpanded = Mount.makeStream(
  "FocusWhenExpanded",
  { args: { expanded: Schema.Boolean } },
  (list: HTMLElement, { expanded: initial }, changes) =>
    Stream.callback<never>(() =>
      Effect.gen(function* () {
        let expanded = initial;
        yield* Stream.runForEach(changes, (args) =>
          Effect.sync(() => {
            if (args.expanded && !expanded) list.focus();
            expanded = args.expanded;
          }),
        ).pipe(Effect.forkScoped);
      }),
    ),
);

const locationHashes = Stream.unwrap(
  Router.Router.useSync((router) =>
    Stream.merge(
      Stream.map(router.changes, (location) => location.hash),
      Stream.suspend(() => Stream.map(Stream.fromEventListener(window, "hashchange"), () => router.location().hash)),
    ),
  ),
);

const EndpointLine = (h: H, key: string, url: string, label: string, kind?: EndpointAudience) =>
  h.div.class("endpoint", kind === "agents" && "endpoint-agent").children(
    kind ? h.span.class("endpoint-kind").children(kind === "agents" ? "Agents" : "People") : null,
    h.code.children(url.split(/(?<=\/)(?!\/)/).flatMap((part, index) => (index ? [h.wbr, part] : [part]))),
    CopyButton(h, {
      key,
      props: {
        value: url,
        label: "Copy URL",
        className: "btn sm copy-btn",
        icon: true,
        ariaLabel: kind === "agents" ? `Copy agent URL for ${label}` : `Copy URL for ${label}`,
      },
    }),
  );

function connectorProblem(
  group: EndpointGroup,
  signals: Readonly<Record<string, ConnectorSignals>>,
): { label: string; tone: Tone } | null {
  const { config, live } = group;
  if (!live) return null;
  const verdict = connectorVerdict(live, Object.hasOwn(signals, config.id) ? signals[config.id] : undefined);
  return verdict.tone === "ok" ? null : { label: verdict.label, tone: verdict.tone };
}

const ConnectorName = (h: H, group: EndpointGroup, signals: Readonly<Record<string, ConnectorSignals>>) => {
  const { config } = group;
  const problem = connectorProblem(group, signals);
  const title = config.title ?? config.id;
  return h.a
    .class("endpoint-connector-name")
    .attr("href", `/connectors/${encodeURIComponent(config.id)}#${problem ? "connection" : "tools"}`)
    .children(
      Monogram(h, config.id, title, "sm"),
      title,
      problem ? h.span.class("dot", problem.tone).attr("title", problem.label).attr("aria-hidden", "true") : null,
      problem ? h.span.class("visually-hidden").children(" (", problem.label, ")") : null,
    );
};

const Chip = (h: H, chip: AccessChip) =>
  h.li
    .key(chip.key)
    .class("access-chip", chip.kind)
    .attr("title", chip.text)
    .children(
      MemberMark(h, chip),
      chip.kind === "agent" ? h.span.class("visually-hidden").children("Agent ") : null,
      h.span.class("access-chip-text", "visually-hidden").children(chip.text),
    );

const WhoCanUse = (h: H, endpoint: EndpointRow, expanded: boolean) => {
  const label = `Who can use ${endpoint.label}`;
  const group = h.div.class("endpoint-access").attr("aria-label", label).attr("role", "group");
  if (!endpoint.access.length) return group.children(h.span.class("meta").children("Nobody"));
  const { shown, hidden } = visibleChips(endpoint.access, expanded);
  return group.children(
    h.ul
      .class("access-chips", "stack", expanded && "all")
      .attr("tabindex", "-1")
      .onMount(FocusWhenExpanded({ expanded }))
      .children(shown.map((chip) => Chip(h, chip))),
    hidden
      ? h.button
          .attr("type", "button")
          .class("access-more")
          .attr("aria-label", `Show ${hidden} more who can use ${endpoint.label}`)
          .on("click", EndpointsPageMessage.ClickedShowMoreAccess({ key: endpoint.key }))
          .children("+", String(hidden))
      : null,
  );
};

const MONOGRAM_LIMIT = 4;

const ConnectorMarks = (h: H, endpoint: EndpointRow, signals: Readonly<Record<string, ConnectorSignals>>) => {
  if (!endpoint.groups.length) return h.span.class("endpoint-monograms", "meta").children("None");
  const shown = endpoint.groups.slice(0, MONOGRAM_LIMIT);
  const rest = endpoint.groups.length - shown.length;
  return h.ul
    .class("endpoint-monograms")
    .attr("aria-label", `Connectors on ${endpoint.label}`)
    .children(
      shown.map((group) => {
        const title = group.config.title ?? group.config.id;
        const problem = connectorProblem(group, signals);
        return h.li
          .key(group.config.id)
          .attr("title", problem ? `${title} · ${problem.label}` : title)
          .children(
            Monogram(h, group.config.id, title),
            problem ? h.span.class("monogram-dot", problem.tone).attr("aria-hidden", "true") : null,
            h.span.class("visually-hidden").children(title, problem ? ` (${problem.label})` : ""),
          );
      }),
      rest
        ? h.li
            .key("more")
            .class("monogram-more")
            .attr("title", `${rest} more`)
            .children("+", String(rest), h.span.class("visually-hidden").children(" more"))
        : null,
    );
};

const ToolSummary = (h: H, endpoint: EndpointRow) => {
  if (endpoint.toolCount === null) {
    return h.div
      .class("endpoint-tool-summary")
      .attr("title", "Tools not known yet")
      .children(
        h.span
          .class("endpoint-count")
          .children(
            h.span.class("visually-hidden").children("Tools: not known yet"),
            h.span.attr("aria-hidden", "true").children("–"),
          ),
        SplitBar(h, 0, 0),
      );
  }
  const split = toolSplit(endpoint.groups.flatMap((group) => group.tools));
  return h.div
    .class("endpoint-tool-summary")
    .attr("title", `${split.read} read · ${split.write} write`)
    .children(
      h.span
        .class("endpoint-count")
        .children(h.span.class("visually-hidden").children("Tools: "), String(endpoint.toolCount)),
      SplitBar(h, split.read, split.write),
      h.span.class("visually-hidden").children(`, ${split.read} read, ${split.write} write`),
    );
};

const EndpointTools = (h: H, endpoint: EndpointRow, signals: Readonly<Record<string, ConnectorSignals>>) => [
  endpoint.access.length
    ? h.ul
        .class("endpoint-members")
        .attr("aria-label", `Members of ${endpoint.label}`)
        .children(
          endpoint.access.map((chip) =>
            h.li.key(chip.key).class("member-chip", chip.kind).children(MemberMark(h, chip), chip.text),
          ),
        )
    : null,
  endpoint.groups.length
    ? h.table
        .class("endpoint-breakdown")
        .attr("aria-label", `Tools on ${endpoint.label}`)
        .children(
          h.thead.children(
            h.tr.children(
              h.th.attr("scope", "col").children("Connector"),
              h.th.attr("scope", "col").children("Runs as"),
              h.th.attr("scope", "col").children("Tools"),
            ),
          ),
          h.tbody.children(
            endpoint.groups.map((group) =>
              h.tr.key(group.config.id).children(
                h.td.children(
                  ConnectorName(h, group, signals),
                  group.unlisted
                    ? h.span
                        .class("meta")
                        .attr("title", "Kept off the model's roster; still callable")
                        .children(" · unlisted")
                    : null,
                ),
                h.td
                  .class("endpoint-runs-as")
                  .children(
                    RunsAs(
                      h,
                      group.runsAs
                        ? runsAsLabel(group.runsAs)
                        : group.config.authScope === "personal"
                          ? "Personal"
                          : "Shared",
                    ),
                  ),
                h.td.children(
                  group.tools.length
                    ? h.ul.class("endpoint-tools").children(
                        group.tools.map((tool) =>
                          h.li
                            .key(tool.address)
                            .class("tool-chip", tool.classification ?? undefined)
                            .children(
                              tool.classification === "write" ? Icon(h, "pencil", 11) : null,
                              tool.name,
                              tool.classification === "write"
                                ? h.span.class("visually-hidden").children(" · write")
                                : null,
                            ),
                        ),
                      )
                    : toolsPending(group)
                      ? h.span
                          .class("meta")
                          .children(
                            group.live?.problem === "connector_timeout" ? "Not known until Refresh" : "Checking…",
                          )
                      : h.span.class("meta").children("No tools"),
                ),
              ),
            ),
          ),
        )
    : StateBlock(h, { copy: "No connectors" }),
];

const SetupDrawer = (h: H, target: SetupTarget | null, client: ClientId, open: boolean) => {
  const commands = target ? clientSetupCommands(target.name, target.url) : [];
  const command = commands.find((candidate) => candidate.id === client) ?? commands[0];
  return Dialog(h, {
    key: "setup",
    open,
    drawer: true,
    title: "Client setup",
    description: target?.label ?? "",
    onClose: EndpointsPageMessage.RequestedCloseSetup(),
    children: [
      target && command
        ? h.section.class("setup-list").children(
            EndpointLine(h, "setup-url", target.url, target.label),
            SegmentedControl(h, {
              label: "Client",
              value: command.id,
              options: commands.map((candidate) => ({ value: candidate.id, label: CLIENT_LABELS[candidate.id] })),
              select: (picked) => EndpointsPageMessage.PickedClient({ client: picked }),
            }),
            h.div
              .class("setup-item")
              .attr("data-setup", command.id)
              .children(
                h.pre.class("setup-code").children(command.text),
                CopyButton(h, {
                  key: "setup-command",
                  props: {
                    value: command.text,
                    label: "Copy",
                    icon: true,
                    className: "btn sm copy-btn setup-copy",
                    ariaLabel: `Copy ${command.label} setup for ${target.label}`,
                  },
                }),
              ),
          )
        : null,
    ],
  });
};

const EndpointEntry = (
  h: H,
  endpoint: EndpointRow,
  index: number,
  data: Ready,
  model: {
    readonly open: ReadonlyArray<string>;
    readonly expanded: ReadonlyArray<string>;
    readonly linked: string | null;
  },
) => {
  const expanded = model.open.includes(endpoint.key);
  const panel = `endpoint-tools-${index}`;
  const url = endpointUrl(endpoint.path);
  const section = h.section
    .key(endpoint.key)
    .class("endpoint-entry", expanded && "open")
    .attr("data-endpoint", endpoint.key)
    .attr("aria-label", endpoint.label);
  return (endpoint.key === model.linked ? section.onMount(RevealEndpoint({})) : section).children(
    h.div.class("endpoint-columns").children(
      h.div.class("endpoint-name").children(
        h.button
          .attr("type", "button")
          .class("endpoint-toggle")
          .attr("aria-expanded", expanded ? "true" : "false")
          .attr("aria-controls", panel)
          .on("click", EndpointsPageMessage.ClickedEndpointToggle({ key: endpoint.key }))
          .children(
            h.span.class("endpoint-chevron").children(Icon(h, "chevron", 14)),
            EndpointName(h, endpoint.pool, endpoint.label),
          ),
        endpoint.readOnly ? Pill(h, "info", "read-only") : null,
        h.span.class("meta").children(`${endpoint.surface} · code ${endpoint.executeCode ? "on" : "off"}`),
      ),
      h.div
        .class("endpoint-urls")
        .children(EndpointLine(h, `url:${endpoint.key}`, url, endpoint.label, endpoint.audience)),
      WhoCanUse(h, endpoint, model.expanded.includes(endpoint.key)),
      ConnectorMarks(h, endpoint, data.signals),
      ToolSummary(h, endpoint),
      h.button
        .class("btn", "default", "sm", "endpoint-setup")
        .attr("aria-label", `Client setup for ${endpoint.label}`)
        .on(
          "click",
          EndpointsPageMessage.ClickedSetup({
            target: {
              label: endpoint.label,
              url,
              name: clientServerName(
                data.serverName ?? undefined,
                endpoint.audience === "agents" ? (endpoint.pool ?? undefined) : undefined,
              ),
            },
          }),
        )
        .children(Icon(h, "terminal", 14), "Setup"),
    ),
    h.div
      .attr("id", panel)
      .class("endpoint-details")
      .attr("hidden", expanded ? undefined : "")
      .children(expanded ? EndpointTools(h, endpoint, data.signals) : null),
  );
};

const toggled = (keys: ReadonlyArray<string>, key: string) =>
  keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key];

export const EndpointsPageNoDeps = Html.component({
  name: "EndpointsPage",
  props: Schema.Struct({ data: EndpointsData, recovering: Schema.Boolean }),
  model: Schema.Struct({
    open: Schema.Array(Schema.String),
    expanded: Schema.Array(Schema.String),
    setup: Schema.NullOr(SetupTarget),
    client: ClientId,
    linked: Schema.NullOr(Schema.String),
  }),
  message: EndpointsPageMessage,
  restore: false,
}).make({
  init: () => ({ open: [], expanded: [], setup: null, client: "claude" as const, linked: null }),
  update: {
    ClickedEndpointToggle: ($, { key }) => $.evolve({ open: (open) => toggled(open, key) }),
    ClickedShowMoreAccess: ($, { key }) =>
      $.evolve({ expanded: (expanded) => (expanded.includes(key) ? expanded : [...expanded, key]) }),
    ClickedSetup: ($, { target }) => $.evolve({ setup: target }),
    PickedClient: ($, { client }) => $.evolve({ client }),
    RequestedCloseSetup: ($) => $.evolve({ setup: null }),
    StartedRecovery: ($) => $.evolve({ setup: null }),
    ChangedLocationHash: ($, { hash }) => {
      const linked = endpointFromHash(hash);
      return linked
        ? $.evolve({ linked, open: (open) => (open.includes(linked) ? open : [...open, linked]) })
        : $.evolve({ linked: null });
    },
    ClickedRetryLoad: ($) => $.run(RetryEndpointsLoad.make()),
  },
  subscriptions: ({ props }) => [
    Subscription.make(
      "linkedEndpoint",
      Stream.map(locationHashes, (hash) => EndpointsPageMessage.ChangedLocationHash({ hash })),
    ),
    ...(props.recovering ? [Subscription.make("recovery", Stream.make(EndpointsPageMessage.StartedRecovery()))] : []),
  ],
  view: (h, model) => {
    const { data, recovering } = h.props;
    const ready = data._tag === "Ready" ? data : null;
    return h.section.attr("id", "endpointsView").children(
      h.div
        .class("page-heading")
        .children(
          h.div.children(
            h.h1.attr("id", "endpointsHeading").attr("tabindex", "-1").children("Endpoints"),
            h.p
              .class("meta")
              .children(
                ready
                  ? `${ready.rows.length} ${ready.rows.length === 1 ? "endpoint" : "endpoints"}`
                  : "Defined in code",
              ),
          ),
        ),
      h.p
        .class("meta")
        .children(
          "Maintainers get the whole catalog at /mcp; everyone else gets their one pool there. Agents connect at /agent/<pool>.",
        ),
      EndpointsData.match(data, {
        Contract: ({ contract }) => ContractState(h, contract, EndpointsPageMessage.ClickedRetryLoad()),
        Ready: (ready) =>
          h.div
            .class("endpoint-table")
            .attr("aria-label", "Endpoints")
            .children(
              h.div
                .class("endpoint-columns", "endpoint-labels")
                .attr("aria-hidden", "true")
                .children(
                  h.span.class("endpoint-label-name").children("Endpoint"),
                  h.span.class("endpoint-label-who").children("Access"),
                  h.span.class("endpoint-label-conn").children("Connectors"),
                  h.span.class("endpoint-label-tools").children("Tools"),
                ),
              ready.rows.map((endpoint, index) => EndpointEntry(h, endpoint, index, ready, model)),
            ),
      }),
      SetupDrawer(h, model.setup, model.client, model.setup !== null && !recovering),
    );
  },
});

export const EndpointsPage = EndpointsPageNoDeps.pipe(Component.provide([RetryEndpointsLoad.layer]));
