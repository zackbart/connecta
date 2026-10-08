import { expect, it, vi } from "vitest";
import { Registry } from "../src/registry.js";
import { resultKeys, scopes, stashLedgerKeys } from "../src/storage/keys.js";
import type { KVStorage } from "../src/types.js";
import { silentLogger } from "./helpers.js";

type Entry = [string, number, number];
const entries = (raw: string | null): Entry[] => (raw === null ? [] : JSON.parse(raw).entries);
const make = (storage: KVStorage, capacity = 1, maxBytes = capacity) =>
  new Registry([], { storage, logger: silentLogger, results: { maxStashEntries: capacity, maxStashBytes: maxBytes } });
const chunk = (id: string, index = 0) => scopes.results + resultKeys.chunk(id, index);
const WRITE_MS = 30_000;
const TTL_MS = 900_000;

/** SQL fixtures age rows and translate new absolute expiries with the mocked clock. */
export function stashChargeContract(
  open: () => Promise<{
    storage: KVStorage;
    advance?: (ms: number) => Promise<void>;
    expiries?: () => Promise<(number | null)[]>;
  }>,
): void {
  const clocked = async () => {
    const fixture = await open();
    let clock = Date.now();
    const start = clock;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    return {
      ...fixture,
      start,
      now: () => clock,
      restore: () => spy.mockRestore(),
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
  };

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
      const f = await clocked();
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
      const f = await clocked();
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
      const f = await clocked();
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
      const f = await clocked();
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
      const f = await clocked();
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
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
        vi.useRealTimers();
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
