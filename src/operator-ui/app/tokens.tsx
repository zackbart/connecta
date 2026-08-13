import { useState } from "preact/hooks";
import {
  accessTokenUnavailableCopy,
  formatDate,
  type OperatorState,
  type UiAccessToken,
} from "../view.js";
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
      class="token-create"
      onSubmit={(event) => {
        event.preventDefault();
        // Only a token that exists empties the field. A rejected POST leaves
        // the typed client name where it was, so the retry is one click.
        void createAccessToken(name.trim()).then((created) => {
          if (created) setName("");
        });
      }}
    >
      <label for="tokenName">Client name</label>
      <div class="row">
        <input
          id="tokenName"
          type="text"
          maxLength={80}
          placeholder="Claude desktop, ChatGPT production…"
          autocomplete="off"
          value={name}
          onInput={(event) => setName(event.currentTarget.value)}
        />
        <button id="createToken" class="linklike" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create token"}
        </button>
      </div>
    </form>
  );
}

function Reveal({ token }: { token: string }) {
  return (
    <section
      id="tokenReveal"
      class="token-reveal"
      aria-labelledby="tokenRevealHeading"
    >
      <div class="token-reveal-head">
        <h2 id="tokenRevealHeading" tabIndex={-1}>
          Copy this token now
        </h2>
        <span class="cap">Shown once</span>
      </div>
      <p class="meta">
        Store it in the MCP client before leaving this page. It cannot be
        displayed again.
      </p>
      <div class="endpoint-row token-secret">
        <code id="createdToken" class="mono">
          {token}
        </code>
        <CopyButton value={token} label="Copy token" />
      </div>
      <button class="linklike" type="button" onClick={dismissCreatedToken}>
        I stored it
      </button>
    </section>
  );
}

function TokenCard({
  token,
  renaming,
  busy,
}: {
  token: UiAccessToken;
  renaming: boolean;
  busy: boolean;
}) {
  const [name, setName] = useState(token.name);
  const revoked = Boolean(token.revokedAt);
  return (
    <section
      class={revoked ? "token-card revoked" : "token-card"}
      aria-labelledby={`access-token-${token.id}`}
    >
      <div class="token-card-head">
        <div>
          <h2 id={`access-token-${token.id}`}>{token.name}</h2>
          <p class="mono">{token.tokenPrefix}…</p>
        </div>
        <div class="cap">
          {revoked
            ? `Revoked ${formatDate(token.revokedAt)}`
            : `Created ${formatDate(token.createdAt)}`}
        </div>
      </div>
      <div class="credential-actions">
        <button
          class="linklike"
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
          <button
            class="linklike danger"
            type="button"
            disabled={busy}
            onClick={() => void revokeAccessToken(token.id)}
          >
            Revoke
          </button>
        )}
      </div>
      {renaming ? (
        <form
          class="credential-form"
          onSubmit={(event) => {
            event.preventDefault();
            const next = name.trim();
            if (next) void saveAccessTokenName(token.id, next);
          }}
        >
          <label class="visually-hidden" for={`token-name-${token.id}`}>
            Token name
          </label>
          <input
            id={`token-name-${token.id}`}
            type="text"
            maxLength={80}
            autocomplete="off"
            value={name}
            onInput={(event) => setName(event.currentTarget.value)}
          />
          <button class="linklike" type="submit" disabled={busy}>
            Save name
          </button>
          <button
            class="linklike"
            type="button"
            disabled={busy}
            onClick={() => renameAccessToken(null)}
          >
            Cancel
          </button>
        </form>
      ) : null}
    </section>
  );
}

export function TokensPage({ state }: { state: OperatorState }) {
  const available = state.data?.accessTokenManagement === "available";
  return (
    <section id="tokensView">
      <div class="lead pgrid">
        <h1 id="tokensHeading" class="pcap" tabIndex={-1}>
          Access tokens
        </h1>
        <div class="pbody">
          <p class="activity-copy">
            Create named Bearer tokens for MCP clients. Each secret is shown
            once; revoke it when that client should lose access.
          </p>
          <NoticeLine id="tokenNotice" notice={state.tokenNotice} />
          {!available ? (
            <Unavailable>
              {accessTokenUnavailableCopy(state.data?.accessTokenManagement)}
            </Unavailable>
          ) : (
            <div id="tokenAvailable">
              {state.createdToken ? (
                <Reveal token={state.createdToken} />
              ) : (
                <CreateForm busy={state.tokenBusy} />
              )}
              <div
                id="tokenList"
                class="token-ledger"
                aria-busy={state.tokenPhase === "loading" ? "true" : "false"}
              >
                {state.tokenPhase === "loading" ? (
                  <Empty>Loading access tokens…</Empty>
                ) : state.tokenPhase === "error" ? (
                  <p class="empty">
                    <button
                      class="linklike"
                      type="button"
                      onClick={() => void loadAccessTokens()}
                    >
                      Try loading access tokens again
                    </button>
                  </p>
                ) : state.tokens.length === 0 ? (
                  <Empty>
                    No access tokens yet. Name the first MCP client above.
                  </Empty>
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
