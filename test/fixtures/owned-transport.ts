import { onTestFinished, vi } from "vitest";
import { configureGuardedTransport } from "../../src/guarded-transport.js";

/**
 * Stand in for listen() while resolving the current fetch fake at send time.
 * Call inside a test or beforeEach so onTestFinished can own restoration.
 */
export function installOwnedTransport() {
  const send = vi.fn(async (url: URL, init: RequestInit) => globalThis.fetch(url, init));
  const previous = configureGuardedTransport({ send });
  let active = true;
  const restore = () => {
    if (!active) return;
    active = false;
    configureGuardedTransport(previous);
  };
  // Nested installs unwind in reverse order, even when a fixture fails early.
  onTestFinished(restore);
  return { send, restore };
}
