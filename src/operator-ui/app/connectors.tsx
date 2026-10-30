import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { OperatorConnectorOverlay, OperatorTool } from "../contract.js";
import type { ConnectorHealth } from "../health.js";
import { formatDate, type OperatorState } from "../view.js";
import { Badge, followLink, Pill, pillStatus, StateBlock } from "./parts.js";
import { Button, Input, SegmentedControl } from "./primitives.js";
import { ProblemAction, verdictFor } from "./problems.js";
import { ContractState } from "./contract-state.js";
import { useConnectorHealth } from "./health.js";
import { ConnectorMatrix } from "./matrix.js";
import { loadOperatorContract } from "./store.js";

function ConnectorLink({ id, name, tab }: { id: string; name?: string; tab?: string }) {
  const href = `/connectors/${encodeURIComponent(id)}${tab ? `#${tab}` : ""}`;
  return (
    <a href={href} title={name ?? id} aria-label={name ?? id} onClick={(event) => followLink(event, href, "connector")}>
      {name ?? id}
    </a>
  );
}

/** "Shared" or "Per person": whose account the connector calls with. */
export function AuthScopeBadge({ scope }: { scope: string }) {
  return <Badge>{scope === "personal" ? "Per person" : "Shared"}</Badge>;
}

/**
 * Read and write tools as one thin bar, counts beside it. The widths are SVG
 * attributes, never inline styles, so the page CSP holds.
 */
export function ToolSplit({
  tools,
  awaitingLive = false,
}: {
  tools: readonly Pick<OperatorTool, "classification">[];
  /** A stored row: its tools come only with a live read, so none is not "No tools". */
  awaitingLive?: boolean;
}) {
  const write = tools.filter((tool) => tool.classification === "write").length;
  const read = tools.length - write;
  const readWidth = tools.length ? (read / tools.length) * 100 : 0;
  if (!tools.length)
    return (
      <div className="tool-split">
        <span className="tool-split-total">{awaitingLive ? "Tools awaiting live read" : "No tools"}</span>
      </div>
    );
  return (
    <div className="tool-split">
      <span className="tool-split-total">
        <span className="num">{tools.length}</span> {tools.length === 1 ? "tool" : "tools"}
      </span>
      <span className="tool-split-counts">
        {read} read · {write} write
      </span>
      <svg className="tool-split-bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
        <rect className="track" width="100" height="6" />
        {read ? <rect className="read" width={readWidth} height="6" /> : null}
        {write ? <rect className="write" x={readWidth} width={100 - readWidth} height="6" /> : null}
      </svg>
    </div>
  );
}

/** "3 min ago" for recent times, the date after a week. The exact time is the title. */
export function sinceLabel(iso: string, now = Date.now()): string {
  const at = new Date(iso).valueOf();
  if (Number.isNaN(at)) return "";
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/**
 * The one mark of a stored row, on the list and the detail page alike: the
 * status shown is an earlier observation, and when it was made. A parked
 * timeout waits for Refresh; any other stored row has a live read on its way.
 * The age counts from a fixed observation time and re-renders as it grows.
 */
export function StoredStatus({ observedAt, parked }: { observedAt: number; parked: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const at = new Date(observedAt).toISOString();
  return (
    <span className="meta stored-status" title={`Stored status from ${formatDate(at)}`}>
      Stored status, checked {sinceLabel(at, Math.max(now, Date.now())).toLowerCase()}
      {parked ? ". Refresh to check again." : " · checking live…"}
    </span>
  );
}

type Row = OperatorConnectorOverlay & { title: string; authScope: string; readOnly?: boolean; description?: string };

function ConnectorCard({ row, steady }: { row: Row; steady: ConnectorHealth }) {
  const health = verdictFor(row.id, row, steady);
  const titleId = `connector-card-${row.id}`;
  return (
    <li className={`connector-card ${health.action ? `attention ${health.tone}` : ""}`} aria-labelledby={titleId}>
      <div className="connector-card-top">
        <div className="connector-card-name">
          <h3 id={titleId} title={row.title}>
            <ConnectorLink id={row.id} name={row.title} />
          </h3>
          <span className="connector-card-sub">
            <code title={row.id}>{row.id}</code>
            <AuthScopeBadge scope={row.authScope} />
            {row.readOnly ? <Pill status="info">Read-only</Pill> : null}
          </span>
        </div>
        <Pill status={pillStatus(health.tone)}>{health.label}</Pill>
      </div>
      {row.description ? <p className="connector-card-description">{row.description}</p> : null}
      <ToolSplit tools={row.tools} awaitingLive={row.observedAt !== undefined} />
      <div className="connector-card-foot">
        <span className="connector-card-last">
          <span className="meta">Last call</span>{" "}
          {row.lastCall ? (
            <span title={`${formatDate(row.lastCall.at)} · ${row.lastCall.outcome}`}>
              <span className={`dot ${row.lastCall.outcome}`} aria-hidden="true" /> {sinceLabel(row.lastCall.at)}
            </span>
          ) : (
            <span className="meta" title="Not observed">
              —<span className="visually-hidden">Not observed</span>
            </span>
          )}
        </span>
        {row.observedAt !== undefined ? (
          <StoredStatus observedAt={row.observedAt} parked={row.problem === "connector_timeout"} />
        ) : null}
        {health.action ? <ProblemAction id={row.id} name={row.title} action={health.action} /> : null}
      </div>
    </li>
  );
}

type View = "list" | "matrix";
type Filter = "all" | "attention" | "healthy";

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
  const [filter, setFilter] = useState<Filter>("all");
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
  // Steady rows: a connector being read again keeps its last verdict, so
  // cards, filter counts and the attention set hold still until it settles.
  const health = useConnectorHealth(state);
  const contract = health.contract;
  const rows: Row[] =
    contract?.config?.connectors.flatMap((config) => {
      const live = contract.live.connectors.find((c) => c.id === config.id);
      return live
        ? [
            {
              ...live,
              title: config.title ?? config.id,
              authScope: config.authScope,
              readOnly: config.readOnly === true,
              ...(config.description ? { description: config.description } : {}),
            },
          ]
        : [];
    }) ?? [];
  const pending = contract?.config?.connectors.filter((c) => !rows.some((row) => row.id === c.id)) ?? [];
  const total = rows.length + pending.length;
  const attention = new Set(rows.filter((row) => verdictFor(row.id, row, health).action).map((row) => row.id));
  const q = query.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      (filter === "all" || (filter === "attention") === attention.has(row.id)) &&
      [row.id, row.title, row.status].some((value) => value.toLowerCase().includes(q)),
  );
  const filters = [
    { value: "all", label: "All", count: total },
    { value: "attention", label: "Needs attention", count: attention.size },
    { value: "healthy", label: "Healthy", count: rows.length - attention.size },
  ] as const;
  return (
    <section id="connectionsView">
      <div className="page-heading">
        <div>
          <h1 id="connectionsHeading" tabIndex={-1}>
            Connectors
          </h1>
          {contract ? (
            <h2 id="connectorLedgerHeading" className="meta" tabIndex={-1}>
              {total} {total === 1 ? "connector" : "connectors"}
            </h2>
          ) : null}
        </div>
        <div className="page-actions">
          {contract ? <ViewToggle view={view} onChange={setView} /> : null}
          <Button disabled={state.contractPhase === "loading"} onClick={() => void loadOperatorContract()}>
            Refresh
          </Button>
        </div>
      </div>
      {!contract ? (
        <ContractState state={state} />
      ) : (
        <section className="section" aria-labelledby="connectorLedgerHeading">
          {total ? (
            <div className="connector-toolbar">
              <SegmentedControl label="Show connectors" value={filter} options={filters} onChange={setFilter} />
              <Input
                id="filter"
                type="search"
                className="filter"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Filter connectors"
              />
            </div>
          ) : null}
          {filter === "all" && pending.length ? (
            <ul className="connector-grid" aria-label="Loading connectors">
              {pending
                .filter((c) => `${c.id} ${c.title ?? ""}`.toLowerCase().includes(q))
                .map((c) => (
                  <li key={c.id} className="connector-card" aria-busy="true">
                    <ConnectorLink id={c.id} name={c.title ?? c.id} />
                    <p className="meta">Loading connection…</p>
                  </li>
                ))}
            </ul>
          ) : null}
          {visible.length && view === "matrix" ? (
            <ConnectorMatrix
              contract={contract}
              rows={visible}
              state={state}
              health={health}
              link={(row) => <ConnectorLink id={row.id} name={row.title} />}
            />
          ) : visible.length ? (
            <ul className="connector-grid" aria-label="Connectors">
              {visible.map((row) => (
                <ConnectorCard key={row.id} row={row} steady={health} />
              ))}
            </ul>
          ) : pending.length ? null : (
            <StateBlock>{rows.length ? "No matches" : "No connectors."}</StateBlock>
          )}
        </section>
      )}
    </section>
  );
}
