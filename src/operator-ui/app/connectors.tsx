import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { OperatorConnectorOverlay } from "../contract.js";
import {
  connectorStatusLabel,
  connectorStatusTone,
  formatDate,
  registrationPathLabel,
  type OperatorState,
} from "../view.js";
import { Badge, StateBlock } from "./parts.js";
import { Button, DataTable, Input } from "./primitives.js";
import { ContractState } from "./overview.js";
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

type Row = OperatorConnectorOverlay & { title: string; authScope: string; source: string };
const columns: ColumnDef<Row>[] = [
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
      <Badge tone={connectorStatusTone(row.original.status)}>
        {connectorStatusLabel(row.original.status, row.original.problem)}
      </Badge>
    ),
  },
  {
    accessorKey: "authScope",
    header: "Auth",
    cell: ({ row }) => <ConnectorLink id={row.original.id} tab="auth" name={`${row.original.authScope} auth`} />,
  },
  {
    id: "registrationPath",
    header: "OAuth client",
    cell: ({ row }) =>
      row.original.auth ? (
        registrationPathLabel(row.original.auth.registrationPath)
      ) : (
        <span className="meta">Not selected</span>
      ),
  },
  { accessorKey: "source", header: "Source" },
  { id: "tools", header: "Tools", cell: ({ row }) => row.original.tools.length },
  {
    id: "lastCall",
    header: "Last call",
    cell: ({ row }) =>
      row.original.lastCall ? (
        <span title={row.original.lastCall.outcome}>{formatDate(row.original.lastCall.at)}</span>
      ) : (
        <span className="meta">Not observed</span>
      ),
  },
];

export function ConnectorsPage({ state }: { state: OperatorState }) {
  const [query, setQuery] = useState("");
  const contract = state.contract;
  const rows: Row[] =
    contract?.config.connectors.flatMap((config) => {
      const live = contract.live.connectors.find((c) => c.id === config.id);
      return live
        ? [
            {
              ...live,
              title: config.title ?? config.id,
              authScope: config.authScope,
              source: config.source.provider ?? config.source.kind,
            },
          ]
        : [];
    }) ?? [];
  const q = query.trim().toLowerCase();
  const visible = rows.filter((row) =>
    [row.id, row.title, row.source, row.status].some((value) => value.toLowerCase().includes(q)),
  );
  return (
    <section id="connectionsView">
      <div className="page-heading">
        <h1 id="connectionsHeading" tabIndex={-1}>
          Connectors
        </h1>
        <Button disabled={state.contractPhase === "loading"} onClick={() => void loadOperatorContract()}>
          Refresh
        </Button>
      </div>
      <p className="meta">
        Configured in code. Open a connector to inspect its catalog, authentication, and diagnostics.
      </p>
      {!contract ? (
        <ContractState state={state} />
      ) : (
        <section className="section" aria-labelledby="connectorLedgerHeading">
          <div className="section-head">
            <h2 id="connectorLedgerHeading" tabIndex={-1}>
              {rows.length} connectors
            </h2>
            <Input
              id="filter"
              type="search"
              className="filter"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter connectors…"
              aria-label="Filter connectors"
            />
          </div>
          {visible.length ? (
            <DataTable data={visible} columns={columns} label="Connectors" />
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
