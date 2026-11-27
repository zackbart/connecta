import { Command, Component, Mount, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Effect, Queue, Schema, Stream } from "effect";
import { agentRows, lastSeenLabel, slotBadge, slotSince, type AgentRow } from "../../agents.js";
import type { OperatorUiContractV2 } from "../../contract.js";
import {
  accessTokenUnavailableCopy,
  contractRecovering,
  formatDate,
  type Notice,
  type OperatorState,
} from "../../view.js";
import {
  CopyButtonMessage,
  CopyButtonView,
  CopyLabels,
  CopyStatus,
  copyToClipboard,
  WaitBeforeReset,
} from "../components/copy-button.js";
import { Dialog } from "../components/dialog.js";
import { opaque } from "../components/projection.js";
import { AgentMark } from "../components/marks.js";
import {
  ConfirmAction,
  ConfirmBar,
  focusableId,
  NoticeLine,
  Pill,
  pillStatus,
  StateBlock,
  Unavailable,
} from "../components/parts.js";
import { runNow } from "../run.js";
import { OperatorController, type IssuedTokenHandle } from "../services/controller.js";

const outlivingThePage = (effect: Effect.Effect<void>) => Effect.as(Effect.forkDetach(effect), Component.noop);

const afterCommit = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const IssuedHandle = Schema.String.pipe(Schema.brand("IssuedTokenHandle"));

const SlotAsk = Schema.Literals(["rotate", "revoke"]);

const IssuedToken = Schema.Struct({ handle: IssuedHandle, name: Schema.NullOr(Schema.String) });

export const TokensData = Schema.Struct({
  available: Schema.Boolean,
  recovering: Schema.Boolean,
  unavailable: Schema.String,
  rows: opaque<ReadonlyArray<AgentRow>>("AgentRows"),
  phase: Schema.Literals(["idle", "loading", "ready", "error"]),
  busy: Schema.Boolean,
  notice: Schema.NullOr(opaque<Notice>("Notice")),
  confirm: Schema.NullOr(Schema.Struct({ name: Schema.String, action: SlotAsk })),
  issued: Schema.NullOr(IssuedToken),
});
export type TokensData = typeof TokensData.Type;

export const tokensProjection = () => {
  let last: {
    contract: OperatorUiContractV2 | OperatorState["contract"];
    tokens: OperatorState["tokens"];
    unresolved: OperatorState["unresolvedSlots"];
    rows: ReadonlyArray<AgentRow>;
  } | null = null;
  return (state: OperatorState, handle: IssuedTokenHandle | null): TokensData => {
    if (
      last?.contract !== state.contract ||
      last.tokens !== state.tokens ||
      last.unresolved !== state.unresolvedSlots
    ) {
      last = {
        contract: state.contract,
        tokens: state.tokens,
        unresolved: state.unresolvedSlots,
        rows: agentRows(state.contract, state.tokens, state.unresolvedSlots),
      };
    }
    return {
      available: state.data?.accessTokenManagement === "available",
      recovering: contractRecovering(state),
      unavailable: accessTokenUnavailableCopy(state.data?.accessTokenManagement),
      rows: last.rows,
      phase: state.tokenPhase,
      busy: state.tokenBusy,
      notice: state.tokenNotice,
      confirm: state.tokenConfirm,
      issued: handle ? { handle, name: state.createdTokenFor } : null,
    };
  };
};

export class LoadAccessTokens extends Command.Service<LoadAccessTokens>()("operator/LoadAccessTokens", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync((controller) => () => outlivingThePage(controller.loadAccessTokens)),
  );
}

export class IssueAgentToken extends Command.Service<IssueAgentToken>()("operator/IssueAgentToken", {
  args: { name: Schema.String },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync(
      (controller) =>
        ({ name }) =>
          outlivingThePage(controller.rotateAgentToken(name)),
    ),
  );
}

export class ConfirmTokenAction extends Command.Service<ConfirmTokenAction>()("operator/ConfirmTokenAction", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync((controller) => () => outlivingThePage(controller.confirmTokenAction)),
  );
}

export class CancelTokenAction extends Command.Service<CancelTokenAction>()("operator/CancelTokenAction", {
  args: { name: Schema.String, action: SlotAsk },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync(
      (controller) =>
        ({ name, action }) =>
          Effect.as(
            Effect.suspend(() => controller.cancelTokenAction(cancelQuestion(name, action))),
            Component.noop,
          ),
    ),
  );
}

export class DismissIssuedToken extends Command.Service<DismissIssuedToken>()("operator/DismissIssuedToken", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync((controller) => () => Effect.as(controller.dismissCreatedToken, Component.noop)),
  );
}

export class FocusAfterIssuedToken extends Command.Service<FocusAfterIssuedToken>()("operator/FocusAfterIssuedToken", {
  args: { name: Schema.NullOr(Schema.String) },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(({ name }) =>
    Effect.as(
      Effect.andThen(
        afterCommit,
        Effect.sync(() => {
          const target =
            document.getElementById("recoveryRetry") ??
            (name ? document.getElementById(`token-primary-${name}`) : null) ??
            document.getElementById("tokensHeading");
          target?.focus();
        }),
      ),
      Component.noop,
    ),
  );
}

export class CopyIssuedToken extends Command.Service<CopyIssuedToken>()("operator/CopyIssuedToken", {
  args: { handle: IssuedHandle },
  success: CopyButtonMessage,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync((controller) => ({ handle }) => {
      const secret = controller.issuedToken(handle);
      return secret ? copyToClipboard(secret) : Effect.succeed(CopyButtonMessage.FailedCopyText());
    }),
  );
}

export const ShowIssuedToken = Mount.makeStream(
  "ShowIssuedToken",
  { args: { handle: IssuedHandle } },
  (code: HTMLElement, _args, changes) =>
    Stream.callback<never, never, OperatorController>(() =>
      Effect.gen(function* () {
        const controller = yield* OperatorController;
        yield* Stream.runForEach(changes, ({ handle }) =>
          Effect.sync(() => {
            code.textContent = controller.issuedToken(handle) ?? "";
          }),
        ).pipe(Effect.forkScoped);
        yield* Effect.addFinalizer(() => Effect.sync(() => (code.textContent = "")));
      }),
    ),
);

const cancelQuestion = (name: string, action: "rotate" | "revoke") =>
  focusableId(action === "rotate" ? `token-primary-${name}` : `token-revoke-${name}`, "tokensHeading");

export const AskTokenQuestion = Mount.makeStream(
  "AskTokenQuestion",
  { args: { name: Schema.String, action: Schema.Literals(["issue", "rotate", "revoke"]) } },
  (button: HTMLButtonElement, initial, changes) =>
    Stream.callback<string, never, OperatorController>((queue) =>
      Effect.gen(function* () {
        const controller = yield* OperatorController;
        let { name, action } = initial;
        yield* Stream.runForEach(changes, (args) => Effect.sync(() => ({ name, action } = args))).pipe(
          Effect.forkScoped,
        );
        const onClick = () => {
          if (action === "revoke") runNow(controller.revokeAgentToken(name));
          else if (controller.prepareRotation(name) === "issue") Queue.offerUnsafe(queue, name);
        };
        const onKey = (event: KeyboardEvent) => {
          const asked = controller.state().tokenConfirm;
          if (event.key !== "Escape" || asked?.name !== name) return;
          event.preventDefault();
          runNow(controller.cancelTokenAction(cancelQuestion(name, asked.action)));
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            button.addEventListener("click", onClick);
            button.addEventListener("keydown", onKey);
          }),
          () =>
            Effect.sync(() => {
              button.removeEventListener("click", onClick);
              button.removeEventListener("keydown", onKey);
            }),
        );
      }),
    ),
);

const IssuedTokenCopyNoDeps = Html.component({
  name: "IssuedTokenCopy",
  props: Schema.Struct({ handle: IssuedHandle, ...CopyLabels }),
  model: CopyStatus,
  message: CopyButtonMessage,
  restore: false,
}).make({
  init: () => ({ status: "idle" as const }),
  update: {
    ClickedCopy: ($) => $.run(CopyIssuedToken.make({ handle: $.props.handle })),
    SucceededCopyText: ($) => $.evolve({ status: "copied" }).run(WaitBeforeReset.make()),
    FailedCopyText: ($) => $.evolve({ status: "failed" }).run(WaitBeforeReset.make()),
    CompletedWaitBeforeReset: ($) => $.evolve({ status: "idle" }),
  },
  view: (h, model) => CopyButtonView(h, h.props, model),
});

export const IssuedTokenCopy = IssuedTokenCopyNoDeps.pipe(
  Component.provide([CopyIssuedToken.layer, WaitBeforeReset.layer]),
);

const IssuedTokenDialogMessage = UiSchema.TaggedEnum({ RequestedCloseIssuedToken: {}, ClosedIssuedToken: {} });

export const IssuedTokenDialogNoDeps = Html.component({
  name: "IssuedTokenDialog",
  props: Schema.Struct({ issued: Schema.NullOr(IssuedToken) }),
  model: Schema.Struct({ closing: Schema.Boolean, returnTo: Schema.NullOr(Schema.String) }),
  message: IssuedTokenDialogMessage,
  restore: false,
}).make({
  init: () => ({ closing: false, returnTo: null }),
  update: {
    RequestedCloseIssuedToken: ($) =>
      $.props.issued
        ? $.evolve({ closing: true, returnTo: $.props.issued.name }).run(DismissIssuedToken.make())
        : $.model,
    ClosedIssuedToken: ($) =>
      $.model.closing
        ? $.evolve({ closing: false, returnTo: null }).run(FocusAfterIssuedToken.make({ name: $.model.returnTo }))
        : $.model,
  },
  view: (h) => {
    const { issued } = h.props;
    const close = IssuedTokenDialogMessage.RequestedCloseIssuedToken();
    return Dialog(h, {
      key: "issuedToken",
      open: issued !== null,
      title: issued?.name ? `New token for ${issued.name}` : "New token",
      description: "You won't see this token again.",
      returnFocus: false,
      onClose: close,
      onClosed: IssuedTokenDialogMessage.ClosedIssuedToken(),
      children: [
        issued
          ? h.div.class("token-secret-panel").children(
              h.code
                .attr("id", "createdToken")
                .class("token-secret")
                .onMount(ShowIssuedToken({ handle: issued.handle })),
              h.div.class("actions").children(
                IssuedTokenCopy(h, {
                  props: { handle: issued.handle, label: "Copy token", className: "btn primary" },
                }),
                h.button.class("btn", "default").attr("type", "button").on("click", close).children("I stored it"),
              ),
            )
          : null,
      ],
    });
  },
});

export const IssuedTokenDialog = IssuedTokenDialogNoDeps.pipe(
  Component.provide([DismissIssuedToken.layer, FocusAfterIssuedToken.layer]),
);

const TokensPageMessage = UiSchema.TaggedEnum({
  ClickedRefresh: {},
  PressedIssueToken: { name: Schema.String },
  ClickedConfirm: {},
  ClickedCancel: { name: Schema.String, action: SlotAsk },
});

type H = Html.H<typeof TokensPageMessage.Type>;

const credentialLabel = (kind: AgentRow["credentialTypes"][number]) =>
  kind === "vercel_oidc" ? "Vercel OIDC" : "Agent token";

const ActionButton = (h: H, row: AgentRow, action: AgentRow["actions"][number], busy: boolean) => {
  const blocked = Boolean(row.blocked);
  const button = h.button
    .key(action)
    .attr("type", "button")
    .disabled(busy || blocked)
    .attr("aria-describedby", blocked ? `token-unavailable-${row.name}` : undefined)
    .onMount(
      AskTokenQuestion({ name: row.name, action }).pipe(
        Mount.map((name) => TokensPageMessage.PressedIssueToken({ name })),
      ),
    );
  if (action === "revoke") {
    return button
      .attr("id", `token-revoke-${row.name}`)
      .class("btn", "quiet", "sm", "token-revoke")
      .attr("aria-label", `Revoke ${row.name}'s token`)
      .children("Revoke");
  }
  const issue = action === "issue";
  return button
    .attr("id", `token-primary-${row.name}`)
    .class("btn", issue ? "primary" : "default", "sm")
    .attr("aria-label", `${issue ? "Issue" : "Rotate"} ${row.name}'s token`)
    .children(issue ? "Issue" : "Rotate");
};

const SlotRow = (h: H, row: AgentRow, busy: boolean) => {
  const badge = slotBadge(row.slot);
  return h.tr
    .key(row.name)
    .attr("data-agent", row.name)
    .class(row.slot?.state === "revoked" && "revoked")
    .children(
      h.th
        .attr("scope", "row")
        .children(
          h.span
            .class("agent-name")
            .children(
              AgentMark(h),
              h.span.attr("title", row.credentialTypes.map(credentialLabel).join(" · ")).children(row.name),
              row.credentialTypes.includes("vercel_oidc")
                ? h.span.class("meta").children(row.credentialTypes.length > 1 ? "OIDC · Token" : "OIDC")
                : null,
            ),
        ),
      h.td.children(
        row.pools.length
          ? h.ul
              .class("agent-pools")
              .attr("aria-label", `${row.name}'s pools`)
              .children(row.pools.map((pool) => h.li.key(pool).class("pool-chip").children(pool)))
          : h.span.class("meta").children("None"),
      ),
      h.td.children(Pill(h, pillStatus(badge.tone), badge.label)),
      h.td.class("token-date").children(slotSince(row.slot, formatDate)),
      h.td.class("token-date").children(lastSeenLabel(row.lastSeenAt, formatDate)),
      h.td.children(
        h.div.class("token-actions").children(
          row.blocked
            ? h.span
                .class("meta", "token-unavailable")
                .attr("id", `token-unavailable-${row.name}`)
                .children(row.blocked)
            : null,
          row.actions.map((action) => ActionButton(h, row, action, busy)),
        ),
      ),
    );
};

const SlotConfirm = (h: H, name: string, action: "rotate" | "revoke") =>
  h.tr
    .key(`${name}:confirm`)
    .class("token-confirm-row")
    .children(
      h.td.attr("colspan", "6").children(
        ConfirmBar(h, {
          id: `token-${name}`,
          question:
            action === "rotate"
              ? `Rotate ${name}'s token? The current one stops working now.`
              : `Revoke ${name}'s token? It loses access now.`,
          confirm: ConfirmAction(h, action === "rotate" ? "Rotate" : "Revoke").on(
            "click",
            TokensPageMessage.ClickedConfirm(),
          ),
          cancel: TokensPageMessage.ClickedCancel({ name, action }),
        }),
      ),
    );

const TokenList = (h: H, data: TokensData) => {
  const refresh = TokensPageMessage.ClickedRefresh();
  return h.div
    .attr("id", "tokenList")
    .attr("aria-busy", data.phase === "loading" ? "true" : "false")
    .children(
      data.phase === "loading"
        ? StateBlock(h, { busy: true, copy: "Loading tokens…" })
        : data.phase === "error"
          ? StateBlock(h, {
              tone: "error",
              copy: "Couldn't load tokens.",
              ...(data.recovering ? {} : { action: { label: "Retry", message: refresh } }),
            })
          : data.rows.length === 0
            ? StateBlock(h, { copy: "No agents" })
            : h.div.class("table-scroll").children(
                h.table
                  .class("data-table", "token-table")
                  .attr("aria-label", "Agent tokens")
                  .children(
                    h.thead.children(
                      h.tr.children(
                        h.th.attr("scope", "col").children("Agent"),
                        h.th.attr("scope", "col").children("Pools"),
                        h.th.attr("scope", "col").children("Token"),
                        h.th.attr("scope", "col").children("Since"),
                        h.th.attr("scope", "col").children("Last seen"),
                        h.th.attr("scope", "col").children(h.span.class("visually-hidden").children("Actions")),
                      ),
                    ),
                    h.tbody.children(
                      data.rows.flatMap((row) => [
                        SlotRow(h, row, data.busy),
                        data.confirm?.name === row.name ? SlotConfirm(h, row.name, data.confirm.action) : null,
                      ]),
                    ),
                  ),
              ),
    );
};

export const TokensPageNoDeps = Html.component({
  name: "TokensPage",
  props: Schema.Struct({ data: TokensData }),
  model: Schema.Null,
  message: TokensPageMessage,
  restore: false,
}).make({
  init: () => null,
  update: {
    ClickedRefresh: ($) => $.run(LoadAccessTokens.make()),
    PressedIssueToken: ($, { name }) => $.run(IssueAgentToken.make({ name })),
    ClickedConfirm: ($) => $.run(ConfirmTokenAction.make()),
    ClickedCancel: ($, { name, action }) => $.run(CancelTokenAction.make({ name, action })),
  },
  view: (h) => {
    const { data } = h.props;
    return h.section.attr("id", "tokensView").children(
      h.div.class("page-heading").children(
        h.div.children(
          h.h1.attr("id", "tokensHeading").attr("tabindex", "-1").children("Tokens"),
          h.p.class("meta").children("Declared in code"),
        ),
        data.available && !data.recovering
          ? h.div.class("page-actions").children(
              h.button
                .attr("id", "refreshTokens")
                .class("btn", "default")
                .attr("type", "button")
                .disabled(data.busy || data.phase === "loading")
                .on("click", TokensPageMessage.ClickedRefresh())
                .children("Refresh"),
            )
          : null,
      ),
      NoticeLine(h, "tokenNotice", data.notice, "meta"),
      !data.available && data.rows.length === 0 ? Unavailable(h).children(data.unavailable) : TokenList(h, data),
    );
  },
});

export const TokensPage = TokensPageNoDeps.pipe(
  Component.provide([LoadAccessTokens.layer, IssueAgentToken.layer, ConfirmTokenAction.layer, CancelTokenAction.layer]),
);
