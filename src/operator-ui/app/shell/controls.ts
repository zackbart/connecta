import { Command, Component, Subscription, UiSchema } from "@effect/ui";
import { Autocomplete, Tabs, type AutocompleteItem } from "@effect/ui-kit";
import { Html, HtmlSubscription } from "@effect/ui/html";
import { Effect, Schema, Stream } from "effect";
import { OPERATOR_PAGES, PAGE_META, type OperatorPage, type OperatorState } from "../../view.js";
import { schemePinned } from "../config.js";
import { SCHEME_KEY } from "../scheme.js";
import { Dialog } from "../components/dialog.js";
import { Icon, type IconName } from "../components/icons.js";
import { opaque } from "../components/projection.js";
import { OperatorController } from "../services/controller.js";
import { NavigateToPage } from "./commands.js";

export const Scheme = Schema.Literals(["light", "dark", "system"]);
export type Scheme = typeof Scheme.Type;

export function readScheme(): Scheme {
  const current = document.documentElement.dataset.scheme;
  if (schemePinned && (current === "light" || current === "dark")) return current;
  try {
    const stored = localStorage.getItem(SCHEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    return "system";
  }
  return "system";
}

export class ApplyScheme extends Command.Service<ApplyScheme>()("operator/ApplyScheme", {
  args: { scheme: Scheme },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(({ scheme }) =>
    Effect.sync(() => {
      if (scheme === "system") delete document.documentElement.dataset.scheme;
      else document.documentElement.dataset.scheme = scheme;
      if (!schemePinned) {
        try {
          localStorage.setItem(SCHEME_KEY, scheme);
        } catch {
          return Component.noop;
        }
      }
      return Component.noop;
    }),
  );
}

type Group = "Pages" | "Connectors" | "Tools" | "Preferences";

export interface PaletteEntry {
  readonly value: string;
  readonly search: string;
  readonly group: Group;
  readonly text: string;
  readonly icon: IconName;
  readonly code: boolean;
  readonly target:
    | { readonly _tag: "Page"; readonly page: OperatorPage; readonly href: string }
    | { readonly _tag: "Appearance" };
}

const pageEntry = (page: OperatorPage): PaletteEntry => ({
  value: `page:${page}`,
  search: PAGE_META[page].label,
  group: "Pages",
  text: PAGE_META[page].label,
  icon: "page",
  code: false,
  target: { _tag: "Page", page, href: PAGE_META[page].path },
});

const APPEARANCE: PaletteEntry = {
  value: "appearance",
  search: "Appearance",
  group: "Preferences",
  text: "Appearance",
  icon: "sun",
  code: false,
  target: { _tag: "Appearance" },
};

const connectorHref = (id: string) => `/connectors/${encodeURIComponent(id)}#tools`;

export const paletteEntries = () => {
  let last: { contract: OperatorState["contract"]; entries: ReadonlyArray<PaletteEntry> } | null = null;
  return (state: OperatorState): ReadonlyArray<PaletteEntry> => {
    const contract =
      state.session === "ready" && state.contract?.role === "maintainer" && state.contract.config
        ? state.contract
        : null;
    if (last && last.contract === contract) return last.entries;
    const entries: PaletteEntry[] = contract
      ? [
          ...contract.config!.connectors.map((connector): PaletteEntry => ({
            value: `connector:${connector.id}`,
            search: `connector ${connector.id} ${connector.title ?? ""}`,
            group: "Connectors",
            text: connector.title ?? connector.id,
            icon: "plug",
            code: false,
            target: { _tag: "Page", page: "connector", href: connectorHref(connector.id) },
          })),
          ...contract.live.connectors.flatMap((connector) =>
            connector.tools.map((tool): PaletteEntry => ({
              value: `tool:${tool.address}`,
              search: `tool ${tool.address} ${tool.description ?? ""}`,
              group: "Tools",
              text: tool.address,
              icon: "tool",
              code: true,
              target: { _tag: "Page", page: "connector", href: connectorHref(connector.id) },
            })),
          ),
        ]
      : [];
    last = { contract, entries };
    return entries;
  };
};

export function commandScore(search: string, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 1;
  const haystack = search.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of needle) {
    const at = haystack.indexOf(char, from);
    if (at < 0) return 0;
    const start = at === 0 || /[\s\-_./:]/.test(haystack[at - 1]!);
    score += at === previous + 1 ? 1 : start ? 0.9 : 0.3;
    previous = at;
    from = at + 1;
  }
  return score / needle.length;
}

export function rankEntries(entries: ReadonlyArray<PaletteEntry>, query: string): ReadonlyArray<PaletteEntry> {
  if (!query.trim()) return entries;
  const scored = entries
    .map((entry, index) => ({ entry, index, score: commandScore(entry.search, query) }))
    .filter(({ score }) => score > 0);
  const best = new Map<Group, number>();
  for (const { entry, score } of scored) best.set(entry.group, Math.max(best.get(entry.group) ?? 0, score));
  return scored
    .sort(
      (a, b) =>
        best.get(b.entry.group)! - best.get(a.entry.group)! ||
        (a.entry.group === b.entry.group ? b.score - a.score : 0) ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
}

const Page = Schema.Literals(OPERATOR_PAGES);

const ShellControlsMessage = UiSchema.TaggedEnum({
  ClickedSearch: {},
  ClickedAppearance: {},
  PressedShortcut: {},
  RequestedClosePalette: {},
  RequestedCloseAppearance: {},
  SettledPalette: {},
  CompletedFocusReturn: {},
  UpdatedQuery: { value: Schema.String, reason: Schema.String },
  SelectedScheme: { value: Schema.String },
  ChangedEntries: { entries: opaque<ReadonlyArray<PaletteEntry>>("PaletteEntries") },
  StartedRecovery: {},
});
type Message = typeof ShellControlsMessage.Type;

const ShellControlsEvents = UiSchema.TaggedEnum({ ChangedScheme: { scheme: Scheme } });

export class AwaitFocusReturn extends Command.Service<AwaitFocusReturn>()("operator/AwaitFocusReturn", {
  args: {},
  success: ShellControlsMessage,
}) {
  static readonly layer = this.toLayer(() =>
    Effect.as(
      Effect.promise(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      ),
      ShellControlsMessage.CompletedFocusReturn(),
    ),
  );
}

const paletteChanges = Stream.unwrap(
  OperatorController.useSync((controller) => {
    const project = paletteEntries();
    return Stream.changes(
      Stream.map(Stream.concat(Stream.sync(controller.state), controller.changes), (state) => project(state)),
    );
  }),
);

const SCHEME_ICON: Record<Scheme, IconName> = { dark: "moon", light: "sun", system: "monitor" };

const SCHEMES = [
  ["light", "Light", "Light surfaces"],
  ["dark", "Dark", "Dark surfaces"],
  ["system", "System", "Match your device"],
] as const;

const PICKED = "\u0000";

const paletteItem =
  (query: string) =>
  (entry: PaletteEntry): AutocompleteItem => ({
    value: entry.value,
    label: `${query}${PICKED}${entry.value}`,
    group: entry.group,
  });

const pickedValue = (label: string) => label.slice(label.lastIndexOf(PICKED) + 1);

const Palette = (h: Html.H<Message>, entries: ReadonlyArray<PaletteEntry>, query: string) => {
  const ranked = rankEntries(entries, query);
  const byValue = new Map(entries.map((entry) => [entry.value, entry]));
  return Autocomplete(h, {
    key: "palette-search",
    props: {
      open: false,
      value: query,
      items: entries.map(paletteItem(query)),
      filteredItems: ranked.map(paletteItem(query)),
      inline: true,
      autoHighlight: "always",
    },
    onEmit: {
      RequestedOpen: () => undefined,
      RequestedClose: () => undefined,
      Updated: ({ value, reason }) => ShellControlsMessage.UpdatedQuery({ value, reason }),
      Highlighted: () => undefined,
      Settled: () => undefined,
    },
    view: (autocomplete) =>
      h.div.class("command").children(
        autocomplete.label(h.div.class("visually-hidden")).children("Operator commands"),
        h.div
          .class("command-field")
          .children(
            Icon(h, "search", 16),
            autocomplete.input(h.input.class("command-input").attr("placeholder", "Search pages, connectors, tools…")),
          ),
        autocomplete.empty(h.div.class("command-empty")).children("No matches"),
        autocomplete.list(h.div.class("command-list")).children(
          autocomplete.groups.map((group) =>
            autocomplete
              .group({ element: h.div.key(group.key ?? "").class("command-group"), group: group.key ?? "" })
              .children(
                autocomplete
                  .groupLabel({ element: h.div.class("command-group-heading"), group: group.key ?? "" })
                  .children(group.key ?? ""),
                group.items.map((item) => {
                  const entry = byValue.get(item.value)!;
                  return autocomplete
                    .item({ element: h.div.class("command-item"), value: item.value })
                    .children(Icon(h, entry.icon, 15), entry.code ? h.code.children(entry.text) : entry.text);
                }),
              ),
          ),
        ),
      ),
  });
};

const Appearance = (h: Html.H<Message>, scheme: Scheme) =>
  schemePinned
    ? h.p.class("meta").children(`${scheme === "dark" ? "Dark" : "Light"} mode`)
    : Tabs(h, {
        key: "scheme",
        props: { value: scheme, tabs: SCHEMES.map(([value]) => ({ value })), activateOnFocus: true },
        onEmit: { Selected: ({ value }) => ShellControlsMessage.SelectedScheme({ value }) },
        view: (tabs) =>
          tabs.root(h.div).children(
            tabs.list(h.div.class("tabs-list", "segmented").attr("aria-label", "Color scheme")).children(
              ...SCHEMES.map(([value, label]) =>
                tabs
                  .tab({
                    element: h.button
                      .key(value)
                      .class("tabs-trigger")
                      .attr("data-state", scheme === value ? "active" : "inactive"),
                    value,
                  })
                  .children(label),
              ),
            ),
            tabs
              .panel({ element: h.div.key(scheme).class("tabs-content"), value: scheme })
              ?.children(h.p.children(SCHEMES.find(([value]) => value === scheme)![2])) ?? null,
          ),
      });

const closed = { palette: false, appearance: false, queued: false, query: "" } as const;

export const ShellControlsNoDeps = Html.component({
  name: "ShellControls",
  props: Schema.Struct({ pages: Schema.Array(Page), recovering: Schema.Boolean, scheme: Scheme }),
  model: Schema.Struct({
    palette: Schema.Boolean,
    appearance: Schema.Boolean,
    queued: Schema.Boolean,
    returnFocus: Schema.Boolean,
    query: Schema.String,
    entries: opaque<ReadonlyArray<PaletteEntry>>("PaletteEntries"),
  }),
  message: ShellControlsMessage,
  events: ShellControlsEvents,
  restore: false,
}).make({
  init: () => ({ ...closed, returnFocus: true, entries: [] }),
  update: {
    ClickedSearch: ($) => $.evolve({ palette: true, returnFocus: true, query: "" }),
    ClickedAppearance: ($) => $.evolve({ appearance: true, returnFocus: true }),
    PressedShortcut: ($) => $.evolve({ palette: !$.model.palette, returnFocus: true, query: "" }),
    RequestedClosePalette: ($) => $.evolve({ palette: false, query: "" }),
    RequestedCloseAppearance: ($) => $.evolve({ appearance: false }),
    SettledPalette: ($) => ($.model.queued ? $.run(AwaitFocusReturn.make()) : $),
    CompletedFocusReturn: ($) =>
      $.model.queued && !$.model.palette ? $.evolve({ queued: false, appearance: true, returnFocus: true }) : $,
    UpdatedQuery: ($, { value, reason }) => {
      if (reason !== "item-press") return $.evolve({ query: value });
      const picked = pickedValue(value);
      const entry = [...$.props.pages.map(pageEntry), ...$.model.entries, APPEARANCE].find(
        (candidate) => candidate.value === picked,
      );
      if (!entry) return $.evolve({ palette: false, query: "" });
      if (entry.target._tag === "Appearance")
        return $.evolve({ palette: false, query: "", queued: !$.model.appearance });
      return $.evolve({ ...closed, returnFocus: false }).run(
        NavigateToPage.make({ page: entry.target.page, href: entry.target.href }),
      );
    },
    SelectedScheme: ($, { value }) =>
      Schema.is(Scheme)(value)
        ? $.run(ApplyScheme.make({ scheme: value })).emit(ShellControlsEvents.ChangedScheme({ scheme: value }))
        : $,
    ChangedEntries: ($, { entries }) => $.evolve({ entries }),
    StartedRecovery: ($) => $.evolve({ ...closed, returnFocus: false }),
  },
  subscriptions: ({ props }) => [
    HtmlSubscription.onDocument(
      "keydown",
      ({ key, meta, ctrl }) =>
        (meta || ctrl) && key.toLowerCase() === "k" ? ShellControlsMessage.PressedShortcut() : undefined,
      { preventDefault: true, capture: true },
    ),
    Subscription.make(
      "paletteEntries",
      Stream.map(paletteChanges, (entries) => ShellControlsMessage.ChangedEntries({ entries })),
    ),
    ...(props.recovering ? [Subscription.make("recovery", Stream.make(ShellControlsMessage.StartedRecovery()))] : []),
  ],
  view: (h, model) => {
    const { pages, scheme } = h.props;
    const entries = [...pages.map(pageEntry), ...model.entries, APPEARANCE];
    return h.div.class("shell-controls").children(
      h.button
        .key("search")
        .attr("type", "button")
        .class("icon-button", "command-trigger")
        .attr("aria-label", "Search ⌘K")
        .attr("title", "Search ⌘K")
        .attr("aria-keyshortcuts", "Meta+K Control+K")
        .on("click", ShellControlsMessage.ClickedSearch())
        .children(Icon(h, "search", 15)),
      h.button
        .key("appearance")
        .attr("type", "button")
        .class("icon-button", "appearance-trigger")
        .attr("aria-label", "Appearance")
        .attr("title", "Appearance")
        .on("click", ShellControlsMessage.ClickedAppearance())
        .children(Icon(h, SCHEME_ICON[scheme], 17)),
      Dialog(h, {
        key: "appearance-dialog",
        open: model.appearance,
        title: "Appearance",
        description: schemePinned ? "Set by this deployment" : "Color scheme",
        returnFocus: model.returnFocus,
        onClose: ShellControlsMessage.RequestedCloseAppearance(),
        children: [Appearance(h, scheme)],
      }),
      Dialog(h, {
        key: "palette-dialog",
        open: model.palette,
        palette: true,
        title: "Search",
        description: "Pages, connectors and tools",
        returnFocus: model.returnFocus,
        onClose: ShellControlsMessage.RequestedClosePalette(),
        onClosed: ShellControlsMessage.SettledPalette(),
        children: [model.palette ? Palette(h, entries, model.query) : null],
      }),
    );
  },
});

export const ShellControls = ShellControlsNoDeps.pipe(
  Component.provide([NavigateToPage.layer, ApplyScheme.layer, AwaitFocusReturn.layer]),
);
