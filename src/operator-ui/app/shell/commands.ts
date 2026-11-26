import { Command, Component, Router } from "@effect/ui";
import { Effect, Predicate, Schema } from "effect";
import { canonicalOperatorPath, type OperatorPage } from "../../view.js";
import { OperatorController, type PreparedOAuth } from "../services/controller.js";
import { LEGACY_CONNECTOR_TABS } from "./routes.js";

const afterCommit = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const OAuthMode = Schema.Literals(["continue", "restart"]);

export const Prepared = Schema.declare<PreparedOAuth>(
  (input): input is PreparedOAuth => Predicate.isObject(input) && Predicate.isBoolean(input.refused),
);

export const CandidateHandle = Schema.String.pipe(Schema.brand("CandidateHandle"));

export class StartOAuth extends Command.Service<StartOAuth>()("operator/StartOAuth", {
  args: { connector: Schema.String, mode: OAuthMode, prepared: Prepared },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync(
      (controller) =>
        ({ connector, mode, prepared }) =>
          Effect.as(controller.startOAuth(connector, mode, prepared), Component.noop),
    ),
  );
}

export class DisconnectOAuth extends Command.Service<DisconnectOAuth>()("operator/DisconnectOAuth", {
  args: { connector: Schema.String },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync(
      (controller) =>
        ({ connector }) =>
          Effect.as(controller.disconnectOAuth(connector), Component.noop),
    ),
  );
}

export class SaveCredential extends Command.Service<SaveCredential>()("operator/SaveCredential", {
  args: { connector: Schema.String, candidate: CandidateHandle, verify: Schema.Literals(["test", "skip"]) },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync(
      (controller) =>
        ({ connector, candidate, verify }) =>
          Effect.as(controller.saveHeldCredential(connector, candidate, verify), Component.noop),
    ),
  );
}

export class RemoveCredential extends Command.Service<RemoveCredential>()("operator/RemoveCredential", {
  args: { connector: Schema.String },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync(
      (controller) =>
        ({ connector }) =>
          Effect.as(controller.removeCredential(connector), Component.noop),
    ),
  );
}

export class TestCredential extends Command.Service<TestCredential>()("operator/TestCredential", {
  args: { connector: Schema.String },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync(
      (controller) =>
        ({ connector }) =>
          Effect.as(controller.testCredential(connector), Component.noop),
    ),
  );
}

export class RotateAgentToken extends Command.Service<RotateAgentToken>()("operator/RotateAgentToken", {
  args: { name: Schema.String },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync(
      (controller) =>
        ({ name }) =>
          Effect.as(controller.rotateAgentToken(name), Component.noop),
    ),
  );
}

export class ConfirmTokenAction extends Command.Service<ConfirmTokenAction>()("operator/ConfirmTokenAction", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync((controller) => () => Effect.as(controller.confirmTokenAction, Component.noop)),
  );
}

export class BootOperator extends Command.Service<BootOperator>()("operator/BootOperator", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync((controller) => () => Effect.as(controller.boot, Component.noop)),
  );
}

export class SignIn extends Command.Service<SignIn>()("operator/SignIn", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync((controller) => () => Effect.as(controller.signIn, Component.noop)),
  );
}

export class SignOut extends Command.Service<SignOut>()("operator/SignOut", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync((controller) => () => Effect.as(controller.signOut, Component.noop)),
  );
}

export class ForgetBearer extends Command.Service<ForgetBearer>()("operator/ForgetBearer", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync((controller) => () => Effect.as(controller.forgetBearer, Component.noop)),
  );
}

export class RetryLoad extends Command.Service<RetryLoad>()("operator/RetryLoad", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync((controller) => () => Effect.as(controller.retryLoad, Component.noop)),
  );
}

export class RecheckOnReturn extends Command.Service<RecheckOnReturn>()("operator/RecheckOnReturn", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync((controller) => () => Effect.as(controller.returnedToTab, Component.noop)),
  );
}

export class ReportRoute extends Command.Service<ReportRoute>()("operator/ReportRoute", {
  args: { path: Schema.String },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync(
      (controller) =>
        ({ path }) =>
          Effect.as(controller.routeChanged(path), Component.noop),
    ),
  );
}

export class CloseForRecovery extends Command.Service<CloseForRecovery>()("operator/CloseForRecovery", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync((controller) => () => Effect.as(controller.closeForRecovery, Component.noop)),
  );
}

export class LoadPageCollections extends Command.Service<LoadPageCollections>()("operator/LoadPageCollections", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync((controller) => () => Effect.as(controller.loadPageCollections, Component.noop)),
  );
}

export const commandLayers = [
  StartOAuth.layer,
  DisconnectOAuth.layer,
  SaveCredential.layer,
  RemoveCredential.layer,
  TestCredential.layer,
  RotateAgentToken.layer,
  ConfirmTokenAction.layer,
  BootOperator.layer,
  SignIn.layer,
  SignOut.layer,
  ForgetBearer.layer,
  RetryLoad.layer,
  RecheckOnReturn.layer,
  ReportRoute.layer,
  CloseForRecovery.layer,
  LoadPageCollections.layer,
] as const;

export class NavigateToPage extends Command.Service<NavigateToPage>()("operator/NavigateToPage", {
  args: { page: Schema.String, href: Schema.String },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const controller = yield* OperatorController;
      const router = yield* Router.Router;
      return ({ page, href }) =>
        Effect.gen(function* () {
          yield* controller.navigated(page as OperatorPage, new URL(href, window.location.href).pathname);
          yield* router.navigate(href);
          return Component.noop;
        });
    }),
  );
}

export class CanonicalizeLocation extends Command.Service<CanonicalizeLocation>()("operator/CanonicalizeLocation", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    Router.Router.useSync((router) => () => {
      const { url, hash } = router.location();
      const at = url.indexOf("?");
      const path = at < 0 ? url : url.slice(0, at);
      const query = at < 0 ? "" : url.slice(at);
      const canonical = canonicalOperatorPath(path);
      const fragment = hash.replace(/^#/, "");
      const nextHash =
        canonical.startsWith("/connectors/") && LEGACY_CONNECTOR_TABS.includes(fragment) ? "#connection" : hash;
      return canonical === path && nextHash === hash
        ? Effect.succeed(Component.noop)
        : Effect.as(router.navigate(`${canonical}${query}${nextHash}`, { replace: true }), Component.noop);
    }),
  );
}

export class FocusPendingTarget extends Command.Service<FocusPendingTarget>()("operator/FocusPendingTarget", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    OperatorController.useSync(
      (controller) => () =>
        Effect.gen(function* () {
          yield* afterCommit;
          const state = controller.state();
          if (!state.pendingFocus && !state.focusIfLost) return Component.noop;
          if (state.pendingFocus) {
            const target = document.getElementById(state.pendingFocus);
            if (target?.closest("[inert]")) return Component.noop;
            target?.focus();
          } else if (state.focusIfLost) {
            const active = document.activeElement;
            const lost =
              !active ||
              active === document.body ||
              !active.isConnected ||
              (active as HTMLButtonElement).disabled === true;
            if (lost) document.getElementById(state.focusIfLost)?.focus();
          }
          yield* controller.focusHandled;
          return Component.noop;
        }),
    ),
  );
}

export class FocusRecoveryRetry extends Command.Service<FocusRecoveryRetry>()("operator/FocusRecoveryRetry", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(() =>
    Effect.as(
      Effect.andThen(
        afterCommit,
        Effect.sync(() => document.getElementById("recoveryRetry")?.focus()),
      ),
      Component.noop,
    ),
  );
}

export const shellCommandLayers = [
  NavigateToPage.layer,
  CanonicalizeLocation.layer,
  FocusPendingTarget.layer,
  FocusRecoveryRetry.layer,
] as const;
