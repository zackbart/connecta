import { Fragment, useRef } from "react";
import { agentRows, lastSeenLabel, slotBadge, slotSince, type AgentRow } from "../agents.js";
import { accessTokenUnavailableCopy, contractRecovering, formatDate, type OperatorState } from "../view.js";
import {
  ConfirmBar,
  CopyButton,
  Empty,
  focusableId,
  NoticeLine,
  Pill,
  pillStatus,
  StateBlock,
  Unavailable,
} from "./parts.js";
import { Button, Dialog } from "./primitives.js";
import { useCloseOnRecovery } from "./contract-state.js";
import { AgentMark } from "./marks.js";
import {
  cancelTokenAction,
  confirmTokenAction,
  dismissCreatedToken,
  loadAccessTokens,
  revokeAgentToken,
  rotateAgentToken,
} from "./store.js";

/**
 * The new secret, once. Closing the dialog by any route drops it from the
 * page; the row's own primary action takes focus back, or the recovery
 * banner's Retry while the page is stale. Recovery never closes it: a minted
 * secret nobody has seen cannot be shown again.
 */
function SecretDialog({ state }: { state: OperatorState }) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const name = state.createdTokenFor;
  return (
    <Dialog
      open={Boolean(state.createdToken)}
      onOpenChange={(open) => {
        if (open) return;
        returnFocus.current =
          (name ? document.getElementById(`token-primary-${name}`) : null) ?? document.getElementById("tokensHeading");
        dismissCreatedToken();
      }}
      returnFocusTo={returnFocus}
      title={name ? `New token for ${name}` : "New token"}
      description="You won't see this token again."
    >
      {state.createdToken ? (
        <div className="token-secret-panel">
          <code id="createdToken" className="token-secret">
            {state.createdToken}
          </code>
          <div className="actions">
            <CopyButton value={state.createdToken} label="Copy token" className="btn primary" />
            <Button
              onClick={() => {
                returnFocus.current =
                  (name ? document.getElementById(`token-primary-${name}`) : null) ??
                  document.getElementById("tokensHeading");
                dismissCreatedToken();
              }}
            >
              I stored it
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

/** The in-row question before a rotation or revocation, in its own table row under the agent's. */
function SlotConfirm({ name, action }: { name: string; action: "rotate" | "revoke" }) {
  const copy =
    action === "rotate"
      ? { question: `Rotate ${name}'s token? The current one stops working now.`, confirm: "Rotate" }
      : { question: `Revoke ${name}'s token? It loses access now.`, confirm: "Revoke" };
  return (
    <tr className="token-confirm-row">
      <td colSpan={6}>
        <ConfirmBar
          id={`token-${name}`}
          {...copy}
          onConfirm={() => void confirmTokenAction()}
          onCancel={() =>
            cancelTokenAction(
              focusableId(action === "rotate" ? `token-primary-${name}` : `token-revoke-${name}`, "tokensHeading"),
            )
          }
        />
      </td>
    </tr>
  );
}

function SlotRow({ row, busy }: { row: AgentRow; busy: boolean }) {
  const badge = slotBadge(row.slot);
  return (
    <tr data-agent={row.name} className={row.slot?.state === "revoked" ? "revoked" : undefined}>
      <th scope="row">
        <span className="agent-name">
          <AgentMark />
          <span
            title={row.credentialTypes
              .map((kind) => (kind === "vercel_oidc" ? "Vercel OIDC" : "Agent token"))
              .join(" · ")}
          >
            {row.name}
          </span>
          {row.credentialTypes.includes("vercel_oidc") ? (
            <span className="meta">{row.credentialTypes.length > 1 ? "OIDC · Token" : "OIDC"}</span>
          ) : null}
        </span>
      </th>
      <td>
        {row.pools.length ? (
          <ul className="agent-pools" aria-label={`${row.name}'s pools`}>
            {row.pools.map((pool) => (
              <li key={pool} className="pool-chip">
                {pool}
              </li>
            ))}
          </ul>
        ) : (
          <span className="meta">None</span>
        )}
      </td>
      <td>
        <Pill status={pillStatus(badge.tone)}>{badge.label}</Pill>
      </td>
      <td className="token-date">{slotSince(row.slot, formatDate)}</td>
      <td className="token-date">{lastSeenLabel(row.lastSeenAt, formatDate)}</td>
      <td>
        <div className="token-actions">
          {row.blocked ? (
            <span className="meta token-unavailable" id={`token-unavailable-${row.name}`}>
              {row.blocked}
            </span>
          ) : null}
          {row.actions.map((action) =>
            action === "revoke" ? (
              <Button
                key={action}
                id={`token-revoke-${row.name}`}
                variant="quiet"
                size="sm"
                className="token-revoke"
                disabled={busy || Boolean(row.blocked)}
                {...(row.blocked ? { "aria-describedby": `token-unavailable-${row.name}` } : {})}
                aria-label={`Revoke ${row.name}'s token`}
                onClick={() => void revokeAgentToken(row.name)}
              >
                Revoke
              </Button>
            ) : (
              <Button
                key={action}
                id={`token-primary-${row.name}`}
                variant={action === "issue" ? "primary" : "default"}
                size="sm"
                disabled={busy || Boolean(row.blocked)}
                {...(row.blocked ? { "aria-describedby": `token-unavailable-${row.name}` } : {})}
                aria-label={`${action === "issue" ? "Issue" : "Rotate"} ${row.name}'s token`}
                onClick={() => void rotateAgentToken(row.name)}
              >
                {action === "issue" ? "Issue" : "Rotate"}
              </Button>
            ),
          )}
        </div>
      </td>
    </tr>
  );
}

export function TokensPage({ state }: { state: OperatorState }) {
  const available = state.data?.accessTokenManagement === "available";
  // While the shell's recovery banner owns Retry, this page offers none of its own.
  const recovering = contractRecovering(state);
  // A rotation or revocation question closes when recovery starts; the secret dialog does not.
  useCloseOnRecovery(state, () => cancelTokenAction());
  const rows = agentRows(state.contract, state.tokens, state.unresolvedSlots);
  return (
    <section id="tokensView">
      <div className="page-heading">
        <div>
          <h1 id="tokensHeading" tabIndex={-1}>
            Tokens
          </h1>
          <p className="meta">Declared in code</p>
        </div>
        {available && !recovering ? (
          <div className="page-actions">
            <Button
              id="refreshTokens"
              disabled={state.tokenBusy || state.tokenPhase === "loading"}
              onClick={() => void loadAccessTokens()}
            >
              Refresh
            </Button>
          </div>
        ) : null}
      </div>
      <NoticeLine id="tokenNotice" notice={state.tokenNotice} />
      {!available && rows.length === 0 ? (
        <Unavailable>{accessTokenUnavailableCopy(state.data?.accessTokenManagement)}</Unavailable>
      ) : (
        <div id="tokenList" aria-busy={state.tokenPhase === "loading" ? "true" : "false"}>
          {state.tokenPhase === "loading" ? (
            <StateBlock busy>Loading tokens…</StateBlock>
          ) : state.tokenPhase === "error" ? (
            <StateBlock
              tone="error"
              {...(recovering ? {} : { action: { label: "Retry", onClick: () => void loadAccessTokens() } })}
            >
              Couldn't load tokens.
            </StateBlock>
          ) : rows.length === 0 ? (
            <Empty>No agents</Empty>
          ) : (
            <div className="table-scroll">
              <table className="data-table token-table" aria-label="Agent tokens">
                <thead>
                  <tr>
                    <th scope="col">Agent</th>
                    <th scope="col">Pools</th>
                    <th scope="col">Token</th>
                    <th scope="col">Since</th>
                    <th scope="col">Last seen</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <Fragment key={row.name}>
                      <SlotRow row={row} busy={state.tokenBusy} />
                      {state.tokenConfirm?.name === row.name ? (
                        <SlotConfirm name={row.name} action={state.tokenConfirm.action} />
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <SecretDialog state={state} />
    </section>
  );
}
