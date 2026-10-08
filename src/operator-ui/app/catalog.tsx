import { useMemo, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { OperatorTool } from "../contract.js";
import { Badge, StateBlock } from "./parts.js";
import { Button, DataTable, Dialog, Input } from "./primitives.js";

type CatalogRow = OperatorTool & { connectorId: string };
export function Catalog({ tools }: { tools: CatalogRow[] }) {
  const [query, setQuery] = useState("");
  const [classification, setClassification] = useState("all");
  const [selected, setSelected] = useState<CatalogRow | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const q = query.trim().toLowerCase();
  const visible = tools.filter(
    (t) =>
      (classification === "all" || t.classification === classification) &&
      [t.address, t.description, t.connectorId].some((value) => value?.toLowerCase().includes(q)),
  );
  const columns = useMemo<ColumnDef<CatalogRow>[]>(
    () => [
      {
        accessorKey: "address",
        header: "Tool",
        cell: ({ row }) => (
          <div className="table-name">
            <Button
              variant="quiet"
              className="schema-trigger"
              onClick={(event) => {
                returnFocus.current = event.currentTarget;
                setSelected(row.original);
              }}
            >
              <code>{row.original.address}</code>
            </Button>
            {row.original.description ? (
              <span className="td catalog-description">{row.original.description}</span>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: "connectorId",
        header: "Connector",
        cell: ({ row }) => (
          <a href={`/connectors/${encodeURIComponent(row.original.connectorId)}#tools`}>{row.original.connectorId}</a>
        ),
      },
      {
        accessorKey: "classification",
        header: "Classification",
        cell: ({ row }) => (
          <Badge tone={row.original.classification === "read" ? "ok" : "warn"}>{row.original.classification}</Badge>
        ),
      },
    ],
    [],
  );
  return (
    <div className="collection">
      <div className="row">
        <Input
          type="search"
          aria-label="Filter tools"
          placeholder="Filter tools…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="select-label">
          Classification
          <select
            aria-label="Tool classification"
            value={classification}
            onChange={(e) => setClassification(e.target.value)}
          >
            <option value="all">All tools</option>
            <option value="read">Read</option>
            <option value="write">Write</option>
          </select>
        </label>
      </div>
      <p className="meta">
        {visible.length} of {tools.length} tools. Select a tool to inspect its schema.
      </p>
      {visible.length ? (
        <DataTable data={visible} columns={columns} label="Tool catalog" />
      ) : (
        <StateBlock>
          {tools.length
            ? "No tools match these filters."
            : "No live tools are visible. Check the connector's authentication and diagnostics."}
        </StateBlock>
      )}
      <Dialog
        returnFocusTo={returnFocus}
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={selected?.address ?? "Tool schema"}
        description="Catalog metadata. Classification is resolved by the deployment."
      >
        {selected ? (
          <div className="collection">
            <Badge tone={selected.classification === "read" ? "ok" : "warn"}>{selected.classification}</Badge>
            {selected.description ? <p>{selected.description}</p> : null}
            <h3>Input schema</h3>
            <pre className="schema-code">
              {selected.inputSchema ? JSON.stringify(selected.inputSchema, null, 2) : "No input schema supplied."}
            </pre>
            <h3>Output schema</h3>
            <pre className="schema-code">
              {selected.outputSchema ? JSON.stringify(selected.outputSchema, null, 2) : "No output schema supplied."}
            </pre>
            {selected.annotations ? (
              <>
                <h3>Annotations</h3>
                <pre className="schema-code">{JSON.stringify(selected.annotations, null, 2)}</pre>
              </>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
