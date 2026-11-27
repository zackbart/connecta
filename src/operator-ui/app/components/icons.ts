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
  chevron: [["path", "m9 18 6-6-6-6"]],
  close: [["path", "M18 6 6 18M6 6l12 12"]],
  pencil: [["path", "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"]],
  terminal: [["path", "m5 8 4 4-4 4M12 17h7"]],
  plug: [
    ["path", "M9 3v5M15 3v5"],
    ["path", "M6 8h12v3a6 6 0 0 1-12 0z"],
    ["path", "M12 17v4"],
  ],
  agent: [
    ["rect", "4", "8", "16", "12", "3"],
    ["path", "M12 8V4.5M9.5 13.5v1M14.5 13.5v1"],
  ],
  activity: [["path", "M22 12h-4l-3 9L9 3l-3 9H2"]],
  shield: [["path", "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"]],
  box: [
    ["path", "M21 8 12 3 3 8v8l9 5 9-5V8z"],
    ["path", "m3 8 9 5 9-5M12 13v8"],
  ],
  globe: [
    ["circle", "12", "12", "9.5"],
    ["path", "M2.5 12h19M12 2.5a14.5 14.5 0 0 1 0 19M12 2.5a14.5 14.5 0 0 0 0 19"],
  ],
  users: [
    ["circle", "9", "8", "3.5"],
    ["path", "M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6.5 6.5 0 0 1 3.5 6"],
  ],
  book: [["path", "M4 19.5V5a2 2 0 0 1 2-2h14v15H6.5a2.5 2.5 0 0 0 0 5H20"]],
  search: [
    ["circle", "11", "11", "7.5"],
    ["path", "m20.5 20.5-4.2-4.2"],
  ],
  minus: [["path", "M5 12h14"]],
  cloud: [["path", "M17.5 19H8a6 6 0 1 1 1.3-11.9A7 7 0 0 1 22 11.5 4 4 0 0 1 17.5 19z"]],
  sun: [
    ["circle", "12", "12", "4"],
    ["path", "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"],
  ],
  moon: [["path", "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"]],
  monitor: [
    ["rect", "2", "3", "20", "14", "2"],
    ["path", "M8 21h8M12 17v4"],
  ],
  page: [
    ["path", "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"],
    ["path", "M14 3v5h5"],
  ],
  tool: [
    [
      "path",
      "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z",
    ],
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
