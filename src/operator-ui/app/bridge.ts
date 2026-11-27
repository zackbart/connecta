import { useSyncExternalStore } from "react";
import type { Effect } from "effect";
import type { OperatorPage, OperatorState, PendingConfirm } from "../view.js";
import type { CredentialBody, OAuthStartMode, OperatorControllerShape } from "./services/controller.js";
import type { IslandRequest } from "./shell/island-request.js";

export interface IslandHost {
  readonly controller: OperatorControllerShape;
  readonly run: (effect: Effect.Effect<void>) => void;
  readonly request: (request: IslandRequest) => void;
  readonly navigate: (href: string, replace: boolean) => void;
}

let host: IslandHost | null = null;

export function installIslandHost(next: IslandHost): void {
  host = next;
}

function current(): IslandHost {
  if (!host) throw new Error("The operator shell has not mounted its islands.");
  return host;
}

const subscribeState = (listener: () => void) => current().controller.subscribe(listener);
const stateSnapshot = () => current().controller.state();

export function useOperatorState(): OperatorState {
  return useSyncExternalStore(subscribeState, stateSnapshot);
}

const run = (select: (controller: OperatorControllerShape) => Effect.Effect<void>) => {
  const active = current();
  active.run(select(active.controller));
};

export function navigate(page: OperatorPage, href: string): void {
  const active = current();
  active.run(active.controller.navigated(page, new URL(href, window.location.href).pathname));
  active.navigate(href, false);
}

export const retryLoad = () => run((c) => c.retryLoad);
export const askConfirm = (id: string, action: PendingConfirm["action"]) => run((c) => c.askConfirm(id, action));
export const cancelConfirm = (returnFocusTo: string) => run((c) => c.cancelConfirm(returnFocusTo));
export const editCredential = (id: string | null) => run((c) => c.editCredential(id));
export const refuseCredential = (id: string, copy: string) => run((c) => c.refuseCredential(id, copy));
export const focusHandled = () => run((c) => c.focusHandled);

export function startOAuth(connector: string, mode: OAuthStartMode): void {
  const active = current();
  const prepared = active.controller.prepareOAuth(connector, mode);
  active.request({ _tag: "StartOAuth", connector, mode, prepared });
}

export const disconnectOAuth = (connector: string) => current().request({ _tag: "DisconnectOAuth", connector });
export function saveCredential(connector: string, body: CredentialBody, verify: "test" | "skip" = "skip"): void {
  const active = current();
  active.request({
    _tag: "SaveCredential",
    connector,
    candidate: active.controller.holdCredentialCandidate(body),
    verify,
  });
}
export const removeCredential = (connector: string) => current().request({ _tag: "RemoveCredential", connector });
export const testCredential = (connector: string) => current().request({ _tag: "TestCredential", connector });

export function accountLabel(): string | null {
  return current().controller.accountLabel();
}

export function sessionPresumed(): boolean {
  return current().controller.sessionPresumed();
}

export function navHint(): { activity: boolean } {
  return current().controller.navHint();
}
