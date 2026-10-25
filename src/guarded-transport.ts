// The plain runtime slot keeps the HTTP kit and Node sender off the root
// and Worker graphs. /node installs its sender when listen() starts serving.
import { ConnectorCallError } from "./errors.js";

export interface GuardedTransport {
  readonly send: (url: URL, init: RequestInit, beforeDispatch?: () => void) => Promise<Response>;
  /** The owned sender invokes beforeDispatch at its last safe pre-send boundary. */
  readonly delaysDispatch?: true;
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
    typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === "undefined" &&
    typeof process !== "undefined" &&
    process.versions?.node !== undefined;
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

/** Legacy/fake senders dispatch immediately; the owned sender may first establish a tunnel. */
export function sendGuarded(
  transport: GuardedTransport,
  url: URL,
  init: RequestInit,
  beforeDispatch: () => void,
): Promise<Response> {
  if (transport.delaysDispatch) return transport.send(url, init, beforeDispatch);
  beforeDispatch();
  return transport.send(url, init);
}
