import { Command, Component, Router } from "@effect/ui";
import { Effect, Schema } from "effect";
import { starterIn } from "../run.js";
import { OperatorController, type OperatorControllerShape } from "../services/controller.js";
import { IslandRequests } from "../shell/island.js";
import { IslandRequest } from "../shell/island-request.js";

const ConfirmAction = Schema.Literals(["oauth_disconnect", "oauth_restart", "credential_remove"]);

const run = <A extends object>(body: (controller: OperatorControllerShape, args: A) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const controller = yield* OperatorController;
    const start = starterIn(yield* Effect.context<never>());
    return (args: A) =>
      Effect.sync(() => {
        start(body(controller, args));
        return Component.noop;
      });
  });

export class RequestPageWrite extends Command.Service<RequestPageWrite>()("operator/RequestPageWrite", {
  args: { request: IslandRequest },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    IslandRequests.useSync(
      (islands) =>
        ({ request }) =>
          Effect.sync(() => {
            islands.offer(request);
            return Component.noop;
          }),
    ),
  );
}

export class RetryOperatorLoad extends Command.Service<RetryOperatorLoad>()("operator/RetryOperatorLoad", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(run((controller) => controller.retryLoad));
}

export class LoadOperatorContract extends Command.Service<LoadOperatorContract>()("operator/LoadOperatorContract", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(run((controller) => controller.loadOperatorContract));
}

export class RefreshConnector extends Command.Service<RefreshConnector>()("operator/RefreshConnector", {
  args: { connector: Schema.String },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(run((controller, { connector }) => controller.refreshConnector(connector)));
}

export class AskConfirm extends Command.Service<AskConfirm>()("operator/AskConfirm", {
  args: { connector: Schema.String, action: ConfirmAction },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    run((controller, { connector, action }) => controller.askConfirm(connector, action)),
  );
}

const firstEnabled = (ids: ReadonlyArray<string>): string => {
  for (const id of ids) {
    const element = document.getElementById(id) as HTMLButtonElement | null;
    if (element && !element.disabled) return id;
  }
  return ids[ids.length - 1] ?? "";
};

export class CancelConfirm extends Command.Service<CancelConfirm>()("operator/CancelConfirm", {
  args: { focus: Schema.Array(Schema.String) },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(run((controller, { focus }) => controller.cancelConfirm(firstEnabled(focus))));
}

export class EditCredential extends Command.Service<EditCredential>()("operator/EditCredential", {
  args: { connector: Schema.NullOr(Schema.String) },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(run((controller, { connector }) => controller.editCredential(connector)));
}

export class RefuseCredential extends Command.Service<RefuseCredential>()("operator/RefuseCredential", {
  args: { connector: Schema.String, copy: Schema.String },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    run((controller, { connector, copy }) => controller.refuseCredential(connector, copy)),
  );
}

export class ShowConnectorTab extends Command.Service<ShowConnectorTab>()("operator/ShowConnectorTab", {
  args: { tab: Schema.String },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    Router.Router.useSync(
      (router) =>
        ({ tab }) =>
          Effect.as(router.navigate(`${router.location().url}#${tab}`), Component.noop),
    ),
  );
}

export class ShowConnectorView extends Command.Service<ShowConnectorView>()("operator/ShowConnectorView", {
  args: { view: Schema.Literals(["list", "matrix"]) },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    Router.Router.useSync((router) => ({ view }) => {
      const { url, hash } = router.location();
      const at = url.indexOf("?");
      const path = at < 0 ? url : url.slice(0, at);
      const params = new URLSearchParams(at < 0 ? "" : url.slice(at));
      if (view === "matrix") params.set("view", "matrix");
      else params.delete("view");
      const query = params.toString();
      return Effect.as(router.navigate(`${path}${query ? `?${query}` : ""}${hash}`, { replace: true }), Component.noop);
    }),
  );
}
