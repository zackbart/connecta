import { useEffect, useRef, useState } from "react";
import type { OperatorState } from "../view.js";
import { connectorStatusLabel, connectorStatusTone } from "../view.js";
import { clientServerName, clientSetupCommands, poolEndpointUrl } from "../setup-commands.js";
import { mcpUrl } from "./config.js";
import { Badge, CopyButton, LoadFailure, StateBlock } from "./parts.js";
import { Button, Dialog } from "./primitives.js";
import { loadHealth, loadOperatorContract } from "./store.js";

export function ContractState({ state }: { state: OperatorState }) {
  if (state.loadFailure) return <LoadFailure state={state} />;
  return <StateBlock {...(state.contractPhase === "error" ? {
    title: "Configuration couldn't be loaded", action: { label: "Retry", onClick: () => void loadOperatorContract() },
  } : {})}>
    {state.contractPhase === "error" ? "Retry to read the configuration visible to your session." : "Loading configuration…"}
  </StateBlock>;
}

export function EndpointLine({ url, label }: { url: string; label?: string }) {
  return <div className="endpoint"><code id={label ? undefined : "mcpUrl"}>{url}</code><CopyButton value={url} label="Copy URL" ariaLabel={label ? `Copy URL for ${label}` : "Copy URL"} /></div>;
}

export function OverviewPage({ state }: { state: OperatorState }) {
  const [open, setOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => { void loadHealth(); }, [state.generation]);
  const contract = state.contract;
  const attention = contract?.live.connectors.filter(c => c.status !== "ok" || c.problem) ?? [];
  const endpoints = [{ label: "All tools", url: mcpUrl, name: clientServerName(contract?.config.server.name) },
    ...(contract?.you.pools ?? []).map(pool => ({ label: pool.name, url: poolEndpointUrl(mcpUrl, pool.name), name: clientServerName(contract?.config.server.name, pool.name) }))];
  return <section id="overviewView">
    <div className="page-heading"><h1 id="overviewHeading" tabIndex={-1}>Overview</h1><Button onClick={event => { returnFocus.current = event.currentTarget; setOpen(true); }}>Client setup</Button></div>
    <p className="meta">Your deployment and the connectors visible to this session.</p>
    <section className="section" aria-labelledby="healthHeading"><div className="section-head"><h2 id="healthHeading">Health</h2><Button variant="quiet" onClick={() => { void loadHealth(); void loadOperatorContract(); }}>Refresh</Button></div>
      <div className="facts-row"><Badge tone={state.health === "ok" ? "ok" : state.health === "unavailable" ? "warn" : "neutral"}>{state.health === "ok" ? "Deployment responding" : state.health === "loading" ? "Checking health" : "Health unavailable"}</Badge>
      {contract ? <><span>{contract.config.server.name}</span><span className="meta">Connecta {contract.config.connectaVersion}</span><span className="meta">{contract.config.executor.name ?? "Custom executor"}</span></> : null}</div>
      <EndpointLine url={mcpUrl} />
    </section>
    {!contract ? <ContractState state={state} /> : <>
      <section className="section" aria-labelledby="attentionHeading"><div className="section-head"><h2 id="attentionHeading">Needs attention</h2><span className="meta">{attention.length} of {contract.live.connectors.length} connectors</span></div>
        {attention.length ? <div className="rows">{attention.map(c => <a className="attention-row" key={c.id} href={`/connectors/${encodeURIComponent(c.id)}#${c.status === "auth_required" ? "auth" : "diagnostics"}`}><span>{contract.config.connectors.find(config => config.id === c.id)?.title ?? c.id}</span><Badge tone={connectorStatusTone(c.status)}>{connectorStatusLabel(c.status, c.problem)}</Badge></a>)}</div> : <StateBlock>All visible connectors are ready.</StateBlock>}
      </section>
      <section className="section"><h2>Catalog</h2><p className="meta">{contract.live.connectors.reduce((n, c) => n + c.tools.length, 0)} tools across {contract.live.connectors.length} connectors. Root endpoint trust: {contract.you.trust}.</p><a href="/tools" className="btn quiet">Browse tools</a></section>
    </>}
    <Dialog drawer returnFocusTo={returnFocus} open={open} onOpenChange={setOpen} title="Client setup" description="Connect your MCP client to a visible endpoint.">
      {endpoints.map(endpoint => <section className="setup-list" key={endpoint.url}><h3>{endpoint.label}</h3><EndpointLine url={endpoint.url} label={endpoint.label} />{clientSetupCommands(endpoint.name, endpoint.url).map(command => <div className="setup-item" key={command.id} data-setup={command.id}><div className="setup-head"><span>{command.label}</span><CopyButton value={command.text} label="Copy" ariaLabel={`Copy ${command.label} setup for ${endpoint.label}`} /></div><pre className="setup-code">{command.text}</pre></div>)}</section>)}
      <p className="meta">No token is included. Use your deployment's inbound sign-in or an issued client token.</p>
    </Dialog>
  </section>;
}
