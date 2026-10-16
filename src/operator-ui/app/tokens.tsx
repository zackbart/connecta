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
import { Icon } from "./icons.js";
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
      description="Copy it into the agent's MCP client now. You won't see this token again."
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
          <p className="meta">Rotating replaces it; revoking stops it. Neither shows it again.</p>
        </div>
      ) : null}
    </Dialog>
  );
}

/** The in-row question before a rotation or revocation, in its own table row under the agent's. */
function SlotConfirm({ name, action }: { name: string; action: "rotate" | "revoke" }) {
  const copy =
    action === "rotate"
      ? { question: `Rotate ${name}'s token? Its current token stops working immediately.`, confirm: "Rotate" }
      : { question: `Revoke ${name}'s token? The agent will immediately lose access.`, confirm: "Revoke" };
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
    <tr data-agent={row.name} className={row.slot.state === "revoked" ? "revoked" : undefined}>
      <th scope="row">
        <span className="agent-name">
          <span className="agent-mark" aria-hidden="true">
            <Icon name="agent" size={12} />
          </span>
          <span>{row.name}</span>
        </span>
      </th>
      <td>
        {row.pools.length ? (
          <ul className="agent-pools" aria-label={`${row.name}'s pools`}>
            {row.pools.map((pool) => (
              <li key={pool} className="tool-chip">
                {pool}
              </li>
            ))}
          </ul>
        ) : (
          <span className="meta">No pools</span>
        )}
      </td>
      <td>
        <Pill status={pillStatus(badge.tone)}>{badge.label}</Pill>
      </td>
      <td className="meta">{slotSince(row.slot, formatDate)}</td>
      <td className="meta">{lastSeenLabel(row.lastSeenAt, formatDate)}</td>
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
                variant="danger"
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
          <p className="meta">
            One Bearer token per agent. Agents are declared in code; only their tokens change here.
          </p>
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
      {!available ? (
        <Unavailable>{accessTokenUnavailableCopy(state.data?.accessTokenManagement)}</Unavailable>
      ) : (
        <div id="tokenList" aria-busy={state.tokenPhase === "loading" ? "true" : "false"}>
          {state.tokenPhase === "loading" ? (
            <StateBlock busy>Loading access tokens…</StateBlock>
          ) : state.tokenPhase === "error" ? (
            <StateBlock
              tone="error"
              {...(recovering
                ? {}
                : { action: { label: "Try loading access tokens again", onClick: () => void loadAccessTokens() } })}
            >
              Access tokens could not be loaded.
            </StateBlock>
          ) : rows.length === 0 ? (
            <Empty>No agents are declared. Add them to agents in the deployment code.</Empty>
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
