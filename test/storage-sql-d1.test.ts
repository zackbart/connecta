// SQL contracts against native workerd D1 and separate Worker requests.
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import { d1ActivityStore, d1Storage, type D1DatabaseBinding } from "../src/d1.js";
import { getNativeStorage } from "../src/runtime/native-storage.js";
import { runEdge } from "../src/runtime/run.js";
import { sqlEffectContract } from "./sql-effect-contract.js";
import {
  sqlActivityRollbackContract,
  sqlBatchRollbackContract,
  sqlCasExpiryContract,
  sqlGetManyContract,
  sqlStashFixture,
  type SqlFixture,
} from "./sql-storage-contract.js";
import { stashClockSkewContract } from "./stash-charge-contract.js";

const bindings = await (async () => {
  try {
    const testModule = "cloudflare:test";
    const { env } = (await import(/* @vite-ignore */ testModule)) as {
      env: { STORAGE_DB?: D1Database; SQL_LIFETIMES: Fetcher };
    };
    return env.STORAGE_DB ? { db: env.STORAGE_DB, worker: env.SQL_LIFETIMES } : undefined;
  } catch {
    return undefined;
  }
})();

vi.setConfig({ testTimeout: 60_000 });

async function fresh(): Promise<D1Database> {
  const db = bindings!.db;
  await db.prepare("DROP TABLE IF EXISTS connecta_kv").run();
  await db.prepare("DROP TABLE IF EXISTS tool_call_activity").run();
  return db;
}

async function open(): Promise<SqlFixture> {
  const db = await fresh();
  return {
    storage: () => d1Storage(db),
    activity: (options) => d1ActivityStore(db, options),
    async exec(sql, ...params) {
      await db
        .prepare(sql)
        .bind(...params)
        .run();
    },
    async rows<Row>(sql: string, ...params: (string | number | null)[]) {
      return (
        await db
          .prepare(sql)
          .bind(...params)
          .all<Row>()
      ).results;
    },
  };
}

describe.skipIf(!bindings)("CAS expiry reclamation over native Workers D1", () => {
  sqlCasExpiryContract(open);
});

describe.skipIf(!bindings)("getMany over native Workers D1", () => {
  sqlGetManyContract(open);
});

describe.skipIf(!bindings)("SQL batch rollback over native Workers D1", () => {
  sqlBatchRollbackContract(open);
  sqlActivityRollbackContract(open);
  sqlEffectContract(open);
});

/** Only the structural members connecta declares; nothing else is reachable. */
function structural(db: D1Database, hooks: { onBatch?: () => void; onRun?: (sql: string) => void; calls: string[] }) {
  const wrap = (sql: string, statement: D1PreparedStatement): ReturnType<D1DatabaseBinding["prepare"]> => ({
    bind: (...values: unknown[]) => wrapBound(sql, statement.bind(...values)),
    all: () => statement.all(),
    run: () => {
      hooks.calls.push(`run:${sql.slice(0, 24)}`);
      const pending = statement.run();
      hooks.onRun?.(sql);
      return pending;
    },
  });
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrapBound = (sql: string, statement: D1PreparedStatement) => {
    const w = wrap(sql, statement);
    real.set(w, statement);
    return w;
  };
  const binding: D1DatabaseBinding = {
    prepare: (sql) => wrapBound(sql, db.prepare(sql)),
    batch: (statements) => {
      hooks.calls.push(`batch:${statements.length}`);
      const pending = db.batch(statements.map((s) => real.get(s)!));
      hooks.onBatch?.();
      return pending;
    },
  };
  return binding;
}

describe.skipIf(!bindings)("review r1: D1 interruption after physical dispatch", () => {
  it("INV-7 INV-9: abort right after db.batch dispatch: original reason, write committed (unknown state), never replayed", async () => {
    const db = await fresh();
    const controller = new AbortController();
    const reason = new Error("caller gone after batch dispatch");
    const hooks: { calls: string[]; onBatch?: () => void } = { calls: [] };
    const storage = d1Storage(structural(db, hooks));
    await storage.get("warm");
    hooks.calls.length = 0;
    hooks.onBatch = () => controller.abort(reason);
    const native = getNativeStorage(storage)!;
    await expect(runEdge(native.set("dispatched", "v"), { signal: controller.signal })).rejects.toBe(reason);
    delete hooks.onBatch;
    // Let the submitted batch finish in the background.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
    expect(hooks.calls).toEqual(["batch:2"]);
    expect(await storage.get("dispatched")).toBe("v");
  });

  it("INV-7 INV-9: abort right after CAS dispatch: original reason, claim committed, a second claim is refused", async () => {
    const db = await fresh();
    const controller = new AbortController();
    const reason = new Error("caller gone after CAS dispatch");
    const hooks: { calls: string[]; onBatch?: () => void } = { calls: [] };
    const storage = d1Storage(structural(db, hooks));
    await storage.get("warm");
    hooks.calls.length = 0;
    hooks.onBatch = () => controller.abort(reason);
    const native = getNativeStorage(storage)!;
    await expect(
      runEdge(native.compareAndSet("cas", null, "holder", { ttlSeconds: 60 }), { signal: controller.signal }),
    ).rejects.toBe(reason);
    delete hooks.onBatch;
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
    // The expiry sweep rides in the claim's batch: one D1 round trip.
    expect(hooks.calls).toEqual(["batch:2"]);
    expect(await storage.get("cas")).toBe("holder");
    expect(await storage.compareAndSet("cas", null, "replay")).toBe(false);
  });

  it("INV-7 INV-9: abort before dispatch (synchronously after runEdge) sends nothing to D1", async () => {
    const db = await fresh();
    const hooks: { calls: string[] } = { calls: [] };
    const storage = d1Storage(structural(db, hooks));
    await storage.get("warm");
    hooks.calls.length = 0;
    const controller = new AbortController();
    const reason = new Error("left before dispatch");
    const pending = runEdge(getNativeStorage(storage)!.compareAndSet("never", null, "x"), {
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(hooks.calls).toEqual([]);
    expect(await storage.get("never")).toBeNull();
  });
});

describe.skipIf(!bindings)("review r1: D1 binding error identity", () => {
  it("INV-13: synchronous and asynchronous binding throws keep identity on Promise and native edges", async () => {
    const db = await fresh();
    const sentinel = new TypeError("binding failure carrying secret-value");
    let mode: "sync" | "async" | "off" = "off";
    const binding: D1DatabaseBinding = {
      prepare: (sql) => db.prepare(sql),
      batch: (statements) => {
        if (mode === "sync") throw sentinel;
        if (mode === "async") return Promise.reject(sentinel);
        return db.batch(statements as D1PreparedStatement[]);
      },
    };
    const storage = d1Storage(binding);
    await storage.get("warm");
    for (const m of ["sync", "async"] as const) {
      mode = m;
      await expect(storage.set("k", "v")).rejects.toBe(sentinel);
      const exit = await runEdge(Effect.exit(getNativeStorage(storage)!.set("k", "v")));
      expect(Exit.isFailure(exit) && exit.cause.reasons.find(Cause.isFailReason)?.error).toBe(sentinel);
    }
    mode = "off";
    await storage.set("k", "v");
    expect(await storage.get("k")).toBe("v");
  });
});

describe.skipIf(!bindings)("stash capacity over native Workers D1", () => {
  stashClockSkewContract(async () => {
    return sqlStashFixture(await open());
  });
});

describe.skipIf(!bindings)("native SQL service request ownership", () => {
  it("INV-7: reuses stores across real workerd requests without sharing clients, promises, or prepared handles", async () => {
    const worker = bindings!.worker;
    const key = crypto.randomUUID();
    const fetch = async (path: string) => {
      const response = await worker.fetch(`https://sql.test${path}`);
      expect(response.status).toBe(200);
      return response.json();
    };
    const claims = await Promise.all(
      Array.from({ length: 50 }, (_, index) => fetch(`/claim?key=${key}&owner=owner-${index}`)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await fetch(`/get?key=${key}`)).toBe(`owner-${claims.indexOf(true)}`);
    for (let index = 0; index < 3; index++) await fetch(`/activity?owner=request-${index}`);
    expect(await fetch("/list")).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ requestId: "request-0" }),
        expect.objectContaining({ requestId: "request-1" }),
        expect.objectContaining({ requestId: "request-2" }),
      ]),
    });
  });
});
