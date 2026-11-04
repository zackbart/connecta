// Node-only: runs the guest API contract cases on the Node QuickJS executor.
// The QuickJS arm of the guest API contract. The same case table runs against
// the Dynamic Worker executor in test/guest-api-contract.test.ts.

import { CONFIG_DEFAULTS } from "../src/config-defaults.js";
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
  checkReadDeadlineCancels,
  checkReadDeadlineUtilities,
  checkDispatchGateAfterAuth,
  checkDispatchGateAfterCatalog,
  checkStallAtCeiling,
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
  checkRetainedResultsPassFinalSet,
  checkRetainedResultsSameRunAndCost,
  checkRetainedResultsUnreadableWhileSealing,
  retainedSealingCases,
  checkProgramResultBom,
  checkProgramResultSurrogates,
  checkProgramReturnFallback,
  checkProgramReturnPaging,
  checkProgramReturnWriteWarning,
  checkReclaimAfterSealingBegan,
  checkTransferReclaim,
  wholeReadSealingCases,
} from "./program-result-cases.js";

// Every case here drives a real QuickJS child process, whose startup and IPC
// are wall-clock nothing here can fake: on a loaded host they outran vitest's
// 5s default with no behavior at fault. This file budget is a hang guard. The
// deadlines a case pins are the executor's own, asserted on its outcome.
vi.setConfig({ testTimeout: 20_000 });

// A generous guest-CPU budget: these programs loop and stringify, and the
// clause under test is never the 250ms default.
const executor = quickJsExecutor({ cpuTimeMs: 5_000 });
// Long enough that a loaded host still delivers a read's timeout inside the margin.
const readDeadlineExecutor = quickJsExecutor({
  timeoutMs: 2_000,
  cpuTimeMs: 5_000,
});

afterAll(async () => {
  await executor.close?.();
  await readDeadlineExecutor.close?.();
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
  it("INV-5: a retained result is readable from later runs only if it passes its run's final secret set", async () => {
    await checkRetainedResultsPassFinalSet(executor);
  }, 60_000);
  it("INV-5: same-run paging keeps working and a run pays no extra storage to seal", async () => {
    await checkRetainedResultsSameRunAndCost(executor);
  }, 60_000);
  for (const [title, check] of Object.entries(retainedSealingCases)) {
    it(`INV-5 INV-7: ${title}`, () => check(executor), 60_000);
  }
  for (const [title, check] of Object.entries(wholeReadSealingCases)) {
    it(`[S11, R4a] INV-5: ${title}`, () => check(executor), 60_000);
  }
  it("[L6, R4a]: sealing owns an entry from the moment it begins", checkReclaimAfterSealingBegan);
  it("[L6] INV-9: reclaims finished reads and keeps a failed run's write output", async () => {
    await checkTransferReclaim(executor);
  });
  it("[S11] scales the whole-read ceiling with the CPU budget and caps it", async () => {
    const ceiling = (options: Parameters<typeof quickJsExecutor>[0]) => {
      const scaled = quickJsExecutor(options);
      void scaled.close?.();
      return scaled.maxReadBytes;
    };
    expect(ceiling({})).toBe(1.5 * 1024 * 1024);
    expect(ceiling({ cpuTimeMs: 125 })).toBe(0.75 * 1024 * 1024);
    expect(ceiling({ cpuTimeMs: 60_000 })).toBe(2 * 1024 * 1024);
    expect(ceiling({ cpuTimeMs: 60_000, memoryLimitBytes: 16 * 1024 * 1024 })).toBe(1024 * 1024);
  });
  it("[S11] a run keeps its answer when freeing its runtime aborts the child", async () => {
    // Reproducible with this value: a large return, then a whole read of it in the same child.
    const pool = quickJsExecutor({ cpuTimeMs: 5_000 });
    const registry = makeRegistry(
      [
        {
          id: "store",
          kind: "api",
          maxResultBytes: 9_001,
          async listTools() {
            return [{ name: "noop", annotations: { readOnlyHint: true } }];
          },
          async callTool() {
            return "ok";
          },
        },
      ],
      {},
    );
    const execute = createExecuteTool(registry, "https://whole-read.test", pool, silentLogger);
    try {
      const made = await execute({
        code: `async () => { await connecta.call("store.noop"); return { text: '雪"\\\\\\n'.repeat(150000) }; }`,
      });
      const { resultId } = made.structuredContent!.result as { resultId: string };
      for (let run = 0; run < 3; run++) {
        const read = await execute({
          code: `async () => (await connecta.result(${JSON.stringify(resultId)}, { all: true })).data.text.length`,
        });
        expect(read.isError, JSON.stringify(read.structuredContent)).toBeUndefined();
        expect(read.structuredContent!.result).toBe(600_000);
      }
    } finally {
      await pool.close?.();
    }
  }, 60_000);
  it("[S11, L4] a default program reads whole what paging can't finish in one program", async () => {
    // Every limit at its default: 250 ms of CPU, 20 host calls, 24,000 return characters.
    const defaults = quickJsExecutor();
    const rows = Array.from({ length: 12_000 }, (_, i) => ({ i, pad: "x".repeat(80) }));
    const registry = makeRegistry([
      {
        id: "store",
        kind: "api",
        async listTools() {
          return [{ name: "read", annotations: { readOnlyHint: true } }];
        },
        async callTool() {
          return { rows };
        },
      },
    ]);
    const execute = createExecuteTool(registry, "https://whole-read.test", defaults, silentLogger);
    try {
      const whole = await execute({
        code: `async () => {
          const handle = await connecta.call("store.read");
          const { data } = await connecta.result(handle, { all: true });
          return { totalBytes: handle.totalBytes, rows: data.rows.length, last: data.rows.at(-1).i };
        }`,
      });
      expect(whole.isError, JSON.stringify(whole.structuredContent)).toBeUndefined();
      const value = whole.structuredContent!.result as { totalBytes: number; rows: number; last: number };
      expect(value.totalBytes).toBeGreaterThan(1024 * 1024);
      expect([value.rows, value.last]).toEqual([12_000, 11_999]);

      // The same result, paged as far as one program can: the host-call limit ends the run.
      const paged = await execute({
        code: `async () => {
          const handle = await connecta.call("store.read");
          let page, offset = 0;
          do {
            page = await connecta.result(handle, { offset });
            offset = page.nextOffset;
          } while (page.hasMore);
          return offset;
        }`,
      });
      expect(paged.isError).toBe(true);
      expect(JSON.stringify(paged.structuredContent)).toContain("budget_exceeded");
    } finally {
      await defaults.close?.();
    }
  }, 60_000);
  it("INV-5: at every step of sealing another request reads only what sealing published", async () => {
    await checkRetainedResultsUnreadableWhileSealing(executor);
  }, 60_000);
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
      const base = contractCase.runDeadline ? readDeadlineExecutor : executor;
      const config = caseConfig(contractCase);
      const outcome = await harness.run(base, contractCase.code, config);
      const follow = contractCase.follows ? await harness.run(base, contractCase.follows, config) : undefined;
      contractCase.check(outcome, harness.state, follow);
    });
  }

  it("[L3] ends connecta.read, search and describe before the run deadline", async () => {
    await checkReadDeadlineUtilities(readDeadlineExecutor);
  });

  it("[L3, INV-9] a stall after a successful write is never retryable", async () => {
    await checkStallAtCeiling(readDeadlineExecutor, "for (;;) {}");
  });

  it("[L3, W9, INV-9] the final gate refuses a write its auth step ran out of time, unsent", async () => {
    await checkDispatchGateAfterAuth(readDeadlineExecutor);
  }, 60_000);

  it("[L3, W9, INV-9] the final gate refuses a read its catalog ran out of time, unsent", async () => {
    await checkDispatchGateAfterCatalog(readDeadlineExecutor);
  }, 60_000);

  it("[L3] the default run deadline ends below the response ceiling", () => {
    expect(executor.deadlineMs).toBe(30_000);
    expect(executor.deadlineMs).toBeLessThan(CONFIG_DEFAULTS.execute.watchdogMs);
  });

  it("[L3] a read the cap ends stops its downstream work before the program hears", async () => {
    await checkReadDeadlineCancels(readDeadlineExecutor);
  }, 60_000);

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

  describe("the advice on a paged read handle", () => {
    const BASE = "https://connecta.handle";
    const TOTAL = 1_100_000;
    type Handle = { format: "paged"; resultId: string; totalBytes: number; hint: string };
    type Run = {
      result?: { handle?: Handle; bytes?: number; nextOffset?: number; hasMore?: boolean };
      error?: { code: string };
      hostCalls: { attempted: number };
    };
    const setup = (options: { maxHostCalls?: number; maxResultBytes?: number } = {}) => {
      const calls = { reads: 0 };
      const registry = makeRegistry(
        [
          {
            id: "logs",
            kind: "api",
            ...(options.maxResultBytes ? { maxResultBytes: options.maxResultBytes } : {}),
            listTools: async () => [
              { name: "read", annotations: { readOnlyHint: true } },
              { name: "ping", annotations: { readOnlyHint: true } },
            ],
            callTool: async (tool: string) => {
              if (tool === "ping") return "pong";
              calls.reads++;
              return "x".repeat(TOTAL);
            },
          },
        ],
        {},
      );
      const execute = createExecuteTool(
        registry,
        BASE,
        // These handles sit past this executor's read ceiling, where the advice is paging.
        customExecutor(
          { maxReadBytes: 1_000_000, execute: executor.execute.bind(executor) },
          { lifecycle: "self-managed" },
        ),
        silentLogger,
        undefined,
        options.maxHostCalls ? { maxHostCalls: options.maxHostCalls } : {},
      );
      const program = async (code: string) => JSON.parse(required((await execute({ code })).content[0]).text!) as Run;
      /** The handle, after spending `spent` calls, the read's own included. */
      const handle = async (spent = 1) => {
        const pings = 'await connecta.call("logs.ping");'.repeat(spent - 1);
        const { result } = await program(
          `async () => { ${pings} return { handle: await connecta.call("logs.read") }; }`,
        );
        return required(result?.handle);
      };
      /** One program following the hint's bound, carrying the offset and the reduction. */
      const pages = (id: string, limit: number, offset: number, bytes: number) =>
        program(`async () => {
          let bytes = ${bytes}, offset = ${offset}, page;
          for (let calls = 0; calls < ${limit}; calls++) {
            page = await connecta.result(${JSON.stringify(id)}, { offset });
            bytes += page.bytes;
            offset = page.nextOffset;
            if (!page.hasMore) break;
          }
          return { bytes, nextOffset: offset, hasMore: page.hasMore };
        }`);
      return { calls, handle, pages, program };
    };
    /** Follows a bounded hint through fresh programs to the last byte. */
    const follow = async ({ pages }: ReturnType<typeof setup>, { hint, resultId, totalBytes }: Handle) => {
      const [, here, each] = /at most (\d+) times here and (\d+) per new program/.exec(hint)!;
      let limit = Number(here);
      let offset = 0;
      let bytes = 0;
      let programs = 0;
      for (;;) {
        // The first bound may be zero; the program that read the handle has simply finished.
        if (limit > 0) {
          const { result, error, hostCalls } = await pages(resultId, limit, offset, bytes);
          expect(error).toBeUndefined();
          expect(hostCalls.attempted).toBeLessThanOrEqual(limit);
          programs++;
          bytes = result!.bytes!;
          offset = result!.nextOffset!;
          if (!result!.hasMore) break;
        }
        limit = Number(each);
      }
      return { bytes, totalBytes, programs };
    };

    it("[L6] bounds the pages per program at the defaults, and following it reaches the last byte", async () => {
      const handler = setup();
      const handle = await handler.handle();
      const { hint, resultId } = handle;
      expect(hint).toContain(`Needs up to ${Math.ceil((TOTAL + 2) / 23_997)} host calls`);
      expect(hint).toContain("this program has 19 left");
      expect(hint).toContain(`connecta.result(${JSON.stringify(resultId)}, { offset }) at most 17 times here`);
      expect(hint).toContain("and 18 per new program");
      expect(hint).toContain("return your reduction and nextOffset, and continue from both within 15 minutes");
      expect(hint).not.toContain("until !hasMore");
      const followed = await follow(handler, handle);
      expect(followed.bytes).toBe(followed.totalBytes);
      expect(followed.programs).toBe(3);
      expect(handler.calls.reads).toBe(1);
    });

    it("[L6] the loop the bound replaces does end in budget_exceeded at the defaults", async () => {
      const { handle, program } = setup();
      const { resultId } = await handle();
      const looped = await program(`async () => {
        let offset = 0, page;
        do {
          page = await connecta.result(${JSON.stringify(resultId)}, { offset });
          offset = page.nextOffset;
        } while (page.hasMore);
        return offset;
      }`);
      expect(looped.error?.code).toBe("budget_exceeded");
      expect(looped.result).toBeUndefined();
    });

    it("[L6] sizes the bound from a lower host-call budget", async () => {
      const handler = setup({ maxHostCalls: 5 });
      const handle = await handler.handle();
      const { hint } = handle;
      expect(hint).toContain("this program has 4 left");
      expect(hint).toMatch(/at most 2 times here and 3 per new program/);
      const followed = await follow(handler, handle);
      expect(followed.bytes).toBe(followed.totalBytes);
    });

    it("[L6] still gives a usable bound on the smallest budget", async () => {
      const { hint } = await setup({ maxHostCalls: 1 }).handle();
      expect(hint).toMatch(/at most 0 times here and 1 per new program/);
    });

    it("[L6] counts pages at the connector's cap", async () => {
      const { handle } = setup({ maxResultBytes: 1_000, maxHostCalls: 100 });
      const { hint } = await handle();
      expect(hint).toContain(`up to ${Math.ceil((TOTAL + 2) / 997)} host calls`);
      expect(hint).not.toContain("until !hasMore");
    });

    it("[L6] offers the loop when a raised budget fits it, and only with the calls still left", async () => {
      const handler = setup({ maxHostCalls: 60 });
      const pagesNeeded = Math.ceil((TOTAL + 2) / 23_997);
      expect((await handler.handle()).hint).toContain("until !hasMore");
      // The last spend that still leaves every page and the two spare calls.
      const fits = 60 - pagesNeeded - 2;
      const { hint, resultId } = await handler.handle(fits);
      expect(hint).toBe("Loop connecta.result(handle, { offset }) until !hasMore, setting offset to nextOffset.");
      const looped = await handler.pages(resultId, pagesNeeded + 1, 0, 0);
      expect(looped.error).toBeUndefined();
      expect(looped.hostCalls.attempted).toBeLessThanOrEqual(pagesNeeded);
      const late = await handler.handle(fits + 1);
      expect(late.hint).toContain(`this program has ${60 - fits - 1} left`);
      expect(late.hint).not.toContain("until !hasMore");
      expect(late.hint).toContain(`at most ${60 - fits - 3} times here`);
      expect(late.hint).toContain("and 58 per new program");
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
