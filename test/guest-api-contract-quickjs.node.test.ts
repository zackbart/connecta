// Node-only: runs the guest API contract cases on the Node QuickJS executor.
// The QuickJS arm of the guest API contract. The same case table runs against
// the Dynamic Worker executor in test/guest-api-contract.test.ts.

import { afterAll, describe, expect, it, vi } from "vitest";
import { createExecuteTool } from "../src/execute.js";
import { customExecutor } from "../src/executor-contract.js";
import { quickJsExecutor } from "../src/executors/quickjs.js";
import { createMetaTools } from "../src/meta-tools.js";
import { USAGE_SKILL } from "../src/usage-guide.js";
import { checkAuthHandoffProgram } from "./fixtures/authorization-handoff.js";
import {
  CAPABILITY_PROBE_CODE,
  caseConfig,
  checkHostFailureArrays,
  checkNativeSnapshots,
  checkProgramReadDependencies,
  checkProgramVisibilityDependencies,
  checkQueuedWriteAtExhaustion,
  checkSharedPreludes,
  checkStashAuthority,
  checkWriteDeadlineDiagnostics,
  CONTRACT_CASES,
  contractHarness,
} from "./guest-contract-cases.js";
import { makeRegistry, required, silentLogger } from "./helpers.js";
import {
  checkLargeProgramRead,
  checkLargeProgramWrite,
  checkProgramPagingFailure,
  checkProgramResultBom,
  checkProgramResultSurrogates,
  checkProgramReturnFallback,
  checkProgramReturnPaging,
  checkProgramReturnWriteWarning,
} from "./program-result-cases.js";

// Every case here drives a real QuickJS child process, whose startup and IPC
// are wall-clock nothing here can fake: on a loaded host they outran vitest's
// 5s default with no behavior at fault. This file budget is a hang guard. The
// deadlines a case pins are the executor's own, asserted on its outcome.
vi.setConfig({ testTimeout: 20_000 });

// A generous guest-CPU budget: these programs loop and stringify, and the
// clause under test is never the 250ms default.
const executor = quickJsExecutor({ cpuTimeMs: 5_000 });
const deadlineExecutor = quickJsExecutor({
  timeoutMs: 500,
  cpuTimeMs: 5_000,
});

afterAll(async () => {
  await executor.close?.();
  await deadlineExecutor.close?.();
});

describe("guest API contract (QuickJS executor)", () => {
  it("INV-4 INV-5 INV-7: program error data carries a reusable handoff that completes OAuth", async () => {
    // The deployment fixture owns its executor and closes it with the app.
    await checkAuthHandoffProgram(quickJsExecutor({ cpuTimeMs: 5_000 }));
  });
  it("INV-2 INV-3 INV-4: program return pages recheck identity, endpoint, pool membership and live authentication", async () => {
    await checkStashAuthority(executor, true);
  });

  for (const custom of [false, true]) {
    it(`INV-3 INV-4: ${custom ? "customExecutor: " : ""}unresolved failures and local guides retain connector visibility on return pages`, async () => {
      await checkProgramVisibilityDependencies(
        custom ? customExecutor(executor, { lifecycle: "self-managed" }) : executor,
      );
    });
    it(`INV-3 INV-4: ${custom ? "customExecutor: " : ""}skill and catalog return pages stay bound to their endpoint and live authentication`, async () => {
      await checkProgramReadDependencies(custom ? customExecutor(executor, { lifecycle: "self-managed" }) : executor);
    });
    it(`INV-2 INV-9: ${custom ? "customExecutor: " : ""}return paging warns only about writes completed in this run`, async () => {
      await checkProgramReturnWriteWarning(custom ? customExecutor(executor, { lifecycle: "self-managed" }) : executor);
    });
  }

  it("INV-2 INV-5 INV-9: oversized returns page completely after exactly one recorded write", async () => {
    await checkProgramReturnPaging(executor);
  });
  it("INV-2 INV-9: unavailable return paging preserves success and a bounded fallback", async () => {
    await checkProgramReturnFallback(executor);
  });

  it("INV-3 INV-7: native snapshots prevent mutation budget bypass and cross-run leakage", async () => {
    const concurrent = quickJsExecutor({ concurrency: 2, cpuTimeMs: 5_000 });
    try {
      await checkNativeSnapshots(concurrent);
    } finally {
      await concurrent.close?.();
    }
  });
  it("INV-9: lone surrogates refuse raw-text paging without replaying writes and round-trip as JSON", async () => {
    await checkProgramResultSurrogates(executor);
  });
  it("INV-9: program reconstruction and direct pages preserve leading and page-boundary U+FEFF after one write", async () => {
    await checkProgramResultBom(executor);
  });
  it("INV-3 INV-9: oversized program reads arrive whole through bounded stash pages", async () => {
    await checkLargeProgramRead(executor);
  });
  it("INV-2 INV-9: oversized program writes run once and return a shared pageable handle", async () => {
    await checkLargeProgramWrite(executor);
  });
  it("INV-7 INV-9: paging failures preserve completed write accounting and never replay the write", async () => {
    await checkProgramPagingFailure(executor);
  });
  it("[L4, W9] cancels an exempt write queued at exhaustion", async () => {
    await checkQueuedWriteAtExhaustion(executor);
  });
  for (const custom of [false, true]) {
    it(`INV-3 INV-6: ${custom ? "customExecutor: " : ""}codec array hooks cannot change host validation and repair`, async () => {
      await checkHostFailureArrays(custom ? customExecutor(executor, { lifecycle: "self-managed" }) : executor);
    });
    it(`INV-6 INV-7 INV-9: ${custom ? "customExecutor: " : ""}dispatched write timeouts retain diagnostics through caught guest errors`, async () => {
      await checkWriteDeadlineDiagnostics(custom ? customExecutor(executor, { lifecycle: "self-managed" }) : executor);
    });
    it(`INV-2 INV-3 INV-4: ${custom ? "customExecutor: " : ""}stash pages enforce bindings, pool membership and live authentication`, async () => {
      await checkStashAuthority(custom ? customExecutor(executor, { lifecycle: "self-managed" }) : executor);
    });
    it(`INV-3: ${custom ? "customExecutor: " : ""}provider preludes retain shared lexical bindings`, async () => {
      await checkSharedPreludes(custom ? customExecutor(executor, { lifecycle: "self-managed" }) : executor);
    });
  }
  const duplicateCases = new Set([
    "INV-3: Luna's exact p5-direct-rich-output program emits the badge and caption",
    "INV-3: object and positional calls declare JSON versus text",
    "INV-3: malformed calls fail with the exact supported signatures",
    "INV-6: rethrown required-field validation messages keep plain JavaScript guidance",
    "INV-3: plain downstream text declares its format",
    "TypeScript syntax is not JavaScript and does not run",
    "a trailing semicolon after the arrow expression is accepted",
    "one fenced program surrounded by prose runs on both executors",
    "a named async declaration keeps recursion and its arguments binding",
    "canonical addresses preserve punctuation",
    "unknown addresses and unknown tools are distinguishable",
    "a conflict carries where things stand, bounded, into the program",
    "program discovery defaults to JSON and labels compact schemas as text",
    "search returns guide and code-mode key metadata on flat rows",
    "an unfiltered browse enumerates the deployment's connectors",
    "describe answers per address and reports bad ones inline",
    "a small result reaches the model byte-identical and unadorned",
    "an oversized result truncates once, successfully, and honestly",
    "console output is captured in order",
    "logs survive a failing program",
    "a policy refusal stays non-retryable however the address reads",
    "every refusal is an event, including one at an address nothing owns",
    "emitted blocks are delivered after the envelope, in order",
    "an invalid emit throws catchably and accepts nothing",
    "utility validation and budget failures use distinct codes",
    "pins the portable ambient-authority boundary",
    "INV-6: program errors repair fs.readFile('secret')",
    "INV-6: program errors repair callTool('reader.read')",
    "INV-6: program errors repair callTool.query()",
    "INV-6: program errors repair skills()",
    "INV-6: program errors repair await connecta.guide('usage')",
  ]);
  for (const contractCase of CONTRACT_CASES.filter(({ name }) => !duplicateCases.has(name))) {
    it(`[${contractCase.clauses}] ${contractCase.name}`, async () => {
      const harness = contractHarness(contractCase.maxStashEntries);
      const base = contractCase.deadline ? deadlineExecutor : executor;
      const config = caseConfig(contractCase);
      const outcome = await harness.run(base, contractCase.code, config);
      const follow = contractCase.follows ? await harness.run(base, contractCase.follows, config) : undefined;
      contractCase.check(outcome, harness.state, follow);
    });
  }

  describe("the whole-result loop a truncated read offers", () => {
    const BASE = "https://connecta.loop";
    const run = async (text: string, options: { maxHostCalls?: number; maxResultBytes?: number } = {}) => {
      const calls = { reads: 0 };
      const registry = makeRegistry(
        [
          {
            id: "logs",
            kind: "api",
            ...(options.maxResultBytes ? { maxResultBytes: options.maxResultBytes } : {}),
            listTools: async () => [{ name: "read", annotations: { readOnlyHint: true } }],
            callTool: async () => {
              calls.reads++;
              return text;
            },
          },
        ],
        {},
      );
      const notice = JSON.parse(
        required(
          (
            await createMetaTools(
              registry,
              BASE,
              options.maxHostCalls ? { maxProgramHostCalls: options.maxHostCalls } : {},
            ).callTool({ address: "logs.read" })
          ).content[0],
        ).text!.split("\n")[0]!,
      ) as { hint: string; resultId: string; totalBytes: number };
      const loop = async () =>
        JSON.parse(
          required(
            (
              await createExecuteTool(
                registry,
                BASE,
                executor,
                silentLogger,
                undefined,
                options.maxHostCalls ? { maxHostCalls: options.maxHostCalls } : {},
              )({
                code: `async () => {
                  let text = "", offset = 0, page;
                  do {
                    page = await connecta.result(${JSON.stringify(notice.resultId)}, { offset });
                    text += page.text;
                    offset = page.nextOffset;
                  } while (page.hasMore);
                  return { length: text.length };
                }`,
              })
            ).content[0],
          ).text!,
        ) as { result?: { length: number }; error?: { code: string }; hostCalls: { attempted: number } };
      return { notice, loop, calls };
    };
    // 18 pages of 23,997 bytes is the last size offered at the default 24,000-byte cap and 20 calls.
    const LARGEST_OFFERED = 18 * 23_997;

    it.each([
      ["a small overflow", 30_000, "x"],
      ["the near-limit size", LARGEST_OFFERED, "x"],
      ["three-byte characters that shorten every page", LARGEST_OFFERED, "\u20ac"],
    ])("[L4] completes inside the budget for %s", async (_label, bytes, unit) => {
      // A downstream string is retained in its JSON form, two quotes longer.
      const text = unit!.repeat(Math.floor((bytes - 2) / new TextEncoder().encode(unit).length));
      const { notice, loop, calls } = await run(text);
      expect(notice.hint).toContain(`loop connecta.result(${JSON.stringify(notice.resultId)}, { offset })`);
      expect(notice.hint).toContain("retained for 15 minutes");
      expect(notice.hint).not.toContain("repeat this read");
      const looped = await loop();
      expect(looped.error).toBeUndefined();
      expect(looped.result?.length).toBe(text.length + 2);
      expect(looped.hostCalls.attempted).toBeLessThanOrEqual(18);
      // Whole-value reduction without fetching the downstream a second time.
      expect(calls.reads).toBe(1);
    });

    it("[L4] falls back to repeating the read past the near-limit size, where a loop would lose everything", async () => {
      const { notice, loop } = await run("x".repeat(LARGEST_OFFERED + 24_000));
      expect(notice.hint).toContain("repeat this read inside execute_code with connecta.call");
      expect(notice.hint).not.toContain("loop connecta.result");
      // The size is still reachable with no calls to spare, which is why the margin is two.
      expect((await loop()).hostCalls.attempted).toBeLessThanOrEqual(20);
      const beyond = await run("x".repeat(21 * 24_000));
      expect(beyond.notice.hint).toContain("repeat this read");
      expect((await beyond.loop()).error?.code).toBe("budget_exceeded");
    });

    it("[L4] sizes the offer from the connector's cap and the deployment's budget", async () => {
      const text = "x".repeat(225_781);
      expect((await run(text)).notice.hint).toContain("loop connecta.result");
      expect((await run(text, { maxResultBytes: 1_000 })).notice.hint).toContain("repeat this read");
      expect((await run(text, { maxHostCalls: 5 })).notice.hint).toContain("repeat this read");
    });

    it("[L4] the usage guide's paging example finishes the size that used to exhaust the budget", async () => {
      expect(USAGE_SKILL).not.toMatch(/connecta\.result\("result-id", \{[^}]*maxBytes/);
      const looped = await (await run("x".repeat(225_781))).loop();
      expect(looped.error).toBeUndefined();
      expect(looped.hostCalls.attempted).toBe(10);
    });
  });

  it("[R5, L4] retains streamed logs when the budget ends the child", async () => {
    const outcome = await contractHarness().run(
      executor,
      `async () => {
      console.log("before budget exhaustion");
      for (let i = 0; i < 213; i++) {
        try { await connecta.call("reader.read", { value: "ok" }); }
        catch { console.log("must not catch the budget refusal"); }
      }
    }`,
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.value).toMatchObject({
      error: { code: "budget_exceeded" },
      logs: "before budget exhaustion",
    });
  });

  it("[P2, X5] pins the QuickJS capability set", async () => {
    const outcome = await contractHarness().run(executor, CAPABILITY_PROBE_CODE);

    expect(outcome.isError, outcome.text).toBe(false);
    expect(outcome.result).toEqual({
      globals: {
        fetch: "undefined",
        setTimeout: "undefined",
        clearTimeout: "undefined",
        process: "undefined",
        crypto: "undefined",
        WebSocket: "undefined",
        require: "undefined",
        Deno: "undefined",
        Bun: "undefined",
      },
      dataFetch: "absent",
      externalHttp: "absent",
      externalHttps: "absent",
      webSocket: "absent",
      netConnect: "import blocked",
      tlsConnect: "import blocked",
      dnsLookup: "import blocked",
      unavailableImports: {
        fs: "blocked",
        http: "blocked",
        https: "blocked",
      },
      unavailableBuiltins: {
        fs: "process absent",
        http: "process absent",
        https: "process absent",
      },
      env: {
        entrypoint: { type: "undefined", keys: 0 },
        global: { type: "undefined", keys: 0 },
        process: { type: "undefined", keys: 0 },
        workers: { type: "undefined", keys: 0 },
      },
    });
  });
});
