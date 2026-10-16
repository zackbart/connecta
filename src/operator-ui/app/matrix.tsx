import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { OperatorConnectorOverlay, OperatorUiContractV2 } from "../contract.js";
import {
  connectorRunsAs,
  matrixCell,
  matrixCellLabel,
  matrixCellText,
  matrixColumns,
  runsAsLabel,
  type MatrixCell,
  type MatrixColumn,
} from "../endpoints.js";
import type { OperatorState } from "../view.js";
import { ConnectorStatus } from "./problems.js";

export type MatrixRow = OperatorConnectorOverlay & { title: string };

interface OpenCell {
  key: string;
  title: string;
  column: MatrixColumn;
  cell: Exclude<MatrixCell, { kind: "none" }>;
  anchor: HTMLButtonElement;
}

/**
 * One cell's tools, beside the cell that opened it. Non-modal: focus moves in
 * so a screen reader reads the list, Escape or Tab returns it to the cell, and
 * a click elsewhere closes it.
 */
function CellPopover({ open, onClose }: { open: OpenCell; onClose: (restoreFocus: boolean) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const focused = useRef(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const place = () => {
    const rect = open.anchor.getBoundingClientRect();
    const width = ref.current?.offsetWidth ?? 280;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setPosition({ top: rect.bottom + 6, left });
  };
  useLayoutEffect(place, [open]);
  // Focus once it is placed: a hidden element cannot take focus.
  useEffect(() => {
    if (!position || focused.current) return;
    focused.current = true;
    ref.current?.focus();
  }, [position]);
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
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className="matrix-popover"
      style={position ? { top: position.top, left: position.left } : { visibility: "hidden" }}
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
      <p className="matrix-popover-title">{label}</p>
      {open.cell.tools.length ? (
        <ul className="matrix-popover-tools">
          {open.cell.tools.map((tool) => (
            <li key={tool.name}>
              <code>{tool.name}</code>
              {tool.classification === "write" ? <span className="write-mark">write</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="meta">No tools in the live catalog yet.</p>
      )}
      {open.column.readOnly && open.cell.tools.some((tool) => tool.classification === "write") ? (
        <p className="meta">Read-only endpoint: write tools are refused here.</p>
      ) : null}
      <p className="meta">Runs as {runsAsLabel(open.cell.runsAs)}</p>
    </div>,
    document.body,
  );
}

function Legend() {
  return (
    <div className="matrix-legend" aria-hidden="true">
      <span>
        <span className="matrix-swatch all" /> all
      </span>
      <span>
        <span className="matrix-swatch some" /> some
      </span>
      <span>
        <span className="matrix-swatch read-only" /> read-only
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
              <th scope="col">Status</th>
              <th scope="col">Runs as</th>
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
              const runsAs = connectorRunsAs(contract, row.id);
              return (
                <tr key={row.id}>
                  <th scope="row">{link(row)}</th>
                  <td>
                    <ConnectorStatus id={row.id} name={row.title} live={row} state={state} />
                  </td>
                  <td className="matrix-runs-as">{runsAs ? runsAsLabel(runsAs) : "—"}</td>
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
                          <button
                            type="button"
                            className={`matrix-chip ${cell.kind}${tone}`}
                            aria-label={name}
                            aria-haspopup="dialog"
                            aria-expanded={open?.key === key}
                            onClick={(event) => {
                              if (open?.key === key) return close(false);
                              setOpen({ key, title: row.title, column, cell, anchor: event.currentTarget });
                            }}
                          >
                            {matrixCellText(cell)}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {open ? <CellPopover open={open} onClose={close} /> : null}
    </>
  );
}
