import { Component, Mount, Subscription, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Effect, Queue, Schema, Stream } from "effect";
import type { OperatorConnectorOverlay, OperatorUiContractV2 } from "../../contract.js";
import {
  matrixCell,
  matrixCellLabel,
  matrixCellShare,
  matrixCellText,
  matrixColumns,
  runsAsLabel,
  type MatrixCell,
  type MatrixColumn,
} from "../../endpoints.js";
import type { ConnectorHealth } from "../../health.js";
import { ConnectorLink, ConnectorStatusDot } from "../components/connector-parts.js";
import { EndpointName, Monogram, RunsAs, SharePie } from "../components/marks.js";
import { opaque } from "../components/projection.js";
import { NavigateToPage } from "../shell/commands.js";

export interface MatrixRow {
  readonly id: string;
  readonly title: string;
  readonly readOnly: boolean;
  readonly live: OperatorConnectorOverlay | null;
}

const Block = Schema.Literals(["above", "below"]);
const Inline = Schema.Literals(["start", "end", "viewport"]);

type Placement = { readonly block: typeof Block.Type; readonly inline: typeof Inline.Type };

const GAP = 8;

function placement(anchor: DOMRect, panel: { width: number; height: number }): Placement {
  const below = window.innerHeight - anchor.bottom - GAP;
  const above = anchor.top - GAP;
  return {
    block: panel.height <= below || below >= above ? "below" : "above",
    inline:
      anchor.left + panel.width <= window.innerWidth - GAP
        ? "start"
        : anchor.right - panel.width >= GAP
          ? "end"
          : "viewport",
  };
}

const anchorsSupported = (): boolean =>
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("anchor-name: --matrix-open");

type PopoverReport = { readonly _tag: "Placed"; readonly placement: Placement } | { readonly _tag: "Dismissed" };

export const TrackPopover = Mount.makeStream(
  "TrackPopover",
  { args: { anchor: Schema.String, inline: Schema.Boolean, placed: Schema.Boolean } },
  (node: HTMLElement, initial, changes) =>
    Stream.callback<PopoverReport>((queue) =>
      Effect.gen(function* () {
        let args = initial;
        let side: Placement | null = null;
        let focused = false;
        const anchor = () => document.getElementById(args.anchor);
        const place = () => {
          const target = anchor();
          if (args.inline || !target) return;
          const next = placement(target.getBoundingClientRect(), {
            width: node.offsetWidth,
            height: node.offsetHeight,
          });
          if (side?.block === next.block && side.inline === next.inline) return;
          side = next;
          Queue.offerUnsafe(queue, { _tag: "Placed", placement: next });
        };
        const focusOnce = () => {
          if (focused || (!args.placed && !args.inline)) return;
          focused = true;
          const attempt = (frames: number) =>
            requestAnimationFrame(() => {
              const active = document.activeElement;
              if (!node.isConnected || (active !== null && active !== document.body && active !== anchor())) return;
              node.focus();
              if (document.activeElement !== node && frames > 0) attempt(frames - 1);
            });
          attempt(10);
        };
        const dismiss = (restoreFocus: boolean) => {
          const target = anchor();
          if (restoreFocus && target?.isConnected) target.focus();
          Queue.offerUnsafe(queue, { _tag: "Dismissed" });
        };
        const onPointer = (event: PointerEvent) => {
          const target = event.target as Node;
          if (!node.contains(target) && !anchor()?.contains(target)) dismiss(false);
        };
        const onKey = (event: KeyboardEvent) => {
          if (event.key !== "Escape" && event.key !== "Tab") return;
          event.preventDefault();
          event.stopPropagation();
          dismiss(true);
        };
        const onFocusOut = (event: FocusEvent) => {
          const next = event.relatedTarget as Node | null;
          if (next && !node.contains(next) && next !== anchor()) dismiss(false);
        };
        yield* Stream.runForEach(changes, (next) =>
          Effect.sync(() => {
            args = next;
            place();
            focusOnce();
          }),
        ).pipe(Effect.forkScoped);
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            window.addEventListener("resize", place);
            window.addEventListener("scroll", place, true);
            document.addEventListener("pointerdown", onPointer);
            node.addEventListener("keydown", onKey);
            node.addEventListener("focusout", onFocusOut);
          }),
          () =>
            Effect.sync(() => {
              window.removeEventListener("resize", place);
              window.removeEventListener("scroll", place, true);
              document.removeEventListener("pointerdown", onPointer);
              node.removeEventListener("keydown", onKey);
              node.removeEventListener("focusout", onFocusOut);
            }),
        );
        place();
        focusOnce();
      }),
    ),
);

const OpenCell = Schema.Struct({
  key: Schema.String,
  rowId: Schema.String,
  column: Schema.String,
  anchor: Schema.String,
});
type OpenCell = typeof OpenCell.Type;

const MatrixMessage = UiSchema.TaggedEnum({
  ClickedCell: { cell: OpenCell },
  PlacedPopover: { block: Block, inline: Inline },
  DismissedPopover: {},
  StartedRecovery: {},
  ClickedConnectorLink: { href: Schema.String },
});

type H = Html.H<typeof MatrixMessage.Type>;

const follow = (href: string) => MatrixMessage.ClickedConnectorLink({ href });

const Legend = (h: H) =>
  h.div
    .class("matrix-legend")
    .attr("aria-hidden", "true")
    .children(
      h.span.children(SharePie(h, 1), " All"),
      h.span.children(SharePie(h, 0.4), " Some"),
      h.span.children(h.span.class("matrix-swatch", "read-only"), " Read-only"),
    );

interface Shown {
  readonly open: OpenCell;
  readonly row: MatrixRow;
  readonly column: MatrixColumn;
  readonly cell: Exclude<MatrixCell, { kind: "none" }>;
}

const Popover = (h: H, shown: Shown, inline: boolean, side: Placement | null) => {
  const { open, row, column, cell } = shown;
  const readOnly = column.readOnly || row.readOnly;
  return h.div
    .key(open.key)
    .attr("role", "dialog")
    .attr("aria-label", `${row.title} on ${column.label}`)
    .attr("tabindex", "-1")
    .class("matrix-popover")
    .attr("data-placement", inline ? "inline" : side?.block)
    .attr("data-align", inline ? undefined : side?.inline)
    .onMount(
      TrackPopover({ anchor: open.anchor, inline, placed: side !== null }).pipe(
        Mount.map((report) =>
          report._tag === "Placed" ? MatrixMessage.PlacedPopover(report.placement) : MatrixMessage.DismissedPopover(),
        ),
      ),
    )
    .children(
      h.div
        .class("matrix-popover-head")
        .children(
          Monogram(h, row.id, row.title),
          h.p
            .class("matrix-popover-title")
            .children(
              row.title,
              h.span.class("visually-hidden").children(" on "),
              EndpointName(h, column.pool, column.label),
            ),
          readOnly ? h.span.class("badge", "tag", "accent").children("read-only") : null,
        ),
      cell.tools.length
        ? h.ul.class("matrix-popover-tools").children(
            cell.tools.map((tool) => {
              const refused = readOnly && tool.classification !== "read";
              return h.li
                .key(tool.name)
                .class(refused && "refused")
                .children(
                  h.code.children(tool.name),
                  tool.classification
                    ? h.span.class("tool-kind", tool.classification).children(tool.classification)
                    : null,
                  refused ? h.span.class("visually-hidden").children(" (refused by read-only policy)") : null,
                );
            }),
          )
        : h.p.class("meta").children("No tools yet"),
      h.p
        .class("matrix-popover-runs")
        .children(h.span.class("matrix-popover-label").children("Runs as"), " ", RunsAs(h, runsAsLabel(cell.runsAs))),
    );
};

const shownCell = (
  contract: OperatorUiContractV2,
  rows: ReadonlyArray<MatrixRow>,
  columns: ReadonlyArray<MatrixColumn>,
  open: OpenCell | null,
): Shown | null => {
  if (!open) return null;
  const row = rows.find((candidate) => candidate.id === open.rowId);
  const column = columns.find((candidate) => candidate.key === open.column);
  if (!row || !column) return null;
  const cell = matrixCell(contract, row.id, column);
  return cell.kind === "none" ? null : { open, row, column, cell };
};

export const ConnectorMatrixNoDeps = Html.component({
  name: "ConnectorMatrix",
  props: Schema.Struct({
    contract: opaque<OperatorUiContractV2>("OperatorUiContractV2"),
    rows: opaque<ReadonlyArray<MatrixRow>>("MatrixRows"),
    health: opaque<ConnectorHealth>("ConnectorHealth"),
    recovering: Schema.Boolean,
  }),
  model: Schema.Struct({
    open: Schema.NullOr(OpenCell),
    side: Schema.NullOr(Schema.Struct({ block: Block, inline: Inline })),
  }),
  message: MatrixMessage,
  restore: false,
}).make({
  init: () => ({ open: null, side: null }),
  update: {
    ClickedCell: ($, { cell }) =>
      $.model.open?.key === cell.key ? $.evolve({ open: null, side: null }) : $.evolve({ open: cell, side: null }),
    PlacedPopover: ($, side) => $.evolve({ side: { block: side.block, inline: side.inline } }),
    DismissedPopover: ($) => $.evolve({ open: null, side: null }),
    StartedRecovery: ($) => $.evolve({ open: null, side: null }),
    ClickedConnectorLink: ($, { href }) => $.run(NavigateToPage.make({ page: "connector", href })),
  },
  subscriptions: ({ props }) =>
    props.recovering ? [Subscription.make("recovery", Stream.make(MatrixMessage.StartedRecovery()))] : [],
  view: (h, model) => {
    const { contract, rows, health } = h.props;
    const inline = !anchorsSupported();
    const columns = matrixColumns(contract);
    const shown = shownCell(contract, rows, columns, model.open);
    return h.div.class("matrix-view").children(
      Legend(h),
      h.div.class("table-scroll").children(
        h.table
          .class("data-table", "matrix-table")
          .attr("aria-label", "Connectors by endpoint")
          .children(
            h.thead.children(
              h.tr.children(
                h.th.attr("scope", "col").children("Connector"),
                columns.map((column) =>
                  h.th
                    .key(column.key)
                    .attr("scope", "col")
                    .class("matrix-head", column.readOnly && "read-only")
                    .children(
                      EndpointName(h, column.pool, column.label),
                      column.readOnly ? h.span.class("visually-hidden").children(" (read-only)") : null,
                    ),
                ),
              ),
            ),
            h.tbody.children(
              rows.flatMap((row, rowIndex) => [
                h.tr.key(row.id).children(
                  h.th
                    .attr("scope", "row")
                    .children(
                      h.span
                        .class("matrix-connector")
                        .children(
                          Monogram(h, row.id, row.title, "sm"),
                          ConnectorLink(h, row.id, row.title, follow),
                          row.readOnly ? h.span.class("badge", "tag", "accent").children("Read-only") : null,
                          row.live
                            ? ConnectorStatusDot(h, { id: row.id, name: row.title, live: row.live, health, follow })
                            : h.span.class("meta").children("Checking…"),
                        ),
                    ),
                  columns.map((column, columnIndex) => {
                    const cell = matrixCell(contract, row.id, column);
                    const name = matrixCellLabel(row.title, column, cell);
                    const key = `${row.id}\u0000${column.key}`;
                    const anchor = h.id(`chip-${rowIndex}-${columnIndex}`);
                    const opened = model.open?.key === key;
                    return h.td
                      .key(column.key)
                      .class("matrix-cell", column.readOnly && "read-only")
                      .children(
                        cell.kind === "none"
                          ? h.span
                              .class("matrix-none")
                              .attr("title", name)
                              .children(
                                h.span.attr("aria-hidden", "true").children("—"),
                                h.span.class("visually-hidden").children(name),
                              )
                          : [
                              h.button
                                .attr("id", anchor)
                                .attr("type", "button")
                                .class("matrix-chip", cell.kind, column.readOnly && "read-only")
                                .attr("aria-label", name)
                                .attr("aria-haspopup", "dialog")
                                .attr("aria-expanded", opened ? "true" : "false")
                                .on(
                                  "click",
                                  MatrixMessage.ClickedCell({
                                    cell: { key, rowId: row.id, column: column.key, anchor },
                                  }),
                                )
                                .children(
                                  SharePie(h, matrixCellShare(cell)),
                                  h.span.class("matrix-chip-text").children(matrixCellText(cell)),
                                ),
                              opened && !inline && shown ? Popover(h, shown, false, model.side) : null,
                            ],
                      );
                  }),
                ),
                inline && shown && shown.row.id === row.id
                  ? h.tr
                      .key(`${row.id}:expansion`)
                      .class("matrix-expansion")
                      .children(
                        h.td.attr("colspan", String(1 + columns.length)).children(Popover(h, shown, true, null)),
                      )
                  : null,
              ]),
            ),
          ),
      ),
    );
  },
});

export const ConnectorMatrix = ConnectorMatrixNoDeps.pipe(Component.provide([NavigateToPage.layer]));
