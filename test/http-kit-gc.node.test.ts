// Node-only: forces V8 collections through --expose-gc, which workerd does not provide.
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { tithely } from "../src/providers/tithely/index.js";
import { machineLogin as machineConnector } from "./fixtures/machine-login.js";
import { openRequest } from "../src/runtime/call.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One completed call whose request then closes; only weak references to its services leave. */
async function oneRequest(connector: Connector, machineLogin: boolean): Promise<Record<string, WeakRef<object>>> {
  const ctx = {
    storage: memoryStorage(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    baseUrl: "https://connecta.example",
    signal: new AbortController().signal,
    requestScope: {},
    credential: {
      get: async () => null,
      getAll: async () =>
        machineLogin
          ? { clientId: "client_lifetime", clientSecret: "secret_lifetime" }
          : { publicKey: "pub_lifetime", privateKey: "pri_lifetime" },
    },
  };
  const request = openRequest(ctx.requestScope);
  try {
    await connector.callTool(
      machineLogin ? "list_items" : "get_charge",
      machineLogin ? {} : { chargeId: "ch_1" },
      ctx,
    );
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

it.each([false, true])(
  "INV-7: a kit connector keeps no closed call service (machine login: %s)",
  async (machineLogin) => {
    // A plain stub: a mock would record each call's init, signal included.
    vi.stubGlobal("fetch", async (url: unknown) =>
      String(url).endsWith("/login")
        ? Response.json({ accessToken: "access_lifetime", expiresIn: 3600 })
        : Response.json(machineLogin ? { projects: [] } : { status: "success", object: { charge_id: "ch_1" } }),
    );
    // A deployment keeps its connector for its whole lifetime; its first call builds the typed client.
    const connector = machineLogin
      ? machineConnector("giving")
      : tithely("giving", { purpose: "Weekly giving reports", environment: "live" });
    const refs = await oneRequest(connector, machineLogin);
    const held = () => Object.keys(refs).filter((name) => refs[name]!.deref() !== undefined);
    for (let round = 0; round < 30 && held().length > 0; round++) {
      await new Promise((resolve) => setImmediate(resolve));
      gc();
    }
    expect(held()).toEqual([]);
    expect(connector.id).toBe("giving");
  },
);
