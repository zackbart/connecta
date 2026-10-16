import { useRef, useState } from "react";
import {
  memberConfirmCopy,
  memberPage,
  toolCountLabel,
  type AccountControl,
  type MemberAccount,
} from "../member-page.js";
import { safeHttpHref, type Notice, type OperatorState } from "../view.js";
import { clientServerName } from "../setup-commands.js";
import { productName } from "./config.js";
import { CredentialForm } from "./credentials.js";
import { ConfirmBar, focusableId, NoticeLine, Pill, pillStatus, StateBlock } from "./parts.js";
import { Icon } from "./icons.js";
import { ConnectorMark } from "./marks.js";
import { Button } from "./primitives.js";
import { ClientSetupDialog, EndpointLine, endpointUrl, type SetupTarget } from "./endpoints.js";
import { useCloseOnRecovery } from "./contract-state.js";
import {
  askConfirm,
  cancelConfirm,
  disconnectOAuth,
  editCredential,
  removeCredential,
  retryLoad,
  startOAuth,
  testCredential,
} from "./store.js";

/**
 * A pool member's one page: their endpoints with client setup, the personal
 * accounts they connect themselves, and what is shared with them by name. The
 * member contract carries no other people, agents, settings or shared
 * credential state, and this page reads nothing that would. It sends only the
 * member's own OAuth and credential requests.
 */

/**
 * Fix prompts are written for a coding agent working on the deployment, which
 * a member is not; their notices keep the sentence alone.
 */
function ownNotice(notice: Notice | null): Notice | null {
  return notice ? { message: notice.message, tone: notice.tone } : null;
}

const CONTROL_ID: Record<AccountControl["kind"], string> = {
  connect: "connect",
  restart: "reconnect",
  disconnect: "disconnect",
  save: "credential-save",
  test: "credential-test",
  clear: "clear-credential",
};

function controlId(control: AccountControl["kind"], connector: string): string {
  return `${CONTROL_ID[control]}-${connector}`;
}

function AccountRow({ account, state, hue }: { account: MemberAccount; state: OperatorState; hue: number }) {
  const { id, title, manage } = account;
  const confirming = state.confirming?.connectorId === id ? state.confirming.action : null;
  const oauthBusy = state.oauthBusy === id;
  const credentialBusy = state.credentialBusy === id;
  const editing = state.credentialEditing === id && manage.kind === "credential";
  // The browser refused the new tab; the route answered anyway, so its link is the action.
  const blocked = state.oauthBlocked === id ? safeHttpHref(state.oauthBlockedUrl ?? undefined) : null;
  const run = (control: AccountControl) => {
    switch (control.kind) {
      case "connect":
        return void startOAuth(id, "continue");
      case "restart":
        return askConfirm(id, "oauth_restart");
      case "disconnect":
        return askConfirm(id, "oauth_disconnect");
      case "save":
        return editCredential(editing ? null : id);
      case "test":
        return void testCredential(id);
      case "clear":
        return askConfirm(id, "credential_remove");
    }
  };
  const busyFor = (control: AccountControl) =>
    control.kind === "save" || control.kind === "test" || control.kind === "clear" ? credentialBusy : oauthBusy;
  return (
    <li className="account-row" aria-labelledby={`account-${id}`}>
      <div className="account-main">
        <ConnectorMark id={id} title={title} size="lg" hue={hue} />
        <div className="account-copy">
          <h3 id={`account-${id}`}>{title}</h3>
          <p className="meta">
            {toolCountLabel(account.toolCount)}
            {account.summary ? <span className="account-note"> · {account.summary}</span> : null}
          </p>
        </div>
        <div className="account-status">
          {account.badge ? <Pill status={pillStatus(account.badge.tone)}>{account.badge.label}</Pill> : null}
        </div>
        <div className="account-actions">
          {blocked ? (
            <a className="btn primary sm" href={blocked} target="_blank" rel="noopener noreferrer">
              Open authorization page
            </a>
          ) : (
            account.controls.map((control) => (
              <Button
                key={control.kind}
                id={controlId(control.kind, id)}
                size="sm"
                variant={
                  control.kind === "connect" || (control.kind === "save" && control.label === "Add credential")
                    ? "primary"
                    : control.kind === "disconnect" || control.kind === "clear"
                      ? "quiet"
                      : "default"
                }
                disabled={busyFor(control)}
                aria-label={`${control.label} ${title}`}
                {...(control.kind === "save" ? { "aria-expanded": editing ? "true" : "false" } : {})}
                onClick={() => run(control)}
              >
                {busyFor(control) && (control.kind === "connect" || control.kind === "test")
                  ? "Working…"
                  : control.label}
              </Button>
            ))
          )}
        </div>
      </div>
      {confirming ? (
        <ConfirmBar
          id={id}
          {...memberConfirmCopy(confirming, title)}
          onConfirm={() => {
            if (confirming === "oauth_restart") void startOAuth(id, "restart");
            else if (confirming === "oauth_disconnect") void disconnectOAuth(id);
            else void removeCredential(id);
          }}
          onCancel={() =>
            cancelConfirm(
              focusableId(
                controlId(
                  confirming === "oauth_restart"
                    ? "restart"
                    : confirming === "oauth_disconnect"
                      ? "disconnect"
                      : "clear",
                  id,
                ),
                "memberHeading",
              ),
            )
          }
        />
      ) : null}
      {editing && manage.kind === "credential" ? (
        <div className="account-form">
          {manage.description ? <p className="meta">{manage.description}</p> : null}
          <CredentialForm
            connector={id}
            credential={{ label: manage.label, ...(manage.fields ? { fields: manage.fields } : {}) }}
            busy={credentialBusy}
          />
        </div>
      ) : null}
      <NoticeLine id={`oauthNotice-${id}`} notice={state.oauthNoticeFor === id ? ownNotice(state.oauthNotice) : null} />
      <NoticeLine
        id={`credentialNotice-${id}`}
        notice={state.credentialNoticeFor === id ? ownNotice(state.credentialNotice) : null}
      />
    </li>
  );
}

export function MemberPage({ state, account }: { state: OperatorState; account?: string | null }) {
  const [setup, setSetup] = useState<SetupTarget | null>(null);
  // Members never get the maintainer recovery banner, so this is a no-op for
  // them; their confirmations and credential form close with the
  // member-unavailable transition instead.
  useCloseOnRecovery(state, () => setSetup(null));
  const returnFocus = useRef<HTMLElement | null>(null);
  const page = memberPage(state.contract);
  const heading = (
    <div className="member-heading">
      <span className="member-avatar" aria-hidden="true">
        {account ? account.trim().charAt(0).toUpperCase() : <Icon name="user" size={18} />}
      </span>
      <div>
        <h1 id="memberHeading" tabIndex={-1}>
          Your connections
        </h1>
        {account ? <p className="meta">{account}</p> : null}
      </div>
    </div>
  );
  // Confirmed a member, but the latest contract read failed or is pending:
  // this page's own state, never another page's.
  if (state.contract?.role !== "member") {
    return (
      <section id="memberView" className="member-page">
        {heading}
        {state.contractPhase === "error" ? (
          <StateBlock
            tone="error"
            title="Your connections couldn't be refreshed"
            action={{ label: "Retry", onClick: () => void retryLoad() }}
          >
            {state.loadFailure === "network"
              ? `Couldn't reach ${productName}. Check your connection, then retry.`
              : "Retry to load your endpoints and accounts."}
          </StateBlock>
        ) : (
          <StateBlock busy>Loading your connections…</StateBlock>
        )}
      </section>
    );
  }
  return (
    <section id="memberView" className="member-page">
      {heading}

      <section className="member-section" aria-labelledby="memberEndpointsHeading">
        <h2 id="memberEndpointsHeading" className="member-label">
          {page.endpoints.length === 1 ? "Your endpoint" : "Your endpoints"}
        </h2>
        {page.endpoints.length ? (
          <ul className="member-endpoints">
            {page.endpoints.map((endpoint) => {
              const url = endpointUrl(endpoint.path);
              return (
                <li className="member-endpoint" key={endpoint.pool} aria-label={endpoint.path}>
                  <span className="member-endpoint-mark" aria-hidden="true">
                    <Icon name="plug" size={16} />
                  </span>
                  <div className="member-endpoint-copy">
                    <p className="member-endpoint-name">{endpoint.pool}</p>
                    <EndpointLine url={url} label={endpoint.pool} />
                  </div>
                  <Button
                    size="sm"
                    className="endpoint-setup"
                    onClick={(event) => {
                      returnFocus.current = event.currentTarget;
                      setSetup({
                        label: endpoint.pool,
                        path: endpoint.path,
                        url,
                        name: clientServerName(productName, endpoint.pool),
                      });
                    }}
                    aria-label={`Client setup for ${endpoint.pool}`}
                  >
                    Client setup
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <StateBlock>No endpoints yet.</StateBlock>
        )}
      </section>

      <section className="member-section" aria-labelledby="memberAccountsHeading">
        <h2 id="memberAccountsHeading" className="member-label">
          Your accounts
        </h2>
        {page.accounts.length ? (
          <ul className="member-card">
            {page.accounts.map((account, index) => (
              <AccountRow key={account.id} account={account} state={state} hue={index} />
            ))}
          </ul>
        ) : (
          <p className="member-empty meta">Nothing to connect.</p>
        )}
      </section>

      {page.shared.length ? (
        <section className="member-section" aria-labelledby="memberSharedHeading">
          <h2 id="memberSharedHeading" className="member-label">
            Shared with you
          </h2>
          <ul className="shared-list">
            {page.shared.map((connector, index) => (
              <li key={connector.id} className="shared-chip">
                <ConnectorMark id={connector.id} title={connector.title} size="sm" hue={page.accounts.length + index} />
                <span className="shared-name">{connector.title}</span>
                <span className="shared-count">{toolCountLabel(connector.toolCount)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="member-footer meta">Trouble? Ask whoever runs {productName}.</p>
      <ClientSetupDialog target={setup} onClose={() => setSetup(null)} returnFocus={returnFocus} />
    </section>
  );
}
