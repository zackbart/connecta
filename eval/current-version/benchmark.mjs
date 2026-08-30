import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getEncoding } from "js-tiktoken";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const tokenizer = getEncoding("o200k_base");
const agentModel = process.env.CONNECTA_BENCHMARK_MODEL ?? "gpt-5.6-sol";
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
  "shell_snapshot",
  "shell_tool",
  "unified_exec",
  "workspace_dependencies",
];

function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function positiveInteger(name, fallback) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseAnswer(text) {
  const direct = parseJson(text.trim());
  if (direct !== undefined) return direct;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? parseJson(fenced[1].trim()) : undefined;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

const cases = [
  {
    id: "cold-unknown-read",
    purpose: "Cold discovery and one read in a large catalog",
    expectedRoute: ["execute_code"],
    prompt: `Use only the Connecta MCP server. You do not know the connector or tool address yet. Look up the current project named Atlas. Return only JSON with exactly name, status, and owner.`,
    score({ answer, downstreamCalls }) {
      return {
        correct:
          answer?.name === "Atlas" &&
          answer?.status === "on_track" &&
          answer?.owner === "Rina Shah",
        semantics:
          downstreamCalls.length === 1 &&
          downstreamCalls[0]?.address === "projects.list_projects",
        private: true,
      };
    },
  },
  {
    id: "known-address-read",
    purpose: "Control: one read whose canonical address is already known",
    expectedRoute: ["call_tool"],
    prompt: `Use only the Connecta MCP server. The canonical address is projects.list_projects and it takes no arguments. Call it, select Atlas, and return only JSON with exactly name, status, and owner.`,
    score({ answer, downstreamCalls }) {
      return {
        correct:
          answer?.name === "Atlas" &&
          answer?.status === "on_track" &&
          answer?.owner === "Rina Shah",
        semantics:
          downstreamCalls.length === 1 &&
          downstreamCalls[0]?.address === "projects.list_projects",
        private: true,
      };
    },
  },
  {
    id: "semantic-analytics",
    purpose: "Exact provider semantics and positional-table validation",
    expectedRoute: ["execute_code"],
    prompt: `Use only the Connecta MCP server. In the Mixpanel sandbox, find product-wide usage for the project named Pulse over the last 30 days. Follow every connector guide required by discovery, resolve exact identities, and validate any table before reading it. Return only JSON with exactly projectId, eventName, days, and total.`,
    score({ answer, downstreamCalls, toolCalls }) {
      const query = downstreamCalls.find(
        (call) => call.address === "mixpanel.query_event_usage",
      );
      const listed = downstreamCalls.some(
        (call) => call.address === "mixpanel.list_events",
      );
      const guideFetched = toolCalls.some(
        (call) =>
          call.tool === "skills" &&
          call.arguments?.name === "connector:mixpanel",
      );
      return {
        correct:
          answer?.projectId === 2803261 &&
          answer?.eventName === "App Open or Present Session" &&
          answer?.days === 30 &&
          answer?.total === 334100,
        semantics:
          guideFetched &&
          listed &&
          query?.args?.projectId === 2803261 &&
          query?.args?.eventName === "App Open or Present Session" &&
          query?.args?.days === 30,
        private: true,
      };
    },
  },
  {
    id: "private-pagination",
    purpose: "Pagination and in-sandbox reduction of private records",
    expectedRoute: ["execute_code"],
    prompt: `Use only the Connecta MCP server and Stripe sandbox. Count every customer across all pages. Customer records contain private identifiers and emails: do not return, quote, or summarize any record. Return only JSON with exactly customerCount.`,
    score({ answer, downstreamCalls, finalText }) {
      const pages = downstreamCalls.filter(
        (call) => call.address === "stripe-sandbox.list_customers",
      );
      return {
        correct: answer?.customerCount === 225,
        semantics:
          pages.length === 3 &&
          pages[0]?.args?.starting_after === undefined &&
          pages[1]?.args?.starting_after === "cus_benchmark_100" &&
          pages[2]?.args?.starting_after === "cus_benchmark_200",
        private:
          !/@example\.invalid/i.test(finalText) &&
          !/cus_benchmark_/i.test(finalText),
      };
    },
  },
];

function startServer() {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: here,
    env: { ...process.env, CONNECTA_BENCHMARK_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const ready = new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error(`Benchmark server timed out.\n${stderr}`)),
      30_000,
    );
    child.once("error", rejectReady);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`Benchmark server exited early (${code}).\n${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        const message = parseJson(stdout.slice(0, newline));
        stdout = stdout.slice(newline + 1);
        if (message?.event !== "ready") continue;
        clearTimeout(timeout);
        resolveReady(message);
        return;
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

async function runCodex(fixture, ready) {
  const workspace = await mkdtemp(resolve(tmpdir(), "connecta-benchmark-"));
  const command = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    workspace,
    "--config",
    `mcp_servers.connecta.url="${ready.url}"`,
    "--config",
    'mcp_servers.connecta.bearer_token_env_var="CONNECTA_BENCHMARK_TOKEN"',
    "--config",
    'approval_policy="never"',
    ...disabledHostFeatures.flatMap((feature) => ["--disable", feature]),
    "--model",
    agentModel,
    fixture.prompt,
  ];
  const startedAt = performance.now();
  const child = spawn("codex", command, {
    cwd: workspace,
    env: { ...process.env, CONNECTA_BENCHMARK_TOKEN: ready.token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let buffer = "";
  let stderr = "";
  let finalText = "";
  let usage = {};
  const toolCalls = [];
  const itemStarts = new Map();
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const event = parseJson(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (!event) continue;
      if (event.type === "item.started") {
        itemStarts.set(event.item?.id, performance.now());
      } else if (event.type === "item.completed") {
        const item = event.item ?? {};
        if (item.type === "mcp_tool_call" && item.server === "connecta") {
          const serialized = JSON.stringify(item.result ?? null);
          const itemStarted = itemStarts.get(item.id);
          toolCalls.push({
            tool: item.tool,
            arguments: item.arguments,
            status: item.status,
            durationMs:
              itemStarted === undefined ? null : round(performance.now() - itemStarted),
            resultBytes: Buffer.byteLength(serialized),
            resultTokens: tokenizer.encode(serialized).length,
          });
        } else if (item.type === "agent_message") {
          finalText = item.text ?? "";
        }
      } else if (event.type === "turn.completed") {
        usage = event.usage ?? {};
      }
    }
  });

  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error(`Codex timed out in ${fixture.id}.`));
    }, 180_000);
    child.once("error", rejectExit);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  await rm(workspace, { recursive: true, force: true });
  if (exitCode !== 0) {
    throw new Error(`Codex exited with ${exitCode} in ${fixture.id}.\n${stderr}`);
  }
  return {
    finalText,
    usage,
    toolCalls,
    latencyMs: round(performance.now() - startedAt),
  };
}

function forwardingMetrics(outerCalls, toolCalls) {
  const results = outerCalls
    .map((call) => parseJson(call.responseText)?.result)
    .filter((result) => result && typeof result === "object");
  const responseBytes = outerCalls.reduce((sum, call) => sum + call.responseBytes, 0);
  const modelResultBytes = toolCalls.reduce((sum, call) => sum + call.resultBytes, 0);
  return {
    outerResponseBytes: responseBytes,
    contentBytes: results.reduce(
      (sum, result) => sum + Buffer.byteLength(JSON.stringify(result.content ?? null)),
      0,
    ),
    structuredContentBytes: results.reduce(
      (sum, result) =>
        sum + Buffer.byteLength(JSON.stringify(result.structuredContent ?? null)),
      0,
    ),
    modelResultBytes,
    modelResultTokens: toolCalls.reduce((sum, call) => sum + call.resultTokens, 0),
    duplicatedCalls: results.filter(
      (result) => result.content !== undefined && result.structuredContent !== undefined,
    ).length,
    representationDuplicated: results.some(
      (result) => result.content !== undefined && result.structuredContent !== undefined,
    ),
  };
}

async function runOnce(fixture, repetition) {
  const server = startServer();
  const ready = await server.ready;
  try {
    const agent = await runCodex(fixture, ready);
    const stateResponse = await fetch(ready.stateUrl);
    if (!stateResponse.ok) throw new Error(`State read failed: ${stateResponse.status}`);
    const state = await stateResponse.json();
    const answer = parseAnswer(agent.finalText);
    const route = agent.toolCalls
      .filter((call) => call.tool !== "skills")
      .map((call) => call.tool);
    const routeCorrect = JSON.stringify(route) === JSON.stringify(fixture.expectedRoute);
    const checks = fixture.score({
      answer,
      finalText: agent.finalText,
      downstreamCalls: state.downstreamCalls,
      toolCalls: agent.toolCalls,
    });
    return {
      case: fixture.id,
      repetition,
      pass: routeCorrect && checks.correct && checks.semantics && checks.private,
      route,
      expectedRoute: fixture.expectedRoute,
      checks: { route: routeCorrect, ...checks },
      usage: agent.usage,
      latencyMs: agent.latencyMs,
      forwarding: forwardingMetrics(state.outerCalls, agent.toolCalls),
      toolCalls: agent.toolCalls,
      downstreamCalls: state.downstreamCalls,
      finalText: agent.finalText,
    };
  } finally {
    await stopServer(server.child);
  }
}

function summarize(runs) {
  const totals = runs.reduce(
    (sum, run) => ({
      passed: sum.passed + Number(run.pass),
      inputTokens: sum.inputTokens + (run.usage.input_tokens ?? 0),
      cachedInputTokens:
        sum.cachedInputTokens + (run.usage.cached_input_tokens ?? 0),
      outputTokens: sum.outputTokens + (run.usage.output_tokens ?? 0),
      resultTokens: sum.resultTokens + run.forwarding.modelResultTokens,
      latencyMs: sum.latencyMs + run.latencyMs,
    }),
    { passed: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, resultTokens: 0, latencyMs: 0 },
  );
  return {
    runs: runs.length,
    ...totals,
    passRate: runs.length ? totals.passed / runs.length : 0,
    averageLatencyMs: runs.length ? round(totals.latencyMs / runs.length) : 0,
  };
}

function markdown(report) {
  const lines = [
    "# Current-version benchmark",
    "",
    `Generated ${report.generatedAt} with Codex. ${report.summary.passed}/${report.summary.runs} runs passed.`,
    "",
    "| Case | Pass | Route | Input | Cached | Output | MCP result | Latency |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const run of report.runs) {
    lines.push(
      `| ${run.case} #${run.repetition} | ${run.pass ? "yes" : "no"} | ${run.route.join(" → ") || "none"} | ${run.usage.input_tokens ?? 0} | ${run.usage.cached_input_tokens ?? 0} | ${run.usage.output_tokens ?? 0} | ${run.forwarding.modelResultTokens} | ${run.latencyMs} ms |`,
    );
  }
  lines.push(
    "",
    "A run passes only when route, answer, provider semantics, and privacy checks all pass. Raw JSON carries tool calls, downstream arguments, and forwarding bytes.",
    "",
  );
  return lines.join("\n");
}

function selfTest() {
  const parsed = parseAnswer("```json\n{\"customerCount\":75}\n```");
  if (parsed?.customerCount !== 75) throw new Error("Fenced answer parsing failed.");
  const metrics = forwardingMetrics(
    [{
      responseBytes: 60,
      responseText: '{"jsonrpc":"2.0","result":{"content":[],"structuredContent":{}}}',
    }],
    [{ resultBytes: 20, resultTokens: 7 }],
  );
  if (
    !metrics.representationDuplicated ||
    metrics.duplicatedCalls !== 1 ||
    metrics.contentBytes !== 2 ||
    metrics.structuredContentBytes !== 2 ||
    metrics.modelResultTokens !== 7
  ) {
    throw new Error("Forwarding metric self-test failed.");
  }
  console.log("benchmark self-test passed");
}

if (argv.includes("--self-test")) {
  selfTest();
} else {
  const selected = option("--case", "all");
  const selectedCases =
    selected === "all" ? cases : cases.filter((fixture) => fixture.id === selected);
  if (selectedCases.length === 0) throw new Error(`Unknown case: ${selected}`);
  const repetitions = positiveInteger("--repetitions", 3);
  const output = resolve(here, option("--output", "results/latest.json"));
  const runs = [];
  for (const fixture of selectedCases) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      process.stderr.write(`running ${fixture.id} #${repetition}\n`);
      runs.push(await runOnce(fixture, repetition));
    }
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    agent: { client: "codex", model: agentModel },
    tokenizer: "o200k_base",
    summary: summarize(runs),
    runs,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(output.replace(/\.json$/i, ".md"), markdown(report));
  console.log(JSON.stringify(report.summary));
  if (runs.some((run) => !run.pass)) process.exitCode = 1;
}

tokenizer.free?.();
