// The classification the registry served for the call a context dispatches:
// deployment config's verdict when it gives one, else the tool's own. A
// transport that could send a request twice (an OAuth refresh and replay)
// reads it here, so a write is sent once whatever HTTP method carries it
// (INV-9). It rides beside the context like the rest of the call state until
// decision 0009 (B.1) moves it into a Context service.
import { contextKey } from "./derived-context.js";
import type { ConnectorContext } from "./types.js";

const classifications = new WeakMap<object, "read" | "write">();

export function attachCallClassification(ctx: ConnectorContext, classification: "read" | "write"): void {
  classifications.set(contextKey(ctx), classification);
}

/** Undefined for a context no invocation dispatched, such as a credential test. */
export function callClassification(ctx: ConnectorContext): "read" | "write" | undefined {
  return classifications.get(contextKey(ctx));
}
