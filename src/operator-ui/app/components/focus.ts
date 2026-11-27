import { Component, Mount } from "@effect/ui";
import { Effect } from "effect";
import { OperatorController } from "../services/controller.js";

export const TakeRequestedFocus = Mount.make("TakeRequestedFocus", { args: {} }, (node: HTMLElement) =>
  Effect.gen(function* () {
    const controller = yield* OperatorController;
    if (controller.state().pendingFocus !== node.id || node.closest("[inert]")) return Component.noop;
    node.focus();
    yield* controller.focusHandled;
    return Component.noop;
  }),
);
