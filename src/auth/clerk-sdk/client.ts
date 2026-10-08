import { createClerkClient as createGeneratedClerkClient } from "./generated.js";

/** The reviewed SDK user fields used by admission and activity labels. */
export interface ClerkUser {
  readonly id: string;
  readonly fullName: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly username: string | null;
  readonly primaryEmailAddressId: string | null;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
    readonly verification: { readonly status: string } | null;
  }[];
}

/** Connecta's gate client contract, independent of the consumer's Clerk SDK. */
export interface ClerkGateClient {
  users: { getUser(userId: string): Promise<ClerkUser> };
}

type ClerkAuth =
  | { isAuthenticated: false }
  | {
    isAuthenticated: true;
    tokenType: "session_token";
    userId: string;
    sessionClaims: { azp?: string };
  }
  | {
    isAuthenticated: true;
    tokenType: "oauth_token";
    userId: string;
    clientId: string;
    getToken(): Promise<string>;
  };

/** Only the bundled SDK operations Connecta calls, not the full upstream API. */
export interface ClerkSdkClient extends ClerkGateClient {
  authenticateRequest(request: Request, options: {
    acceptsToken: "session_token" | "oauth_token";
  }): Promise<{
    status: "signed-in" | "signed-out" | "handshake";
    reason: string | null;
    headers: Headers;
    toAuth(): ClerkAuth | null;
  }>;
  telemetry: {
    record(event: unknown): void;
    recordLog(log: unknown): void;
  };
}

export interface ClerkClientOptions {
  publishableKey: string;
  secretKey: string;
}

/** The generated JavaScript is untyped; this boundary owns its declarations. */
export function createClerkClient(options: ClerkClientOptions & {
  fetch: typeof fetch;
  telemetry: { disabled: true };
}): ClerkSdkClient {
  return createGeneratedClerkClient(options);
}
