import { createClerkClient as createIsolatedClerkClient } from "./clerk-sdk/client.js";
import type { ClerkClientOptions, ClerkSdkClient } from "./clerk-sdk/client.js";
import { byteReadResponse } from "../byte-read-response.js";
import { failureRecord, logFailure } from "../operator-record.js";

/** All SDK network paths, including fresh opaque-verification clients. */
export function createByteReadingClerkClient(options: ClerkClientOptions): ClerkSdkClient {
  const client = createIsolatedClerkClient({
    ...options,
    telemetry: { disabled: true },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => byteReadResponse(await fetch(input, init)),
  });
  // The upstream disabled flag does not cover recordLog or debug output.
  client.telemetry.record = () => {};
  client.telemetry.recordLog = () => {};
  return client;
}

/** The generated SDK never forwards its diagnostic text to a console. */
export function clerkSdkFailure(failure?: unknown): void {
  logFailure(console, "Clerk authentication failed", failureRecord({}, failure));
}
