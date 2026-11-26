import type { Html } from "@effect/ui/html";

type Shape =
  | readonly ["path", string]
  | readonly ["circle", string, string, string]
  | readonly ["rect", string, string, string, string, string];

const SHAPES = {
  user: [
    ["circle", "12", "8", "4"],
    ["path", "M4 21a8 8 0 0 1 16 0"],
  ],
  logout: [["path", "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"]],
  key: [
    ["circle", "7.5", "15.5", "4.5"],
    ["path", "m11 12 9-9M16 7l3 3M14 9l2 2"],
  ],
  lock: [
    ["rect", "4", "11", "16", "10", "2.5"],
    ["path", "M8 11V7a4 4 0 0 1 8 0v4"],
  ],
  alert: [
    ["path", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"],
    ["path", "M12 9v4M12 17h.01"],
  ],
  refresh: [
    ["path", "M21 12a9 9 0 1 1-3-6.7L21 8"],
    ["path", "M21 3v5h-5"],
  ],
  copy: [
    ["rect", "9", "9", "12", "12", "2.5"],
    ["path", "M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"],
  ],
  check: [["path", "M20 6 9 17l-5-5"]],
  back: [["path", "m15 18-6-6 6-6"]],
  plug: [
    ["path", "M9 3v5M15 3v5"],
    ["path", "M6 8h12v3a6 6 0 0 1-12 0z"],
    ["path", "M12 17v4"],
  ],
  agent: [
    ["rect", "4", "8", "16", "12", "3"],
    ["path", "M12 8V4.5M9.5 13.5v1M14.5 13.5v1"],
  ],
} satisfies Record<string, ReadonlyArray<Shape>>;

export type IconName = keyof typeof SHAPES;

const shape = <M>(h: Html.H<M>, item: Shape) =>
  item[0] === "path"
    ? h.el("path").attr("d", item[1])
    : item[0] === "circle"
      ? h.el("circle").attrs({ cx: item[1], cy: item[2], r: item[3] })
      : h.el("rect").attrs({ x: item[1], y: item[2], width: item[3], height: item[4], rx: item[5] });

export const Icon = <M>(h: Html.H<M>, name: IconName, size = 16) =>
  h
    .el("svg")
    .attrs({
      class: "icon",
      viewBox: "0 0 24 24",
      width: String(size),
      height: String(size),
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.8",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    })
    .children(SHAPES[name].map((item: Shape) => shape(h, item)));
