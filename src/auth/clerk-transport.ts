import type { createClerkClient } from "@clerk/backend";
import { createClerkClient as createIsolatedClerkClient } from "./clerk-sdk/generated.js";
import { byteReadResponse } from "../byte-read-response.js";
import { failureRecord, logFailure } from "../operator-record.js";

type ClerkOptions = Parameters<typeof createClerkClient>[0];

/** All SDK network paths, including fresh opaque-verification clients. */
export function createByteReadingClerkClient(options: ClerkOptions): ReturnType<typeof createClerkClient> {
  const client = createIsolatedClerkClient({
    ...options,
    telemetry: { disabled: true },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => byteReadResponse(await fetch(input, init)),
  }) as unknown as ReturnType<typeof createClerkClient>;
  // The upstream disabled flag does not cover recordLog or debug output.
  client.telemetry.record = () => {};
  client.telemetry.recordLog = () => {};
  return client;
}

/** The generated SDK never forwards its diagnostic text to a console. */
export function clerkSdkFailure(failure?: unknown): void {
  logFailure(console, "Clerk authentication failed", failureRecord({}, failure));
}
