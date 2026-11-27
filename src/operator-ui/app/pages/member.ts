import { Component, Mount, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Schema } from "effect";
import {
  memberConfirmCopy,
  memberPage,
  toolCountLabel,
  type AccountControl,
  type MemberAccount,
  type MemberPageModel,
} from "../../member-page.js";
import { clientServerName } from "../../setup-commands.js";
import { safeHttpHref, type Notice, type OperatorState, type PendingConfirm } from "../../view.js";
import { productName } from "../config.js";
import { CredentialForm } from "../components/credential-form.js";
import { Icon } from "../components/icons.js";
import { ConnectorMark } from "../components/marks.js";
import { ConfirmAction, ConfirmBar, NoticeLine, Pill, pillStatus, StateBlock } from "../components/parts.js";
import { keepSame, opaque } from "../components/projection.js";
import { CandidateHandle, Prepared } from "../shell/commands.js";
import { PageWrite } from "../shell/page-writes.js";
import { PrepareOAuth } from "./connector-auth.js";
import {
  AskConfirm,
  CancelConfirm,
  EditCredential,
  RefuseCredential,
  RequestPageWrite,
  RetryOperatorLoad,
} from "./connector-commands.js";
import { ClientId, EndpointLine, endpointUrl, SetupDrawer, SetupTarget } from "./endpoints.js";

type ConfirmKind = PendingConfirm["action"];

export interface MemberRow {
  readonly confirming: ConfirmKind | null;
  readonly oauthBusy: boolean;
  readonly credentialBusy: boolean;
  readonly editing: boolean;
  readonly blocked: string | null;
  readonly oauthNotice: Notice | null;
  readonly credentialNotice: Notice | null;
}

export const MemberData = UiSchema.TaggedEnum({
  Pending: { failed: Schema.Boolean, network: Schema.Boolean },
  Ready: {
    page: opaque<MemberPageModel>("MemberPageModel"),
    rows: opaque<Readonly<Record<string, MemberRow>>>("MemberRows"),
  },
});
export type MemberData = typeof MemberData.Type;

const ownNotice = (notice: Notice | null): Notice | null =>
  notice ? { message: notice.message, tone: notice.tone } : null;

const rowOf = (state: OperatorState, account: MemberAccount): MemberRow => ({
  confirming: state.confirming?.connectorId === account.id ? state.confirming.action : null,
  oauthBusy: state.oauthBusy === account.id,
  credentialBusy: state.credentialBusy === account.id,
  editing: state.credentialEditing === account.id && account.manage.kind === "credential",
  blocked: state.oauthBlocked === account.id ? safeHttpHref(state.oauthBlockedUrl ?? undefined) : null,
  oauthNotice: state.oauthNoticeFor === account.id ? ownNotice(state.oauthNotice) : null,
  credentialNotice: state.credentialNoticeFor === account.id ? ownNotice(state.credentialNotice) : null,
});

export const memberProjection = () => {
  const inputs = keepSame<{
    contract: OperatorState["contract"];
    confirming: OperatorState["confirming"];
    oauthBusy: OperatorState["oauthBusy"];
    credentialBusy: OperatorState["credentialBusy"];
    credentialEditing: OperatorState["credentialEditing"];
    oauthBlocked: OperatorState["oauthBlocked"];
    oauthBlockedUrl: OperatorState["oauthBlockedUrl"];
    oauthNotice: OperatorState["oauthNotice"];
    oauthNoticeFor: OperatorState["oauthNoticeFor"];
    credentialNotice: OperatorState["credentialNotice"];
    credentialNoticeFor: OperatorState["credentialNoticeFor"];
    contractPhase: OperatorState["contractPhase"];
    loadFailure: OperatorState["loadFailure"];
  }>();
  let last: { inputs: object; data: MemberData } | null = null;
  return (state: OperatorState): MemberData => {
    const current = inputs({
      contract: state.contract,
      confirming: state.confirming,
      oauthBusy: state.oauthBusy,
      credentialBusy: state.credentialBusy,
      credentialEditing: state.credentialEditing,
      oauthBlocked: state.oauthBlocked,
      oauthBlockedUrl: state.oauthBlockedUrl,
      oauthNotice: state.oauthNotice,
      oauthNoticeFor: state.oauthNoticeFor,
      credentialNotice: state.credentialNotice,
      credentialNoticeFor: state.credentialNoticeFor,
      contractPhase: state.contractPhase,
      loadFailure: state.loadFailure,
    });
    if (last?.inputs === current) return last.data;
    const data =
      state.contract?.role !== "member"
        ? MemberData.Pending({ failed: state.contractPhase === "error", network: state.loadFailure === "network" })
        : (() => {
            const page = memberPage(state.contract);
            return MemberData.Ready({
              page,
              rows: Object.fromEntries(page.accounts.map((account) => [account.id, rowOf(state, account)])),
            });
          })();
    last = { inputs: current, data };
    return data;
  };
};

const ControlKind = Schema.Literals(["restart", "disconnect", "save", "test", "clear"]);
const OAuthMode = Schema.Literals(["continue", "restart"]);
const Verify = Schema.Literals(["test", "skip"]);

export const MemberMessage = UiSchema.TaggedEnum({
  ClickedControl: { connector: Schema.String, control: ControlKind },
  CompletedPrepareOAuth: { connector: Schema.String, mode: OAuthMode, prepared: Prepared },
  ClickedConfirmDisconnect: { connector: Schema.String },
  ClickedConfirmRemove: { connector: Schema.String },
  ClickedCancelConfirm: { focus: Schema.Array(Schema.String) },
  HeldCredentialCandidate: { connector: Schema.String, candidate: CandidateHandle, verify: Verify },
  RefusedCredentialCandidate: { connector: Schema.String, copy: Schema.String },
  ClickedCancelCredential: {},
  ClickedSetup: { target: SetupTarget },
  PickedClient: { client: ClientId },
  RequestedCloseSetup: {},
  ClickedRetryLoad: {},
});
type Message = typeof MemberMessage.Type;
type H = Html.H<Message>;

const CONTROL_ID: Record<AccountControl["kind"], string> = {
  connect: "connect",
  restart: "reconnect",
  disconnect: "disconnect",
  save: "credential-save",
  test: "credential-test",
  clear: "clear-credential",
};

const controlId = (control: AccountControl["kind"], connector: string) => `${CONTROL_ID[control]}-${connector}`;

const CONFIRM_TRIGGER: Record<ConfirmKind, AccountControl["kind"]> = {
  oauth_restart: "restart",
  oauth_disconnect: "disconnect",
  credential_remove: "clear",
};

const CONFIRM_FOR: Record<"restart" | "disconnect" | "clear", ConfirmKind> = {
  restart: "oauth_restart",
  disconnect: "oauth_disconnect",
  clear: "credential_remove",
};

const write = (request: PageWrite) => RequestPageWrite.make({ request });

const prepared = (connector: string, mode: typeof OAuthMode.Type) =>
  PrepareOAuth({ connector, mode }).pipe(
    Mount.map((tab) => MemberMessage.CompletedPrepareOAuth({ connector, mode, prepared: tab })),
  );

const variant = (control: AccountControl) =>
  control.kind === "connect" || (control.kind === "save" && control.label === "Add credential")
    ? "primary"
    : control.kind === "disconnect" || control.kind === "clear"
      ? "quiet"
      : "default";

const ControlButton = (h: H, account: MemberAccount, row: MemberRow, control: AccountControl) => {
  const busy =
    control.kind === "save" || control.kind === "test" || control.kind === "clear" ? row.credentialBusy : row.oauthBusy;
  const button = h.button
    .key(control.kind)
    .attr("type", "button")
    .attr("id", controlId(control.kind, account.id))
    .class("btn", variant(control), "sm")
    .disabled(busy)
    .attr("aria-label", `${control.label} ${account.title}`)
    .attr("aria-expanded", control.kind === "save" ? (row.editing ? "true" : "false") : undefined)
    .children(busy && (control.kind === "connect" || control.kind === "test") ? "Working…" : control.label);
  return control.kind === "connect"
    ? button.onMount(prepared(account.id, "continue"))
    : button.on("click", MemberMessage.ClickedControl({ connector: account.id, control: control.kind }));
};

const Confirm = (h: H, account: MemberAccount, action: ConfirmKind) => {
  const id = account.id;
  const copy = memberConfirmCopy(
    action,
    account.title,
    account.manage.kind === "oauth" && account.manage.reconnectKeepsGrant === true,
  );
  const button = ConfirmAction(h, copy.confirm);
  return ConfirmBar(h, {
    id,
    question: copy.question,
    confirm:
      action === "oauth_restart"
        ? button.onMount(prepared(id, "restart"))
        : action === "oauth_disconnect"
          ? button.on("click", MemberMessage.ClickedConfirmDisconnect({ connector: id }))
          : button.on("click", MemberMessage.ClickedConfirmRemove({ connector: id })),
    cancel: MemberMessage.ClickedCancelConfirm({ focus: [controlId(CONFIRM_TRIGGER[action], id), "memberHeading"] }),
  }).key("confirm");
};

const AccountRow = (h: H, account: MemberAccount, row: MemberRow, hue: number) => {
  const { id, title, manage } = account;
  return h.li
    .key(id)
    .class("account-row")
    .attr("aria-labelledby", `account-${id}`)
    .children(
      h.div
        .key("main")
        .class("account-main")
        .children(
          ConnectorMark(h, id, title, "lg", hue),
          h.div
            .class("account-copy")
            .children(
              h.h3.attr("id", `account-${id}`).children(title),
              h.p
                .class("meta")
                .children(
                  toolCountLabel(account.toolCount),
                  account.summary ? h.span.class("account-note").children(` · ${account.summary}`) : null,
                  account.account
                    ? h.span
                        .class("account-note")
                        .attr("data-connected-account", "true")
                        .children(` · ${account.account}`)
                    : null,
                ),
            ),
          h.div
            .class("account-status")
            .children(account.badge ? Pill(h, pillStatus(account.badge.tone), account.badge.label) : null),
          h.div
            .class("account-actions")
            .children(
              row.blocked
                ? h.a
                    .key("authorize")
                    .class("btn", "primary", "sm")
                    .attr("href", row.blocked)
                    .attr("target", "_blank")
                    .attr("rel", "noopener noreferrer")
                    .children("Open authorization page")
                : account.controls.map((control) => ControlButton(h, account, row, control)),
            ),
        ),
      row.confirming ? Confirm(h, account, row.confirming) : null,
      row.editing && manage.kind === "credential"
        ? h.div
            .key("form")
            .class("account-form")
            .children(
              manage.description ? h.p.class("meta").children(manage.description) : null,
              CredentialForm(h, {
                connector: id,
                credential: { label: manage.label, fields: manage.fields },
                busy: row.credentialBusy,
                untested: false,
                held: (candidate, verify) =>
                  MemberMessage.HeldCredentialCandidate({ connector: id, candidate, verify }),
                refused: (copy) => MemberMessage.RefusedCredentialCandidate({ connector: id, copy }),
                cancel: MemberMessage.ClickedCancelCredential(),
              }),
            )
        : null,
      NoticeLine(h, `oauthNotice-${id}`, row.oauthNotice, "meta").key("oauthNotice"),
      NoticeLine(h, `credentialNotice-${id}`, row.credentialNotice, "meta").key("credentialNotice"),
    );
};

const Heading = (h: H, account: string | null) =>
  h.div.class("member-heading").children(
    h.span
      .class("member-avatar")
      .attr("aria-hidden", "true")
      .children(account ? account.trim().charAt(0).toUpperCase() : Icon(h, "user", 18)),
    h.div.children(
      h.h1.attr("id", "memberHeading").attr("tabindex", "-1").children("Your connections"),
      account ? h.p.class("meta").children(account) : null,
    ),
  );

const Endpoints = (h: H, page: MemberPageModel) =>
  h.section
    .key("endpoints")
    .class("member-section")
    .attr("aria-labelledby", "memberEndpointsHeading")
    .children(
      h.h2
        .attr("id", "memberEndpointsHeading")
        .class("member-label")
        .children(page.endpoints.length === 1 ? "Your endpoint" : "Your endpoints"),
      page.endpoints.length
        ? h.ul.class("member-endpoints").children(
            page.endpoints.map((endpoint) => {
              const url = endpointUrl(endpoint.path);
              return h.li
                .key(endpoint.pool)
                .class("member-endpoint")
                .attr("aria-label", endpoint.pool)
                .children(
                  h.span
                    .class("member-endpoint-mark")
                    .attr("aria-hidden", "true")
                    .children(Icon(h, "plug", 16)),
                  h.div
                    .class("member-endpoint-copy")
                    .children(
                      h.p.class("member-endpoint-name").children(endpoint.pool),
                      EndpointLine(h, `url:${endpoint.pool}`, url, endpoint.pool),
                    ),
                  h.button
                    .attr("type", "button")
                    .class("btn", "default", "sm", "endpoint-setup")
                    .attr("aria-label", `Client setup for ${endpoint.pool}`)
                    .on(
                      "click",
                      MemberMessage.ClickedSetup({
                        target: { label: endpoint.pool, url, name: clientServerName(productName) },
                      }),
                    )
                    .children("Client setup"),
                );
            }),
          )
        : StateBlock(h, { copy: "No endpoints yet." }),
    );

const Accounts = (h: H, page: MemberPageModel, rows: Readonly<Record<string, MemberRow>>) =>
  h.section
    .key("accounts")
    .class("member-section")
    .attr("aria-labelledby", "memberAccountsHeading")
    .children(
      h.h2.attr("id", "memberAccountsHeading").class("member-label").children("Your accounts"),
      page.accounts.length
        ? h.ul
            .class("member-card")
            .children(page.accounts.map((account, index) => AccountRow(h, account, rows[account.id]!, index)))
        : h.p.class("member-empty", "meta").children("Nothing to connect."),
    );

const Shared = (h: H, page: MemberPageModel) =>
  page.shared.length
    ? h.section
        .key("shared")
        .class("member-section")
        .attr("aria-labelledby", "memberSharedHeading")
        .children(
          h.h2.attr("id", "memberSharedHeading").class("member-label").children("Shared with you"),
          h.ul.class("shared-list").children(
            page.shared.map((connector, index) =>
              h.li
                .key(connector.id)
                .class("shared-chip")
                .children(
                  ConnectorMark(h, connector.id, connector.title, "sm", page.accounts.length + index),
                  h.span.class("shared-name").children(connector.title),
                  h.span.class("shared-count").children(toolCountLabel(connector.toolCount)),
                ),
            ),
          ),
        )
    : null;

export const MemberPageNoDeps = Html.component({
  name: "MemberPage",
  props: Schema.Struct({ data: MemberData, account: Schema.NullOr(Schema.String) }),
  model: Schema.Struct({ setup: Schema.NullOr(SetupTarget), client: ClientId }),
  message: MemberMessage,
  restore: false,
}).make({
  init: () => ({ setup: null, client: "claude" as const }),
  update: {
    ClickedControl: ($, { connector, control }) => {
      if (control === "save") {
        const editing = $.props.data._tag === "Ready" && $.props.data.rows[connector]?.editing === true;
        return $.run(EditCredential.make({ connector: editing ? null : connector }));
      }
      if (control === "test") return $.run(write(PageWrite.TestCredential({ connector })));
      return $.run(AskConfirm.make({ connector, action: CONFIRM_FOR[control] }));
    },
    CompletedPrepareOAuth: ($, { connector, mode, prepared }) =>
      $.run(write(PageWrite.StartOAuth({ connector, mode, prepared }))),
    ClickedConfirmDisconnect: ($, { connector }) => $.run(write(PageWrite.DisconnectOAuth({ connector }))),
    ClickedConfirmRemove: ($, { connector }) => $.run(write(PageWrite.RemoveCredential({ connector }))),
    ClickedCancelConfirm: ($, { focus }) => $.run(CancelConfirm.make({ focus })),
    HeldCredentialCandidate: ($, { connector, candidate, verify }) =>
      $.run(write(PageWrite.SaveCredential({ connector, candidate, verify }))),
    RefusedCredentialCandidate: ($, { connector, copy }) => $.run(RefuseCredential.make({ connector, copy })),
    ClickedCancelCredential: ($) => $.run(EditCredential.make({ connector: null })),
    ClickedSetup: ($, { target }) => $.evolve({ setup: target }),
    PickedClient: ($, { client }) => $.evolve({ client }),
    RequestedCloseSetup: ($) => $.evolve({ setup: null }),
    ClickedRetryLoad: ($) => $.run(RetryOperatorLoad.make()),
  },
  view: (h, model) => {
    const { data, account } = h.props;
    const section = h.section.attr("id", "memberView").class("member-page");
    if (data._tag === "Pending")
      return section.children(
        Heading(h, account),
        data.failed
          ? StateBlock(h, {
              tone: "error",
              title: "Couldn't refresh",
              copy: data.network ? `Couldn't reach ${productName}.` : null,
              action: { label: "Retry", message: MemberMessage.ClickedRetryLoad() },
            })
          : StateBlock(h, { busy: true, copy: "Loading your connections…" }),
      );
    return section.children(
      Heading(h, account),
      Endpoints(h, data.page),
      Accounts(h, data.page, data.rows),
      Shared(h, data.page),
      h.p.key("footer").class("member-footer", "meta").children(`Trouble? Ask whoever runs ${productName}.`),
      SetupDrawer(h, {
        target: model.setup,
        client: model.client,
        open: model.setup !== null,
        onClose: MemberMessage.RequestedCloseSetup(),
        pick: (client) => MemberMessage.PickedClient({ client }),
      }),
    );
  },
});

export const MemberPage = MemberPageNoDeps.pipe(
  Component.provide([
    RequestPageWrite.layer,
    AskConfirm.layer,
    CancelConfirm.layer,
    EditCredential.layer,
    RefuseCredential.layer,
    RetryOperatorLoad.layer,
  ]),
);
