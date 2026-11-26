import { Mount } from "@effect/ui";
import { Effect, Queue, Schema, Stream } from "effect";
import type { MapNode } from "../../connection-map.js";

const SVG = "http://www.w3.org/2000/svg";

type Attrs = Readonly<Record<string, string | number>>;
type Child = SVGElement | string;

function svg(tag: string, attrs: Attrs, ...children: ReadonlyArray<Child | null>): SVGElement {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  for (const child of children) if (child !== null) element.append(child);
  return element;
}

const box = (x: number, y: number, width: number, height: number, className = "map-box") =>
  svg("rect", { class: className, x, y, width, height, rx: 11 });

const agentGlyph = () =>
  svg(
    "svg",
    {
      class: "icon",
      viewBox: "0 0 24 24",
      width: 16,
      height: 16,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.8",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    svg("rect", { x: "4", y: "8", width: "16", height: "12", rx: "3" }),
    svg("path", { d: "M12 8V4.5M9.5 13.5v1M14.5 13.5v1" }),
  );

function nodeBody(node: MapNode): SVGElement[] {
  const { x, y, width, height } = node;
  const title = (text: string, mono = false, left = x + 46) =>
    svg("text", { class: mono ? "map-title mono" : "map-title", x: left, y: y + 23 }, text);
  const detail = (text: string, left = x + 46, className = "map-detail") =>
    svg("text", { class: className, x: left, y: y + 39 }, text);
  if (node.kind === "person") {
    return [
      box(x, y, width, height),
      svg("circle", { class: `map-avatar hue-${node.hue}`, cx: x + 24, cy: y + height / 2, r: 13 }),
      svg(
        "text",
        { class: "map-avatar-text", x: x + 24, y: y + height / 2 + 4, "text-anchor": "middle" },
        node.initials,
      ),
      title(node.label),
      detail(node.detail),
    ];
  }
  if (node.kind === "agent") {
    return [
      box(x, y, width, height),
      svg("rect", { class: "map-agent-mark", x: x + 11, y: y + height / 2 - 13, width: 26, height: 26, rx: 7 }),
      svg("g", { class: "map-agent-glyph", transform: `translate(${x + 16} ${y + height / 2 - 8})` }, agentGlyph()),
      title(node.label, true),
      detail(node.detail, x + 46, node.tone === "warn" ? "map-detail tone-warn" : "map-detail"),
    ];
  }
  if (node.kind === "endpoint") {
    return [
      box(x, y, width, height),
      title(node.label, true, x + 14),
      ...(node.readOnly
        ? [
            svg("rect", { class: "map-mode read-only", x: x + width - 70, y: y + 10, width: 58, height: 18, rx: 9 }),
            svg(
              "text",
              { class: "map-mode-text", x: x + width - 41, y: y + 22.5, "text-anchor": "middle" },
              "read-only",
            ),
          ]
        : []),
      detail(node.detail, x + 14),
    ];
  }
  return [
    box(x, y, width, height),
    svg("rect", { class: "map-tile", x: x + 11, y: y + 13, width: 26, height: 28, rx: 7 }),
    svg("text", { class: "map-tile-text", x: x + 24, y: y + 31, "text-anchor": "middle" }, node.initials),
    title(node.label),
    detail(node.detail, x + 46, node.tone === "ok" ? "map-detail" : `map-detail tone-${node.tone}`),
    svg("circle", { class: `map-health tone-${node.tone}`, cx: x + width - 16, cy: y + height / 2, r: 4 }),
  ];
}

const toolCount = (x: number, y: number, count: number) =>
  svg(
    "text",
    { class: "map-title", x: x + 14, y: y + 22 },
    svg("tspan", { class: "map-count" }, String(count)),
    svg("tspan", { class: "map-detail", dx: 5 }, count === 1 ? "tool" : "tools"),
  );

function toolsBox(node: MapNode): SVGElement[] {
  if (!node.toolsBox) return [];
  const { x, y, width, height } = node.toolsBox;
  if (!node.tools && node.storedTools !== null) {
    return [
      box(x, y, width, height, "map-box tools"),
      toolCount(x, y, node.storedTools),
      svg("rect", { class: "map-bar", x: x + 14, y: y + 33, width: width - 28, height: 6, rx: 3 }),
    ];
  }
  if (!node.tools) {
    return [
      box(x, y, width, height, "map-box tools"),
      svg("rect", { class: "map-unknown", x: x + 14, y: y + height / 2 - 1.5, width: 16, height: 3, rx: 1.5 }),
    ];
  }
  const total = node.tools.read + node.tools.write;
  const bar = width - 28;
  const read = total ? (bar * node.tools.read) / total : 0;
  const gap = node.tools.read ? 1.5 : 0;
  return [
    box(x, y, width, height, "map-box tools"),
    toolCount(x, y, total),
    total
      ? svg(
          "text",
          { class: "map-detail", x: x + width - 14, y: y + 22, "text-anchor": "end" },
          `${node.tools.read} read, ${node.tools.write} write`,
        )
      : null,
    svg("rect", { class: "map-bar", x: x + 14, y: y + 33, width: bar, height: 6, rx: 3 }),
    node.tools.read
      ? svg("rect", { class: "map-bar read", x: x + 14, y: y + 33, width: read, height: 6, rx: 3 })
      : null,
    node.tools.write
      ? svg("rect", {
          class: "map-bar write",
          x: x + 14 + read + gap,
          y: y + 33,
          width: Math.max(0, bar - read - gap),
          height: 6,
          rx: 3,
        })
      : null,
  ].filter((element): element is SVGElement => element !== null);
}

function nodeClass(node: MapNode, lit: ReadonlySet<string> | null): string {
  return [
    "map-node",
    `kind-${node.kind}`,
    node.kind === "connector" && node.tone !== "ok" && `problem-${node.tone}`,
    node.kind === "agent" && node.tone === "warn" && "no-token",
    lit?.has(node.id) && "lit",
    lit && !lit.has(node.id) && "dim",
  ]
    .filter(Boolean)
    .join(" ");
}

export type MapNodeEvent =
  | { readonly _tag: "Hovered"; readonly id: string | null }
  | { readonly _tag: "Focused"; readonly id: string | null }
  | { readonly _tag: "Followed"; readonly href: string };

const Nodes = Schema.declare<ReadonlyArray<MapNode>>((input): input is ReadonlyArray<MapNode> => Array.isArray(input));

export const DrawMapNodes = Mount.makeStream(
  "DrawMapNodes",
  {
    args: {
      nodes: Nodes,
      lit: Schema.NullOr(Schema.Array(Schema.String)),
      tabStop: Schema.NullOr(Schema.String),
      moveTo: Schema.NullOr(Schema.String),
    },
  },
  (layer: SVGGElement, _args, changes) =>
    Stream.callback<MapNodeEvent>((queue) =>
      Effect.gen(function* () {
        const emit = (event: MapNodeEvent) => void Queue.offerUnsafe(queue, event);
        const drawn = new Map<string, { element: SVGElement; node: MapNode }>();
        const listen = (element: SVGElement, id: string) => {
          element.addEventListener("mouseenter", () => emit({ _tag: "Hovered", id }));
          element.addEventListener("mouseleave", () => emit({ _tag: "Hovered", id: null }));
          element.addEventListener("focus", () => emit({ _tag: "Focused", id }));
          element.addEventListener("blur", () => emit({ _tag: "Focused", id: null }));
          element.addEventListener("click", (event) => {
            const href = element.getAttribute("href");
            if (
              !href ||
              event.defaultPrevented ||
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            emit({ _tag: "Followed", href });
          });
        };
        const draw = ({ nodes, lit, tabStop, moveTo }: typeof _args) => {
          const lighted = lit ? new Set(lit) : null;
          const keep = new Set<string>();
          let before: ChildNode | null = layer.firstChild;
          for (const node of nodes) {
            keep.add(node.id);
            const tag = node.href ? "a" : "g";
            let entry = drawn.get(node.id);
            if (entry && entry.element.localName !== tag) {
              entry.element.remove();
              entry = undefined;
            }
            if (!entry) {
              const element = svg(tag, { "data-node": node.id });
              listen(element, node.id);
              entry = { element, node: undefined as unknown as MapNode };
              drawn.set(node.id, entry);
            }
            const { element } = entry;
            element.setAttribute("class", nodeClass(node, lighted));
            element.setAttribute("tabindex", node.id === tabStop ? "0" : "-1");
            if (entry.node !== node) {
              if (node.href) element.setAttribute("href", node.href);
              else element.setAttribute("role", "group");
              element.setAttribute("aria-label", node.summary);
              element.replaceChildren(...nodeBody(node), ...(node.kind === "connector" ? toolsBox(node) : []));
              entry.node = node;
            }
            if (element !== before) layer.insertBefore(element, before);
            before = element.nextSibling;
          }
          for (const [id, { element }] of drawn) {
            if (keep.has(id)) continue;
            element.remove();
            drawn.delete(id);
          }
          if (moveTo) drawn.get(moveTo)?.element.focus();
        };
        yield* Stream.runForEach(changes, (args) => Effect.sync(() => draw(args))).pipe(Effect.forkScoped);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const { element } of drawn.values()) element.remove();
            drawn.clear();
          }),
        );
      }),
    ),
);
