import { connectionMap, plural, type MapNode } from "../connection-map.js";
import { attentionItems, overviewHeadline, type AttentionItem, type OverviewHeadline } from "../overview.js";
import { driftState, type ConnectorSignals, type OperatorState } from "../view.js";
import { fixPrompt } from "../fix-prompts.js";
import { ContractState, maintainerContract } from "./contract-state.js";
import { ConnectionMapView } from "./connection-map.js";
import { CopyButton, followLink } from "./parts.js";

/**
 * The maintainer's landing page: how the deployment is doing, what needs
 * attention with the fix the rest of the UI already offers, and the map of
 * who reaches what. Read-only; every action here is a link to the page that
 * owns it, or the fixed fix prompt for a coding agent.
 */

/** Drift from `/ui/data` and per-connector read failures, the two facts the contract does not carry. */
function connectorSignals(state: OperatorState): Record<string, ConnectorSignals> {
  const signals: Record<string, ConnectorSignals> = {};
  for (const connector of state.data?.connectors ?? []) {
    if (driftState(connector.catalogDrift) === "warning") signals[connector.id] = { drift: true };
  }
  for (const id of Object.keys(state.connectorFailures)) signals[id] = { ...signals[id], failed: true };
  return signals;
}

function Stats({ headline, callers }: { headline: OverviewHeadline; callers: MapNode[] }) {
  const shown = callers.slice(0, 8);
  const readWrite = headline.endpoints - headline.readOnlyEndpoints;
  return (
    <div className="overview-stats">
      <section className="overview-stat" aria-label="Connector health">
        <p className="overview-number">{headline.connectors ? `${headline.healthy} of ${headline.connectors}` : "0"}</p>
        <p className="overview-label">{headline.connectors ? "connectors healthy" : "connectors declared"}</p>
        <div className="health-bar" aria-hidden="true">
          {headline.bar.length ? (
            headline.bar.map((entry) => (
              <span key={entry.id} className={`tone-${entry.tone}`} title={`${entry.title}: ${entry.label}`} />
            ))
          ) : (
            <span />
          )}
        </div>
        {headline.connectors ? (
          <ul className="health-legend">
            <li>
              <span className="dot ok" aria-hidden="true" />
              {headline.healthy} healthy
            </li>
            {headline.warn ? (
              <li>
                <span className="dot warn" aria-hidden="true" />
                {headline.warn} {headline.warn === 1 ? "needs" : "need"} attention
              </li>
            ) : null}
            {headline.danger ? (
              <li>
                <span className="dot danger" aria-hidden="true" />
                {headline.danger} failing
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="health-legend">Each connector gets a segment here once declared.</p>
        )}
      </section>
      <section className="overview-stat" aria-label="Endpoints">
        <p className="overview-number">{headline.endpoints}</p>
        <p className="overview-label">{headline.endpoints === 1 ? "endpoint" : "endpoints"}, defined in code</p>
        <div className="health-bar" aria-hidden="true">
          {Array.from({ length: headline.endpoints }, (_, index) => (
            <span key={index} className={index < headline.readOnlyEndpoints ? "mode-read-only" : "mode-read-write"} />
          ))}
        </div>
        <ul className="health-legend">
          {headline.readOnlyEndpoints ? (
            <li>
              <span className="dot read-only" aria-hidden="true" />
              {headline.readOnlyEndpoints} read-only
            </li>
          ) : null}
          <li>
            <span className="dot read-write" aria-hidden="true" />
            {readWrite === headline.endpoints && readWrite > 1 ? "All read-write" : `${readWrite} read-write`}
          </li>
        </ul>
        <a
          className="overview-link"
          href="/endpoints"
          aria-label="View endpoints"
          onClick={(event) => followLink(event, "/endpoints")}
        >
          View
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
            <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </a>
      </section>
      <section className="overview-stat" aria-label="People and agents">
        <p className="overview-number">
          {plural(headline.people, "person", "people")} · {plural(headline.agents, "agent")}
        </p>
        <p className="overview-label">can use this deployment</p>
        {shown.length ? (
          <ul className="overview-callers" aria-hidden="true">
            {shown.map((node) =>
              node.kind === "person" ? (
                <li key={node.id} className={`avatar hue-${node.hue}`} title={node.name}>
                  {node.initials}
                </li>
              ) : (
                <li
                  key={node.id}
                  className={node.tone === "warn" ? "agent-mark muted" : "agent-mark"}
                  title={node.name}
                />
              ),
            )}
            {callers.length > shown.length ? <li className="overview-more">+{callers.length - shown.length}</li> : null}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function AttentionIcon({ item }: { item: AttentionItem }) {
  return (
    <span className={`attention-icon tone-${item.tone}`} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
        {item.kind === "agent" ? (
          <>
            <circle cx="5.5" cy="10.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M7.7 8.3 13.5 2.5M11.5 4.5l1.8 1.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </>
        ) : item.tone === "danger" ? (
          <>
            <path d="M8 2.2 14.2 13H1.8z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M8 6.5v3M8 11.3v.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </>
        ) : (
          <>
            <path d="M5.5 1.8v3M10.5 1.8v3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path
              d="M3.5 4.8h9v2.4a4.5 4.5 0 0 1-9 0z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            <path d="M8 11.7v2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </>
        )}
      </svg>
    </span>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const subject = item.kind === "agent" ? <code>{item.subject}</code> : item.subject;
  return (
    <li className="attention-item" data-attention={item.key}>
      <AttentionIcon item={item} />
      <div className="attention-text">
        <h3>
          {item.href ? (
            <a href={item.href} onClick={(event) => followLink(event, item.href!)}>
              {subject}
            </a>
          ) : (
            subject
          )}{" "}
          {item.problem}
        </h3>
        <p>{item.body}</p>
      </div>
      <div className="attention-actions">
        {item.fix ? (
          <CopyButton
            value={fixPrompt(item.fix.kind, item.fix.connectorId)}
            label="Copy fix prompt"
            className="btn"
            ariaLabel={`Copy fix prompt for ${item.subject}`}
          />
        ) : null}
        {item.action ? (
          <a
            className="btn primary"
            href={item.action.href}
            aria-label={item.action.ariaLabel}
            onClick={(event) => followLink(event, item.action!.href)}
          >
            {item.action.label}
          </a>
        ) : null}
      </div>
    </li>
  );
}

function Attention({ items, empty }: { items: AttentionItem[]; empty: boolean }) {
  return (
    <section className="section overview-section" aria-labelledby="attentionHeading">
      <div className="overview-section-head">
        <h2 id="attentionHeading">Needs attention</h2>
        {items.length ? (
          <p className="meta">Each row links to its fix. Copy fix prompt hands the problem to a coding agent.</p>
        ) : null}
      </div>
      {items.length ? (
        <ul className="attention-list" aria-labelledby="attentionHeading">
          {items.map((item) => (
            <AttentionRow key={item.key} item={item} />
          ))}
        </ul>
      ) : (
        <div className="attention-list attention-clear" role="status">
          <span className="attention-icon tone-ok" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
              <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </span>
          <div className="attention-text">
            <h3>All clear</h3>
            <p>
              {empty
                ? "Nothing needs attention yet."
                : "Every connector is healthy, and every agent in an endpoint has a token."}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

export function OverviewPage({ state }: { state: OperatorState }) {
  const contract = maintainerContract(state);
  const tokensPage = state.data?.accessTokenManagement === "available";
  const signals = connectorSignals(state);
  const map = contract ? connectionMap(contract, { signals, tokensPage }) : null;
  const items = contract ? attentionItems(contract, { signals, tokensPage }) : [];
  const headline = contract && map ? overviewHeadline(contract, map, items, signals) : null;
  return (
    <section id="overviewView">
      <div className="page-heading">
        <div>
          <h1 id="overviewHeading" tabIndex={-1}>
            Overview
          </h1>
          {headline ? <p className="meta overview-lede">{headline.sentence}</p> : null}
        </div>
      </div>
      {!contract || !map || !headline ? (
        <ContractState state={state} />
      ) : (
        <>
          <Stats headline={headline} callers={map.nodes.filter((node) => node.column === 0)} />
          <Attention items={items} empty={!headline.connectors} />
          <section className="section overview-section" aria-labelledby="mapHeading">
            <div className="overview-section-head">
              <h2 id="mapHeading">Who reaches what</h2>
              {headline.connectors ? <p className="meta">{map.summary}</p> : null}
            </div>
            <ConnectionMapView map={map} />
          </section>
        </>
      )}
    </section>
  );
}
