import { useSyncExternalStore } from "react";
import type { Effect } from "effect";
import type { SteadyHealth } from "../health.js";
import type { OperatorPage, OperatorState, PendingConfirm } from "../view.js";
import type { CredentialBody, OAuthStartMode, OperatorControllerShape } from "./services/controller.js";
import type { IslandRequest } from "./shell/island-request.js";

export interface IslandHost {
  readonly controller: OperatorControllerShape;
  readonly steadyHealth: (state: OperatorState) => SteadyHealth;
  readonly run: (effect: Effect.Effect<void>) => void;
  readonly request: (request: IslandRequest) => void;
  readonly navigate: (href: string, replace: boolean) => void;
  readonly location: () => { readonly url: string; readonly hash: string };
}

let host: IslandHost | null = null;
const locationListeners = new Set<() => void>();
let locationSnapshot: IslandLocation | null = null;

export function installIslandHost(next: IslandHost): void {
  host = next;
  locationChanged();
}

export function locationChanged(): void {
  locationSnapshot = null;
  for (const listener of locationListeners) listener();
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

export interface IslandLocation {
  readonly pathname: string;
  readonly searchStr: string;
  readonly search: Readonly<Record<string, string>>;
  readonly hash: string;
}

function readLocation(): IslandLocation {
  if (locationSnapshot) return locationSnapshot;
  const { url, hash } = current().location();
  const at = url.indexOf("?");
  const pathname = at < 0 ? url : url.slice(0, at);
  const search = at < 0 ? "" : url.slice(at);
  locationSnapshot = {
    pathname,
    searchStr: search,
    search: Object.fromEntries(new URLSearchParams(search)),
    hash: hash.replace(/^#/, ""),
  };
  return locationSnapshot;
}

function subscribeLocation(listener: () => void): () => void {
  locationListeners.add(listener);
  return () => locationListeners.delete(listener);
}

export function useLocation(): IslandLocation {
  return useSyncExternalStore(subscribeLocation, readLocation);
}

export interface NavigateOptions {
  readonly to: string;
  readonly search?: Readonly<Record<string, unknown>>;
  readonly hash?: string;
  readonly replace?: boolean;
}

export function useNavigate(): (options: NavigateOptions) => void {
  return ({ to, search, hash, replace }) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(search ?? {})) {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    }
    const query = params.toString();
    current().navigate(`${to}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`, replace === true);
    locationChanged();
  };
}

const run = (select: (controller: OperatorControllerShape) => Effect.Effect<void>) => {
  const active = current();
  active.run(select(active.controller));
};

export function navigate(page: OperatorPage, href: string): void {
  const active = current();
  active.run(active.controller.navigated(page, new URL(href, window.location.href).pathname));
  active.navigate(href, false);
  locationChanged();
}

export const retryLoad = () => run((c) => c.retryLoad);
export const retryCollection = () => run((c) => c.retryCollection);
export const loadOperatorContract = () => run((c) => c.loadOperatorContract);
export const loadActivity = (reset: boolean) => run((c) => c.loadActivity(reset));
export const loadAccessTokens = () => run((c) => c.loadAccessTokens);
export const setActivitySearch = (search: string) => run((c) => c.setActivitySearch(search));
export const refreshConnector = (id: string) => run((c) => c.refreshConnector(id));
export const stopConnectorReads = (id: string) => run((c) => c.stopConnectorReads(id));
export const askConfirm = (id: string, action: PendingConfirm["action"]) => run((c) => c.askConfirm(id, action));
export const cancelConfirm = (returnFocusTo: string) => run((c) => c.cancelConfirm(returnFocusTo));
export const editCredential = (id: string | null) => run((c) => c.editCredential(id));
export const refuseCredential = (id: string, copy: string) => run((c) => c.refuseCredential(id, copy));
export const cancelTokenAction = (returnFocusTo?: string) => run((c) => c.cancelTokenAction(returnFocusTo));
export const dismissCreatedToken = () => run((c) => c.dismissCreatedToken);
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
export function rotateAgentToken(name: string): void {
  const active = current();
  if (active.controller.prepareRotation(name) === "issue") active.request({ _tag: "RotateAgentToken", name });
}

export const revokeAgentToken = (name: string) => run((c) => c.revokeAgentToken(name));
export const confirmTokenAction = () => current().request({ _tag: "ConfirmTokenAction" });

export function steadyHealthOf(state: OperatorState): SteadyHealth {
  return current().steadyHealth(state);
}

export function accountLabel(): string | null {
  return current().controller.accountLabel();
}

export function sessionPresumed(): boolean {
  return current().controller.sessionPresumed();
}

export function navHint(): { activity: boolean } {
  return current().controller.navHint();
}
