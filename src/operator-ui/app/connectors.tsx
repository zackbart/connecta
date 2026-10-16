import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { OperatorConnectorOverlay } from "../contract.js";
import { formatDate, type OperatorState } from "../view.js";
import { StateBlock } from "./parts.js";
import { Button, DataTable, Input, SegmentedControl } from "./primitives.js";
import { ConnectorStatus } from "./problems.js";
import { ContractState, maintainerContract } from "./contract-state.js";
import { ConnectorMatrix } from "./matrix.js";
import { loadOperatorContract, navigate } from "./store.js";

function ConnectorLink({ id, name, tab }: { id: string; name?: string; tab?: string }) {
  const href = `/connectors/${encodeURIComponent(id)}${tab ? `#${tab}` : ""}`;
  return (
    <a
      href={href}
      onClick={(event) => {
        if (event.button || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        event.preventDefault();
        navigate("connector", href);
      }}
    >
      {name ?? id}
    </a>
  );
}

type Row = OperatorConnectorOverlay & { title: string; authScope: string };
const columns = (state: OperatorState): ColumnDef<Row>[] => [
  {
    accessorKey: "title",
    header: "Connector",
    cell: ({ row }) => (
      <div className="table-name">
        <ConnectorLink id={row.original.id} name={row.original.title} />
        <span className="meta mono">{row.original.id}</span>
      </div>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <ConnectorStatus id={row.original.id} name={row.original.title} live={row.original} state={state} />
    ),
  },
  {
    accessorKey: "authScope",
    header: "Auth",
    cell: ({ row }) => (row.original.authScope === "personal" ? "Personal" : "Shared"),
  },
  { id: "tools", header: "Tools", cell: ({ row }) => <span className="num">{row.original.tools.length}</span> },
  {
    id: "lastCall",
    header: "Last call",
    cell: ({ row }) =>
      row.original.lastCall ? (
        <span title={row.original.lastCall.outcome}>{formatDate(row.original.lastCall.at)}</span>
      ) : (
        <span className="meta" title="Not observed">
          —<span className="visually-hidden">Not observed</span>
        </span>
      ),
  },
];

type View = "list" | "matrix";

/** List or Matrix, kept in the query string so a matrix link opens on the matrix. */
const VIEWS = [
  { value: "list", label: "List" },
  { value: "matrix", label: "Matrix" },
] as const;
function ViewToggle({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  return <SegmentedControl label="Connector view" value={view} options={VIEWS} onChange={onChange} />;
}

export function ConnectorsPage({ state }: { state: OperatorState }) {
  const [query, setQuery] = useState("");
  const location = useLocation();
  const go = useNavigate();
  const view: View = new URLSearchParams(location.searchStr).get("view") === "matrix" ? "matrix" : "list";
  const setView = (next: View) =>
    void go({
      to: location.pathname,
      search: { ...location.search, view: next === "matrix" ? "matrix" : undefined },
      hash: location.hash,
      replace: true,
    });
  const contract = maintainerContract(state);
  const rows: Row[] =
    contract?.config?.connectors.flatMap((config) => {
      const live = contract.live.connectors.find((c) => c.id === config.id);
      return live
        ? [
            {
              ...live,
              title: config.title ?? config.id,
              authScope: config.authScope,
            },
          ]
        : [];
    }) ?? [];
  const q = query.trim().toLowerCase();
  const visible = rows.filter((row) =>
    [row.id, row.title, row.status].some((value) => value.toLowerCase().includes(q)),
  );
  return (
    <section id="connectionsView">
      <div className="page-heading">
        <div>
          <h1 id="connectionsHeading" tabIndex={-1}>
            Connectors
          </h1>
          {contract ? (
            <h2 id="connectorLedgerHeading" className="meta" tabIndex={-1}>
              {rows.length} {rows.length === 1 ? "connector" : "connectors"}, defined in code.
            </h2>
          ) : (
            <p className="meta">Defined in code.</p>
          )}
        </div>
        <div className="page-actions">
          {contract ? <ViewToggle view={view} onChange={setView} /> : null}
          {contract ? (
            <Input
              id="filter"
              type="search"
              className="filter"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter connectors…"
              aria-label="Filter connectors"
            />
          ) : null}
          <Button disabled={state.contractPhase === "loading"} onClick={() => void loadOperatorContract()}>
            Refresh
          </Button>
        </div>
      </div>
      {!contract ? (
        <ContractState state={state} />
      ) : (
        <section className="section" aria-labelledby="connectorLedgerHeading">
          {visible.length && view === "matrix" ? (
            <ConnectorMatrix
              contract={contract}
              rows={visible}
              state={state}
              link={(row) => <ConnectorLink id={row.id} name={row.title} />}
            />
          ) : visible.length ? (
            <DataTable data={visible} columns={columns(state)} label="Connectors" />
          ) : (
            <StateBlock>
              {rows.length ? "No connectors match this filter." : "No connectors are visible to this session."}
            </StateBlock>
          )}
        </section>
      )}
    </section>
  );
}
