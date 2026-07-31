import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getEncoding } from "js-tiktoken";

import { createAuditClient, round } from "./audit-lib.mjs";
import {
  distribution,
  scoreAgentRun,
  validateFixtures,
} from "./agent-benchmark-scoring.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function positiveIntegerOption(name, fallback) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

const outputPath = resolve(
  here,
  option("--output", "results/current-agent-performance.json"),
);
const selectedCase = option("--case", "all");
const repetitions = positiveIntegerOption("--repetitions", 3);
const concurrency = positiveIntegerOption("--concurrency", 2);
const tokenizerName =
  process.env.CONNECTA_EVAL_TOKENIZER ?? "o200k_base";
const tokenizer = getEncoding(tokenizerName);
const agentModel = process.env.CONNECTA_EVAL_AGENT_MODEL;
const bearer = "connecta-agent-eval-token";
const disabledHostFeatures = [
  "apps",
  "plugins",
  "browser_use",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "multi_agent",
  "goals",
  "tool_suggest",
  "skill_search",
];
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const cases = [
  {
    id: "single-read",
    prompt:
      "Return the one deterministic record with id 7. Respond with only the record JSON.",
    expectedCalls: [
      { address: "controlled.read_record", args: { id: 7 } },
    ],
    validOuterRoutes: [
      ["search_tools", "call_tool"],
      ["execute_code"],
    ],
    costEnvelope: { maxRoundTrips: 3, maxMcpResultTokens: 500 },
    correct(finalText) {
      const value = parseJson(finalText);
      return (
        value?.id === 7 &&
        value?.group === "beta" &&
        value?.score === 18
      );
    },
  },
  {
    id: "independent-batch",
    prompt:
      "Return the point-lookup results for deterministic record ids 11 and 12. Respond with only a JSON array ordered by id.",
    expectedCalls: [
      { address: "controlled.read_record", args: { id: 11 } },
      { address: "controlled.read_record", args: { id: 12 } },
    ],
    validOuterRoutes: [
      ["execute_code"],
      ["search_tools", "call_tool", "call_tool"],
    ],
    costEnvelope: { maxRoundTrips: 4, maxMcpResultTokens: 700 },
    correct(finalText) {
      const value = parseJson(finalText);
      return (
        Array.isArray(value) &&
        value.length === 2 &&
        value[0]?.id === 11 &&
        value[0]?.group === "gamma" &&
        value[0]?.score === 86 &&
        value[1]?.id === 12 &&
        value[1]?.group === "alpha" &&
        value[1]?.score === 2
      );
    },
  },
  {
    id: "dependent-reduction",
    prompt:
      "For the deterministic collection of 120 records, return each group's record count and score sum. Respond with only a JSON object keyed by group.",
    expectedCalls: [
      { address: "controlled.records", args: { count: 120 } },
    ],
    validOuterRoutes: [
      ["execute_code"],
      ["search_tools", "execute_code"],
    ],
    costEnvelope: { maxRoundTrips: 3, maxMcpResultTokens: 700 },
    correct(finalText) {
      const value = parseJson(finalText);
      const expected = {};
      for (let index = 0; index < 120; index += 1) {
        const group = ["alpha", "beta", "gamma"][index % 3];
        const row = (expected[group] ??= { count: 0, sum: 0 });
        row.count += 1;
        row.sum += (index * 17) % 101;
      }
      return ["alpha", "beta", "gamma"].every(
        (group) =>
          (value?.[group]?.count ?? value?.[group]?.record_count) ===
            expected[group].count &&
          (value?.[group]?.sum ??
            value?.[group]?.scoreSum ??
            value?.[group]?.score_sum) ===
            expected[group].sum,
      );
    },
  },
  {
    id: "auth-handoff",
    prompt:
      "Tell me the identity from the oauth-recoverable connector. If an operator must act first, return the exact recovery handoff instead of claiming success.",
    expectedCalls: [
      { address: "oauth-recoverable.whoami", args: {} },
    ],
    expectedFailureAddresses: ["oauth-recoverable.whoami"],
    validOuterRoutes: [
      ["search_tools", "call_tool", "authorize_connector"],
      ["execute_code", "authorize_connector"],
    ],
    costEnvelope: { maxRoundTrips: 4, maxMcpResultTokens: 900 },
    correct(finalText) {
      return (
        (finalText.includes("/fixture/oauth-recoverable/consent") &&
          /open|operator|authorization|consent/i.test(finalText)) ||
        (finalText.includes("authorize_connector") &&
          finalText.includes("oauth-recoverable") &&
          /cancel|approval|operator/i.test(finalText))
      );
    },
  },
];

function startServer() {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "sandbox-server.ts"],
    {
      cwd: here,
      env: {
        ...process.env,
        CONNECTA_EVAL_PORT: "0",
        CONNECTA_EVAL_TOKEN: bearer,
        CONNECTA_EVAL_SOURCE_COMMIT: sourceCommit,
        CONNECTA_EVAL_TRACE: "enabled",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding("utf8");
  let buffered = "";
  const ready = new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error(`Agent eval server timed out.\n${stderr}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(
        new Error(`Agent eval server exited before readiness (${code}).\n${stderr}`),
      );
    });
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const message = parseJson(line);
        if (message?.event !== "ready") continue;
        clearTimeout(timeout);
        resolveReady(message);
      }
    });
  });
  return { child, ready };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

async function readServerTraces(mcpUrl) {
  const traceUrl = new URL(mcpUrl);
  traceUrl.pathname = "/__eval/trace";
  traceUrl.search = "";
  const response = await fetch(traceUrl, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!response.ok) {
    throw new Error(
      `Eval trace read failed with HTTP ${response.status}.`,
    );
  }
  const body = await response.json();
  if (!Array.isArray(body?.traces)) {
    throw new Error("Eval trace response did not contain a traces array.");
  }
  return body.traces;
}

async function advertisedToolNames(url) {
  const context = await createAuditClient({
    url,
    token: bearer,
    tokenizerName,
  });
  try {
    return context.listed.tools.map((tool) => tool.name);
  } finally {
    await context.close();
  }
}

async function runAgent(fixture, url, repetition, advertisedTools) {
  const commandArgs = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    "/tmp",
    "--config",
    `mcp_servers.connecta.url="${url}"`,
    "--config",
    'mcp_servers.connecta.bearer_token_env_var="CONNECTA_EVAL_TOKEN"',
    "--config",
    'approval_policy="never"',
    ...disabledHostFeatures.flatMap((feature) => [
      "--disable",
      feature,
    ]),
    ...(agentModel ? ["--model", agentModel] : []),
    fixture.prompt,
  ];
  const started = performance.now();
  const child = spawn("codex", commandArgs, {
    cwd: root,
    env: {
      ...process.env,
      CONNECTA_EVAL_TOKEN: bearer,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  let buffered = "";
  let finalText = "";
  let usage = {};
  const toolCalls = [];
  const nonMcpActions = [];
  const startedItems = new Map();
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const event = parseJson(line);
      if (!event) continue;
      if (event.type === "item.started") {
        startedItems.set(event.item?.id, performance.now());
      }
      if (event.type === "item.completed") {
        const item = event.item ?? {};
        const itemStarted = startedItems.get(item.id);
        if (item.type === "mcp_tool_call") {
          toolCalls.push({
            server: item.server ?? null,
            tool: item.tool,
            arguments: item.arguments,
            status: item.status,
            error: item.error ?? null,
            durationMs:
              itemStarted === undefined
                ? null
                : round(performance.now() - itemStarted, 1),
            resultBytes: Buffer.byteLength(
              JSON.stringify(item.result ?? null),
            ),
            resultTokens: tokenizer.encode(
              JSON.stringify(item.result ?? null),
            ).length,
          });
        } else if (item.type === "agent_message") {
          finalText = item.text ?? "";
        } else {
          nonMcpActions.push({
            type: item.type ?? "unknown",
            status: item.status ?? null,
            command:
              typeof item.command === "string"
                ? item.command.slice(0, 500)
                : null,
          });
        }
      }
      if (event.type === "turn.completed") usage = event.usage ?? {};
    }
  });
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error(`Agent case "${fixture.id}" timed out.`));
    }, 180_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectExit(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  if (exitCode !== 0) {
    throw new Error(
      `Codex exited with ${exitCode} for "${fixture.id}".\n${stderr}`,
    );
  }
  const serverTraces = (await readServerTraces(url)).sort(
    (left, right) => left.sequence - right.sequence,
  );
  const metaToolTraces = serverTraces.filter(
    (trace) => trace.kind === "meta_tool",
  );
  const connectaToolCalls = toolCalls.filter(
    (call) => call.server === "connecta",
  );
  const foreignToolCalls = toolCalls.filter(
    (call) => call.server !== "connecta",
  );
  const mcpResultTokens = connectaToolCalls.reduce(
    (sum, call) => sum + call.resultTokens,
    0,
  );
  const foreignMcpResultTokens = foreignToolCalls.reduce(
    (sum, call) => sum + call.resultTokens,
    0,
  );
  const scored = scoreAgentRun({
    fixture,
    advertisedTools,
    metaToolTraces,
    foreignToolCalls,
    nonMcpActions,
    finalCorrect: fixture.correct(finalText),
    mcpResultTokens,
  });
  return {
    id: fixture.id,
    repetition,
    prompt: fixture.prompt,
    latencyMs: round(performance.now() - started, 1),
    ...scored,
    correct: scored.taskCorrect,
    routeEfficient:
      scored.surfaceValid &&
      scored.foreignClean &&
      scored.roundTripEfficient,
    expectedCalls: fixture.expectedCalls,
    validOuterRoutes: fixture.validOuterRoutes,
    costEnvelope: fixture.costEnvelope,
    mcpResultTokenBudget: fixture.costEnvelope.maxMcpResultTokens,
    calledTools: connectaToolCalls.map((call) => call.tool),
    guidanceFetched: metaToolTraces.some(
      (trace) => trace.operation === "skills",
    ),
    foreignToolCalls: foreignToolCalls.map(
      (call) => `${call.server ?? "unknown"}.${call.tool}`,
    ),
    advertisedTools,
    serverTraces,
    toolCalls,
    nonMcpActions,
    finalText,
    usage,
    mcpResultTokens,
    foreignMcpResultTokens,
  };
}

const selected =
  selectedCase === "all"
    ? cases
    : cases.filter((fixture) => fixture.id === selectedCase);
if (selected.length === 0) {
  throw new Error(
    `Unknown --case "${selectedCase}". Choose ${cases
      .map((fixture) => fixture.id)
      .join(", ")}, or all.`,
  );
}

const jobs = Array.from({ length: repetitions }, (_, index) =>
  selected.map((fixture) => ({
    fixture,
    repetition: index + 1,
  })),
).flat();
const runs = Array.from({ length: jobs.length });
let nextJob = 0;
let benchmarkSurface;

async function worker() {
  for (;;) {
    const index = nextJob;
    nextJob += 1;
    const job = jobs[index];
    if (!job) return;
    process.stderr.write(
      `Running fresh-agent case ${job.fixture.id} (${job.repetition}/${repetitions})…\n`,
    );
    const server = startServer();
    try {
      const ready = await server.ready;
      const advertisedTools = await advertisedToolNames(ready.url);
      validateFixtures(selected, advertisedTools);
      if (
        benchmarkSurface &&
        JSON.stringify(benchmarkSurface) !== JSON.stringify(advertisedTools)
      ) {
        throw new Error("Advertised tool inventory changed between runs.");
      }
      benchmarkSurface ??= advertisedTools;
      runs[index] = await runAgent(
        job.fixture,
        ready.url,
        job.repetition,
        advertisedTools,
      );
    } finally {
      await stopServer(server.child);
    }
  }
}

await Promise.all(
  Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
);

function rate(caseRuns, predicate) {
  return round(
    caseRuns.filter(predicate).length / caseRuns.length,
    3,
  );
}

const caseResults = selected.map((fixture) => {
  const caseRuns = runs.filter((run) => run.id === fixture.id);
  return {
    id: fixture.id,
    prompt: fixture.prompt,
    repetitions: caseRuns.length,
    validOuterRoutes: fixture.validOuterRoutes,
    costEnvelope: fixture.costEnvelope,
    rates: {
      taskCorrect: rate(caseRuns, (run) => run.taskCorrect),
      safetyPassed: rate(caseRuns, (run) => run.safetyPassed),
      surfaceValid: rate(caseRuns, (run) => run.surfaceValid),
      foreignClean: rate(caseRuns, (run) => run.foreignClean),
      costEfficient: rate(caseRuns, (run) => run.costEfficient),
      passed: rate(caseRuns, (run) => run.passed),
    },
    latencyMs: distribution(
      caseRuns.map((run) => run.latencyMs),
      round,
    ),
    mcpResultTokens: distribution(
      caseRuns.map((run) => run.mcpResultTokens),
      round,
    ),
    connectaRoundTrips: distribution(
      caseRuns.map((run) => run.connectaRoundTrips),
      round,
    ),
    wholeAgentInputTokens: distribution(
      caseRuns.map((run) => run.usage.input_tokens ?? 0),
      round,
    ),
    wholeAgentOutputTokens: distribution(
      caseRuns.map((run) => run.usage.output_tokens ?? 0),
      round,
    ),
    diagnostics: {
      failedMetaToolCalls: caseRuns.reduce(
        (sum, run) => sum + run.failedMetaToolCalls,
        0,
      ),
    },
    waste: {
      duplicateMetaToolCalls: caseRuns.reduce(
        (sum, run) => sum + run.waste.duplicateMetaToolCalls,
        0,
      ),
      unexpectedFailedMetaToolCalls: caseRuns.reduce(
        (sum, run) => sum + run.waste.unexpectedFailedMetaToolCalls,
        0,
      ),
      foreignToolCalls: caseRuns.reduce(
        (sum, run) => sum + run.waste.foreignToolCalls,
        0,
      ),
      nonMcpHostActions: caseRuns.reduce(
        (sum, run) => sum + run.waste.nonMcpHostActions,
        0,
      ),
      unavailableSurfaceCalls: caseRuns.reduce(
        (sum, run) => sum + run.waste.unavailableSurfaceCalls,
        0,
      ),
      unexpectedExecutions: caseRuns.reduce(
        (sum, run) => sum + run.waste.unexpectedExecutions,
        0,
      ),
    },
    observedRoutes: Object.entries(
      caseRuns.reduce((counts, run) => {
        const route = run.outerTools.join(" → ") || "(none)";
        counts[route] = (counts[route] ?? 0) + 1;
        return counts;
      }, {}),
    ).map(([route, count]) => ({ route, count })),
    runs: caseRuns,
  };
});

const result = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  source: {
    commit: sourceCommit,
    nodeVersion: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    codexVersion: execFileSync("codex", ["--version"], {
      encoding: "utf8",
    }).trim(),
    model: agentModel ?? "codex-default",
    tokenizer: tokenizerName,
  },
  benchmark: {
    surface: "seven-tool",
    comparisonClass: "seven-tool-with-executor",
    advertisedTools: benchmarkSurface,
    repetitions,
    concurrency,
    scoring:
      "Outcome, safety, advertised-surface validity, foreign-tool use, Connecta round trips, Connecta result tokens, whole-agent tokens, and latency. Routes are observed, not prescribed.",
    removedToolPolicy:
      "Removed top-level tools are reported as unavailable-surface calls and are not treated as equivalent routes.",
  },
  summary: {
    cases: caseResults.length,
    runs: runs.length,
    correct: runs.filter((run) => run.taskCorrect).length,
    routeEfficient: runs.filter((run) => run.routeEfficient).length,
    contextEfficient: runs.filter((run) => run.contextEfficient).length,
    safetyPassed: runs.filter((run) => run.safetyPassed).length,
    surfaceValid: runs.filter((run) => run.surfaceValid).length,
    foreignClean: runs.filter((run) => run.foreignClean).length,
    costEfficient: runs.filter((run) => run.costEfficient).length,
    passed: runs.filter((run) => run.passed).length,
    totalLatencyMs: round(
      runs.reduce((sum, run) => sum + run.latencyMs, 0),
      1,
    ),
    totalInputTokens: caseResults.reduce(
      (sum, fixture) =>
        sum +
        fixture.runs.reduce(
          (runSum, run) => runSum + (run.usage.input_tokens ?? 0),
          0,
        ),
      0,
    ),
    totalOutputTokens: caseResults.reduce(
      (sum, fixture) =>
        sum +
        fixture.runs.reduce(
          (runSum, run) => runSum + (run.usage.output_tokens ?? 0),
          0,
        ),
      0,
    ),
    totalMcpResultTokens: runs.reduce(
      (sum, run) => sum + run.mcpResultTokens,
      0,
    ),
    totalForeignMcpResultTokens: runs.reduce(
      (sum, run) => sum + run.foreignMcpResultTokens,
      0,
    ),
  },
  cases: caseResults,
  runs,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
tokenizer.free?.();
process.stdout.write(
  `${JSON.stringify({
    event: "agent_benchmark_complete",
    output: outputPath,
    sourceCommit,
    summary: result.summary,
    cases: caseResults.map((fixture) => ({
      id: fixture.id,
      repetitions: fixture.repetitions,
      rates: fixture.rates,
      observedRoutes: fixture.observedRoutes,
      latencyMs: fixture.latencyMs,
      mcpResultTokens: fixture.mcpResultTokens,
      connectaRoundTrips: fixture.connectaRoundTrips,
      diagnostics: fixture.diagnostics,
      waste: fixture.waste,
    })),
  })}\n`,
);
