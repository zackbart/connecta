// One module graph shared by genuinely separate workerd requests.
import { Effect } from "effect";
import { d1Storage, d1ActivityStore, type D1DatabaseBinding } from "../../src/d1.js";
import { getNativeStorage, getNativeActivity } from "../../src/runtime/native-storage.js";
import { runEdge } from "../../src/runtime/run.js";
import { RequestReads } from "../../src/runtime/request-reads.js";

let stores: ReturnType<typeof makeStores> | undefined;
function makeStores(db: D1DatabaseBinding) {
  return { kv: getNativeStorage(d1Storage(db))!, activity: getNativeActivity(d1ActivityStore(db))! };
}

export default {
  async fetch(request: Request, env: { DB: D1DatabaseBinding }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/memo") {
      // This Worker's compatibility date predates default weak references and
      // sets no enable_weak_ref: the request memo must read storage each time.
      const storage = d1Storage(env.DB);
      const reads = new RequestReads();
      let loads = 0;
      const load = Effect.promise(() => {
        loads++;
        return storage.get("memo");
      });
      const values = [await runEdge(reads.read(storage, "memo", load)), await runEdge(reads.read(storage, "memo", load))];
      reads.close();
      return Response.json({ weakRef: typeof WeakRef, finalizationRegistry: typeof FinalizationRegistry, values, loads });
    }
    const { kv, activity } = stores ??= makeStores(env.DB);
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
