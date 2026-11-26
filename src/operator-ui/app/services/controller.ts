import { Context, type Brand, type Effect, type Stream } from "effect";
import type { OperatorPage, OperatorState, PendingConfirm } from "../../view.js";

export type OAuthStartMode = "continue" | "restart";

export type CredentialBody = { value: string } | { values: Record<string, string> };

export type CandidateHandle = string & Brand.Brand<"CandidateHandle">;

export type PreparedOAuth = { readonly refused: true } | { readonly refused: false; readonly tab: Window | null };

export interface OperatorControllerShape {
  readonly state: () => OperatorState;
  readonly changes: Stream.Stream<OperatorState>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly sessionPresumed: () => boolean;
  readonly navHint: () => { activity: boolean };
  readonly accountLabel: () => string | null;
  readonly clerkSignedIn: () => boolean;

  readonly boot: Effect.Effect<void>;
  readonly routeChanged: (path: string) => Effect.Effect<void>;
  readonly navigated: (page: OperatorPage, path: string) => Effect.Effect<void>;
  readonly returnedToTab: Effect.Effect<void>;

  readonly signIn: Effect.Effect<void>;
  readonly signOut: Effect.Effect<void>;
  readonly signInWithBearer: (value: string) => Effect.Effect<void>;
  readonly forgetBearer: Effect.Effect<void>;
  readonly retryLoad: Effect.Effect<void>;
  readonly retryCollection: Effect.Effect<void>;

  readonly focusHandled: Effect.Effect<void>;
  readonly closeForRecovery: Effect.Effect<void>;
  readonly setConnectorFilter: (filter: string) => Effect.Effect<void>;
  readonly setActivitySearch: (search: string) => Effect.Effect<void>;
  readonly askConfirm: (connectorId: string, action: PendingConfirm["action"]) => Effect.Effect<void>;
  readonly cancelConfirm: (returnFocusTo: string) => Effect.Effect<void>;
  readonly editCredential: (connector: string | null) => Effect.Effect<void>;
  readonly refuseCredential: (connector: string, copy: string) => Effect.Effect<void>;
  readonly cancelTokenAction: (returnFocusTo?: string) => Effect.Effect<void>;
  readonly dismissCreatedToken: Effect.Effect<void>;

  readonly loadOperatorContract: Effect.Effect<void>;
  readonly refreshConnector: (id: string, quiet?: boolean) => Effect.Effect<void>;
  readonly stopConnectorReads: (id: string) => Effect.Effect<void>;
  readonly loadActivity: (reset: boolean) => Effect.Effect<void>;
  readonly loadAccessTokens: Effect.Effect<void>;
  readonly loadPageCollections: Effect.Effect<void>;

  readonly prepareOAuth: (connector: string, mode: OAuthStartMode) => PreparedOAuth;
  readonly startOAuth: (connector: string, mode: OAuthStartMode, prepared?: PreparedOAuth) => Effect.Effect<void>;
  readonly disconnectOAuth: (connector: string) => Effect.Effect<void>;
  readonly saveCredential: (connector: string, body: CredentialBody, verify?: "test" | "skip") => Effect.Effect<void>;
  readonly holdCredentialCandidate: (body: CredentialBody) => CandidateHandle;
  readonly saveHeldCredential: (
    connector: string,
    candidate: CandidateHandle,
    verify: "test" | "skip",
  ) => Effect.Effect<void>;
  readonly removeCredential: (connector: string) => Effect.Effect<void>;
  readonly testCredential: (connector: string) => Effect.Effect<void>;
  readonly prepareRotation: (name: string) => "asked" | "issue" | "none";
  readonly rotateAgentToken: (name: string) => Effect.Effect<void>;
  readonly revokeAgentToken: (name: string) => Effect.Effect<void>;
  readonly confirmTokenAction: Effect.Effect<void>;
}

export class OperatorController extends Context.Service<OperatorController, OperatorControllerShape>()(
  "connecta/operator-ui/OperatorController",
) {}
