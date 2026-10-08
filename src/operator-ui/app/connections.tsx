import { useLocation } from "@tanstack/react-router";
import type { UiConnector } from "../model.js";
import {
  confirmCopy,
  connectorLoadFailureCopy,
  driftCounts,
  driftState,
  driftSummary,
  formatDate,
  permissionLabel,
  registrationPathLabel,
  problemCopy,
  problemTone,
  safeHttpHref,
  type OperatorState,
} from "../view.js";
import { productName } from "./config.js";
import { CredentialCard } from "./credentials.js";
import {
  ConfirmBar,
  FixPrompt,
  FixPromptButton,
  FixPromptPreview,
  NoticeLine,
  StateBlock,
  focusableId,
} from "./parts.js";
import { askConfirm, cancelConfirm, disconnectOAuth, refreshConnector, startOAuth } from "./store.js";

const DRIFT_HEADING: Record<ReturnType<typeof driftState>, string> = {
  clean: "Catalog drift · none",
  warning: "Catalog drift · review",
  unavailable: "Catalog drift · not observed",
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
      <div id={`drift-${connector.id}`} className={`connector-drift ${state}`} data-drift={state}>
        <p className="cap">{DRIFT_HEADING[state]}</p>
        <p className="meta">{driftSummary(drift)}</p>
        {state === "unavailable" ? null : (
          <ul className="drift-counts">
            {driftCounts(drift).map(({ key, label, count }) => (
              <li key={key} className={count > 0 ? "drift-count flagged" : "drift-count"}>
                <span className="drift-count-value">{count}</span>
                <span className="drift-count-label">{label}</span>
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

export function ConnectorAuth({ connector, state }: { connector: UiConnector; state: OperatorState }) {
  const id = connector.id;
  const name = connector.title || id;
  const manage = Boolean(connector.permissions?.manageSharedAuth || connector.permissions?.connectPersonal);
  const confirming = state.confirming?.connectorId === id ? state.confirming : null;
  const oauthConfirm = confirming && confirming.action !== "credential_remove" ? confirming : null;
  const local = state.connectorFailures[id];
  const problem = !local && connector.status !== "loading" ? problemCopy(connector.problem) : null;
  return (
    <div className="collection" data-connector={id}>
      {connector.registrationPath ? (
        <p className="meta">OAuth client: {registrationPathLabel(connector.registrationPath)}</p>
      ) : null}
      {connector.status === "loading" ? <StateBlock>Loading authentication details…</StateBlock> : null}
      {problem && connector.problem ? (
        <p className={problemTone(connector.problem) === "warn" ? "msg warn" : "msg"} data-problem={connector.problem}>
          {problem}
        </p>
      ) : null}
      {local ? (
        <p className="msg warn" data-load-failure={local}>
          {connectorLoadFailureCopy(local, productName)}
        </p>
      ) : null}
      <p className="meta">{permissionLabel(connector)}</p>
      <div className="actions">
        {local ? null : <AuthActions connector={connector} name={name} manage={manage} state={state} />}
        <button
          className={local ? "btn primary" : "btn quiet"}
          type="button"
          aria-label={`Refresh ${name}`}
          disabled={connector.status === "loading"}
          onClick={() => void refreshConnector(id)}
        >
          Refresh
        </button>
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
      ) : (
        <p className="meta">
          No operator-managed credential slot is visible. Credentials configured in code stay in the deployment.
        </p>
      )}
    </div>
  );
}

export function ConnectorDiagnostics({ connector, state }: { connector: UiConnector; state: OperatorState }) {
  const problem = problemCopy(connector.problem);
  const failure = state.connectorFailures[connector.id];
  const fixKind = connector.problem && problemTone(connector.problem) === "danger" ? connector.problem : null;
  return (
    <div className="collection">
      {problem ? (
        <p
          className={connector.problem && problemTone(connector.problem) === "warn" ? "msg warn" : "msg"}
          data-problem={connector.problem}
        >
          {problem}
        </p>
      ) : null}
      {failure ? (
        <p className="msg warn" data-load-failure={failure}>
          {connectorLoadFailureCopy(failure, productName)}
        </p>
      ) : null}
      <div className="actions">
        <button
          className="btn"
          type="button"
          aria-label={`Refresh ${connector.title || connector.id}`}
          disabled={connector.status === "loading"}
          onClick={() => void refreshConnector(connector.id)}
        >
          Refresh diagnostics
        </button>
        {fixKind ? (
          <FixPromptButton kind={fixKind} connectorId={connector.id} name={connector.title || connector.id} />
        ) : null}
      </div>
      {fixKind ? <FixPromptPreview kind={fixKind} connectorId={connector.id} standalone /> : null}
      <DriftPanel connector={connector} />
      {connector.resourceTemplateRefusals?.map((code) => (
        <p className="meta" key={code}>
          Resource dispatch refusal: {code}
        </p>
      ))}
      {connector.catalogAccess ? (
        <p className="meta">
          Catalog cache {connector.catalogAccess.state} · {formatDate(connector.catalogAccess.observedAt)}
        </p>
      ) : null}
    </div>
  );
}
