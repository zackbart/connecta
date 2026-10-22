// The plain runtime slot keeps the kit and Node implementations off the root
// and Worker graphs. /node installs its sender when listen() starts serving.
import { ConnectorCallError } from "./errors.js";

export interface GuardedTransport {
  readonly send: (url: URL, init: RequestInit) => Promise<Response>;
}

let owned: GuardedTransport | undefined;

/** Runtime configuration, never request data. Returns the previous slot for isolated fixtures. */
export function configureGuardedTransport(transport: GuardedTransport | undefined): GuardedTransport | undefined {
  const previous = owned;
  owned = transport;
  return previous;
}

export function guardedTransport(write: boolean): GuardedTransport {
  if (owned) return owned;
  const node =
    typeof WebSocketPair === "undefined" && typeof process !== "undefined" && process.versions?.node !== undefined;
  if (node && write) {
    throw new ConnectorCallError(
      "connector_call_failed",
      "Guarded writes on Node require the owned transport: serve with listen from @zackbart/connecta/node.",
      { retryable: false },
    );
  }
  // workerd supplies its native network implementation, with manual redirects.
  // Node reads can use native fetch without claiming a single physical attempt.
  return { send: (url, init) => globalThis.fetch(url, init) };
}
