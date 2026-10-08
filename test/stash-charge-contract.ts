import { expect, it, vi } from "vitest";
import { Registry } from "../src/registry.js";
import { resultKeys, scopes, stashLedgerKeys } from "../src/storage/keys.js";
import type { KVStorage } from "../src/types.js";
import { silentLogger } from "./helpers.js";

/** SQL uses its own clock, so age its rows alongside the mocked stash clock. */
export function stashChargeContract(
  open: () => Promise<{ storage: KVStorage; advance?: (ms: number) => Promise<void> }>,
): void {
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
      const { storage: inner, advance } = await open();
      let clock = Date.now();
      const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
      const tick = async (ms: number) => {
        clock += ms;
        await advance?.(ms);
      };
      const charge = scopes.results + resultKeys.chunk("victim", 0);
      type Entry = [string, number, number];
      let reservation: string | undefined;
      const entries = (raw: string | null): Entry[] => (raw === null ? [] : JSON.parse(raw).entries);
      const capacity = releaseLosses + settlementLosses >= 64 ? 128 : transient ? 1 : 64;
      const make = (storage: KVStorage) =>
        new Registry([], {
          storage,
          logger: silentLogger,
          results: { maxStashEntries: capacity, maxStashBytes: capacity },
        });
      const competitor = make(inner);
      let competing = 0;
      let lostRelease = 0;
      let lostSettlement = 0;
      let errors = 0;
      const storage: KVStorage = {
        ...inner,
        async set(key, value, options) {
          if (slow && key === charge) await tick(31_000);
          await inner.set(key, value, options);
        },
        async compareAndSet(key, expected, next, options) {
          if (key === stashLedgerKeys.ledger) {
            reservation ??= entries(next).find((entry) => entry[2] === Number.MAX_SAFE_INTEGER)?.[0];
          }
          if (key === stashLedgerKeys.ledger && entries(expected).some((entry) => entry[0] === reservation)) {
            const victim = entries(next).find((entry) => entry[0] === reservation);
            if (transient && victim && victim[2] !== Number.MAX_SAFE_INTEGER && errors++ === 0) {
              throw new Error("transient settlement failure");
            }
            if (
              (!victim && lostRelease < releaseLosses) ||
              (victim && victim[2] !== Number.MAX_SAFE_INTEGER && lostSettlement < settlementLosses)
            ) {
              // A healthy second Registry commits a real stash between the
              // victim's read and CAS, reproducing the review's contention.
              expect(await competitor.stashResult(`competitor-${competing++}`, ["x"], 900)).toBe(true);
              if (victim) lostSettlement++;
              else lostRelease++;
            }
          }
          return inner.compareAndSet(key, expected, next, options);
        },
      };
      try {
        expect(await make(storage).stashResult("victim", ["x"], 900)).toBe(!slow);
        expect(lostRelease).toBe(releaseLosses);
        expect(lostSettlement).toBe(settlementLosses);
        if (transient) expect(errors).toBeGreaterThan(1);
        expect(await inner.get(charge)).toBe(slow ? null : "x");
        const victim = entries(await inner.get(stashLedgerKeys.ledger)).find((entry) => entry[0] === reservation)!;
        if (settlementLosses) {
          expect(victim[2]).toBe(Number.MAX_SAFE_INTEGER);
          expect(Number(await inner.get(stashLedgerKeys.completion(victim[0])))).toBeLessThan(Number.MAX_SAFE_INTEGER);
        } else {
          expect(victim[2]).toBeLessThan(Number.MAX_SAFE_INTEGER);
        }
        // A recovery read before expiry must keep every readable chunk charged.
        for (let index = competing + 1; index < capacity; index++) {
          expect(await make(inner).stashResult(`before-expiry-${index}`, ["x"], 900)).toBe(true);
        }
        expect(await make(inner).stashResult("still-full", ["x"], 900)).toBe(false);
        expect(await inner.get(charge)).toBe(slow ? null : "x");
        await tick(86_400_000);
        expect(await inner.get(charge)).toBeNull();
        // Recovery uses a new Registry and the unmodified underlying adapter.
        // Every slot must return, including the victim's formerly pinned slot.
        for (let index = 0; index < capacity; index++) {
          expect(await make(inner).stashResult(`recovered-${index}`, ["x"], 900)).toBe(true);
        }
        expect(await make(inner).stashResult("full", ["x"], 900)).toBe(false);
        expect(entries(await inner.get(stashLedgerKeys.ledger))).toHaveLength(capacity);
        expect(await inner.list(stashLedgerKeys.completion(""))).toEqual([]);
      } finally {
        now.mockRestore();
      }
    },
    60_000,
  );

  it("INV-7: retries a transient completion receipt error before settling", async () => {
    const { storage: inner, advance } = await open();
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    let failures = 0;
    const storage: KVStorage = {
      ...inner,
      async set(key, value, options) {
        if (key.startsWith(stashLedgerKeys.completion("")) && failures++ === 0)
          throw new Error("transient receipt failure");
        await inner.set(key, value, options);
      },
    };
    const make = (storage: KVStorage) =>
      new Registry([], {
        storage,
        logger: silentLogger,
        results: { maxStashEntries: 1, maxStashBytes: 1 },
      });
    try {
      expect(await make(storage).stashResult("first", ["x"], 900)).toBe(true);
      expect(failures).toBeGreaterThan(1);
      clock += 960_000;
      await advance?.(960_000);
      expect(await make(inner).stashResult("second", ["x"], 900)).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    { delay: 31_000, hold: 0, rejects: false, maxStashEntries: 1, maxStashBytes: 100 },
    { delay: 31_000, hold: 0, rejects: false, maxStashEntries: 100, maxStashBytes: 1 },
    { delay: 90_000, hold: 0, rejects: true, maxStashEntries: 1, maxStashBytes: 100 },
    { delay: 90_000, hold: 0, rejects: true, maxStashEntries: 100, maxStashBytes: 1 },
    { delay: 31_000, hold: 930_250, rejects: false, maxStashEntries: 1, maxStashBytes: 100 },
  ])(
    "INV-7: holds orphan capacity after a $delay ms write and failed cleanup (hold=$hold ms, $maxStashEntries entries, $maxStashBytes bytes, rejects=$rejects)",
    async ({ delay, hold, rejects, maxStashEntries, maxStashBytes }) => {
      const { storage: inner, advance } = await open();
      const start = Date.now();
      let clock = start;
      const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
      const tick = async (ms: number) => {
        clock += ms;
        await advance?.(ms);
      };
      let entered!: () => void;
      let finish!: () => void;
      const writing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const orphan = scopes.results + resultKeys.chunk("orphan", 0);
      const storage: KVStorage = {
        ...inner,
        async set(key, value, options) {
          if (key === orphan) {
            entered();
            await gate;
            await tick(delay);
          }
          await inner.set(key, value, options);
          if (key === orphan && rejects) throw new Error("write failed after persisting");
        },
        async delete() {
          throw new Error("cleanup unavailable");
        },
      };
      const registry = () =>
        new Registry([], {
          storage,
          logger: silentLogger,
          results: { maxStashEntries, maxStashBytes },
        });
      const first = registry().stashResult("orphan", ["x"], 900);
      try {
        await writing;
        // A pending write can persist later even after the original charge expires.
        if (hold) {
          await tick(hold);
          expect(await registry().stashResult("pending", ["x"], 900)).toBe(false);
        }
        finish();
        if (rejects) await expect(first).rejects.toThrow();
        else expect(await first).toBe(false);
        await tick(Math.max(0, start + 930_250 - clock));
        expect(await inner.get(orphan)).toBe("x");
        expect(await registry().stashResult("second", ["x"], 900)).toBe(false);
        await tick(start + hold + delay + 899_500 - clock);
        expect(await inner.get(orphan)).toBe("x");
        expect(await registry().stashResult("second", ["x"], 900)).toBe(false);
        await tick(32_000);
        expect(await inner.get(orphan)).toBeNull();
        expect(await registry().stashResult("second", ["x"], 900)).toBe(true);
      } finally {
        finish();
        await first.catch(() => undefined);
        now.mockRestore();
      }
    },
  );
}
