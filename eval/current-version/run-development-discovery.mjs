import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAuditClient } from "./audit-lib.mjs";
import { runDiscoveryBenchmark } from "./discovery-benchmark.mjs";

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
  option("--output", "results/issue-322-development-discovery.json"),
);
const reportPath = resolve(
  here,
  option("--report", "results/issue-322-development-discovery.md"),
);
const tokenizerName = process.env.CONNECTA_EVAL_TOKENIZER ?? "o200k_base";
const corpusPath = resolve(here, "discovery-development.json");
const corpusBytes = await readFile(corpusPath);
const bearer = "connecta-development-discovery-token";

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
        CONNECTA_EVAL_DEVELOPMENT_CORPUS: "enabled",
        CONNECTA_EVAL_DISCOVERY_ONLY: "enabled",
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
      rejectReady(new Error(`Development server timed out.\n${stderr}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(
        new Error(`Development server exited before readiness (${code}).\n${stderr}`),
      );
    });
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.event === "ready") {
            clearTimeout(timeout);
            resolveReady(message);
          }
        } catch {
          // Ignore non-protocol server output.
        }
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

const server = startServer();
let context;
try {
  const ready = await server.ready;
  context = await createAuditClient({
    url: ready.url,
    token: bearer,
    tokenizerName,
  });
  const discovery = await runDiscoveryBenchmark(context, corpusPath);
  const qualification = {
    passed:
      discovery.cases.every((entry) => entry.passed) &&
      discovery.metrics.expectedTopAccuracy === 1 &&
      discovery.metrics.positiveRecall === 1 &&
      discovery.metrics.coverageExpectedChecks > 0 &&
      discovery.metrics.coverageExpectedPassed ===
        discovery.metrics.coverageExpectedChecks &&
      discovery.metrics.coverageDiscriminatingCases > 0,
  };
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      commit: sourceCommit,
      nodeVersion: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      tokenizer: tokenizerName,
      corpusSha256: sha256(corpusBytes),
      harnessSha256: sha256(
        await readFile(fileURLToPath(import.meta.url)),
      ),
      sandboxSha256: sha256(
        await readFile(resolve(here, "sandbox-server.ts")),
      ),
      hostIsolation:
        "Loopback-only sandbox with only the development connector configured; deterministic provider handlers; no model, Codex CLI, external account, host app, or plugin.",
    },
    qualification,
    connection: context.connection,
    discovery,
  };
  const metrics = discovery.metrics;
  const report = `# Issue #322 development discovery evidence

Source commit: \`${sourceCommit}\`

Runtime: Node ${result.source.nodeVersion} on ${result.source.platform}; tokenizer \`${tokenizerName}\`

Machine-readable results: [\`${basename(outputPath)}\`](./${basename(outputPath)})

## Result

- Development gate: ${qualification.passed ? "pass" : "FAIL"}
- Expected top-1 accuracy: ${(metrics.expectedTopAccuracy * 100).toFixed(1)}%
- Positive recall: ${(metrics.positiveRecall * 100).toFixed(1)}%
- Mean precision: ${(metrics.meanPrecision * 100).toFixed(1)}%
- Coverage assertions: ${metrics.coverageExpectedPassed}/${metrics.coverageExpectedChecks}
- Cases where coverage distinguishes the name match from description-only decoys: ${metrics.coverageDiscriminatingCases}/${discovery.corpus.queryCount}
- Query-coverage cost: ${metrics.totalQueryCoverageTokens} of ${metrics.totalResponseTokens} response tokens (${(metrics.queryCoverageShare * 100).toFixed(1)}%)

The development corpus is separate from the sealed release holdout. The server exposes only its synthetic analytics connector on loopback. It does not call a model, the Codex CLI, a host app, a plugin, or an external account.
`;
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(reportPath, report);
  process.stdout.write(
    `${JSON.stringify({
      event: "development_discovery_complete",
      output: outputPath,
      report: reportPath,
      sourceCommit,
      qualification,
      metrics,
    })}\n`,
  );
  if (!qualification.passed) process.exitCode = 1;
} finally {
  if (context) await context.close();
  await stopServer(server.child);
}
