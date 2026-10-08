import { useState } from "react";
import { accessTokenUnavailableCopy, formatDate, type OperatorState, type UiAccessToken } from "../view.js";
import { CopyButton, Empty, NoticeLine, Unavailable } from "./parts.js";
import {
  createAccessToken,
  dismissCreatedToken,
  loadAccessTokens,
  renameAccessToken,
  revokeAccessToken,
  saveAccessTokenName,
} from "./store.js";

function CreateForm({ busy }: { busy: boolean }) {
  const [name, setName] = useState("");
  return (
    <form
      id="tokenCreateForm"
      className="token-create"
      onSubmit={(event) => {
        event.preventDefault();
        // Only a token that exists empties the field. A rejected POST leaves
        // the typed client name where it was, so the retry is one click.
        void createAccessToken(name.trim()).then((created) => {
          if (created) setName("");
        });
      }}
    >
      <label htmlFor="tokenName">Client name</label>
      <div className="row">
        <input
          id="tokenName"
          type="text"
          maxLength={80}
          placeholder="Claude desktop, ChatGPT production…"
          autoComplete="off"
          value={name}
          onInput={(event) => setName(event.currentTarget.value)}
        />
        <button id="createToken" className="btn" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create token"}
        </button>
      </div>
    </form>
  );
}

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

function TokenCard({ token, renaming, busy }: { token: UiAccessToken; renaming: boolean; busy: boolean }) {
  const [name, setName] = useState(token.name);
  const revoked = Boolean(token.revokedAt);
  return (
    <section className={revoked ? "token-card revoked" : "token-card"} aria-labelledby={`access-token-${token.id}`}>
      <div className="token-card-head">
        <div>
          <h2 id={`access-token-${token.id}`}>{token.name}</h2>
          <p className="mono">{token.tokenPrefix}…</p>
        </div>
        <div className="cap">
          {revoked ? `Revoked ${formatDate(token.revokedAt)}` : `Created ${formatDate(token.createdAt)}`}
        </div>
      </div>
      <div className="credential-actions">
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={() => {
            setName(token.name);
            renameAccessToken(renaming ? null : token.id);
          }}
        >
          Rename
        </button>
        {revoked ? null : (
          <button className="btn danger" type="button" disabled={busy} onClick={() => void revokeAccessToken(token.id)}>
            Revoke
          </button>
        )}
      </div>
      {renaming ? (
        <form
          className="credential-form"
          onSubmit={(event) => {
            event.preventDefault();
            const next = name.trim();
            if (next) void saveAccessTokenName(token.id, next);
          }}
        >
          <label className="visually-hidden" htmlFor={`token-name-${token.id}`}>
            Token name
          </label>
          <input
            id={`token-name-${token.id}`}
            type="text"
            maxLength={80}
            autoComplete="off"
            value={name}
            onInput={(event) => setName(event.currentTarget.value)}
          />
          <button className="btn" type="submit" disabled={busy}>
            Save name
          </button>
          <button className="btn" type="button" disabled={busy} onClick={() => renameAccessToken(null)}>
            Cancel
          </button>
        </form>
      ) : null}
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
            Access tokens
          </h1>
        )}
        <div className="lead-copy">
          <p className="activity-copy">
            Create named Bearer tokens for MCP clients. Each secret is shown once; revoke it when that client should
            lose access.
          </p>
          <NoticeLine id="tokenNotice" notice={state.tokenNotice} />
          {!available ? (
            <Unavailable>{accessTokenUnavailableCopy(state.data?.accessTokenManagement)}</Unavailable>
          ) : (
            <div id="tokenAvailable">
              {state.createdToken ? <Reveal token={state.createdToken} /> : <CreateForm busy={state.tokenBusy} />}
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
                  <Empty>No access tokens yet. Name the first MCP client above.</Empty>
                ) : (
                  state.tokens.map((token) => (
                    <TokenCard
                      key={token.id}
                      token={token}
                      renaming={state.tokenRenaming === token.id}
                      busy={state.tokenBusy}
                    />
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
