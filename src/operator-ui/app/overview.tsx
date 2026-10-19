import type { ReactNode } from "react";
import { connectionMap, type MapNode } from "../connection-map.js";
import { attentionItems, overviewHeadline, type AttentionItem, type OverviewHeadline } from "../overview.js";
import type { OperatorState } from "../view.js";
import { fixPrompt } from "../fix-prompts.js";
import { ContractState } from "./contract-state.js";
import { ConnectionMapView } from "./connection-map.js";
import { useConnectorHealth } from "./health.js";
import { Icon } from "./icons.js";
import { CopyButton, followLink, MemberMark, Pill } from "./parts.js";
import { Card } from "./primitives.js";

/**
 * The maintainer's landing page: how the deployment is doing, what needs
 * attention with the fix the rest of the UI already offers, and the map of
 * who reaches what. Read-only; every action here is a link to the page that
 * owns it, or the fixed fix prompt for a coding agent.
 */

/** A count with its dot, under a stat's bar. Zero counts drop out. */
function Legend({ entries }: { entries: Array<[tone: string, count: number, label: string]> }) {
  return (
    <ul className="stat-legend">
      {entries
        .filter(([, count]) => count > 0)
        .map(([tone, count, label]) => (
          <li key={label}>
            <span className={`dot ${tone}`} aria-hidden="true" />
            {count} {label}
          </li>
        ))}
    </ul>
  );
}

function Stat({ label, href, children }: { label: string; href?: string; children: ReactNode }) {
  return (
    <Card className="overview-stat" aria-label={label}>
      <div className="stat-head">
        <h2 className="stat-label">{label}</h2>
        {href ? (
          <a
            className="stat-link"
            href={href}
            aria-label={`View ${label.toLowerCase()}`}
            onClick={(event) => followLink(event, href)}
          >
            <Icon name="back" size={14} />
          </a>
        ) : null}
      </div>
      {children}
    </Card>
  );
}

function Stats({ headline, callers }: { headline: OverviewHeadline; callers: MapNode[] }) {
  const shown = callers.slice(0, 8);
  const readWrite = headline.endpoints - headline.readOnlyEndpoints;
  return (
    <div className="overview-stats">
      <Stat label="Connectors" href="/connectors">
        <p className="stat-number">
          {headline.connectors ? (
            <>
              {headline.healthy}
              <span className="stat-of">/{headline.connectors}</span>
            </>
          ) : (
            0
          )}
        </p>
        <div className="stat-bar" aria-hidden="true">
          {headline.bar.length ? (
            headline.bar.map((entry) => (
              <span key={entry.id} className={`tone-${entry.tone}`} title={`${entry.title}: ${entry.label}`} />
            ))
          ) : (
            <span />
          )}
        </div>
        <Legend
          entries={[
            ["ok", headline.healthy, "healthy"],
            ["warn", headline.warn, "attention"],
            ["danger", headline.danger, "failing"],
          ]}
        />
      </Stat>
      <Stat label="Endpoints" href="/endpoints">
        <p className="stat-number">{headline.endpoints}</p>
        <div className="stat-bar" aria-hidden="true">
          {Array.from({ length: headline.endpoints }, (_, index) => (
            <span key={index} className={index < headline.readOnlyEndpoints ? "mode-read-only" : "mode-read-write"} />
          ))}
        </div>
        <Legend
          entries={[
            ["read-only", headline.readOnlyEndpoints, "read-only"],
            ["read-write", readWrite, "read-write"],
          ]}
        />
      </Stat>
      <Stat label="People · Agents">
        <p className="stat-number">
          {headline.people}
          <span className="stat-of"> · </span>
          {headline.agents}
        </p>
        {shown.length ? (
          <ul className="stat-callers" aria-hidden="true">
            {shown.map((node) => (
              <li key={node.id} title={node.name}>
                <MemberMark
                  chip={{ kind: node.kind === "agent" ? "agent" : "human", initials: node.initials, hue: node.hue }}
                  muted={node.kind === "agent" && node.tone === "warn"}
                />
              </li>
            ))}
            {callers.length > shown.length ? <li className="stat-more">+{callers.length - shown.length}</li> : null}
          </ul>
        ) : null}
      </Stat>
    </div>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const subject = item.kind === "agent" ? <code>{item.subject}</code> : item.subject;
  const icon = item.kind === "agent" ? "key" : item.tone === "danger" ? "alert" : "plug";
  return (
    <li className="attention-item" data-attention={item.key}>
      <span className={`attention-icon tone-${item.tone}`} aria-hidden="true">
        <Icon name={icon} size={15} />
      </span>
      <div className="attention-text">
        <h3 title={`${item.subject} ${item.problem}`}>
          {item.href ? (
            <a
              href={item.href}
              title={item.subject}
              aria-label={item.subject}
              onClick={(event) => followLink(event, item.href!)}
            >
              {subject}
            </a>
          ) : (
            subject
          )}{" "}
          {item.problem}
        </h3>
        <p title={item.body}>{item.body}</p>
      </div>
      <div className="attention-actions">
        {item.fix ? (
          <CopyButton
            value={fixPrompt(item.fix.kind, item.fix.connectorId)}
            label="Copy fix prompt"
            className="btn sm quiet"
            ariaLabel={`Copy fix prompt for ${item.subject}`}
          />
        ) : null}
        {item.action ? (
          <a
            className="btn sm"
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

function Attention({ items }: { items: AttentionItem[] }) {
  return (
    <Card className="overview-section overview-attention" title="Needs attention" titleId="attentionHeading">
      {items.length ? (
        <ul className="attention-list" aria-labelledby="attentionHeading">
          {items.map((item) => (
            <AttentionRow key={item.key} item={item} />
          ))}
        </ul>
      ) : (
        <div className="attention-clear" role="status">
          <span className="attention-icon tone-ok" aria-hidden="true">
            <Icon name="check" size={15} />
          </span>
          <h3>All clear</h3>
        </div>
      )}
    </Card>
  );
}

/** The page's status in a word: the cards below carry the numbers. */
function Status({ items }: { items: AttentionItem[] }) {
  if (!items.length) return <Pill status="healthy">All healthy</Pill>;
  const failing = items.some((item) => item.tone === "danger");
  return (
    <Pill status={failing ? "error" : "attention"}>
      {items.length} {items.length === 1 ? "needs" : "need"} attention
    </Pill>
  );
}

export function OverviewPage({ state }: { state: OperatorState }) {
  // Steady health: the headline, bar, attention list and map change only when
  // a connector's own read settles, never to an in-between verdict.
  const { contract, signals } = useConnectorHealth(state);
  const tokensPage = state.data?.accessTokenManagement === "available";
  const map = contract ? connectionMap(contract, { signals, tokensPage }) : null;
  const items = contract ? attentionItems(contract, { signals, tokensPage }) : [];
  const headline = contract && map ? overviewHeadline(contract, map, items, signals) : null;
  return (
    <section id="overviewView">
      <div className="page-heading">
        <div className="overview-title">
          <h1 id="overviewHeading" tabIndex={-1}>
            Overview
          </h1>
          {headline?.connectors ? <Status items={items} /> : null}
        </div>
      </div>
      {!contract || !map || !headline ? (
        <ContractState state={state} />
      ) : (
        <>
          <Stats headline={headline} callers={map.nodes.filter((node) => node.column === 0)} />
          <Attention items={items} />
          <Card className="overview-section overview-map" title="Who reaches what" titleId="mapHeading">
            <ConnectionMapView map={map} />
          </Card>
        </>
      )}
    </section>
  );
}
