import { describe, expect, it } from "vitest";
import { quickJsExecutor } from "../src/executors/quickjs.js";

// The sandbox runs untrusted model-written code, so each captured log entry
// and the cumulative log buffer must be bounded at capture time — a guest
// can't be allowed to retain multiple GB of host memory via console.log.
const MAX_LOG_ENTRY_CHARS = 8_000;
const MAX_LOG_TOTAL_CHARS = 256_000;

describe("quickJsExecutor log limits", () => {
  it("truncates a single huge log entry to the per-entry cap", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute(
      `async () => { console.log("x".repeat(25_000_000)); return null; }`,
      [],
    );
    expect(out.error).toBeUndefined();
    expect(out.logs).toHaveLength(1);
    const [entry] = out.logs!;
    expect(entry.startsWith("x".repeat(MAX_LOG_ENTRY_CHARS))).toBe(true);
    expect(entry.endsWith("…[entry truncated]")).toBe(true);
    // Bounded: the cap plus the short marker, nowhere near 25M chars.
    expect(entry.length).toBeLessThan(MAX_LOG_ENTRY_CHARS + 64);
  });

  it("does not accumulate log characters beyond the cumulative budget", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute(
      `async () => {
        const big = "x".repeat(25_000_000);
        for (let i = 0; i < 200; i++) console.log(big);
        return null;
      }`,
      [],
    );
    expect(out.error).toBeUndefined();
    const total = out.logs!.reduce((n, l) => n + l.length, 0);
    // Cumulative budget plus one over-budget entry and the final marker.
    expect(total).toBeLessThan(MAX_LOG_TOTAL_CHARS + MAX_LOG_ENTRY_CHARS + 128);
    expect(out.logs).toContain("[log truncated: size budget exceeded]");
  });

  it("leaves small logs byte-for-byte unaffected", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute(
      `async () => { console.log("hello", { a: 1 }); console.warn("warned"); return null; }`,
      [],
    );
    expect(out.logs).toEqual(["hello {\"a\":1}", "warned"]);
  });
});
