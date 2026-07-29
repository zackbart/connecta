import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getEncoding } from "js-tiktoken";

import { round } from "./audit-lib.mjs";

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

const outputPath = resolve(
  here,
  option("--output", "results/current-agent-performance.json"),
);
const selectedCase = option("--case", "all");
const tokenizerName =
  process.env.CONNECTA_EVAL_TOKENIZER ?? "o200k_base";
const tokenizer = getEncoding(tokenizerName);
const agentModel = process.env.CONNECTA_EVAL_AGENT_MODEL;
const bearer = "connecta-agent-eval-token";
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
    expectedTools: ["search_tools", "call_tool"],
    mcpResultTokenBudget: 500,
    forbiddenTools: [
      "describe_tools",
      "batch_call",
      "execute_code",
      "call_destructive_tool",
    ],
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
    expectedTools: ["search_tools", "batch_call"],
    mcpResultTokenBudget: 700,
    forbiddenTools: [
      "describe_tools",
      "call_tool",
      "execute_code",
      "call_destructive_tool",
    ],
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
    expectedTools: ["search_tools", "execute_code"],
    mcpResultTokenBudget: 700,
    forbiddenTools: [
      "describe_tools",
      "call_tool",
      "batch_call",
      "call_destructive_tool",
    ],
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
    expectedTools: ["search_tools", "call_tool", "authorize_connector"],
    mcpResultTokenBudget: 900,
    forbiddenTools: [
      "describe_tools",
      "batch_call",
      "execute_code",
      "call_destructive_tool",
    ],
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
        CONNECTA_EVAL_EXECUTOR: "enabled",
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

async function runAgent(fixture, url) {
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
  const called = toolCalls.map((call) => call.tool);
  const missingTools = fixture.expectedTools.filter(
    (tool) => !called.includes(tool),
  );
  const forbiddenTools = fixture.forbiddenTools.filter((tool) =>
    called.includes(tool),
  );
  const correct = fixture.correct(finalText);
  const routeEfficient =
    missingTools.length === 0 && forbiddenTools.length === 0;
  const mcpResultTokens = toolCalls.reduce(
    (sum, call) => sum + call.resultTokens,
    0,
  );
  const contextEfficient = mcpResultTokens <= fixture.mcpResultTokenBudget;
  return {
    id: fixture.id,
    prompt: fixture.prompt,
    latencyMs: round(performance.now() - started, 1),
    correct,
    routeEfficient,
    contextEfficient,
    passed: correct && routeEfficient && contextEfficient,
    expectedTools: fixture.expectedTools,
    mcpResultTokenBudget: fixture.mcpResultTokenBudget,
    calledTools: called,
    missingTools,
    forbiddenTools,
    guidanceFetched: called.includes("skills"),
    toolCalls,
    nonMcpActions,
    finalText,
    usage,
    mcpResultTokens,
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

const caseResults = [];
for (const fixture of selected) {
  process.stderr.write(`Running fresh-agent case ${fixture.id}…\n`);
  const server = startServer();
  try {
    const ready = await server.ready;
    caseResults.push(await runAgent(fixture, ready.url));
  } finally {
    await stopServer(server.child);
  }
}

const result = {
  schemaVersion: 1,
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
  summary: {
    cases: caseResults.length,
    correct: caseResults.filter((fixture) => fixture.correct).length,
    routeEfficient: caseResults.filter((fixture) => fixture.routeEfficient)
      .length,
    contextEfficient: caseResults.filter(
      (fixture) => fixture.contextEfficient,
    ).length,
    passed: caseResults.filter((fixture) => fixture.passed).length,
    totalLatencyMs: round(
      caseResults.reduce((sum, fixture) => sum + fixture.latencyMs, 0),
      1,
    ),
    totalInputTokens: caseResults.reduce(
      (sum, fixture) => sum + (fixture.usage.input_tokens ?? 0),
      0,
    ),
    totalOutputTokens: caseResults.reduce(
      (sum, fixture) => sum + (fixture.usage.output_tokens ?? 0),
      0,
    ),
    totalMcpResultTokens: caseResults.reduce(
      (sum, fixture) => sum + fixture.mcpResultTokens,
      0,
    ),
  },
  cases: caseResults,
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
      correct: fixture.correct,
      routeEfficient: fixture.routeEfficient,
      contextEfficient: fixture.contextEfficient,
      calledTools: fixture.calledTools,
      latencyMs: fixture.latencyMs,
      mcpResultTokens: fixture.mcpResultTokens,
    })),
  })}\n`,
);
