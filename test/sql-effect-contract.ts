// Native SQL characterization, run against DatabaseSync and workerd D1.
import { Cause, Effect, Exit, Random, Tracer } from "effect";
import { expect, it, vi } from "vitest";
import { getNativeActivity, getNativeStorage } from "../src/runtime/native-storage.js";
import * as nativeStores from "../src/runtime/native-storage.js";
import { Registry } from "../src/registry.js";
import { registryProgram } from "../src/runtime/registry.js";
import { Storage } from "../src/runtime/services.js";
import { storageGet, storageSet, storageDelete, storageList, storageCompareAndSet } from "../src/runtime/storage.js";
import { resultKeys, scopes, stashLedgerKeys } from "../src/storage/keys.js";
import * as storageRuntime from "../src/runtime/storage.js";
import { silentLogger } from "./helpers.js";
import { runEdge } from "../src/runtime/run.js";
import { nativeSqlDriver } from "../src/storage/sql-driver.js";
import * as sqlStores from "../src/storage/sql.js";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { InvalidActivityCursorError } from "../src/activity.js";
import { deferred } from "./fixtures/misc.js";
import type { SqlFixture } from "./sql-storage-contract.js";
import type { KVStorage } from "../src/types.js";

export function sqlEffectContract(open: () => Promise<SqlFixture>): void {
  async function setup(beforeRegister?: (storage: KVStorage) => void) {
    const db = await open();
    const factory = vi.spyOn(sqlStores, "sqlStorage");
    const registerStorage = nativeStores.registerNativeStorage;
    // Proof sentinels belong to the original registered edge. Replacing a
    // method after registration intentionally selects the Promise override.
    const registration = beforeRegister
      ? vi.spyOn(nativeStores, "registerNativeStorage").mockImplementation((edge, native) => {
          beforeRegister(edge);
          return registerStorage(edge, native);
        })
      : undefined;
    try {
      const storage = db.storage();
      const driver = factory.mock.calls[0]![0];
      return { db, storage, driver, sql: nativeSqlDriver(driver), native: getNativeStorage(storage)! };
    } finally {
      registration?.mockRestore();
      factory.mockRestore();
    }
  }

  it("INV-13: composes SQL KV and activity through native Effects without Promise adapter re-entry", async () => {
    const { db, driver, native } = await setup((storage) => {
      for (const method of ["get", "set", "delete", "list", "compareAndSet"] as const) {
        vi.spyOn(storage, method).mockImplementation(() => {
          throw new Error("Promise store re-entry");
        });
      }
    });
    for (const method of ["all", "run", "batch"] as const) {
      vi.spyOn(driver, method).mockImplementation(() => {
        throw new Error("Promise driver re-entry");
      });
    }
    await runEdge(
      Effect.gen(function* () {
        yield* native.set("native:é😀", "\ufeffbefore\0after😀", { ttlSeconds: 120 });
        expect(yield* native.get("native:é😀")).toBe("\ufeffbefore\0after😀");
        expect(yield* native.list("native:")).toEqual(["native:é😀"]);
        expect(yield* native.compareAndSet("native:é😀", "\ufeffbefore\0after😀", "changed")).toBe(true);
        expect(yield* native.compareAndSet("native:é😀", "wrong", "discarded")).toBe(false);
        yield* native.delete("native:é😀");
        expect(yield* native.get("native:é😀")).toBeNull();
      }),
    );
    const registerActivity = nativeStores.registerNativeActivity;
    const registration = vi.spyOn(nativeStores, "registerNativeActivity").mockImplementation((edge, native) => {
      vi.spyOn(edge, "record").mockImplementation(() => {
        throw new Error("Promise activity re-entry");
      });
      return registerActivity(edge, native);
    });
    let program: NonNullable<ReturnType<typeof getNativeActivity>>;
    try {
      program = getNativeActivity(db.activity())!;
    } finally {
      registration.mockRestore();
    }
    await runEdge(
      program.record({
        schemaVersion: 1,
        id: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        requestId: "request",
        actor: { kind: "bearer" },
        connectorId: "notes",
        toolName: "list",
        address: "notes.list",
        source: "call_tool",
        outcome: "success",
        durationMs: 1,
        attempts: 1,
        serverName: "connecta",
        serverVersion: "0.35.0",
      }),
    );
    expect((await runEdge(program.list({ limit: 1 }))).events).toHaveLength(1);
  });

  it("INV-4 INV-9 INV-13: registry namespaces and programs compose native SQL without Promise store re-entry", async () => {
    const { storage, native } = await setup((storage) => {
      for (const method of ["get", "set", "delete", "list", "compareAndSet"] as const) {
        vi.spyOn(storage, method).mockImplementation(() => {
          throw new Error("Promise registry store re-entry");
        });
      }
    });
    const registry = new Registry(
      [
        {
          id: "notes",
          kind: "api",
          authScope: "personal",
          staticTools: [],
          listTools: async () => [],
          callTool: async () => ({}),
        },
      ],
      { storage, logger: silentLogger },
    );
    const scoped = registry.scoped({ connectorIds: ["notes"], principalKey: "alice", subjectKey: "alice-request" });
    const ctx = scoped.contextFor("notes", "https://connecta.test", {});
    expect(getNativeStorage(ctx.storage)).toBeDefined();
    await runEdge(
      Effect.gen(function* () {
        yield* storageSet("data:entry", "first", { ttlSeconds: 120 });
        expect(yield* storageGet("data:entry")).toBe("first");
        expect(yield* storageCompareAndSet("data:entry", "wrong", "discarded")).toBe(false);
        expect(yield* storageCompareAndSet("data:entry", "first", "changed")).toBe(true);
        expect(yield* storageList("data:")).toEqual(["data:entry"]);
        yield* storageDelete("data:entry");
        expect(yield* storageGet("data:entry")).toBeNull();
        yield* storageSet("data:entry", "alice");
      }).pipe(Effect.provideService(Storage, ctx.storage)),
    );
    const key = scopes.principal("alice") + scopes.connector("notes") + "data:entry";
    expect(await runEdge(native.get(key))).toBe("alice");
    const bob = registry.personalRegistry("bob").contextFor("notes", "https://connecta.test");
    expect(await runEdge(getNativeStorage(bob.storage)!.get("data:entry"))).toBeNull();
    await runEdge(
      registryProgram(scoped, "bindOAuthHandoff", "notes", "https://provider.test/authorize?state=native-state"),
    );
    expect(await runEdge(registryProgram(registry, "oauthCallbackView", "notes", "native-state"))).toMatchObject({
      principalKey: "alice",
    });
    expect(await runEdge(registryProgram(registry, "consumeOAuthHandoff", "notes", "native-state", "bob"))).toBe(false);
    expect(await runEdge(registryProgram(registry, "consumeOAuthHandoff", "notes", "native-state", "alice"))).toBe(
      true,
    );
    expect(await runEdge(registryProgram(scoped, "stashResult", "native-result", ["header", "chunk"], 120))).toBe(true);
    expect(await runEdge(native.get(scopes.subject("alice-request") + resultKeys.chunk("native-result", 1)))).toBe(
      "chunk",
    );
    expect(await runEdge(getNativeStorage(scoped.resultsStorage())!.get(resultKeys.chunk("native-result", 0)))).toBe(
      "header",
    );
    expect(
      await runEdge(getNativeStorage(registry.resultsStorage())!.get(resultKeys.chunk("native-result", 0))),
    ).toBeNull();
  });

  it("INV-13: real SQL Statement operations use the operation's public SqlClient service and transformer", async () => {
    const { native } = await setup();
    await runEdge(native.set("service", "stored"));
    const clients: SqlClient.SqlClient[] = [];
    const transform: Statement.Transformer = (statement, constructor) =>
      Effect.gen(function* () {
        const current = yield* Effect.serviceOption(SqlClient.SqlClient);
        expect(current._tag).toBe("Some");
        if (current._tag !== "Some") throw new Error("SQL statement has no client service");
        expect(current.value).toBe(constructor);
        clients.push(current.value);
        expect(statement.compile()[1]).toEqual(["service"]);
        return constructor.unsafe("SELECT ? AS value, NULL AS value_bytes", ["transformed"]);
      });
    for (let i = 0; i < 2; i++) {
      expect(
        await runEdge(native.get("service").pipe(Effect.provideService(Statement.CurrentTransformer, transform))),
      ).toBe("transformed");
    }
    expect(clients).toHaveLength(2);
    expect(clients[0]).not.toBe(clients[1]);
    expect(await runEdge(native.get("service"))).toBe("stored");
  });

  it("INV-13: native validation, decoding and activity cursors are recoverable typed failures", async () => {
    const { db, native } = await setup();
    const failed = async (operation: Effect.Effect<unknown, unknown>) => {
      const result = await runEdge(Effect.result(operation));
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") throw new Error("Expected a typed storage failure");
      return result.failure;
    };
    for (const operation of [
      native.get("bad\0key"),
      native.set("bad\0key", "value"),
      native.delete("bad\0key"),
      native.list("bad\0key"),
      native.compareAndSet("bad\0key", null, "value"),
    ])
      expect(await failed(operation)).toBeInstanceOf(TypeError);
    expect(await failed(native.set("valid", "value", { ttlSeconds: Infinity }))).toBeInstanceOf(RangeError);
    expect(await failed(native.compareAndSet("valid", null, "value", { expiresAtMs: NaN }))).toBeInstanceOf(RangeError);
    await runEdge(native.set("utf8", "value"));
    await db.exec("UPDATE connecta_kv SET value = CAST(x'610080' AS TEXT) WHERE key = ?", "utf8");
    const decoded = await runEdge(native.get("utf8").pipe(Effect.catch((error) => Effect.succeed(error))));
    expect(decoded).toBeInstanceOf(TypeError);
    expect((decoded as Error).message).toContain("not valid UTF-8");
    const activity = getNativeActivity(db.activity())!;
    expect(await failed(activity.list({ limit: 1, cursor: "!!" }))).toBeInstanceOf(InvalidActivityCursorError);
    for (const sentinel of [new TypeError("sentinel"), { private: "sentinel" }, "sentinel", undefined]) {
      const options = {
        get ttlSeconds(): number {
          throw sentinel;
        },
      };
      expect(await failed(native.set("valid", "value", options))).toBe(sentinel);
      const page = {
        get limit(): number {
          throw sentinel;
        },
      };
      expect(await failed(activity.list(page))).toBe(sentinel);
      const event = {
        get occurredAt(): string {
          throw sentinel;
        },
      } as Parameters<typeof activity.record>[0];
      expect(await failed(activity.record(event))).toBe(sentinel);
    }
  });

  it("INV-7 INV-13: typed-failure normalization preserves interruption and its exact abort reason", async () => {
    const { sql, native } = await setup();
    await runEdge(native.get("warm"));
    const started = deferred<void>();
    const pending = vi.spyOn(sql, "all").mockImplementation(() =>
      Effect.andThen(
        Effect.sync(() => started.resolve()),
        Effect.never,
      ),
    );
    const controller = new AbortController();
    const reason = { caller: "left" };
    try {
      const exits: Exit.Exit<unknown, unknown>[] = [];
      const outcome = runEdge(
        Effect.result(native.get("wait")).pipe(Effect.onExit((exit) => Effect.sync(() => exits.push(exit)))),
        { signal: controller.signal },
      );
      await started.promise;
      controller.abort(reason);
      await expect(outcome).rejects.toBe(reason);
      expect(exits).toHaveLength(1);
      const exit = exits[0]!;
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
        expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false);
      }
      await expect(runEdge(native.get("wait"), { signal: controller.signal })).rejects.toBe(reason);
    } finally {
      pending.mockRestore();
    }
  });

  it("INV-6 INV-13: an undecodable stash ledger gracefully refuses native and Promise storage without writing chunks", async () => {
    let originalGet!: KVStorage["get"];
    const get = vi.fn<KVStorage["get"]>(() => {
      throw new Error("Promise store re-entry");
    });
    const { db, storage } = await setup((edge) => {
      originalGet = edge.get.bind(edge);
      edge.get = get;
    });
    await storage.set(stashLedgerKeys.ledger, "placeholder");
    await db.exec("UPDATE connecta_kv SET value = CAST(x'ff00' AS TEXT) WHERE key = ?", stashLedgerKeys.ledger);
    const lifted: KVStorage = {
      capabilities: storage.capabilities,
      get: originalGet,
      set: (key, value, options) => storage.set(key, value, options),
      delete: (key) => storage.delete(key),
      list: (prefix) => storage.list(prefix),
      compareAndSet: (key, expected, next, options) => storage.compareAndSet(key, expected, next, options),
    };
    const run = storageRuntime.runOnPartition;
    const runner = vi
      .spyOn(storageRuntime, "runOnPartition")
      .mockImplementation((program, partition) =>
        run(
          program.pipe(Effect.provideService(Random.Random, { nextDoubleUnsafe: () => 0, nextIntUnsafe: () => 0 })),
          partition,
        ),
      );
    const logger = { ...silentLogger, warn: vi.fn(), error: vi.fn() };
    try {
      expect(await new Registry([], { storage: lifted, logger }).stashResult("lifted", ["private-result"], 120)).toBe(
        false,
      );
      expect(await new Registry([], { storage, logger }).stashResult("native", ["private-result"], 120)).toBe(false);
      expect(get).not.toHaveBeenCalled();
      expect(await db.rows("SELECT key, hex(value) AS value FROM connecta_kv")).toEqual([
        { key: stashLedgerKeys.ledger, value: "FF00" },
      ]);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      runner.mockRestore();
      storage.get = originalGet;
    }
  });

  it("INV-9: preserves zero changes, multiple changed rows, and single-statement CAS under 50 native claims", async () => {
    const { sql, native } = await setup();
    await runEdge(native.set("counts", "first"));
    expect(
      await runEdge(
        sql.batch([
          { sql: "UPDATE connecta_kv SET value = ? WHERE key = ?", params: ["second", "absent"] },
          { sql: "UPDATE connecta_kv SET value = ? WHERE key = ?", params: ["second", "counts"] },
          { sql: "DELETE FROM connecta_kv WHERE key = ?", params: ["absent"] },
        ]),
      ),
    ).toEqual([0, 1, 0]);
    const claims = await Promise.all(
      Array.from({ length: 50 }, (_, i) => runEdge(native.compareAndSet("claim", null, `owner-${i}`))),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = `owner-${claims.indexOf(true)}`;
    expect(await runEdge(native.get("claim"))).toBe(winner);
    expect(await runEdge(sql.run({ sql: "UPDATE connecta_kv SET value = ?", params: ["all"] }))).toBe(2);
    expect(await runEdge(sql.run({ sql: "DELETE FROM connecta_kv", params: [] }))).toBe(2);
  });

  it("INV-5 INV-7: keeps database-clock expiry, NUL/UTF-8 values, and literal UTF-16 prefix ordering", async () => {
    const { db, native } = await setup();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now - 300_000);
    try {
      for (const suffix of ["é", "😀", "\ue000", "%", "_"]) {
        await runEdge(native.set(`prefix:${suffix}`, "\ufefffirst\0last😀", { ttlSeconds: 120 }));
      }
      clock.mockReturnValue(now + 300_000);
      expect(await runEdge(native.list("prefix:"))).toEqual(
        ["%", "_", "é", "😀", "\ue000"].map((suffix) => `prefix:${suffix}`),
      );
      expect(await runEdge(native.list("prefix:_"))).toEqual(["prefix:_"]);
      expect(await runEdge(native.get("prefix:é"))).toBe("\ufefffirst\0last😀");
      expect(await runEdge(native.compareAndSet("prefix:é", null, "refused"))).toBe(false);
      await db.exec("UPDATE connecta_kv SET expires_at_ms = 1 WHERE key = ?", "prefix:é");
      expect(await runEdge(native.get("prefix:é"))).toBeNull();
      expect(await runEdge(native.compareAndSet("prefix:é", null, "renewed", { ttlSeconds: 120 }))).toBe(true);
      await db.exec("UPDATE connecta_kv SET value = CAST(x'610080' AS TEXT) WHERE key = ?", "prefix:é");
      await expect(runEdge(native.get("prefix:é"))).rejects.toThrow("not valid UTF-8");
      await expect(runEdge(native.get("invalid\0key"))).rejects.toBeInstanceOf(TypeError);
    } finally {
      clock.mockRestore();
    }
  });

  it("INV-7 INV-9: cancellation after a committed claim preserves the reason and never replays it", async () => {
    const { sql, native } = await setup();
    await runEdge(native.get("init"));
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const original = sql.run.bind(sql);
    const dispatch = vi
      .spyOn(sql, "run")
      .mockImplementation((statement) =>
        original(statement).pipe(
          Effect.andThen(Effect.sync(() => controller.abort(reason))),
          Effect.andThen(Effect.never),
        ),
      );
    try {
      await expect(
        runEdge(native.compareAndSet("committed", null, "holder"), { signal: controller.signal }),
      ).rejects.toBe(reason);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(await runEdge(native.get("committed"))).toBe("holder");
    } finally {
      dispatch.mockRestore();
    }
    expect(await runEdge(native.compareAndSet("committed", null, "replay"))).toBe(false);
    const preAborted = new AbortController();
    preAborted.abort(reason);
    await expect(
      runEdge(native.compareAndSet("not-dispatched", null, "holder"), { signal: preAborted.signal }),
    ).rejects.toBe(reason);
    expect(await runEdge(native.get("not-dispatched"))).toBeNull();
  });

  it("INV-6: SQL tracing receives no statements, parameters, or wrapped driver causes", async () => {
    const { db, native } = await setup();
    await runEdge(native.set("secret-key", "secret-value"));
    await db.exec(`CREATE TRIGGER fail_secret BEFORE UPDATE ON connecta_kv
      BEGIN SELECT RAISE(ABORT, 'secret-value'); END`);
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const error = await runEdge(
      native.compareAndSet("secret-key", "secret-value", "next").pipe(Effect.withTracer(tracer)),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty("_tag", "SqlError");
    expect(error).not.toHaveProperty("reason");
    expect(spans).toEqual([]);
    await db.exec("DROP TRIGGER fail_secret");
    expect(await runEdge(native.get("secret-key"))).toBe("secret-value");
  });
}
