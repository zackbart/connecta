import { onTestFinished, vi } from "vitest";
import { configureGuardedTransport } from "../../src/guarded-transport.js";

/**
 * Stand in for listen() while resolving the current fetch fake at send time.
 * Call inside a test or beforeEach so onTestFinished can own restoration.
 */
export function installOwnedTransport() {
  const send = vi.fn((url: URL, init: RequestInit) => {
    try {
      // Preserve real fetch promises by identity, including their 401/abort
      // ordering, while accepting synchronous Response-returning test fakes.
      return Promise.resolve(globalThis.fetch(url, init));
    } catch (error) {
      return Promise.reject(error);
    }
  });
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
