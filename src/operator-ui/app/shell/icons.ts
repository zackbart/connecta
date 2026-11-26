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
} satisfies Record<string, ReadonlyArray<Shape>>;

export type ShellIconName = keyof typeof SHAPES;

const shape = <M>(h: Html.H<M>, item: Shape) =>
  item[0] === "path"
    ? h.el("path").attr("d", item[1])
    : item[0] === "circle"
      ? h.el("circle").attrs({ cx: item[1], cy: item[2], r: item[3] })
      : h.el("rect").attrs({ x: item[1], y: item[2], width: item[3], height: item[4], rx: item[5] });

export const ShellIcon = <M>(h: Html.H<M>, name: ShellIconName, size = 16) =>
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
