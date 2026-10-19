import type { ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import type { OperatorConnectorOverlay } from "../contract.js";
import type { UiConnector } from "../model.js";
import {
  confirmCopy,
  connectorLoadFailureCopy,
  driftCounts,
  driftState,
  driftSummary,
  formatDate,
  registrationPathLabel,
  problemCopy,
  problemTone,
  safeHttpHref,
  type OperatorState,
} from "../view.js";
import { productName } from "./config.js";
import { CredentialCard } from "./credentials.js";
import {
  Badge,
  Callout,
  ConfirmBar,
  FixPrompt,
  NoticeLine,
  Pill,
  StateBlock,
  SummaryRow,
  focusableId,
} from "./parts.js";
import { Icon } from "./icons.js";
import { sinceLabel } from "./connectors.js";
import { askConfirm, cancelConfirm, disconnectOAuth, refreshConnector, startOAuth } from "./store.js";

const DRIFT_HEADING: Record<ReturnType<typeof driftState>, string> = {
  clean: "No drift",
  warning: "Drift",
  unavailable: "Drift not observed",
};

/**
 * What the last catalog refresh saw, as counts. There is no drill-down and
 * nothing to expand: a tool name or a schema on this panel would turn an
 * operator page into the payload surface the drift model refuses to be
 * ([#343](https://github.com/zackbart/connecta/issues/343)). Absence is its own
 * state — a runtime that has refreshed nothing says so rather than showing four
 * reassuring zeros.
 */
function DriftPanel({ connector }: { connector: UiConnector }) {
  const drift = connector.catalogDrift;
  const state = driftState(drift);
  return (
    <>
      {/* Kept outside the counted panel, so the panel stays counts only. */}
      <div id={`drift-${connector.id}`} className={`connector-drift drift-${state}`} data-drift={state}>
        <div className="drift-head">
          <Pill status={state === "warning" ? "attention" : state === "clean" ? "healthy" : "neutral"}>
            {DRIFT_HEADING[state]}
          </Pill>
          <span className="meta">{driftSummary(drift)}</span>
        </div>
        {state === "unavailable" ? null : (
          <ul className="metric-grid">
            {driftCounts(drift).map(({ key, label, count }) => (
              <li key={key} className={count > 0 ? "metric flagged" : "metric"}>
                <span className="metric-label">{label}</span>
                <span className="metric-value">{count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {state === "warning" ? (
        <FixPrompt kind="catalog_drift" connectorId={connector.id} name={connector.title || connector.id} />
      ) : null}
    </>
  );
}

function AuthActions({
  connector,
  name,
  manage,
  state,
}: {
  connector: UiConnector;
  name: string;
  manage: boolean;
  state: OperatorState;
}) {
  const location = useLocation();
  const handoff = new URLSearchParams(location.searchStr).get("h");
  const id = connector.id;
  const authorization = safeHttpHref(connector.authorizationUrl);
  const busy = state.oauthBusy === id;
  if (connector.status === "loading") return null;
  if (handoff && manage && connector.oauth) {
    const target = new URL(`/connect/${encodeURIComponent(id)}`, window.location.origin);
    target.searchParams.set("h", handoff);
    target.searchParams.set("start", "1");
    return (
      <a className="btn primary" href={target.href} target="_blank" rel="noopener noreferrer">
        Continue requested authorization
      </a>
    );
  }
  // No lifecycle hooks, or no right to use them: a pending link is still the
  // one thing this identity can do.
  if (!connector.oauth || !manage) {
    return authorization && connector.status !== "ok" ? (
      <a className="btn primary" href={authorization} target="_blank" rel="noopener noreferrer">
        Authorize connector
      </a>
    ) : null;
  }
  // The browser refused the new tab; the route answered anyway, so the link
  // it returned is the action.
  if (state.oauthBlocked === id && authorization) {
    return (
      <a id={`authorize-${id}`} className="btn primary" href={authorization} target="_blank" rel="noopener noreferrer">
        Open authorization page
      </a>
    );
  }
  if (connector.status !== "ok") {
    const needsAuth = connector.status === "auth_required";
    return (
      <button
        type="button"
        id={`connect-${id}`}
        className={needsAuth ? "btn primary" : "btn"}
        aria-label={`${needsAuth ? "Connect" : "Reconnect"} ${name}`}
        disabled={busy}
        onClick={() => void startOAuth(id, "continue")}
      >
        {busy ? "Opening…" : needsAuth ? "Connect account" : "Reconnect"}
      </button>
    );
  }
  const switching = connector.authScope === "personal";
  return (
    <>
      <button
        type="button"
        id={`reconnect-${id}`}
        className="btn"
        aria-label={`${switching ? "Switch account for" : "Reconnect"} ${name}`}
        disabled={busy}
        onClick={() => askConfirm(id, "oauth_restart")}
      >
        {busy ? "Working…" : switching ? "Switch account" : "Reconnect"}
      </button>
      <button
        type="button"
        id={`disconnect-${id}`}
        className="btn danger"
        aria-label={`Disconnect ${name}`}
        disabled={busy}
        onClick={() => askConfirm(id, "oauth_disconnect")}
      >
        Disconnect
      </button>
    </>
  );
}

/** Who can change this connector's sign-in, in a word. */
function managedBy(connector: UiConnector): string {
  if (connector.permissions?.manageSharedAuth) return "You";
  if (connector.permissions?.connectPersonal) return "Each person";
  return "Deployment";
}

export function ConnectorAuth({ connector, state }: { connector: UiConnector; state: OperatorState }) {
  const id = connector.id;
  const name = connector.title || id;
  const manage = Boolean(connector.permissions?.manageSharedAuth || connector.permissions?.connectPersonal);
  const confirming = state.confirming?.connectorId === id ? state.confirming : null;
  const oauthConfirm = confirming && confirming.action !== "credential_remove" ? confirming : null;
  const local = state.connectorFailures[id];
  // One notice and prompt per kind: a credential card already reporting this one keeps it.
  const credentialFix = connector.credential?.error ? connector.credential.problem : undefined;
  const problem =
    !local && connector.status !== "loading" && connector.problem !== credentialFix
      ? problemCopy(connector.problem)
      : null;
  const fixKind = problem ? connector.problem : undefined;
  return (
    <div className="collection connector-auth" data-connector={id}>
      {connector.status === "loading" ? <StateBlock busy>Loading authentication details…</StateBlock> : null}
      {problem && connector.problem ? (
        <div className={problemTone(connector.problem) === "warn" ? "problem-block warn" : "problem-block"}>
          <Callout
            tone={problemTone(connector.problem) === "warn" ? "notice" : "problem"}
            data-problem={connector.problem}
          >
            {problem}
          </Callout>
          {fixKind ? <FixPrompt kind={fixKind} connectorId={id} name={name} /> : null}
        </div>
      ) : null}
      {local ? (
        <Callout tone="notice" data-load-failure={local}>
          {connectorLoadFailureCopy(local, productName)}
        </Callout>
      ) : null}
      <div className="auth-row">
        <SummaryRow
          className="auth-facts"
          items={[
            { label: "Mode", value: connector.authScope === "personal" ? "Per person" : "Shared" },
            ...(connector.registrationPath
              ? [
                  {
                    label: "OAuth client",
                    value: <span data-oauth-client>{registrationPathLabel(connector.registrationPath)}</span>,
                  },
                ]
              : []),
            { label: "Managed by", value: <span data-managed-by>{managedBy(connector)}</span> },
          ]}
        />
        <div className="actions">
          {local ? null : <AuthActions connector={connector} name={name} manage={manage} state={state} />}
          <button
            className={local ? "btn primary" : "btn quiet"}
            type="button"
            aria-label={`Refresh ${name}`}
            disabled={connector.status === "loading" || state.contractPhase === "loading"}
            onClick={() => void refreshConnector(id)}
          >
            <Icon name="refresh" size={14} />
            Refresh
          </button>
        </div>
      </div>
      {oauthConfirm ? (
        <ConfirmBar
          id={id}
          {...confirmCopy(oauthConfirm.action, name)}
          onConfirm={() => {
            if (oauthConfirm.action === "oauth_restart") void startOAuth(id, "restart");
            else void disconnectOAuth(id);
          }}
          onCancel={() =>
            cancelConfirm(
              focusableId(
                oauthConfirm.action === "oauth_restart" ? `reconnect-${id}` : `disconnect-${id}`,
                `auth-${id}`,
              ),
            )
          }
        />
      ) : null}
      <NoticeLine id={`oauthNotice-${id}`} notice={state.oauthNoticeFor === id ? state.oauthNotice : null} />
      {connector.credential ? (
        <CredentialCard
          connector={connector}
          credential={connector.credential}
          editing={state.credentialEditing === id}
          busy={state.credentialBusy === id}
          confirming={confirming?.action === "credential_remove"}
          notice={state.credentialNoticeFor === id ? state.credentialNotice : null}
        />
      ) : null}
    </div>
  );
}

/** "12 s", "4 min", "3 h": how long ago the catalog was listed. */
function ageLabel(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

/** Big value, small label: one diagnostic fact. */
function Metric({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className={tone ? `metric ${tone}` : "metric"}>
      <dt className="metric-label">{label}</dt>
      <dd>
        <span className="metric-value">{value}</span>
        {sub ? <span className="metric-sub">{sub}</span> : null}
      </dd>
    </div>
  );
}

export function ConnectorDiagnostics({
  live,
  connector,
}: {
  live: OperatorConnectorOverlay;
  connector: UiConnector | undefined;
}) {
  return (
    <div className="collection connector-diagnostics">
      <dl className="metric-grid">
        <Metric label="Catalog age" value={live.catalogAgeMs === null ? "—" : ageLabel(live.catalogAgeMs)} />
        <Metric
          label="Last call"
          value={live.lastCall ? sinceLabel(live.lastCall.at) : "—"}
          {...(live.lastCall
            ? {
                sub: (
                  <>
                    <span className={`dot ${live.lastCall.outcome}`} aria-hidden="true" />
                    {live.lastCall.outcome}
                  </>
                ),
              }
            : {})}
        />
        {connector?.catalogAccess ? (
          <Metric
            label="Catalog cache"
            value={connector.catalogAccess.state}
            sub={formatDate(connector.catalogAccess.observedAt)}
          />
        ) : null}
      </dl>
      {connector ? <DriftPanel connector={connector} /> : <StateBlock busy>Diagnostics are loading.</StateBlock>}
      {connector?.resourceTemplateRefusals?.length ? (
        <div className="refusals">
          <span className="meta">Resource refusals</span>
          {connector.resourceTemplateRefusals.map((code) => (
            <Badge key={code} tone="warn">
              {code}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
