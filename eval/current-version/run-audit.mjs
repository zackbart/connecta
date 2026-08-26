import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAuditClient, round } from "./audit-lib.mjs";
import { codeFirstTools } from "./agent-benchmark-scoring.mjs";
import { runTaskAudit } from "./audit-all-tools.mjs";
import { runDiscoveryBenchmark } from "./discovery-benchmark.mjs";
import { renderReport } from "./report.mjs";

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

const sourceCommit = option(
  "--source-commit",
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
);
const outputPath = resolve(
  here,
  option("--output", "results/current-version.json"),
);
const reportPath = resolve(
  here,
  option(
    "--report",
    outputPath.endsWith(".json")
      ? outputPath.slice(0, -5) + ".md"
      : outputPath + ".md",
  ),
);
const tokenizerName =
  process.env.CONNECTA_EVAL_TOKENIZER ?? "o200k_base";
const executorMode = "required";
const surface = "seven-tool";
const bearer = process.env.CONNECTA_EVAL_TOKEN ?? "connecta-eval-token";
const operatorToken =
  process.env.CONNECTA_EVAL_OPERATOR_TOKEN ?? "connecta-eval-operator";
const corpusPath = resolve(here, "discovery-holdout.json");
const corpusBytes = await readFile(corpusPath);

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
        CONNECTA_EVAL_OPERATOR_TOKEN: operatorToken,
        CONNECTA_EVAL_SOURCE_COMMIT: sourceCommit,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  child.stdout.setEncoding("utf8");
  let buffered = "";
  const ready = new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error(`Eval server readiness timed out.\n${stderr}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(
        new Error(`Eval server exited before readiness (${code}).\n${stderr}`),
      );
    });
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.event === "ready") {
          clearTimeout(timeout);
          resolveReady(message);
        }
      }
    });
  });
  return { child, ready };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error("Eval server did not stop within 10 seconds."));
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

const server = startServer();
let context;
try {
  const ready = await server.ready;
  context = await createAuditClient({
    url: ready.url,
    token: bearer,
    tokenizerName,
  });
  const tasks = await runTaskAudit(context, {
    baseUrl: ready.baseUrl,
    operatorToken,
  });
  const discovery = await runDiscoveryBenchmark(context, corpusPath);
  const observations = context.observations;
  const definitionTokens = context.connection.toolsListTokens;
  const requestTokens = observations.reduce(
    (sum, entry) => sum + entry.requestTokens,
    0,
  );
  const responseTokens = observations.reduce(
    (sum, entry) => sum + entry.responseTokens,
    0,
  );
  const activityCase = tasks.cases.find(
    (entry) => entry.outcome === "activity-payload-free",
  );
  // The `surface` stamp below is a constant; without this check a server that
  // regressed to the classic nine would still be filed as seven-tool evidence.
  const advertisedTools = context.connection.tools
    .map((tool) => tool.name)
    .sort();
  const expectedTools = [...codeFirstTools].sort();
  const surfaceMatches =
    advertisedTools.length === expectedTools.length &&
    advertisedTools.every((name, index) => name === expectedTools[index]);
  const holdoutFalsePositives = discovery.cases.filter(
    (entry) => entry.relevant.length === 0 && entry.falsePositive,
  ).length;
  const qualificationChecks = [
    {
      name: "advertised surface is exactly the seven meta-tools",
      actual: advertisedTools,
      expected: expectedTools,
      passed: surfaceMatches,
    },
    {
      name: "all behavioral scenarios pass",
      actual: tasks.summary.taskSuccessRate,
      minimum: 1,
      passed: tasks.summary.taskSuccessRate === 1,
    },
    {
      name: "holdout top-1 accuracy does not regress",
      actual: discovery.metrics.top1Accuracy,
      minimum: 0.931,
      passed: discovery.metrics.top1Accuracy >= 0.931,
    },
    {
      name: "holdout positive recall stays complete",
      actual: discovery.metrics.positiveRecall,
      minimum: 1,
      passed: discovery.metrics.positiveRecall === 1,
    },
    {
      name: "default-page recall stays complete",
      actual: discovery.metrics.recallAtDefaultPage,
      minimum: 1,
      passed: discovery.metrics.recallAtDefaultPage === 1,
    },
    {
      name: "holdout negatives return at most one false positive",
      actual: holdoutFalsePositives,
      maximum: 1,
      passed: holdoutFalsePositives <= 1,
    },
    {
      name: "activity storage stays payload-free",
      actual:
        activityCase?.passed === true &&
        Array.isArray(activityCase.forbiddenPresent) &&
        activityCase.forbiddenPresent.length === 0,
      expected: true,
      passed:
        activityCase?.passed === true &&
        Array.isArray(activityCase.forbiddenPresent) &&
        activityCase.forbiddenPresent.length === 0,
    },
  ];
  const audit = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      commit: sourceCommit,
      nodeVersion: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      tokenizer: tokenizerName,
      executorMode,
      surface,
      corpusSha256: createHash("sha256").update(corpusBytes).digest("hex"),
    },
    connection: context.connection,
    totals: {
      definitionTokens,
      requestTokens,
      responseTokens,
      measuredSurfaceTokens:
        definitionTokens + requestTokens + responseTokens,
      requestBytes: observations.reduce(
        (sum, entry) => sum + entry.requestBytes,
        0,
      ),
      responseBytes: observations.reduce(
        (sum, entry) => sum + entry.responseBytes,
        0,
      ),
      roundTrips: observations.length,
      summedLatencyMs: round(
        observations.reduce((sum, entry) => sum + entry.latencyMs, 0),
      ),
    },
    compatibility: {
      client: "@modelcontextprotocol/client StreamableHTTPClientTransport",
      protocolMode: "stateless streamable HTTP",
      resultCount: observations.length,
      contentResults: observations.filter((entry) => entry.hasContent).length,
      structuredContentResults: observations.filter(
        (entry) => entry.hasStructuredContent,
      ).length,
      executeCodeAdvertised: context.listed.tools.some(
        (tool) => tool.name === "execute_code",
      ),
    },
    invariants: {
      activityPayloadFree:
        activityCase?.passed === true &&
        Array.isArray(activityCase.forbiddenPresent) &&
        activityCase.forbiddenPresent.length === 0,
      activityKeys: activityCase?.activityKeys ?? [],
    },
    qualification: {
      passed: qualificationChecks.every((check) => check.passed),
      checks: qualificationChecks,
    },
    tasks,
    discovery,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(audit, null, 2)}\n`);
  await writeFile(
    reportPath,
    renderReport(audit, basename(outputPath)),
  );
  process.stdout.write(
    `${JSON.stringify({
      event: "audit_complete",
      sourceCommit,
      output: outputPath,
      report: reportPath,
      taskSuccessRate: audit.tasks.summary.taskSuccessRate,
      discovery: audit.discovery.metrics,
      totals: audit.totals,
      executorMode,
      surface,
    })}\n`,
  );
  if (!audit.qualification.passed) {
    process.exitCode = 1;
  }
} finally {
  if (context) await context.close();
  await stopServer(server.child);
}
