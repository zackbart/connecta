import { expect, it, vi } from "vitest";
import { Registry } from "../src/registry.js";
import { resultKeys, scopes } from "../src/storage/keys.js";
import type { KVStorage } from "../src/types.js";
import { silentLogger } from "./helpers.js";

/** SQL uses its own clock, so age its rows alongside the mocked stash clock. */
export function stashChargeContract(
  open: () => Promise<{ storage: KVStorage; advance?: (ms: number) => Promise<void> }>,
): void {
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
