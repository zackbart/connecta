import { UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Schema } from "effect";
import type { OperatorTool } from "../../contract.js";
import { Dialog } from "../components/dialog.js";
import { Badge, SegmentedControl, StateBlock } from "../components/parts.js";
import { opaque } from "../components/projection.js";

const Kind = Schema.Literals(["all", "read", "write"]);
type Kind = typeof Kind.Type;

const CatalogMessage = UiSchema.TaggedEnum({
  UpdatedQuery: { value: Schema.String },
  SelectedKind: { kind: Kind },
  ClickedTool: { address: Schema.String },
  RequestedCloseSchema: {},
});

type H = Html.H<typeof CatalogMessage.Type>;

const ClassBadge = (h: H, classification: OperatorTool["classification"]) =>
  Badge(h, classification === "read" ? "Read" : "Write", classification === "read" ? "ok" : "warn");

const AnnotationBadges = (h: H, tool: OperatorTool) => [
  tool.annotations?.destructiveHint ? Badge(h, "Destructive", "danger") : null,
  tool.annotations?.openWorldHint ? Badge(h, "Open world") : null,
];

const SchemaBlock = (h: H, title: string, value: unknown) =>
  h.section
    .class("schema-block")
    .children(
      h.h3.children(title),
      value ? h.pre.class("schema-code").children(JSON.stringify(value, null, 2)) : h.p.class("meta").children("None"),
    );

const ToolRow = (h: H, tool: OperatorTool) =>
  h.li
    .key(tool.address)
    .class("tool-row")
    .children(
      h.div.class("tool-row-main").children(
        h.button
          .attr("type", "button")
          .class("tool-name")
          .on("click", CatalogMessage.ClickedTool({ address: tool.address }))
          .children(h.code.children(tool.address)),
        tool.description ? h.p.class("tool-description").children(tool.description) : null,
      ),
      h.div.class("tool-row-badges").children(AnnotationBadges(h, tool), ClassBadge(h, tool.classification)),
    );

export const Catalog = Html.component({
  name: "Catalog",
  props: Schema.Struct({ tools: opaque<ReadonlyArray<OperatorTool>>("OperatorTools"), connectorId: Schema.String }),
  model: Schema.Struct({ query: Schema.String, kind: Kind, selected: Schema.NullOr(Schema.String) }),
  message: CatalogMessage,
  restore: false,
}).make({
  init: () => ({ query: "", kind: "all" as const, selected: null }),
  update: {
    UpdatedQuery: ($, { value }) => $.evolve({ query: value }),
    SelectedKind: ($, { kind }) => $.evolve({ kind }),
    ClickedTool: ($, { address }) => $.evolve({ selected: address }),
    RequestedCloseSchema: ($) => $.evolve({ selected: null }),
  },
  view: (h, model) => {
    const { tools, connectorId } = h.props;
    const q = model.query.trim().toLowerCase();
    const visible = tools.filter(
      (tool) =>
        (model.kind === "all" || tool.classification === model.kind) &&
        [tool.address, tool.description, connectorId].some((value) => value?.toLowerCase().includes(q)),
    );
    const writes = tools.filter((tool) => tool.classification === "write").length;
    const selected = model.selected === null ? null : (tools.find((tool) => tool.address === model.selected) ?? null);
    return h.div.class("collection", "catalog").children(
      tools.length
        ? h.div.class("catalog-toolbar").children(
            h.input
              .attr("type", "search")
              .class("input", "filter")
              .attr("aria-label", "Filter tools")
              .attr("placeholder", "Search tools")
              .value(model.query)
              .on("input", ({ value }) => CatalogMessage.UpdatedQuery({ value })),
            SegmentedControl(h, {
              label: "Tool classification",
              value: model.kind,
              options: [
                { value: "all", label: "All", count: tools.length },
                { value: "read", label: "Read", count: tools.length - writes },
                { value: "write", label: "Write", count: writes },
              ],
              select: (kind) => CatalogMessage.SelectedKind({ kind }),
            }),
          )
        : null,
      visible.length
        ? h.ul
            .class("tool-list", "card")
            .attr("aria-label", "Tool catalog")
            .children(visible.map((tool) => ToolRow(h, tool)))
        : StateBlock(h, { copy: tools.length ? "No matching tools" : "No live tools." }),
      Dialog(h, {
        key: "schema",
        open: selected !== null,
        drawer: true,
        title: selected?.address ?? "Tool schema",
        description: "Tool schema",
        onClose: CatalogMessage.RequestedCloseSchema(),
        children: [
          selected
            ? h.div
                .class("schema-drawer")
                .children(
                  h.div
                    .class("schema-badges")
                    .children(ClassBadge(h, selected.classification), AnnotationBadges(h, selected)),
                  selected.description ? h.p.class("schema-description").children(selected.description) : null,
                  SchemaBlock(h, "Input schema", selected.inputSchema),
                  SchemaBlock(h, "Output schema", selected.outputSchema),
                  selected.annotations ? SchemaBlock(h, "Annotations", selected.annotations) : null,
                )
            : null,
        ],
      }),
    );
  },
});
