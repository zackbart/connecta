import { accessTokenUnavailableCopy, formatDate, type OperatorState, type UiAccessToken } from "../view.js";
import { CopyButton, Empty, NoticeLine, Unavailable } from "./parts.js";
import { dismissCreatedToken, loadAccessTokens, revokeAgentToken, rotateAgentToken, slotState } from "./store.js";

function Reveal({ token }: { token: string }) {
  return (
    <section id="tokenReveal" className="token-reveal" aria-labelledby="tokenRevealHeading">
      <div className="token-reveal-head">
        <h2 id="tokenRevealHeading" tabIndex={-1}>
          Copy this token now
        </h2>
        <span className="cap">Shown once</span>
      </div>
      <p className="meta">Store it in the MCP client before leaving this page. It cannot be displayed again.</p>
      <div className="endpoint-row token-secret">
        <code id="createdToken" className="mono">
          {token}
        </code>
        <CopyButton value={token} label="Copy token" />
      </div>
      <button className="btn" type="button" onClick={dismissCreatedToken}>
        I stored it
      </button>
    </section>
  );
}

/** One declared agent's token slot. Agents come from code; only the token changes here. */
function TokenCard({ token, busy }: { token: UiAccessToken; busy: boolean }) {
  const slot = slotState(token);
  return (
    <section
      className={slot === "revoked" ? "token-card revoked" : "token-card"}
      aria-labelledby={`access-token-${token.id}`}
    >
      <div className="token-card-head">
        <div>
          <h2 id={`access-token-${token.id}`}>{token.name}</h2>
        </div>
        <div className="cap">
          {slot === "revoked"
            ? `Revoked ${formatDate(token.revokedAt)}`
            : slot === "issued"
              ? `Issued ${formatDate(token.createdAt)}`
              : "No token issued"}
        </div>
      </div>
      <div className="credential-actions">
        <button className="btn" type="button" disabled={busy} onClick={() => void rotateAgentToken(token.id)}>
          {slot === "issued" ? "Rotate" : "Issue"}
        </button>
        {slot === "issued" ? (
          <button className="btn danger" type="button" disabled={busy} onClick={() => void revokeAgentToken(token.id)}>
            Revoke
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function TokensPage({ state, embedded = false }: { state: OperatorState; embedded?: boolean }) {
  const available = state.data?.accessTokenManagement === "available";
  return (
    <section id="tokensView">
      <div className="lead">
        {embedded ? null : (
          <h1 id="tokensHeading" className="" tabIndex={-1}>
            Tokens
          </h1>
        )}
        <div className="lead-copy">
          <p className="activity-copy">
            One Bearer token per agent declared in code. Each secret is shown once; rotating or revoking stops the
            previous token immediately.
          </p>
          <NoticeLine id="tokenNotice" notice={state.tokenNotice} />
          {!available ? (
            <Unavailable>{accessTokenUnavailableCopy(state.data?.accessTokenManagement)}</Unavailable>
          ) : (
            <div id="tokenAvailable">
              {state.createdToken ? <Reveal token={state.createdToken} /> : null}
              <div
                id="tokenList"
                className="token-ledger"
                aria-busy={state.tokenPhase === "loading" ? "true" : "false"}
              >
                {state.tokenPhase === "loading" ? (
                  <Empty>Loading access tokens…</Empty>
                ) : state.tokenPhase === "error" ? (
                  <p className="empty">
                    <button className="btn" type="button" onClick={() => void loadAccessTokens()}>
                      Try loading access tokens again
                    </button>
                  </p>
                ) : state.tokens.length === 0 ? (
                  <Empty>No agents are declared. Add them to agents in the deployment code.</Empty>
                ) : (
                  state.tokens.map((token) => <TokenCard key={token.id} token={token} busy={state.tokenBusy} />)
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
