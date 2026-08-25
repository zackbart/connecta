import { required } from "./helpers.js";
import { describe, expect, it } from "vitest";
import {
  MAX_QUICKJS_LOG_TRANSPORT_BYTES,
  serializedBytes,
} from "../src/executors/quickjs-protocol.js";
import { trackedQuickJs as quickJsExecutor } from "./fixtures/node.js";

// The sandbox runs untrusted model-written code, so each captured log entry
// and the cumulative log buffer must be bounded at capture time — a guest
// can't be allowed to retain multiple GB of host memory via console.log.
const MAX_LOG_ENTRY_CHARS = 8_000;
const MAX_LOG_TOTAL_CHARS = 256_000;

function logTransportBytes(entry: string): number {
  return serializedBytes(JSON.stringify(JSON.stringify(entry)));
}

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
    expect(required(entry).startsWith("x".repeat(MAX_LOG_ENTRY_CHARS))).toBe(true);
    expect(required(entry).endsWith("…[entry truncated]")).toBe(true);
    // Bounded: the cap plus the short marker, nowhere near 25M chars.
    expect(required(entry).length).toBeLessThan(MAX_LOG_ENTRY_CHARS + 64);
  });

  // Allow a 10s cold-child startup plus 25 MB transport; 30s still matches the executor wall ceiling for hangs.
  it(
    "does not accumulate log characters beyond the cumulative budget",
    async () => {
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
      expect(total).toBeLessThan(
        MAX_LOG_TOTAL_CHARS + MAX_LOG_ENTRY_CHARS + 128,
      );
      expect(out.logs).toContain("[log truncated: size budget exceeded]");
    },
    30_000,
  );

  it("leaves small logs byte-for-byte unaffected", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute(
      `async () => { console.log("hello", { a: 1 }); console.warn("warned"); return null; }`,
      [],
    );
    expect(out.logs).toEqual(["hello {\"a\":1}", "warned"]);
  });

  it("preserves the result when escape-heavy logs reach the transport budget", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute(
      `async () => {
        const escaped = String.fromCharCode(1).repeat(8_000);
        for (let i = 0; i < 200; i++) console.log(escaped);
        return { value: "result survived" };
      }`,
      [],
    );

    expect(out.result).toEqual({ value: "result survived" });
    expect(out.error).toBeUndefined();
    expect(out.logs).toContain("[log truncated: size budget exceeded]");
    const transportBytes = out.logs!.reduce(
      (total, entry) => total + logTransportBytes(entry),
      0,
    );
    expect(transportBytes).toBeLessThanOrEqual(
      MAX_QUICKJS_LOG_TRANSPORT_BYTES,
    );
  });
});
