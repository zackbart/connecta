import { Component, Mount, UiSchema, type View } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Effect, Queue, Schema, Stream } from "effect";
import type { OperatorConnectorOverlay } from "../../contract.js";
import type { UiConnector } from "../../model.js";
import {
  confirmCopy,
  connectorLoadFailureCopy,
  credentialProblemCopy,
  formatDate,
  problemCopy,
  problemTone,
  registrationPathLabel,
  safeHttpHref,
  verificationLabel,
  type ConnectorLoadFailure,
  type Notice,
} from "../../view.js";
import { productName } from "../config.js";
import { sinceLabel } from "../components/connector-parts.js";
import { Icon } from "../components/icons.js";
import {
  Badge,
  Callout,
  ConfirmAction,
  ConfirmBar,
  FixPrompt,
  NoticeWithFix,
  Pill,
  StateBlock,
  SummaryRow,
} from "../components/parts.js";
import { opaque } from "../components/projection.js";
import type { CandidateHandle as Handle, CredentialBody, PreparedOAuth } from "../services/controller.js";
import { OperatorController } from "../services/controller.js";
import { CandidateHandle, Prepared } from "../shell/commands.js";
import { IslandRequest } from "../shell/island-request.js";
import {
  AskConfirm,
  CancelConfirm,
  EditCredential,
  RefreshConnector,
  RefuseCredential,
  RequestPageWrite,
} from "./connector-commands.js";

const OAuthMode = Schema.Literals(["continue", "restart"]);
const Verify = Schema.Literals(["test", "skip"]);
type Verify = typeof Verify.Type;
const Action = Schema.Literals(["oauth_disconnect", "oauth_restart", "credential_remove"]);

export const PrepareOAuth = Mount.makeStream(
  "PrepareOAuth",
  { args: { connector: Schema.String, mode: OAuthMode } },
  (button: HTMLElement, initial, changes) =>
    Stream.callback<PreparedOAuth, never, OperatorController>((queue) =>
      Effect.gen(function* () {
        const controller = yield* OperatorController;
        let args = initial;
        yield* Stream.runForEach(changes, (next) => Effect.sync(() => (args = next))).pipe(Effect.forkScoped);
        const onClick = () => void Queue.offerUnsafe(queue, controller.prepareOAuth(args.connector, args.mode));
        yield* Effect.acquireRelease(
          Effect.sync(() => button.addEventListener("click", onClick)),
          () => Effect.sync(() => button.removeEventListener("click", onClick)),
        );
      }),
    ),
);

type Submission =
  | { readonly _tag: "Held"; readonly candidate: Handle }
  | { readonly _tag: "Refused"; readonly copy: string };

const SubmitArgs = { connector: Schema.String, fields: Schema.Array(Schema.String) };
type SubmitArgs = { readonly connector: string; readonly fields: ReadonlyArray<string> };

export const credentialSubmissions = (
  button: EventTarget,
  hold: (body: CredentialBody) => Handle,
  read: (id: string) => string,
  initial: SubmitArgs,
  changes: Stream.Stream<SubmitArgs>,
) =>
  Stream.callback<Submission>((queue) =>
    Effect.gen(function* () {
      let args = initial;
      yield* Stream.runForEach(changes, (next) => Effect.sync(() => (args = next))).pipe(Effect.forkScoped);
      const submit = (): Submission => {
        const { connector, fields } = args;
        if (!fields.length) {
          const value = read(`credential-input-${connector}`).trim();
          return value
            ? { _tag: "Held", candidate: hold({ value }) }
            : { _tag: "Refused", copy: "Paste a credential before saving." };
        }
        const values: Record<string, string> = {};
        for (const [index, name] of fields.entries()) {
          const value = read(`credential-input-${connector}-${index}`).trim();
          if (!value) return { _tag: "Refused", copy: "Fill every field before saving." };
          values[name] = value;
        }
        return { _tag: "Held", candidate: hold({ values }) };
      };
      const onClick = () => void Queue.offerUnsafe(queue, submit());
      yield* Effect.acquireRelease(
        Effect.sync(() => button.addEventListener("click", onClick)),
        () => Effect.sync(() => button.removeEventListener("click", onClick)),
      );
    }),
  );

const readField = (id: string) => {
  const field = document.getElementById(id);
  return field instanceof HTMLInputElement ? field.value : "";
};

export const SubmitCredential = Mount.makeStream(
  "SubmitCredential",
  { args: SubmitArgs },
  (button: HTMLElement, initial, changes) =>
    Stream.unwrap(
      OperatorController.useSync((controller) =>
        credentialSubmissions(button, controller.holdCredentialCandidate, readField, initial, changes),
      ),
    ),
);

export const ConnectorAuthMessage = UiSchema.TaggedEnum({
  CompletedPrepareOAuth: { mode: OAuthMode, prepared: Prepared },
  ClickedAskConfirm: { action: Action },
  ClickedDisconnect: {},
  ClickedCancelConfirm: { focus: Schema.Array(Schema.String) },
  ClickedRefresh: {},
  ClickedEditCredential: { connector: Schema.NullOr(Schema.String) },
  ClickedTestCredential: {},
  ClickedRemoveCredential: {},
  HeldCredentialCandidate: { candidate: CandidateHandle, verify: Verify },
  RefusedCredentialCandidate: { copy: Schema.String },
});
type Message = typeof ConnectorAuthMessage.Type;
type H = Html.H<Message>;

const write = (request: IslandRequest) => RequestPageWrite.make({ request });

const prepared = (connector: string, mode: typeof OAuthMode.Type) =>
  PrepareOAuth({ connector, mode }).pipe(
    Mount.map((tab) => ConnectorAuthMessage.CompletedPrepareOAuth({ mode, prepared: tab })),
  );

const submitted = (connector: string, fields: ReadonlyArray<string>, verify: Verify) =>
  SubmitCredential({ connector, fields }).pipe(
    Mount.map((submission) =>
      submission._tag === "Held"
        ? ConnectorAuthMessage.HeldCredentialCandidate({ candidate: submission.candidate, verify })
        : ConnectorAuthMessage.RefusedCredentialCandidate({ copy: submission.copy }),
    ),
  );

export const ConnectorAuthProps = Schema.Struct({
  connector: opaque<UiConnector>("UiConnector"),
  handoff: Schema.NullOr(Schema.String),
  confirming: Schema.NullOr(Action),
  failure: Schema.NullOr(opaque<ConnectorLoadFailure & string>("ConnectorLoadFailure")),
  oauthBusy: Schema.Boolean,
  oauthBlocked: Schema.Boolean,
  oauthNotice: Schema.NullOr(opaque<Notice>("Notice")),
  editing: Schema.Boolean,
  untested: Schema.Boolean,
  credentialBusy: Schema.Boolean,
  credentialNotice: Schema.NullOr(opaque<Notice>("Notice")),
});
export type ConnectorAuthProps = typeof ConnectorAuthProps.Type;

const external = (h: H, href: string) =>
  h.a.attr("href", href).attr("target", "_blank").attr("rel", "noopener noreferrer");

const AuthActions = (h: H, props: ConnectorAuthProps, name: string, manage: boolean) => {
  const { connector } = props;
  const id = connector.id;
  const authorization = safeHttpHref(connector.authorizationUrl);
  const busy = props.oauthBusy;
  if (connector.status === "loading" || connector.status === "per_caller") return null;
  if (props.handoff && manage && connector.oauth) {
    const target = new URL(`/connect/${encodeURIComponent(id)}`, window.location.origin);
    target.searchParams.set("h", props.handoff);
    target.searchParams.set("start", "1");
    return external(h, target.href).class("btn", "primary").children("Continue requested authorization");
  }
  if (!connector.oauth || !manage)
    return authorization && connector.status !== "ok"
      ? external(h, authorization).class("btn", "primary").children("Authorize connector")
      : null;
  if (props.oauthBlocked && authorization)
    return external(h, authorization)
      .attr("id", `authorize-${id}`)
      .class("btn", "primary")
      .children("Open authorization page");
  if (connector.status !== "ok") {
    const needsAuth = connector.status === "auth_required";
    return h.button
      .attr("type", "button")
      .attr("id", `connect-${id}`)
      .class(needsAuth ? "btn primary" : "btn")
      .attr("aria-label", `${needsAuth ? "Connect" : "Reconnect"} ${name}`)
      .disabled(busy)
      .onMount(prepared(id, "continue"))
      .children(busy ? "Opening…" : needsAuth ? "Connect account" : "Reconnect");
  }
  const switching = connector.authScope === "personal";
  return [
    h.button
      .key("reconnect")
      .attr("type", "button")
      .attr("id", `reconnect-${id}`)
      .class("btn")
      .attr("aria-label", `${switching ? "Switch account for" : "Reconnect"} ${name}`)
      .disabled(busy)
      .on("click", ConnectorAuthMessage.ClickedAskConfirm({ action: "oauth_restart" }))
      .children(busy ? "Working…" : switching ? "Switch account" : "Reconnect"),
    h.button
      .key("disconnect")
      .attr("type", "button")
      .attr("id", `disconnect-${id}`)
      .class("btn", "danger")
      .attr("aria-label", `Disconnect ${name}`)
      .disabled(busy)
      .on("click", ConnectorAuthMessage.ClickedAskConfirm({ action: "oauth_disconnect" }))
      .children("Disconnect"),
  ];
};

const managedBy = (connector: UiConnector): string =>
  connector.permissions?.manageSharedAuth
    ? "You"
    : connector.permissions?.connectPersonal
      ? "Each person"
      : "Deployment";

type Credential = NonNullable<UiConnector["credential"]>;
type CredentialState = "configured" | "missing" | "unavailable";

const credentialState = (credential: { configured: boolean | null; problem?: string }): CredentialState =>
  credential.configured === null || credential.problem === "credential_unreadable"
    ? "unavailable"
    : credential.configured
      ? "configured"
      : "missing";

const STATE_PILL = {
  configured: { label: "Saved", status: "healthy" },
  missing: { label: "Not set", status: "attention" },
  unavailable: { label: "Unavailable", status: "neutral" },
} as const;

const StatePill = (h: H, state: CredentialState) => Pill(h, STATE_PILL[state].status, STATE_PILL[state].label);

const Masked = (h: H, lastFour: string | undefined, updatedAt: string | undefined) =>
  !lastFour && !updatedAt
    ? null
    : h.span
        .class("credential-masked")
        .children(
          lastFour ? h.code.children(`••••${lastFour}`) : null,
          updatedAt ? h.span.class("meta").children(`Updated ${formatDate(updatedAt)}`) : null,
        );

const CredentialForm = (
  h: H,
  options: {
    readonly connector: string;
    readonly credential: Credential;
    readonly busy: boolean;
    readonly untested: boolean;
  },
) => {
  const { connector, credential, busy } = options;
  const testable = credential.testable === true;
  const fields = credential.fields ?? [];
  const names = fields.map((field) => field.name);
  const inputId = `credential-input-${connector}`;
  return h.div
    .key("credential-form")
    .class("credential-form")
    .attr("data-credential-form", connector)
    .children(
      fields.length === 0
        ? [
            h.label.key("label").class("visually-hidden").attr("for", inputId).children(credential.label),
            h.input
              .key("input")
              .attr("id", inputId)
              .attr("type", "password")
              .attr("aria-label", credential.label)
              .attr("placeholder", credential.placeholder || "Paste credential")
              .attr("autocomplete", "new-password")
              .attr("autocapitalize", "none")
              .attr("spellcheck", "false"),
          ]
        : h.div
            .key("fields")
            .class("credential-fields")
            .children(
              fields.map((field, index) => {
                const id = `${inputId}-${index}`;
                const kind = field.inputType ?? "password";
                return h.div
                  .key(field.name)
                  .class("credential-field")
                  .children(
                    h.label.attr("for", id).children(field.label),
                    field.description
                      ? h.p.class("meta").attr("id", `${id}-description`).children(field.description)
                      : null,
                    h.input
                      .attr("id", id)
                      .attr("aria-describedby", field.description ? `${id}-description` : undefined)
                      .attr("type", field.inputType || "password")
                      .attr("placeholder", field.placeholder || field.label)
                      .attr("autocomplete", kind === "password" ? "new-password" : "off")
                      .attr("autocapitalize", "none")
                      .attr("spellcheck", "false"),
                  );
              }),
            ),
      h.div
        .key("actions")
        .class("actions")
        .children(
          h.button
            .key("save")
            .class("btn", "primary")
            .attr("type", "button")
            .disabled(busy)
            .onMount(submitted(connector, names, testable ? "test" : "skip"))
            .children(busy ? (testable ? "Testing…" : "Saving…") : testable ? "Test and save" : "Save"),
          testable && options.untested
            ? h.button
                .key("untested")
                .class("btn")
                .attr("type", "button")
                .attr("data-save-untested", connector)
                .disabled(busy)
                .onMount(submitted(connector, names, "skip"))
                .children("Save without testing")
            : null,
          h.button
            .key("cancel")
            .class("btn", "quiet")
            .attr("type", "button")
            .disabled(busy)
            .on("click", ConnectorAuthMessage.ClickedEditCredential({ connector: null }))
            .children("Cancel"),
        ),
    );
};

const CredentialCard = (h: H, props: ConnectorAuthProps, credential: Credential) => {
  const { connector } = props;
  const id = connector.id;
  const name = connector.title || id;
  const configured = Boolean(credential.configured);
  const removable = configured || Boolean(credential.removable);
  const state = credentialState(credential);
  const multi = Boolean(credential.fields?.length);
  const busy = props.credentialBusy;
  return h.section
    .key("credential")
    .class("subcard", "credential-card")
    .attr("id", `credential-${id}`)
    .attr("aria-labelledby", `credential-title-${id}`)
    .attr("data-credential-state", state)
    .children(
      h.div.class("subcard-head").children(
        h.span
          .class("credential-icon", credential.error ? "danger" : state)
          .attr("aria-hidden", "true")
          .children(Icon(h, "key", 16)),
        h.div
          .class("credential-heading")
          .children(
            h.h3.attr("id", `credential-title-${id}`).children(credential.label),
            credential.description ? h.p.class("meta").children(credential.description) : null,
          ),
        StatePill(h, state),
      ),
      !multi && configured ? Masked(h, credential.lastFour, credential.updatedAt) : null,
      multi
        ? h.ul.class("credential-field-summary").children(
            credential.fields!.map((field) =>
              h.li
                .key(field.name)
                .attr("data-field-state", credentialState(field))
                .children(
                  h.span.class("credential-field-label").children(field.label),
                  field.configured ? Masked(h, field.lastFour, field.updatedAt) : null,
                  StatePill(h, credentialState(field)),
                ),
            ),
          )
        : null,
      credential.error
        ? h.div
            .class("problem-block")
            .children(
              Callout(h, "problem", credentialProblemCopy(credential.problem)).attr("data-problem", credential.problem),
              credential.problem
                ? FixPrompt(h, { kind: credential.problem, connectorId: id, name, key: "credential" })
                : null,
            )
        : null,
      credential.notice ? h.p.class("meta").children(credential.notice) : null,
      h.div.class("actions").children(
        h.button
          .key("edit")
          .class(removable ? "btn sm" : "btn sm primary")
          .attr("type", "button")
          .attr("aria-expanded", props.editing ? "true" : "false")
          .disabled(busy)
          .on("click", ConnectorAuthMessage.ClickedEditCredential({ connector: props.editing ? null : id }))
          .children(removable ? "Replace" : "Add credential"),
        configured && credential.testable
          ? h.button
              .key("test")
              .class("btn", "sm")
              .attr("type", "button")
              .disabled(busy)
              .on("click", ConnectorAuthMessage.ClickedTestCredential())
              .children(busy ? "Working…" : "Test")
          : null,
        removable
          ? h.button
              .key("remove")
              .attr("id", `remove-credential-${id}`)
              .class("btn", "sm", "danger")
              .attr("type", "button")
              .disabled(busy)
              .on("click", ConnectorAuthMessage.ClickedAskConfirm({ action: "credential_remove" }))
              .children("Remove")
          : null,
      ),
      props.confirming === "credential_remove"
        ? ConfirmBar(h, {
            id,
            question: confirmCopy("credential_remove", name).question,
            confirm: ConfirmAction(h, confirmCopy("credential_remove", name).confirm).on(
              "click",
              ConnectorAuthMessage.ClickedRemoveCredential(),
            ),
            cancel: ConnectorAuthMessage.ClickedCancelConfirm({
              focus: [`remove-credential-${id}`, `conn-toggle-${id}`],
            }),
          }).key("confirm")
        : null,
      props.editing ? CredentialForm(h, { connector: id, credential, busy, untested: props.untested }) : null,
      NoticeWithFix(h, `credentialNotice-${id}`, props.credentialNotice),
    );
};

const OAuthConfirm = (h: H, props: ConnectorAuthProps, name: string, action: "oauth_restart" | "oauth_disconnect") => {
  const id = props.connector.id;
  const copy = confirmCopy(action, name, props.connector.reconnectKeepsGrant);
  const button = ConfirmAction(h, copy.confirm);
  return ConfirmBar(h, {
    id,
    question: copy.question,
    confirm:
      action === "oauth_restart"
        ? button.onMount(prepared(id, "restart"))
        : button.on("click", ConnectorAuthMessage.ClickedDisconnect()),
    cancel: ConnectorAuthMessage.ClickedCancelConfirm({
      focus: [action === "oauth_restart" ? `reconnect-${id}` : `disconnect-${id}`, `auth-${id}`],
    }),
  }).key("confirm");
};

export const ConnectorAuthNoDeps = Html.component({
  name: "ConnectorAuth",
  props: ConnectorAuthProps,
  model: Schema.Null,
  message: ConnectorAuthMessage,
  restore: false,
}).make({
  init: () => null,
  update: {
    CompletedPrepareOAuth: ($, { mode, prepared }) =>
      $.run(write(IslandRequest.StartOAuth({ connector: $.props.connector.id, mode, prepared }))),
    ClickedAskConfirm: ($, { action }) => $.run(AskConfirm.make({ connector: $.props.connector.id, action })),
    ClickedDisconnect: ($) => $.run(write(IslandRequest.DisconnectOAuth({ connector: $.props.connector.id }))),
    ClickedCancelConfirm: ($, { focus }) => $.run(CancelConfirm.make({ focus })),
    ClickedRefresh: ($) => $.run(RefreshConnector.make({ connector: $.props.connector.id })),
    ClickedEditCredential: ($, { connector }) => $.run(EditCredential.make({ connector })),
    ClickedTestCredential: ($) => $.run(write(IslandRequest.TestCredential({ connector: $.props.connector.id }))),
    ClickedRemoveCredential: ($) => $.run(write(IslandRequest.RemoveCredential({ connector: $.props.connector.id }))),
    HeldCredentialCandidate: ($, { candidate, verify }) =>
      $.run(write(IslandRequest.SaveCredential({ connector: $.props.connector.id, candidate, verify }))),
    RefusedCredentialCandidate: ($, { copy }) =>
      $.run(RefuseCredential.make({ connector: $.props.connector.id, copy })),
  },
  view: (h) => {
    const props = h.props;
    const { connector, failure } = props;
    const id = connector.id;
    const name = connector.title || id;
    const manage = Boolean(connector.permissions?.manageSharedAuth || connector.permissions?.connectPersonal);
    const oauthConfirm = props.confirming && props.confirming !== "credential_remove" ? props.confirming : null;
    const credentialFix = connector.credential?.error ? connector.credential.problem : undefined;
    const problem =
      !failure && connector.status !== "loading" && connector.problem !== credentialFix
        ? problemCopy(connector.problem)
        : null;
    const fixKind = problem && connector.problem !== "caller_refused" ? connector.problem : undefined;
    const warn = connector.problem ? problemTone(connector.problem) === "warn" : false;
    return h.div
      .class("collection", "connector-auth")
      .attr("data-connector", id)
      .children(
        connector.status === "loading"
          ? StateBlock(h, { busy: true, copy: "Loading authentication details…" }).key("loading")
          : null,
        connector.status === "per_caller"
          ? h.p.key("perCaller").children("Authenticates as each caller; verified on use.")
          : null,
        problem && connector.problem
          ? h.div
              .key("problem")
              .class("problem-block", warn && "warn")
              .children(
                Callout(h, warn ? "notice" : "problem", problem).attr("data-problem", connector.problem),
                fixKind ? FixPrompt(h, { kind: fixKind, connectorId: id, name, key: "problem" }) : null,
              )
          : null,
        failure
          ? Callout(h, "notice", connectorLoadFailureCopy(failure, productName))
              .key("failure")
              .attr("data-load-failure", failure)
          : null,
        h.div
          .key("row")
          .class("auth-row")
          .children(
            SummaryRow(h, "auth-facts", [
              { label: "Mode", value: connector.authScope === "personal" ? "Per person" : "Shared" },
              ...(connector.registrationPath
                ? [
                    {
                      label: "OAuth client",
                      value: h.span
                        .attr("data-oauth-client", "true")
                        .children(registrationPathLabel(connector.registrationPath)),
                    },
                  ]
                : []),
              ...(connector.account
                ? [
                    {
                      label: "Account",
                      value: h.span.attr("data-connected-account", "true").children(connector.account),
                    },
                  ]
                : []),
              ...(connector.verification
                ? [
                    {
                      label: "Last verified",
                      value: h.span
                        .attr("data-verification", connector.verification.outcome)
                        .children(verificationLabel(connector.verification)),
                    },
                  ]
                : []),
              { label: "Managed by", value: h.span.attr("data-managed-by", "true").children(managedBy(connector)) },
            ]),
            h.div.class("actions").children(
              failure ? null : AuthActions(h, props, name, manage),
              h.button
                .key("refresh")
                .class(failure ? "btn primary" : "btn quiet")
                .attr("type", "button")
                .attr("aria-label", `Refresh ${name}`)
                .disabled(connector.status === "loading")
                .on("click", ConnectorAuthMessage.ClickedRefresh())
                .children(Icon(h, "refresh", 14), "Refresh"),
            ),
          ),
        oauthConfirm ? OAuthConfirm(h, props, name, oauthConfirm) : null,
        NoticeWithFix(h, `oauthNotice-${id}`, props.oauthNotice),
        connector.credential ? CredentialCard(h, props, connector.credential) : null,
      );
  },
});

export const ConnectorAuth = ConnectorAuthNoDeps.pipe(
  Component.provide([
    RequestPageWrite.layer,
    AskConfirm.layer,
    CancelConfirm.layer,
    EditCredential.layer,
    RefreshConnector.layer,
    RefuseCredential.layer,
  ]),
);

const ageLabel = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
};

const Metric = <M>(h: Html.H<M>, label: string, value: string, sub?: View.Input<M>) =>
  h.div
    .key(label)
    .class("metric")
    .children(
      h.dt.class("metric-label").children(label),
      h.dd.children(
        h.span.class("metric-value").children(value),
        sub ? h.span.class("metric-sub").children(sub) : null,
      ),
    );

export const ConnectorDiagnostics = <M>(h: Html.H<M>, live: OperatorConnectorOverlay, connector: UiConnector | null) =>
  h.div.class("collection", "connector-diagnostics").children(
    h.dl
      .class("metric-grid")
      .children(
        Metric(h, "Catalog age", live.catalogAgeMs === null ? "—" : ageLabel(live.catalogAgeMs)),
        Metric(
          h,
          "Last call",
          live.lastCall ? sinceLabel(live.lastCall.at) : "—",
          live.lastCall
            ? [h.span.class("dot", live.lastCall.outcome).attr("aria-hidden", "true"), live.lastCall.outcome]
            : undefined,
        ),
        connector?.catalogAccess
          ? Metric(h, "Catalog cache", connector.catalogAccess.state, [formatDate(connector.catalogAccess.observedAt)])
          : null,
      ),
    connector?.resourceTemplateRefusals?.length
      ? h.div.class("refusals").children(
          h.span.class("meta").children("Resource refusals"),
          connector.resourceTemplateRefusals.map((code) => Badge(h, code, "warn").key(code)),
        )
      : null,
  );
