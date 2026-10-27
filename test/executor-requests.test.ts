// Overlapping execute_code programs as separate native workerd requests,
// through the real Worker Loader executor and real TCP host calls (#1106).
// The fixture applies workerd's request binding of AsyncResource frames,
// which the pinned test runtime predates; set MINIFLARE_WORKERD_PATH to a
// workerd released after 2026-09-09 to run against the native check.
import { describe, expect, it } from "vitest";

const worker = await (async () => {
  try {
    const module = "cloudflare:test";
    const { env } = (await import(/* @vite-ignore */ module)) as { env: { EXECUTOR_REQUESTS?: Fetcher } };
    return env.EXECUTOR_REQUESTS;
  } catch {
    return undefined;
  }
})();

interface ToolResult {
  isError?: boolean;
  structuredContent: { result?: { data: { id: string } }[]; error?: Record<string, unknown> };
}

async function run(program: string, code: string, path = "/mcp"): Promise<ToolResult> {
  const response = await worker!.fetch(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Program": program,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: program,
      method: "tools/call",
      params: { name: "execute_code", arguments: { code } },
    }),
  });
  const text = await response.text();
  const line = text.split("\n").find((entry) => entry.startsWith("data: "));
  return (JSON.parse(line ? line.slice(6) : text) as { result: ToolResult }).result;
}

/** `calls` concurrent host calls, each a TCP request answered after `ms`. */
function parallelReads(program: string, calls: number, ms: number): string {
  return `async () => Promise.all(Array.from({ length: ${calls} }, (_, i) => connecta.call("slow.read", { id: "${program}-" + i, ms: ${ms} + i * 7 })))`;
}

interface Snapshot {
  active: number;
  queued: number;
  totals: { admitted: number; queued: number; rejected: number };
}
async function status(): Promise<{ standard: Snapshot; tight: Snapshot; failures: string[] }> {
  return (await worker!.fetch("http://localhost/status")).json();
}

describe.skipIf(!worker)("execute_code across separate Worker requests", () => {
  it("INV-7: a queued program resumes, calls and finishes in its own request, whichever request released its slot", async () => {
    const before = await status();
    const programs = Array.from({ length: 6 }, (_, i) => `queued${i}`);
    const results = await Promise.all(programs.map((p, i) => run(p, parallelReads(p, 3 + i, 300 + i * 40))));
    // Every program, including the two whose release handed a slot to a
    // queued one, returns its own host calls' answers.
    for (const [i, result] of results.entries()) {
      expect(result.structuredContent.error).toBeUndefined();
      expect(result.structuredContent.result?.map((entry) => entry.data.id)).toEqual(
        Array.from({ length: 3 + i }, (_, call) => `${programs[i]}-${call}`),
      );
    }
    const after = await status();
    expect(after.failures).toEqual([]);
    // Default Worker admission is two runs per isolate: four waited for a handoff.
    expect(after.standard.totals.admitted - before.standard.totals.admitted).toBe(6);
    expect(after.standard.totals.queued - before.standard.totals.queued).toBe(4);
    expect(after.standard.totals.rejected - before.standard.totals.rejected).toBe(0);
    expect(after.standard).toMatchObject({ active: 0, queued: 0 });
  }, 30_000);

  it("INV-7: admission refusals are structured and retryable while the running program finishes", async () => {
    const holding = run("holder", parallelReads("holder", 2, 2_500), "/tight/mcp");
    await expect.poll(async () => (await status()).tight.active, { timeout: 10_000 }).toBe(1);
    const timedOut = run("waiter", parallelReads("waiter", 1, 10), "/tight/mcp");
    await expect.poll(async () => (await status()).tight.queued, { timeout: 10_000 }).toBe(1);
    const full = await run("overflow", parallelReads("overflow", 1, 10), "/tight/mcp");
    expect(full).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "executor_overloaded", message: "Executor queue is full.", retryable: true, retryAfterMs: 750 },
      },
    });
    expect(await timedOut).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "executor_overloaded",
          message: "Executor admission timed out after 1000ms.",
          retryable: true,
          retryAfterMs: 750,
        },
      },
    });
    const held = await holding;
    expect(held.structuredContent.error).toBeUndefined();
    expect(held.structuredContent.result?.map((entry) => entry.data.id)).toEqual(["holder-0", "holder-1"]);
    // A retry after the hint is admitted.
    const retried = await run("retried", parallelReads("retried", 1, 10), "/tight/mcp");
    expect(retried.structuredContent.result?.map((entry) => entry.data.id)).toEqual(["retried-0"]);
    expect(await status()).toMatchObject({ tight: { active: 0, queued: 0 }, failures: [] });
  }, 30_000);
});
