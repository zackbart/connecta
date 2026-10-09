import { expect, it, vi } from "vitest";
import { Clock, Duration, Effect, Random } from "effect";
import * as storageRuntime from "../src/runtime/storage.js";
import { Registry } from "../src/registry.js";
import { createConnecta, customExecutor } from "../src/index.js";
import { resultKeys, scopes, stashLedgerKeys, stashExpiryKeys } from "../src/storage/keys.js";
import type { KVStorage } from "../src/types.js";
import { silentLogger } from "./helpers.js";

type Entry = [string, number, number];
const entries = (raw: string | null): Entry[] => (raw === null ? [] : JSON.parse(raw).entries);
const make = (storage: KVStorage, capacity = 1, maxBytes = capacity) =>
  new Registry([], { storage, logger: silentLogger, results: { maxStashEntries: capacity, maxStashBytes: maxBytes } });
const chunk = (id: string, index = 0) => scopes.results + resultKeys.chunk(id, index);
const WRITE_MS = 30_000;
const COMPLETION_MS = 15_000;
const TTL_MS = 900_000;

type StashFixtureFactory = () => Promise<{
  storage: KVStorage;
  advance?: (ms: number) => Promise<void>;
  expiries?: () => Promise<(number | null)[]>;
}>;

/** SQL fixtures age rows and translate new absolute expiries with the mocked clock. */
async function clocked(open: StashFixtureFactory) {
  const fixture = await open();
  let clock = Date.now();
  const start = clock;
  let callerSkew = 0;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const liveClock = Clock.Clock.defaultValue();
  // Drive retry sleeps only after the preceding adapter I/O finishes. Advancing
  // while D1 is still answering would charge runner load against the budget.
  // Longer write/completion timers stay pending until explicitly advanced.
  let retryMs = 0;
  const testClock: Clock.Clock = {
    ...liveClock,
    currentTimeMillisUnsafe: () => clock + callerSkew,
    currentTimeMillis: Effect.sync(() => clock + callerSkew),
    currentTimeNanosUnsafe: () => BigInt(clock + callerSkew) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(clock + callerSkew) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
    sleep: (duration) => {
      const ms = Duration.toMillis(duration);
      if (ms > 250) return liveClock.sleep(duration);
      return Effect.promise(() => {
        retryMs += ms;
        return vi.advanceTimersByTimeAsync(ms);
      });
    },
  };
  const runOnPartition = storageRuntime.runOnPartition;
  const runner = vi.spyOn(storageRuntime, "runOnPartition").mockImplementation((effect, partition) =>
    runOnPartition(
      effect.pipe(
        Effect.provideService(Clock.Clock, testClock),
        // Exercise the largest possible retry windows, without random timing.
        Effect.provideService(Random.Random, { nextDoubleUnsafe: () => 0.999999, nextIntUnsafe: () => 0 }),
      ),
      partition,
    ),
  );
  return {
    ...fixture,
    start,
    now: () => clock,
    skewCaller: (ms: number) => {
      callerSkew = ms;
    },
    retryMs: () => retryMs,
    restore: () => {
      runner.mockRestore();
      vi.useRealTimers();
      spy.mockRestore();
    },
    tick: async (ms: number) => {
      clock += ms;
      await fixture.advance?.(ms);
    },
    boundedRows: async (deadline: number) => {
      for (const expiry of (await fixture.expiries?.()) ?? []) {
        expect(expiry).not.toBeNull();
        expect(expiry).toBeLessThanOrEqual(deadline);
      }
    },
  };
}

export function stashClockSkewContract(open: StashFixtureFactory): void {
  it("INV-7: refuses a second stash while its charge is live in storage despite an ahead caller clock", async () => {
    const f = await clocked(open);
    try {
      expect(await make(f.storage).stashResult("first", ["x"], 900)).toBe(true);
      const charged = entries(await f.storage.get(stashLedgerKeys.ledger));
      expect(charged).toHaveLength(1);
      // Leave ample database-time margin; only the injected Effect clock runs
      // past the charge deadline. Memory's Date clock remains independent too.
      await f.tick(TTL_MS - 60_000);
      f.skewCaller(120_000);
      expect(await f.storage.get(chunk("first"))).toBe("x");
      expect(await make(f.storage).stashResult("second", ["x"], 900)).toBe(false);
      expect(await f.storage.get(chunk("first"))).toBe("x");
      expect(await f.storage.get(chunk("second"))).toBeNull();
      expect(entries(await f.storage.get(stashLedgerKeys.ledger))).toEqual(charged);
      expect(await f.storage.get(stashExpiryKeys.deadline(charged[0]![2]))).toBe("live");
      // Storage expiry, not the caller's skew, eventually frees the slot.
      await f.tick(120_000);
      expect(await f.storage.get(chunk("first"))).toBeNull();
      expect(await f.storage.get(stashExpiryKeys.deadline(charged[0]![2]))).toBeNull();
      f.skewCaller(0);
      expect(await make(f.storage).stashResult("recovered", ["x"], 900)).toBe(true);
    } finally {
      f.restore();
    }
  });
}

export function stashChargeContract(open: StashFixtureFactory): void {
  stashClockSkewContract(open);

  it("INV-7: prunes an expired charge from a still-live ledger with aligned clocks", async () => {
    const f = await clocked(open);
    try {
      expect(await make(f.storage, 2).stashResult("short", ["x"], 60)).toBe(true);
      const short = entries(await f.storage.get(stashLedgerKeys.ledger))[0]!;
      expect(await make(f.storage, 2).stashResult("long", ["x"], 900)).toBe(true);
      const long = entries(await f.storage.get(stashLedgerKeys.ledger))[1]!;
      await f.tick(120_000);
      expect(await f.storage.get(chunk("short"))).toBeNull();
      expect(await f.storage.get(chunk("long"))).toBe("x");
      expect(await make(f.storage, 2).stashResult("replacement", ["x"], 900)).toBe(true);
      const charged = entries(await f.storage.get(stashLedgerKeys.ledger));
      expect(charged).toHaveLength(2);
      expect(charged).toContainEqual(long);
      expect(charged).not.toContainEqual(short);
      expect(await f.storage.get(stashExpiryKeys.deadline(short[2]))).toBeNull();
      expect(await make(f.storage, 2).stashResult("full", ["x"], 900)).toBe(false);
    } finally {
      f.restore();
    }
  });

  it("INV-11: rejects a legacy ttlSeconds-only adapter at construction", async () => {
    const { storage: inner } = await open();
    const legacy = {
      get: inner.get,
      set: (key: string, value: string, opts?: { ttlSeconds?: number }) =>
        inner.set(key, value, opts?.ttlSeconds === undefined ? undefined : { ttlSeconds: opts.ttlSeconds }),
      delete: inner.delete,
      list: inner.list,
      compareAndSet: (key: string, expected: string | null, next: string | null, opts?: { ttlSeconds?: number }) =>
        inner.compareAndSet(
          key,
          expected,
          next,
          opts?.ttlSeconds === undefined ? undefined : { ttlSeconds: opts.ttlSeconds },
        ),
    };
    const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });
    // @ts-expect-error old method signatures lack the required capability opt-in
    const config: Parameters<typeof createConnecta>[0] = { connectors: [], executor, storage: legacy };
    expect(() => createConnecta(config)).toThrow("storage must declare capabilities.absoluteExpiry: true");
    expect(await inner.list("")).toEqual([]);
    const app = createConnecta({ connectors: [], executor, storage: inner, logger: "silent" });
    expect(await app.registry.stashResult("supported", ["x"], 900)).toBe(true);
    await app.close();
  });

  it.each([0, 1])("INV-7: retains a rejected write's charge through its late chunk %s commit", async (index) => {
    const f = await clocked(open);
    const inner = f.storage;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let late: Promise<void> | undefined;
    let deletions = 0;
    const storage: KVStorage = {
      ...inner,
      async set(key, value, options) {
        if (key === chunk("rejected", index)) {
          // The client response fails while the already-dispatched backend is pending.
          late = gate.then(() => inner.set(key, value, options));
          throw new Error("response rejected before backend commit");
        }
        await inner.set(key, value, options);
      },
      async delete(key) {
        deletions++;
        await inner.delete(key);
      },
    };
    try {
      await expect(make(storage, 1, 2).stashResult("rejected", ["h", "x"], 900)).rejects.toThrow("response rejected");
      expect(deletions).toBe(2);
      expect(await inner.list(scopes.results)).toEqual([]);
      expect(entries(await inner.get(stashLedgerKeys.ledger))).toEqual([
        [expect.any(String), 2, f.start + WRITE_MS + TTL_MS],
      ]);
      expect(await make(inner, 1, 2).stashResult("replacement", ["x"], 900)).toBe(false);
      finish();
      await late;
      expect(await inner.get(chunk("rejected", index))).toBe(index === 0 ? "h" : "x");
      expect(await inner.list(scopes.results)).toHaveLength(1);
      await f.tick(TTL_MS - 1_000);
      expect(await inner.get(chunk("rejected", index))).not.toBeNull();
      expect(await make(inner, 1, 2).stashResult("still-full", ["x"], 900)).toBe(false);
      await f.tick(WRITE_MS + 1_001);
      expect(await inner.list("")).toEqual([]);
      expect(await make(inner, 1, 2).stashResult("recovered", ["x"], 900)).toBe(true);
    } finally {
      finish();
      await late;
      f.restore();
    }
  });

  it.each(["timeout", "rejection"])(
    "INV-7: returns within the cleanup budget with stalled deletion after %s",
    async (failure) => {
      const f = await clocked(open);
      const inner = f.storage;
      let entered!: () => void, finishWrite!: () => void, deleting!: () => void, finishDelete!: () => void;
      const writing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const writeGate = new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
      const cleanup = new Promise<void>((resolve) => {
        deleting = resolve;
      });
      const deleteGate = new Promise<void>((resolve) => {
        finishDelete = resolve;
      });
      let lateWrite: Promise<void> | undefined, lateDelete: Promise<void> | undefined;
      let deletions = 0,
        ledgerWrites = 0;
      const storage: KVStorage = {
        ...inner,
        async set(key, value, options) {
          entered();
          if (failure === "rejection") throw new Error("unconfirmed write failure");
          lateWrite = writeGate.then(() => inner.set(key, value, options));
          await lateWrite;
        },
        async delete(key) {
          deletions++;
          deleting();
          lateDelete = deleteGate.then(() => inner.delete(key));
          await lateDelete;
        },
        async compareAndSet(...args) {
          ledgerWrites++;
          return inner.compareAndSet(...args);
        },
      };
      let outcome: boolean | "rejected" | undefined;
      const first = make(storage, 1, 2)
        .stashResult("stalled", ["h", "x"], 900)
        .then(
          (value) => {
            outcome = value;
          },
          () => {
            outcome = "rejected";
          },
        );
      try {
        await writing;
        if (failure === "timeout") {
          await f.tick(WRITE_MS);
          await vi.advanceTimersByTimeAsync(WRITE_MS);
        }
        await cleanup;
        await vi.advanceTimersByTimeAsync(COMPLETION_MS - 1);
        expect(outcome).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(outcome).toBe(failure === "timeout" ? false : "rejected");
        await first;
        expect(entries(await inner.get(stashLedgerKeys.ledger))[0]![2]).toBe(f.start + WRITE_MS + TTL_MS);
        expect(await make(inner, 1, 2).stashResult("still-full", ["x"], 900)).toBe(false);
        finishDelete();
        await lateDelete;
        finishWrite();
        await lateWrite;
        // Completing abandoned adapter promises cannot start more cleanup or ledger I/O.
        expect(deletions).toBe(1);
        expect(ledgerWrites).toBe(1);
        expect(await inner.get(chunk("stalled"))).toBeNull();
        await f.tick(WRITE_MS + TTL_MS + 1);
        expect(await inner.list("")).toEqual([]);
        expect(await make(inner, 1, 2).stashResult("recovered", ["x"], 900)).toBe(true);
      } finally {
        finishDelete();
        finishWrite();
        await Promise.all([first, lateWrite, lateDelete]);
        f.restore();
      }
    },
    30_000,
  );

  it.each(["get", "compareAndSet"] as const)(
    "INV-7: returns within the settlement budget with stalled %s",
    async (operation) => {
      const f = await clocked(open);
      const inner = f.storage;
      let entered!: () => void, finish!: () => void;
      const settling = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let written = false,
        ledgerReads = 0,
        ledgerWrites = 0;
      let late: Promise<unknown> | undefined;
      const storage: KVStorage = {
        ...inner,
        async set(...args) {
          await inner.set(...args);
          written = true;
        },
        async get(key) {
          ledgerReads++;
          if (written && operation === "get") {
            entered();
            late = gate.then(() => inner.get(key));
            return (await late) as string | null;
          }
          return inner.get(key);
        },
        async compareAndSet(...args) {
          ledgerWrites++;
          if (written && operation === "compareAndSet") {
            entered();
            late = gate.then(() => inner.compareAndSet(...args));
            return (await late) as boolean;
          }
          return inner.compareAndSet(...args);
        },
      };
      let outcome: boolean | undefined;
      const first = make(storage)
        .stashResult("settling", ["x"], 900)
        .then((value) => {
          outcome = value;
        });
      try {
        await settling;
        await vi.advanceTimersByTimeAsync(COMPLETION_MS - 1);
        expect(outcome).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(outcome).toBe(true);
        await first;
        expect(await inner.get(chunk("settling"))).toBe("x");
        expect(entries(await inner.get(stashLedgerKeys.ledger))[0]![2]).toBe(f.start + WRITE_MS + TTL_MS);
        expect(await make(inner).stashResult("still-full", ["x"], 900)).toBe(false);
        const counts = [ledgerReads, ledgerWrites];
        finish();
        await late;
        expect([ledgerReads, ledgerWrites]).toEqual(counts);
        await f.tick(WRITE_MS + TTL_MS + 1);
        expect(await inner.list("")).toEqual([]);
        expect(await make(inner).stashResult("recovered", ["x"], 900)).toBe(true);
      } finally {
        finish();
        await Promise.all([first, late]);
        f.restore();
      }
    },
    30_000,
  );

  it.each([
    { name: "contention-exhausted settlement", slow: false, releaseLosses: 0, settlementLosses: 32, transient: false },
    { name: "single transient settlement error", slow: false, releaseLosses: 0, settlementLosses: 0, transient: true },
    {
      name: "slow write, successful deletion and lost release comparisons",
      slow: true,
      releaseLosses: 32,
      settlementLosses: 0,
      transient: false,
    },
    {
      name: "exhausted release and fallback settlement",
      slow: true,
      releaseLosses: 32,
      settlementLosses: 32,
      transient: false,
    },
  ])(
    "INV-7: recovers stash capacity after $name",
    async ({ slow, releaseLosses, settlementLosses, transient }) => {
      const f = await clocked(open);
      const inner = f.storage;
      let reservation: string | undefined;
      let booked = 0;
      const capacity = releaseLosses + settlementLosses >= 64 ? 128 : transient ? 1 : 64;
      const competitor = make(inner, capacity);
      let competing = 0,
        lostRelease = 0,
        lostSettlement = 0,
        errors = 0;
      const storage: KVStorage = {
        ...inner,
        async set(key, value, options) {
          if (slow && key === chunk("victim")) await f.tick(31_000);
          await inner.set(key, value, options);
        },
        async compareAndSet(key, expected, next, options) {
          if (key === stashLedgerKeys.ledger) {
            const own = entries(next).find((entry) => !entries(expected).some((old) => old[0] === entry[0]));
            if (reservation === undefined && own) {
              reservation = own[0];
              booked = own[2];
            }
            if (entries(expected).some((entry) => entry[0] === reservation)) {
              const victim = entries(next).find((entry) => entry[0] === reservation);
              if (transient && victim && victim[2] < booked && errors++ === 0)
                throw new Error("transient settlement failure");
              if (
                (!victim && lostRelease < releaseLosses) ||
                (victim && victim[2] < booked && lostSettlement < settlementLosses)
              ) {
                // A real competing stash commits between the victim's read and CAS.
                expect(await competitor.stashResult(`competitor-${competing++}`, ["x"], 900)).toBe(true);
                if (victim) lostSettlement++;
                else lostRelease++;
              }
            }
          }
          return inner.compareAndSet(key, expected, next, options);
        },
      };
      try {
        expect(await make(storage, capacity).stashResult("victim", ["x"], 900)).toBe(!slow);
        expect(lostRelease).toBe(releaseLosses);
        expect(lostSettlement).toBe(settlementLosses);
        expect(f.retryMs()).toBeLessThan(COMPLETION_MS);
        if (transient) expect(errors).toBeGreaterThan(1);
        expect(await inner.get(chunk("victim"))).toBe(slow ? null : "x");
        const victim = entries(await inner.get(stashLedgerKeys.ledger)).find((entry) => entry[0] === reservation)!;
        expect(booked).toBe(f.start + WRITE_MS + TTL_MS);
        expect(victim[2]).toBe(settlementLosses ? booked : f.start + TTL_MS);
        for (let index = competing + 1; index < capacity; index++) {
          expect(await make(inner, capacity).stashResult(`before-expiry-${index}`, ["x"], 900)).toBe(true);
        }
        expect(await make(inner, capacity).stashResult("still-full", ["x"], 900)).toBe(false);
        const latest = entries(await inner.get(stashLedgerKeys.ledger)).reduce(
          (end, entry) => Math.max(end, entry[2]),
          booked,
        );
        await f.boundedRows(latest);
        await f.tick(booked - f.now() + 1);
        expect(await inner.get(chunk("victim"))).toBeNull();
        expect(
          entries(await inner.get(stashLedgerKeys.ledger)).filter(
            (entry) => entry[0] === reservation && entry[2] > f.now(),
          ),
        ).toEqual([]);
        await f.tick(Math.max(0, latest - f.now() + 1));
        expect(await inner.list("")).toEqual([]);
        for (let index = 0; index < capacity; index++) {
          expect(await make(inner, capacity).stashResult(`recovered-${index}`, ["x"], 900)).toBe(true);
        }
        expect(await make(inner, capacity).stashResult("full", ["x"], 900)).toBe(false);
        expect(entries(await inner.get(stashLedgerKeys.ledger))).toHaveLength(capacity);
      } finally {
        f.restore();
      }
    },
    60_000,
  );

  it.each([
    { capacity: 1, final: false, confirmFails: false },
    { capacity: 2, final: false, confirmFails: false },
    { capacity: 1, final: true, confirmFails: false },
    { capacity: 2, final: true, confirmFails: false },
    { capacity: 1, final: true, confirmFails: true },
  ])(
    "INV-7: books an ambiguous CAS once (capacity=$capacity, final=$final, confirmFails=$confirmFails)",
    async ({ capacity, final, confirmFails }) => {
      const f = await clocked(open);
      const inner = f.storage;
      let attempts = 0,
        commits = 0;
      let booked = 0;
      let ambiguous = false;
      const storage: KVStorage = {
        ...inner,
        async get(key) {
          if (confirmFails && ambiguous && key === stashLedgerKeys.ledger) throw new Error("confirmation unavailable");
          return inner.get(key);
        },
        async compareAndSet(key, expected, next, options) {
          if (key === stashLedgerKeys.ledger && !ambiguous) {
            if (final && ++attempts < 32) return false;
            expect(await inner.compareAndSet(key, expected, next, options)).toBe(true);
            commits++;
            booked = entries(next)[0]![2];
            ambiguous = true;
            await f.tick(5_000);
            throw new Error("committed but response failed");
          }
          return inner.compareAndSet(key, expected, next, options);
        },
      };
      try {
        expect(await make(storage, capacity).stashResult("first", ["x"], 900)).toBe(!confirmFails);
        expect(commits).toBe(1);
        expect(booked).toBe(f.start + WRITE_MS + TTL_MS);
        const live = entries(await inner.get(stashLedgerKeys.ledger));
        expect(live).toHaveLength(1);
        expect(live[0]![2]).toBe(confirmFails ? booked : booked - WRITE_MS);
        expect(await inner.get(chunk("first"))).toBe(confirmFails ? null : "x");
        expect(await inner.list(stashLedgerKeys.family.prefixes[0])).toEqual([stashLedgerKeys.ledger]);
        if (capacity === 2) expect(await make(inner, capacity).stashResult("second", ["x"], 900)).toBe(true);
        expect(await make(inner, capacity).stashResult("full", ["x"], 900)).toBe(false);
        await f.boundedRows(booked);
        await f.tick(booked - f.now() + 1);
        expect(await inner.list("")).toEqual([]);
        expect(await make(inner, capacity).stashResult("recovered", ["x"], 900)).toBe(true);
      } finally {
        f.restore();
      }
    },
    30_000,
  );

  it.each(["failed cleanup", "interrupted settlement"])(
    "INV-7: leaves no completion rows after %s",
    async (failure) => {
      const f = await clocked(open);
      const inner = f.storage;
      let deletionAttempts = 0;
      let interrupted = false;
      const storage: KVStorage = {
        ...inner,
        async set(key, value, options) {
          // No separate completion writes exist, even when their storage fails.
          expect(key.startsWith(stashLedgerKeys.family.prefixes[0])).toBe(false);
          await inner.set(key, value, options);
        },
        async get(key) {
          if (interrupted && key === stashLedgerKeys.ledger)
            throw new Error("process unavailable after settlement commit");
          return inner.get(key);
        },
        async delete() {
          deletionAttempts++;
          throw new Error("cleanup failed");
        },
        async compareAndSet(key, expected, next, options) {
          const applied = await inner.compareAndSet(key, expected, next, options);
          if (failure === "interrupted settlement" && applied && entries(expected).length) {
            interrupted = true;
            throw new Error("interrupted after settlement commit");
          }
          return applied;
        },
      };
      try {
        expect(await make(storage).stashResult("first", ["x"], 900)).toBe(true);
        expect(deletionAttempts).toBe(0);
        expect(await inner.list(stashLedgerKeys.family.prefixes[0])).toEqual([stashLedgerKeys.ledger]);
        await f.boundedRows(f.start + TTL_MS);
        await f.tick(TTL_MS + WRITE_MS + 1);
        expect(await inner.list("")).toEqual([]);
        expect(await make(inner).stashResult("recovered", ["x"], 900)).toBe(true);
      } finally {
        f.restore();
      }
    },
    30_000,
  );

  it.each([
    { delay: 31_000, rejects: false, capacity: 1, maxBytes: 100 },
    { delay: 31_000, rejects: false, capacity: 100, maxBytes: 1 },
    { delay: 90_000, rejects: true, capacity: 1, maxBytes: 100 },
    { delay: 90_000, rejects: true, capacity: 100, maxBytes: 1 },
  ])(
    "INV-7: holds orphan capacity after a $delay ms write and failed cleanup ($capacity entries, $maxBytes bytes, rejects=$rejects)",
    async ({ delay, rejects, capacity, maxBytes }) => {
      const f = await clocked(open);
      const inner = f.storage;
      const storage: KVStorage = {
        ...inner,
        async set(key, value, options) {
          if (key === chunk("orphan")) await f.tick(delay);
          await inner.set(key, value, options);
          if (key === chunk("orphan") && rejects) throw new Error("write failed after persisting");
        },
        async delete() {
          throw new Error("cleanup unavailable");
        },
      };
      try {
        const first = make(storage, capacity, maxBytes).stashResult("orphan", ["x"], 900);
        if (rejects) await expect(first).rejects.toThrow();
        else expect(await first).toBe(false);
        expect(await inner.get(chunk("orphan"))).toBe("x");
        expect(await make(inner, capacity, maxBytes).stashResult("full", ["x"], 900)).toBe(false);
        await f.boundedRows(f.start + WRITE_MS + TTL_MS);
        await f.tick(f.start + TTL_MS - 1_000 - f.now());
        expect(await inner.get(chunk("orphan"))).toBe("x");
        expect(await make(inner, capacity, maxBytes).stashResult("still-full", ["x"], 900)).toBe(false);
        await f.tick(WRITE_MS + 1_001);
        expect(await inner.list("")).toEqual([]);
        expect(await make(inner, capacity, maxBytes).stashResult("recovered", ["x"], 900)).toBe(true);
      } finally {
        f.restore();
      }
    },
  );

  it.each([false, true])(
    "INV-7: aborts a pending write within 30 seconds and bounds its late commit (cleanupFails=%s)",
    async (cleanupFails) => {
      const f = await clocked(open);
      const inner = f.storage;
      let entered!: () => void, finish!: () => void;
      const writing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let committed!: () => void;
      const late = new Promise<void>((resolve) => {
        committed = resolve;
      });
      const storage: KVStorage = {
        ...inner,
        async set(key, value, options) {
          if (key === chunk("pending", 1)) {
            entered();
            await gate;
          }
          await inner.set(key, value, options);
          if (key === chunk("pending", 1)) committed();
        },
        async delete(key) {
          if (cleanupFails) throw new Error("cleanup unavailable");
          await inner.delete(key);
        },
      };
      const first = make(storage, 1, 2).stashResult("pending", ["h", "x"], 900);
      try {
        await writing;
        await f.tick(WRITE_MS - 1);
        expect(await make(inner, 1, 2).stashResult("full", ["x"], 900)).toBe(false);
        await f.tick(1);
        await vi.advanceTimersByTimeAsync(WRITE_MS);
        expect(await first).toBe(false);
        expect(entries(await inner.get(stashLedgerKeys.ledger))[0]![2]).toBe(f.start + WRITE_MS + TTL_MS);
        expect(await inner.get(chunk("pending"))).toBeNull();
        expect(await make(inner, 1, 2).stashResult("still-full", ["x"], 900)).toBe(false);
        await f.tick(TTL_MS + 1);
        expect(await inner.list("")).toEqual([]);
        finish();
        await late;
        expect(await inner.list("")).toEqual([]);
        await f.boundedRows(f.start + WRITE_MS + TTL_MS);
        expect(await make(inner, 1, 2).stashResult("recovered", ["x"], 900)).toBe(true);
      } finally {
        finish();
        await first.catch(() => undefined);
        f.restore();
      }
    },
    30_000,
  );

  it("INV-7: admits exactly one of 16 concurrent bookings at capacity one", async () => {
    const { storage } = await open();
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) => make(storage).stashResult(`claim-${index}`, ["x"], 900)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(entries(await storage.get(stashLedgerKeys.ledger))).toHaveLength(1);
    expect(await storage.list(scopes.results)).toHaveLength(1);
  });
}
