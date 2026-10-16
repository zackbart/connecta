import { useRef } from "react";
import { agentRows, lastSeenLabel, slotBadge, slotSince, type AgentRow } from "../agents.js";
import { accessTokenUnavailableCopy, formatDate, type OperatorState } from "../view.js";
import { Badge, CopyButton, Empty, NoticeLine, StateBlock, Unavailable } from "./parts.js";
import { Button, Dialog } from "./primitives.js";
import { dismissCreatedToken, loadAccessTokens, revokeAgentToken, rotateAgentToken } from "./store.js";

/**
 * The new secret, once. Closing the dialog by any route drops it from the
 * page; the row's own primary action takes focus back.
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

function SlotRow({ row, busy }: { row: AgentRow; busy: boolean }) {
  const badge = slotBadge(row.slot);
  return (
    <tr data-agent={row.name} className={row.slot.state === "revoked" ? "revoked" : undefined}>
      <th scope="row">
        <span className="agent-name">
          <span className="agent-mark" aria-hidden="true" />
          <span className="mono">{row.name}</span>
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
        <Badge tone={badge.tone}>{badge.label}</Badge>
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
        {available ? (
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
            <Empty>Loading access tokens…</Empty>
          ) : state.tokenPhase === "error" ? (
            <StateBlock
              tone="error"
              action={{ label: "Try loading access tokens again", onClick: () => void loadAccessTokens() }}
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
                    <SlotRow key={row.name} row={row} busy={state.tokenBusy} />
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
