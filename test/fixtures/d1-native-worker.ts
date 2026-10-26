// One module graph shared by genuinely separate workerd requests.
import { Effect } from "effect";
import { d1Storage, d1ActivityStore, type D1DatabaseBinding } from "../../src/d1.js";
import { getNativeStorage, getNativeActivity } from "../../src/runtime/native-storage.js";
import { runEdge } from "../../src/runtime/run.js";

let stores: ReturnType<typeof makeStores> | undefined;
function makeStores(db: D1DatabaseBinding) {
  return { kv: getNativeStorage(d1Storage(db))!, activity: getNativeActivity(d1ActivityStore(db))! };
}

export default {
  async fetch(request: Request, env: { DB: D1DatabaseBinding }): Promise<Response> {
    const { kv, activity } = stores ??= makeStores(env.DB);
    const url = new URL(request.url);
    const key = url.searchParams.get("key")!;
    const owner = url.searchParams.get("owner")!;
    return Response.json(await runEdge(Effect.gen(function*() {
      if (url.pathname === "/claim") return yield* kv.compareAndSet(key, null, owner, { ttlSeconds: 120 });
      if (url.pathname === "/get") return yield* kv.get(key);
      if (url.pathname === "/activity") {
        yield* activity.record({
          schemaVersion: 1, id: crypto.randomUUID(), occurredAt: new Date().toISOString(), requestId: owner,
          actor: { kind: "bearer" }, connectorId: "notes", toolName: "list", address: "notes.list",
          source: "call_tool", outcome: "success", durationMs: 1, attempts: 1, serverName: "connecta", serverVersion: "0.35.0",
        });
        return (yield* activity.list({ limit: 100 })).events.length;
      }
      return yield* activity.list({ limit: 100 });
    })));
  },
};
