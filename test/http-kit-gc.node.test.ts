// Node-only: forces V8 collections through --expose-gc, which workerd does not provide.
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { tithely } from "../src/providers/tithely/index.js";
import { openRequest } from "../src/runtime/call.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One completed call whose request then closes; only weak references to its services leave. */
async function oneRequest(connector: Connector): Promise<Record<string, WeakRef<object>>> {
  const ctx = {
    storage: memoryStorage(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    baseUrl: "https://connecta.example",
    signal: new AbortController().signal,
    requestScope: {},
    credential: {
      get: async () => null,
      getAll: async () => ({ publicKey: "pub_lifetime", privateKey: "pri_lifetime" }),
    },
  };
  const request = openRequest(ctx.requestScope);
  try {
    await connector.callTool("get_charge", { chargeId: "ch_1" }, ctx);
  } finally {
    request.close();
  }
  const { signal, requestScope, storage, logger, credential } = ctx;
  return Object.fromEntries(
    Object.entries({ ctx, signal, requestScope, storage, logger, credential }).map(([name, value]) => [
      name,
      new WeakRef(value),
    ]),
  );
}

it("INV-7: a kit connector keeps no service of a call whose request has closed", async () => {
  // A plain stub: a mock would record each call's init, signal included.
  vi.stubGlobal("fetch", async () => Response.json({ status: "success", object: { charge_id: "ch_1" } }));
  // A deployment keeps its connector for its whole lifetime; its first call builds the typed client.
  const connector = tithely("giving", { purpose: "Weekly giving reports", environment: "live" });
  const refs = await oneRequest(connector);
  const held = () => Object.keys(refs).filter((name) => refs[name]!.deref() !== undefined);
  for (let round = 0; round < 30 && held().length > 0; round++) {
    await new Promise((resolve) => setImmediate(resolve));
    gc();
  }
  expect(held()).toEqual([]);
  expect(connector.id).toBe("giving");
});
