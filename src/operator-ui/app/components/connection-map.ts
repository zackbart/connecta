import { Component, Mount, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Predicate, Schema } from "effect";
import {
  mapHighlight,
  mapList,
  toolsPhrase,
  type ConnectionMap,
  type MapEdge,
  type MapNode,
} from "../../connection-map.js";
import { pageForPath } from "../../view.js";
import { NavigateToPage } from "../shell/commands.js";
import { DrawMapNodes, type MapNodeEvent } from "./map-nodes.js";
import { decorative } from "./marks.js";
import { MemberChip, PageLink, StateBlock } from "./parts.js";

export const MapData = Schema.declare<ConnectionMap>((input): input is ConnectionMap => Predicate.isObject(input), {
  identifier: "ConnectionMap",
});

const ConnectionMapMessage = UiSchema.TaggedEnum({
  HoveredMapNode: { id: Schema.NullOr(Schema.String) },
  FocusedMapNode: { id: Schema.NullOr(Schema.String) },
  PressedMapKey: { key: Schema.String },
  ClickedLink: { href: Schema.String },
});

type H = Html.H<typeof ConnectionMapMessage.Type>;

const follow = (href: string) => ConnectionMapMessage.ClickedLink({ href });

const fromNodes = (event: MapNodeEvent) =>
  event._tag === "Hovered"
    ? ConnectionMapMessage.HoveredMapNode({ id: event.id })
    : event._tag === "Focused"
      ? ConnectionMapMessage.FocusedMapNode({ id: event.id })
      : follow(event.href);

const classes = (...values: ReadonlyArray<string | false | null | undefined>) => values.filter(Boolean).join(" ");

const edgeClass = (edge: MapEdge, lit: boolean) =>
  classes(
    "map-edge",
    `tone-${edge.tone}`,
    edge.kind === "grant" && edge.readOnly && "read-only",
    edge.noToken && "no-token",
    lit && "lit",
  );

function nextNode(nodes: ReadonlyArray<MapNode>, from: MapNode, key: string): MapNode | null {
  if (key === "Home") return nodes[0] ?? null;
  if (key === "End") return nodes[nodes.length - 1] ?? null;
  if (key === "ArrowUp" || key === "ArrowDown") {
    const column = nodes.filter((n) => n.column === from.column);
    return column[column.indexOf(from) + (key === "ArrowUp" ? -1 : 1)] ?? null;
  }
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const step = key === "ArrowLeft" ? -1 : 1;
  for (let column = from.column + step; column >= 0 && column <= 2; column += step) {
    const candidates = nodes.filter((n) => n.column === column);
    if (!candidates.length) continue;
    return candidates.reduce((best, n) => (Math.abs(n.y - from.y) < Math.abs(best.y - from.y) ? n : best));
  }
  return null;
}

const MapLegend = (h: H) => {
  const line = (className: string, label: string) =>
    h.li.children(
      h.svg
        .attrs({ viewBox: "0 0 24 4", width: "24", height: "4" })
        .attrs(decorative)
        .children(h.path.class("map-edge", ...className.split(" ")).attr("d", "M1,2 L23,2")),
      label,
    );
  return h.ul
    .class("map-legend")
    .attr("aria-label", "Map legend")
    .children(
      line("tone-ok", "Healthy"),
      line("tone-warn", "Attention"),
      line("tone-danger", "Failing"),
      line("tone-neutral read-only", "Read-only"),
      line("tone-neutral no-token", "No token"),
      h.li.children(h.span.class("map-swatch", "read").attr("aria-hidden", "true"), "Read"),
      h.li.children(h.span.class("map-swatch", "write").attr("aria-hidden", "true"), "Write"),
    );
};

const ListLink = (h: H, node: MapNode, className: string, text: string) =>
  node.href ? PageLink(h, node.href, follow).class(className).children(text) : h.span.class(className).children(text);

const MapList = (h: H, map: ConnectionMap) =>
  h.ul
    .class("map-list")
    .attr("aria-label", "Connections by endpoint")
    .children(
      mapList(map).map(({ endpoint, callers, connectors }) =>
        h.li
          .key(endpoint.id)
          .class("map-list-entry")
          .children(
            h.div
              .class("map-list-head")
              .children(
                ListLink(h, endpoint, "map-list-path", endpoint.name),
                endpoint.readOnly ? h.span.class("badge", "tag", "accent").children("read-only") : null,
              ),
            callers.length
              ? h.ul.class("access-chips").children(
                  callers.map(({ node, noToken }) =>
                    MemberChip(
                      h,
                      {
                        key: node.id,
                        kind: node.kind === "agent" ? "agent" : "human",
                        text: node.name,
                        initials: node.initials,
                        hue: node.hue,
                      },
                      { muted: noToken, link: node.href ? { href: node.href, follow } : null },
                    )
                      .key(node.id)
                      .children(noToken ? h.span.class("map-list-note", "tone-warn").children("no token") : null),
                  ),
                )
              : null,
            connectors.length
              ? h.ul
                  .class("map-list-items")
                  .children(
                    connectors.map(({ node, served }) =>
                      h.li
                        .key(node.id)
                        .children(
                          h.span.class("dot", node.tone).attr("aria-hidden", "true"),
                          ListLink(h, node, "map-list-name", node.name),
                          h.span
                            .class("map-list-note")
                            .children(
                              node.tone === "ok" && node.tools ? toolsPhrase(served.tools, served.write) : node.detail,
                            ),
                        ),
                    ),
                  )
              : null,
          ),
      ),
    );

export const ConnectionMapViewNoDeps = Html.component({
  name: "ConnectionMapView",
  props: Schema.Struct({ map: MapData }),
  model: Schema.Struct({
    hovered: Schema.NullOr(Schema.String),
    focused: Schema.NullOr(Schema.String),
    current: Schema.NullOr(Schema.String),
    moveTo: Schema.NullOr(Schema.String),
  }),
  message: ConnectionMapMessage,
  restore: false,
}).make({
  init: () => ({ hovered: null, focused: null, current: null, moveTo: null }),
  update: {
    HoveredMapNode: ($, { id }) => $.evolve({ hovered: id }),
    FocusedMapNode: ($, { id }) => $.evolve({ focused: id, current: (current) => id ?? current, moveTo: null }),
    PressedMapKey: ($, { key }) => {
      const { nodes } = $.props.map;
      const from = nodes.find((node) => node.id === $.model.focused);
      const to = from ? nextNode(nodes, from, key) : null;
      return to ? $.evolve({ current: to.id, moveTo: to.id }) : $.model;
    },
    ClickedLink: ($, { href }) => $.run(NavigateToPage.make({ page: pageForPath(href.replace(/[?#].*$/, "")), href })),
  },
  view: (h, model) => {
    const { map } = h.props;
    if (!map.nodes.some((node) => node.kind === "connector")) return StateBlock(h, { title: "Nothing to map yet" });
    const tabStop = map.nodes.some((node) => node.id === model.current) ? model.current : (map.nodes[0]?.id ?? null);
    const active = model.hovered ?? model.focused;
    const lit = active ? mapHighlight(map, active) : null;
    const summary = active ? (map.nodes.find((node) => node.id === active)?.summary ?? null) : null;
    const focused = map.nodes.find((node) => node.id === model.focused);
    return h.div.class("map-root").children(
      h.div.class("map-figure").children(
        h.div.class("map-canvas").children(
          h.svg
            .class("map-svg", lit && "tracing")
            .attr("viewBox", `0 0 ${map.width} ${map.height}`)
            .attr("role", "group")
            .attr(
              "aria-label",
              "Connection map: callers, endpoints and connectors. Use the arrow keys to move between nodes.",
            )
            .on(
              "keydown",
              ({ key }) =>
                focused && nextNode(map.nodes, focused, key) ? ConnectionMapMessage.PressedMapKey({ key }) : undefined,
              { preventDefault: true },
            )
            .children(
              h.g.attr("aria-hidden", "true").children(
                map.columns.map((column) =>
                  h.svgText
                    .key(column.label)
                    .class("map-column")
                    .attrs({ x: String(column.x + 2), y: "20" })
                    .children(
                      column.label,
                      h.tspan
                        .class("map-column-count")
                        .attr("dx", "6")
                        .children(column.count === null ? "–" : String(column.count)),
                    ),
                ),
                map.edges.map((edge) =>
                  h.path
                    .key(edge.id)
                    .class(...edgeClass(edge, Boolean(lit?.edges.has(edge.id))).split(" "))
                    .attr("d", edge.path),
                ),
                map.nodes.flatMap((node) =>
                  node.toolsBox
                    ? [
                        h.path
                          .key(`${node.id}>tools`)
                          .class("map-edge", `tone-${node.tone}`, Boolean(lit?.nodes.has(node.id)) && "lit")
                          .attr(
                            "d",
                            `M${node.x + node.width},${node.y + node.height / 2} L${node.toolsBox.x},${node.toolsBox.y + node.toolsBox.height / 2}`,
                          ),
                      ]
                    : [],
                ),
              ),
              h.g.onMount(
                DrawMapNodes({
                  nodes: map.nodes,
                  lit: lit ? [...lit.nodes] : null,
                  tabStop,
                  moveTo: model.moveTo,
                }).pipe(Mount.map(fromNodes)),
              ),
            ),
        ),
        h.div.class("map-foot").children(
          h.p
            .attr("id", "mapTrace")
            .class("map-trace", !summary && "idle")
            .attr("aria-hidden", "true")
            .children(summary ?? ""),
          MapLegend(h),
        ),
      ),
      MapList(h, map),
    );
  },
});

export const ConnectionMapView = ConnectionMapViewNoDeps.pipe(Component.provide([NavigateToPage.layer]));
