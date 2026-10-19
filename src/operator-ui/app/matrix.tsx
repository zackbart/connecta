import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { OperatorConnectorOverlay, OperatorUiContractV2 } from "../contract.js";
import {
  matrixCell,
  matrixCellLabel,
  matrixCellShare,
  matrixCellText,
  matrixColumns,
  runsAsLabel,
  type MatrixCell,
  type MatrixColumn,
} from "../endpoints.js";
import type { OperatorState } from "../view.js";
import { ConnectorStatus } from "./problems.js";
import { useCloseOnRecovery } from "./contract-state.js";
import { RunsAs } from "./endpoints.js";
import { Monogram, SharePie } from "./marks.js";

export type MatrixRow = OperatorConnectorOverlay & { title: string; readOnly?: boolean };

interface OpenCell {
  key: string;
  rowId: string;
  connectorReadOnly: boolean;
  title: string;
  column: MatrixColumn;
  cell: Exclude<MatrixCell, { kind: "none" }>;
  anchor: HTMLButtonElement;
}

interface Placement {
  block: "above" | "below";
  inline: "start" | "end" | "viewport";
}

/**
 * Whether the browser can float the panel beside its chip with CSS anchors.
 * Without them a floating panel would sit inside the table's scroller and be
 * clipped, so the matrix shows the list in flow under the row instead.
 */
function anchorsSupported(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("anchor-name: --matrix-open");
}

/** Room kept between the panel and its cell, and the viewport's edge. */
const GAP = 8;

/**
 * Which side of its cell the panel fits on. Below unless it would overflow
 * the viewport and there is more room above; aligned to the cell's start,
 * else its end, else the viewport's edge on a screen too narrow for either.
 * Its height is capped in CSS to fit the larger side, so one side always
 * holds it.
 */
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

/**
 * One cell's tools. Non-modal: focus moves in so a screen reader reads the
 * list, Escape or Tab returns it to the cell, and a click elsewhere closes it.
 * Floating, it renders inside its cell and the stylesheet positions it: JS
 * picks a side, never a coordinate, so the page carries no inline styles.
 * `inline` renders it in flow instead, for an expansion row.
 */
function CellPopover({
  open,
  inline,
  onClose,
}: {
  open: OpenCell;
  inline: boolean;
  onClose: (restoreFocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const focused = useRef(false);
  const [side, setSide] = useState<Placement | null>(null);
  const place = () => {
    const panel = ref.current;
    if (!panel || inline) return;
    const next = placement(open.anchor.getBoundingClientRect(), {
      width: panel.offsetWidth,
      height: panel.offsetHeight,
    });
    setSide((current) => (current?.block === next.block && current.inline === next.inline ? current : next));
  };
  useLayoutEffect(place, [open]);
  // Focus once it is placed: a hidden element cannot take focus.
  useEffect(() => {
    if ((!side && !inline) || focused.current) return;
    focused.current = true;
    ref.current?.focus();
  }, [side]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !open.anchor.contains(target)) onClose(false);
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  const label = `${open.title} on ${open.column.path}`;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className="matrix-popover"
      {...(inline
        ? { "data-placement": "inline" }
        : side
          ? { "data-placement": side.block, "data-align": side.inline }
          : {})}
      onKeyDown={(event) => {
        // The popover holds nothing to tab to; Tab and Escape both hand focus
        // back to its cell, so the next Tab continues along the row.
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          onClose(true);
        }
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && !ref.current?.contains(next) && next !== open.anchor) onClose(false);
      }}
    >
      <div className="matrix-popover-head">
        <Monogram id={open.rowId} title={open.title} />
        <p className="matrix-popover-title">
          {open.title}
          <span className="visually-hidden"> on </span>
          <code>{open.column.path}</code>
        </p>
        {open.column.readOnly || open.connectorReadOnly ? <span className="badge tag accent">read-only</span> : null}
      </div>
      {open.cell.tools.length ? (
        <ul className="matrix-popover-tools">
          {open.cell.tools.map((tool) => {
            const refused = (open.column.readOnly || open.connectorReadOnly) && tool.classification !== "read";
            return (
              <li key={tool.name} className={refused ? "refused" : undefined}>
                <code>{tool.name}</code>
                {tool.classification ? (
                  <span className={`tool-kind ${tool.classification}`}>{tool.classification}</span>
                ) : null}
                {refused ? <span className="visually-hidden"> (refused by read-only policy)</span> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="meta">No tools yet</p>
      )}
      <p className="matrix-popover-runs">
        <span className="matrix-popover-label">Runs as</span> <RunsAs label={runsAsLabel(open.cell.runsAs)} />
      </p>
    </div>
  );
}

function Legend() {
  return (
    <div className="matrix-legend" aria-hidden="true">
      <span>
        <SharePie share={1} /> All
      </span>
      <span>
        <SharePie share={0.4} /> Some
      </span>
      <span>
        <span className="matrix-swatch read-only" /> Read-only
      </span>
    </div>
  );
}

/**
 * Connectors (rows) by endpoints (columns): `/mcp` first, then each pool.
 * Every cell comes from the contract's matrix; a cell with tools opens the
 * exact list.
 */
export function ConnectorMatrix({
  contract,
  rows,
  state,
  link,
}: {
  contract: OperatorUiContractV2;
  rows: MatrixRow[];
  state: OperatorState;
  link: (row: MatrixRow) => ReactNode;
}) {
  const [open, setOpen] = useState<OpenCell | null>(null);
  useCloseOnRecovery(state, () => setOpen(null));
  const [inline] = useState(() => !anchorsSupported());
  const columns = matrixColumns(contract);
  const close = (restoreFocus: boolean) => {
    const anchor = open?.anchor;
    setOpen(null);
    if (restoreFocus && anchor?.isConnected) anchor.focus();
  };
  return (
    <>
      <Legend />
      <div className="table-scroll">
        <table className="data-table matrix-table" aria-label="Connectors by endpoint">
          <thead>
            <tr>
              <th scope="col">Connector</th>
              {columns.map((column) => (
                <th scope="col" key={column.path} className={column.readOnly ? "matrix-head read-only" : "matrix-head"}>
                  <code>{column.path}</code>
                  {column.readOnly ? <span className="visually-hidden"> (read-only)</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              return (
                <Fragment key={row.id}>
                  <tr>
                    <th scope="row">
                      <span className="matrix-connector">
                        <Monogram id={row.id} title={row.title} size="sm" />
                        {link(row)}
                        {row.readOnly ? <span className="badge tag accent">Read-only</span> : null}
                        <ConnectorStatus id={row.id} name={row.title} live={row} state={state} compact />
                      </span>
                    </th>
                    {columns.map((column) => {
                      const cell = matrixCell(contract, row.id, column);
                      const name = matrixCellLabel(row.title, column, cell);
                      const key = `${row.id}\u0000${column.path}`;
                      const tone = column.readOnly ? " read-only" : "";
                      return (
                        <td key={column.path} className={`matrix-cell${tone}`}>
                          {cell.kind === "none" ? (
                            <span className="matrix-none" title={name}>
                              <span aria-hidden="true">—</span>
                              <span className="visually-hidden">{name}</span>
                            </span>
                          ) : (
                            <>
                              <button
                                type="button"
                                className={`matrix-chip ${cell.kind}${tone}`}
                                aria-label={name}
                                aria-haspopup="dialog"
                                aria-expanded={open?.key === key}
                                onClick={(event) => {
                                  if (open?.key === key) return close(false);
                                  setOpen({
                                    key,
                                    rowId: row.id,
                                    connectorReadOnly: row.readOnly === true,
                                    title: row.title,
                                    column,
                                    cell,
                                    anchor: event.currentTarget,
                                  });
                                }}
                              >
                                <SharePie share={matrixCellShare(cell)} />
                                <span className="matrix-chip-text">{matrixCellText(cell)}</span>
                              </button>
                              {open?.key === key && !inline ? (
                                <CellPopover open={open} inline={false} onClose={close} />
                              ) : null}
                            </>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                  {inline && open?.rowId === row.id ? (
                    <tr className="matrix-expansion">
                      <td colSpan={1 + columns.length}>
                        <CellPopover key={open.key} open={open} inline onClose={close} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
