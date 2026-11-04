import { describe, expect, it } from "vitest";
import type { TrialResult } from "../eval/agent/run.js";
import {
  batchEfficiency,
  efficiencyLines,
  mean,
  median,
  modelEfficiency,
  passK,
  reliability,
  trialEfficiency,
} from "../eval/report/efficiency.js";
import { signTest, trialSteps } from "../eval/report/steps.js";
import { compare, compareStepArms, crossTarget } from "../eval/compare.js";
import { STEP_BATCH, STEP_CONTROL_TASKS, STEP_EXPERIMENTS, STEP_TRIAL_COUNT } from "../eval/step-reduction-plan.js";

type Use = { tool: string; input?: Record<string, unknown>; resultText?: string; isError?: boolean };

function trial(
  overrides: Partial<TrialResult> & {
    uses?: Use[];
    programSkills?: number;
    tokens?: number;
    legacy?: boolean;
  } = {},
): TrialResult {
  const { uses = [], programSkills = 0, tokens = 1000, legacy = false, ...rest } = overrides;
  return {
    task: "t1",
    model: "m1",
    repeat: 1,
    status: "pass",
    checks: [],
    metrics: {
      wallMs: 1000,
      apiMs: undefined,
      modelTurns: 3,
      conversationTurns: 1,
      tokens: { input: tokens, output: 100, cacheRead: 0, cacheCreation: 0 },
      costUsd: undefined,
      metaTools: { execute_code: uses.length },
      otherTools: {},
      toolErrors: uses.filter((use) => use.isError).length,
      confirmationNudges: 0,
      downstream: {
        reads: 0,
        writes: 0,
        duplicateReads: 0,
        duplicateWrites: 0,
        errors: 0,
        unauthorizedRequests: 0,
        byTool: {},
      },
    },
    approvals: { allowed: [], denied: [], gated: [], exercised: [], permissionDenials: [] },
    transcript: [],
    ledger: [],
    startedAt: "2026-10-29T00:00:00.000Z",
    ...(legacy
      ? {}
      : {
          saved: {
            version: 1,
            trace: {
              toolUses: uses.map((use, index) => ({
                id: `u${index}`,
                turn: 1,
                tool: use.tool,
                input: use.input ?? {},
                isError: use.isError ?? false,
                resultText: use.resultText,
              })),
            },
            world: {
              programs: programSkills
                ? [
                    {
                      code: "",
                      peakCalls: 0,
                      succeeded: true,
                      calls: Array.from({ length: programSkills }, () => ({
                        name: "connecta.skill",
                        args: ["usage"],
                        outcome: "ok",
                      })),
                    },
                  ]
                : [],
            },
          } as unknown as TrialResult["saved"],
        }),
    ...rest,
  } as TrialResult;
}

describe("eval efficiency aggregates", () => {
  it("takes medians and means of empty, odd and even samples", () => {
    expect(median([])).toBeUndefined();
    expect(mean([])).toBeUndefined();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(mean([1, 2, 6])).toBe(3);
  });

  it("estimates pass@k and pass^k, and refuses zero repeats or too few trials", () => {
    expect(passK(0, 0, 0)).toBeUndefined();
    expect(passK(3, 3, 0)).toBeUndefined();
    expect(passK(0, 0, 1)).toBeUndefined();
    expect(passK(1, 1, 2)).toBeUndefined();
    expect(passK(3, 3, 3)).toEqual({ passAtK: 1, passHatK: 1 });
    expect(passK(3, 2, 3)).toEqual({ passAtK: 1, passHatK: 0 });
    expect(passK(3, 0, 3)).toEqual({ passAtK: 0, passHatK: 0 });
    const partial = passK(3, 2, 2)!;
    expect(partial.passAtK).toBe(1);
    expect(partial.passHatK).toBeCloseTo(1 / 3);
    const rare = passK(4, 1, 2)!;
    expect(rare.passAtK).toBeCloseTo(0.5);
    expect(rare.passHatK).toBe(0);
    expect(passK(2, 1, 1)).toEqual({ passAtK: 0.5, passHatK: 0.5 });
  });

  it("computes pass^k per cell and per model, excluding N/A and short cells", () => {
    const trials = [
      trial({ task: "a", repeat: 1 }),
      trial({ task: "a", repeat: 2 }),
      trial({ task: "b", repeat: 1 }),
      trial({ task: "b", repeat: 2, status: "fail" }),
      // One infrastructure error leaves a single graded trial: no estimate.
      trial({ task: "c", repeat: 1 }),
      trial({ task: "c", repeat: 2, status: "error" }),
      // Every trial N/A: excluded entirely.
      trial({ task: "d", repeat: 1, status: "skipped" }),
      trial({ task: "d", repeat: 2, status: "skipped" }),
    ];
    const { reliability: rel } = batchEfficiency(trials, 2);
    expect(rel.k).toBe(2);
    const cell = (task: string) => rel.cells.find((c) => c.task === task)!;
    expect(cell("a")).toMatchObject({ graded: 2, passed: 2, passAtK: 1, passHatK: 1 });
    expect(cell("b")).toMatchObject({ graded: 2, passed: 1, passAtK: 1, passHatK: 0 });
    expect(cell("c")).toMatchObject({ graded: 1, excluded: 1, passAtK: undefined, passHatK: undefined });
    expect(cell("d")).toMatchObject({ graded: 0, excluded: 2, passHatK: undefined });
    expect(rel.models).toEqual([{ model: "m1", cells: 2, unestimated: 1, excluded: 1, passAtK: 1, passHatK: 0.5 }]);
  });

  it("reports no estimate for zero repeats or an empty batch", () => {
    const zero = reliability([trial(), trial({ repeat: 2 })], 0, () => "pass");
    expect(zero.cells[0]).toMatchObject({ graded: 2, passAtK: undefined, passHatK: undefined });
    expect(zero.models[0]).toMatchObject({ cells: 0, unestimated: 1, passAtK: undefined, passHatK: undefined });
    expect(reliability([], 1, () => "pass")).toEqual({ k: 1, cells: [], models: [] });
    expect(modelEfficiency([], { include: () => true, pass: () => true })).toEqual([]);
  });

  it("measures response bytes per tool and counts guide fetches from saved traces", () => {
    const e = trialEfficiency(
      trial({
        uses: [
          { tool: "skills", input: { name: "connector:crm" }, resultText: "x".repeat(300) },
          { tool: "skills", input: {}, resultText: "list" },
          { tool: "skills", input: { query: "crm" }, resultText: "found" },
          { tool: "skills", input: { name: " " }, resultText: "" },
          { tool: "execute_code", resultText: "é".repeat(10), isError: true },
          { tool: "execute_code", resultText: "ok" },
          { tool: "execute_code" },
        ],
        programSkills: 2,
      }),
    );
    expect(e.guideFetches).toBe(3);
    expect(e.responses).toEqual({
      skills: { calls: 4, bytes: 309, maxBytes: 300, each: [300, 4, 5, 0] },
      execute_code: { calls: 2, bytes: 22, maxBytes: 20, each: [20, 2] },
    });
    expect(e.responseBytes).toBe(331);
    expect(e.largestResponse).toEqual({ tool: "skills", bytes: 300 });
    expect(e.toolErrors).toBe(1);
    expect(e.calls).toBe(7);
  });

  it("reads old result files with missing metrics and no saved trace", () => {
    const old = trial({ legacy: true });
    const metrics = old.metrics as unknown as Record<string, unknown>;
    delete metrics.toolErrors;
    delete metrics.modelTurns;
    delete metrics.otherTools;
    delete metrics.tokens;
    const e = trialEfficiency(old);
    expect(e).toMatchObject({
      calls: 0,
      promptTokens: 0,
      totalTokens: 0,
      toolErrors: undefined,
      modelTurns: undefined,
      guideFetches: undefined,
      responses: undefined,
      responseBytes: undefined,
      largestResponse: undefined,
    });
    const [summary] = batchEfficiency([old], 1).models;
    expect(summary!.withoutSizes).toBe(1);
    expect(summary!.medians.toolErrors).toEqual({ value: undefined, n: 0 });
    const lines = efficiencyLines(batchEfficiency([old], 1).models).join("\n");
    expect(lines).toContain("guide fetches N/A (n=0)");
    expect(lines).toContain("1 trial(s) lack saved traces");
    expect(lines).toContain("largest response N/A");
  });

  it("summarizes passing medians and names the most expensive trials with reasons", () => {
    const trials = [
      trial({ task: "a", tokens: 1000, uses: [{ tool: "execute_code", resultText: "x".repeat(100) }] }),
      trial({
        task: "b",
        tokens: 3000,
        uses: [
          { tool: "call_tool", resultText: "x".repeat(2048) },
          { tool: "execute_code", resultText: "x".repeat(300) },
        ],
      }),
      trial({
        task: "c",
        tokens: 9000,
        status: "fail",
        programSkills: 1,
        uses: [{ tool: "execute_code", resultText: "x".repeat(50), isError: true }],
      }),
      trial({ task: "d", tokens: 99_000, status: "skipped" }),
      trial({ task: "e", model: "m2", tokens: 500, status: "fail" }),
    ];
    const { models, reliability: rel } = batchEfficiency(trials, 1);
    expect(models.map((m) => m.model)).toEqual(["m1", "m2"]);
    const m1 = models[0]!;
    expect(m1).toMatchObject({ trials: 3, passing: 2, withoutSizes: 0 });
    expect(m1.medians.promptTokens).toEqual({ value: 2000, n: 2 });
    expect(m1.medians.calls).toEqual({ value: 1.5, n: 2 });
    expect(m1.medians.responseBytes).toEqual({ value: (100 + 2348) / 2, n: 2 });
    expect(m1.medians.guideFetches).toEqual({ value: 0, n: 2 });
    expect(m1.responses).toEqual({
      call_tool: { calls: 1, medianBytes: 2048, maxBytes: 2048 },
      execute_code: { calls: 2, medianBytes: 200, maxBytes: 300 },
    });
    expect(m1.expensive.map((t) => t.task)).toEqual(["c", "b", "a"]);
    expect(m1.expensive[0]).toMatchObject({ status: "fail", guideFetches: 1, toolErrors: 1 });
    expect(models[1]).toMatchObject({ trials: 1, passing: 0 });
    expect(models[1]!.medians.calls).toEqual({ value: undefined, n: 0 });
    const text = efficiencyLines(models, rel).join("\n");
    expect(text).toContain("m1: 2/3 passing/ran; pass@1 66.7%, pass^1 66.7% over 3 cell(s)");
    expect(text).toContain(
      "expensive: c #1 fail 9100 tokens 1s: first request N/A tokens, host searches N/A, errors before success N/A, largest response 50 B from execute_code",
    );
    expect(text).toContain("1 guide fetch(es), 1 tool error(s)");
    expect(text).toContain("call_tool median 2.0 KB, max 2.0 KB (1 calls)");
    expect(text).toContain("m2: 0/1 passing/ran");
  });
});

it("records first-request cache input once, permits host search, and preserves unknown telemetry", async () => {
  const { parseTrace } = await import("../eval/agent/trace.js");
  const { infraError } = await import("../eval/agent/infra.js");
  const trace = parseTrace(
    [
      { type: "system", subtype: "init", claude_code_version: "test", tools: ["ToolSearch", "mcp__connecta__skills"] },
      {
        type: "assistant",
        message: {
          usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 },
          content: [{ type: "tool_use", id: "search", name: "ToolSearch", input: { query: "tools" } }],
        },
      },
      { type: "assistant", message: { usage: { input_tokens: 999 }, content: [] } },
      { type: "result", subtype: "success" },
    ],
    [0],
    ["task"],
  );
  expect(trace.firstTurnInputTokens).toBe(60);
  expect(trace.hostSearchCalls).toBe(1);
  expect(trace.toolUses[0]?.tool).toBe("ToolSearch");
  expect(infraError([{ type: "result", subtype: "success" }], 0, trace.loadedTools)).toBeUndefined();
  const codex = parseTrace(
    [
      { type: "codex_usage", total: { inputTokens: 100, cachedInputTokens: 80 } },
      { type: "codex_usage", total: { inputTokens: 500 } },
    ],
    [],
    [],
  );
  expect(codex.firstTurnInputTokens).toBe(100);
  expect(codex.hostSearchCalls).toBeUndefined();
  expect(parseTrace([], [], []).firstTurnInputTokens).toBeUndefined();
  const t = trial();
  Object.assign(t.metrics, { firstTurnInputTokens: 60, hostSearchCalls: 1, toolErrorsBeforeFirstSuccess: 2 });
  const e = trialEfficiency(t);
  expect([e.firstTurnInputTokens, e.hostSearchCalls, e.toolErrorsBeforeFirstSuccess]).toEqual([60, 1, 2]);
  expect(efficiencyLines(batchEfficiency([t], 1).models).join("\n")).toContain("first request 60");
  expect(trialEfficiency(trial({ legacy: true })).firstTurnInputTokens).toBeUndefined();
});

describe("step metrics", () => {
  const replies = (code: string) => JSON.stringify({ ok: false, error: { code } });
  const flow = (uses: Use[], programs: unknown[] = []) => {
    const built = trial({ uses });
    (built.saved!.world as { programs: unknown[] }).programs = programs;
    return trialSteps(built);
  };

  it("counts every step before the first successful vendor call, across both routes", () => {
    const steps = flow([
      { tool: "skills", input: { name: "connector:ccb" }, resultText: "guide" },
      { tool: "search_tools", input: { query: "campus" }, resultText: "{}" },
      { tool: "call_tool", input: { address: "ccb.ccb_api_search" }, resultText: "{}" },
      { tool: "call_tool", input: { address: "ccb.ccb_api_read" }, resultText: replies("invalid_args"), isError: true },
      { tool: "call_tool", input: { address: "ccb.ccb_api_details" }, resultText: "{}" },
      { tool: "call_tool", input: { address: "ccb.ccb_api_read" }, resultText: "{}" },
    ]);
    expect(steps.stepsToFirstVendorOk).toBe(5);
    expect(steps.topStepsToFirstVendorOk).toBe(6);
    expect(steps.discoverySteps).toBe(3);
    expect(steps.guideFetches).toBe(1);
    expect(steps.callsBeforeGuide).toBe(0);
    expect(steps.invalidArgs).toBe(1);
    expect(steps.wrongPathErrors).toBe(1);
    expect(steps.retriesToSuccess).toBe(0);
    expect(steps.unresolvedErrors).toBe(0);
  });

  it("counts vendor calls made before the connector's guide", () => {
    const steps = flow([
      { tool: "call_tool", input: { address: "ccb.list_groups" }, resultText: "{}" },
      { tool: "skills", input: { name: "connector:ccb" }, resultText: "guide" },
      { tool: "call_tool", input: { address: "ccb.get_group" }, resultText: "{}" },
    ]);
    expect(steps.callsBeforeGuide).toBe(1);
  });

  it("separates a retry from an unresolved wrong guess", () => {
    const guess = {
      tool: "call_tool",
      input: { address: "stripe.list" },
      resultText: replies("invalid_args"),
      isError: true,
    };
    expect(
      flow([guess, guess, { tool: "call_tool", input: { address: "stripe.list" }, resultText: "{}" }]),
    ).toMatchObject({
      retriesToSuccess: 1,
      unresolvedErrors: 0,
    });
    expect(flow([guess, guess])).toMatchObject({ retriesToSuccess: 1, unresolvedErrors: 2 });
  });

  it("expands programs in call order and matches them by source", () => {
    const steps = flow(
      [{ tool: "execute_code", input: { code: "b" }, resultText: "{}" }],
      [
        { code: "a", calls: [{ name: "connecta.call", args: ["ccb.get_me"], outcome: "ok" }] },
        {
          code: "b",
          calls: [
            { name: "connecta.search", args: [{}], outcome: "ok" },
            { name: "connecta.call", args: ["ccb.get_person"], outcome: "error", errorCode: "unknown_tool" },
            { name: "connecta.call", args: ["ccb.get_individual"], outcome: "ok" },
          ],
        },
      ],
    );
    expect(steps.stepsToFirstVendorOk).toBe(2);
    expect(steps.topLevelSteps).toBe(1);
    expect(steps.nestedCalls).toBe(2);
    expect(steps.unknownTool).toBe(1);
  });

  it("counts discovery between a hinted list and the next vendor call", () => {
    const steps = flow([
      { tool: "call_tool", input: { address: "ccb.list_families" }, resultText: "{}" },
      { tool: "search_tools", input: { query: "family" }, resultText: "{}" },
      { tool: "call_tool", input: { address: "ccb.ccb_api_details" }, resultText: "{}" },
      { tool: "call_tool", input: { address: "ccb.get_family" }, resultText: "{}" },
      { tool: "search_tools", input: { query: "later" }, resultText: "{}" },
    ]);
    expect(steps.searchesBetweenListAndDetail).toBe(2);
  });

  it("counts a failed overlapping tool followed by its sibling as a wrong tool", () => {
    const update = { tool: "call_destructive_tool", input: { address: "vercel_rest.update_project_env_var" } };
    const upsert = { tool: "call_destructive_tool", input: { address: "vercel_rest.upsert_project_env_var" } };
    expect(
      flow([
        { ...update, resultText: replies("not_found"), isError: true },
        { ...upsert, resultText: "{}" },
      ]).wrongToolCalls,
    ).toBe(1);
    expect(
      flow([
        { ...update, resultText: replies("not_found"), isError: true },
        { ...update, resultText: "{}" },
      ]).wrongToolCalls,
    ).toBe(0);
  });

  it("reports how many decisive pairs would separate arms, never a verdict", () => {
    expect(signTest([-1, -1, 1, 0])).toMatchObject({ better: 2, worse: 1, tied: 1 });
    expect(signTest([-1, -1, -1, -1, -1, -1]).pairsNeeded).toBe(6);
    expect(signTest([-1, 1]).pairsNeeded).toBeUndefined();
    expect(signTest([0, 0]).pairsNeeded).toBeUndefined();
  });

  it("registers a plan inside the owner's trial cap, on the worker surface it was fixed for", () => {
    expect(STEP_TRIAL_COUNT).toBeLessThanOrEqual(STEP_BATCH.trialCap);
    expect(STEP_BATCH).toMatchObject({
      target: "worker",
      catalogTools: 300,
      grading: "outcome",
      repeats: 2,
      concurrency: 2,
    });
    for (const tasks of Object.values(STEP_EXPERIMENTS))
      for (const task of tasks) expect(STEP_CONTROL_TASKS).toContain(task);
  });

  it("refuses to pair a step arm through the ordinary comparators, with or without the override", () => {
    const file = (stepArm?: string) =>
      ({ config: { stepArm, surface: "six", injection: undefined, target: "worker" }, trials: [] }) as never;
    expect(() => compare(file("teach-errors"), file())).toThrow(/step-reduction arms/);
    expect(() => compare(file(), file("control"), { allowMismatch: true })).toThrow(/step-reduction arms/);
    expect(() => crossTarget(file("control"), file("control"))).toThrow(/step-reduction arms/);
    expect(() => compareStepArms(file("control"), file("control"))).toThrow(/must be a step-reduction arm/);
    expect(() => compareStepArms(file("control"), file())).toThrow(/must be a step-reduction arm/);
    expect(() =>
      compareStepArms(
        {
          ...(file("control") as object),
          config: { stepArm: "control", tasks: [], models: [] },
          meta: { git: { srcTree: "aaaaaaaaaaaa" } },
        } as never,
        {
          ...(file("merged-tools") as object),
          config: { stepArm: "merged-tools", tasks: [], models: [] },
          meta: { git: { srcTree: "bbbbbbbbbbbb" } },
        } as never,
        { diagnostic: true },
      ),
    ).toThrow(/same source tree/);
  });
});
