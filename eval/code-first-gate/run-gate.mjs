// The runner. One sample is one fresh gate server plus one throwaway agent
// session, so samples are independent by construction rather than by promise.
//
//   node run-gate.mjs --models claude:opus,codex:gpt-5 --samples 20
//
// Jobs are ordered sample-major: after five of twenty samples you have five
// samples of every scenario, arm, and model rather than a complete picture of
// the first model and nothing about the second. A campaign interrupted halfway
// is therefore still balanced evidence.
//
// A failed job becomes a recorded sample with `harnessError`, never an aborted
// campaign — four hundred agent runs is too much spend to lose to one flake.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getEncoding } from "js-tiktoken";

import { driverFor, parseModelSpec } from "./agents.mjs";
import { measureSample, payloadFreeViolations } from "./measure.mjs";
import { renderReport } from "./report.mjs";
import {
  ARMS,
  readActivity,
  startGateServer,
  stopGateServer,
} from "./server-process.mjs";
import {
  CORPUS_VERSION,
  SCENARIOS,
  SYSTEM_PROMPT,
  promptFor,
  variantForSample,
} from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const argv = process.argv.slice(2);

function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function flag(name) {
  return argv.includes(name);
}

function positiveInteger(name, fallback) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function list(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function fileHash(name) {
  return sha256(await readFile(resolve(here, name), "utf8"));
}

const requestedModels = option("--models", "");
if (requestedModels === "") {
  throw new Error('--models is required, e.g. --models "claude:opus,claude:sonnet".');
}
const modelSpecs = list(requestedModels).map(parseModelSpec);
const samples = positiveInteger("--samples", 20);
const concurrency = positiveInteger("--concurrency", 2);
const timeoutMs = positiveInteger("--timeout-ms", 300_000);
const armNames = list(option("--arms", "code,classic"));
const scenarioFilter = option("--scenarios", "all");
const label = option("--label", "gate");
const dryRun = flag("--dry-run");
const keepTranscripts = flag("--keep-transcripts");
const tokenizerName = process.env.CONNECTA_GATE_TOKENIZER ?? "o200k_base";
const bearer = "connecta-code-first-gate-token";
const outputPath = resolve(here, option("--output", `results/${label}.json`));
const reportPath = resolve(here, option("--report", `results/${label}.md`));

for (const arm of armNames) {
  if (!ARMS[arm]) {
    throw new Error(`Unknown arm "${arm}". Choose code and/or classic.`);
  }
}
if (!armNames.includes("classic")) {
  process.stderr.write(
    "warning: running without the classic control arm — token and round-trip deltas will be absent.\n",
  );
}

const scenarios =
  scenarioFilter === "all"
    ? SCENARIOS
    : SCENARIOS.filter((scenario) => list(scenarioFilter).includes(scenario.id));
if (scenarios.length === 0) {
  throw new Error(
    `No scenario matched "${scenarioFilter}". Choose ${SCENARIOS.map(
      (scenario) => scenario.id,
    ).join(", ")}, or all.`,
  );
}

/**
 * The fixed cost of an arm: what its tool list actually advertises. Measured
 * once per arm from the client seat, because it is identical for every sample.
 */
async function probeArm(arm) {
  const server = startGateServer({ arm, token: bearer, sourceCommit });
  try {
    const ready = await server.ready;
    const client = new Client({ name: "connecta-code-first-gate", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(ready.url), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    await client.connect(transport);
    const listed = await client.listTools();
    await transport.close();
    return {
      arm,
      toolCount: listed.tools.length,
      tools: listed.tools.map((tool) => tool.name).sort(),
      toolDefinitionTokens: tokens(JSON.stringify(listed.tools)),
    };
  } finally {
    await stopGateServer(server.child);
  }
}

// ---------------------------------------------------------------------------
// provenance
// ---------------------------------------------------------------------------

const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const productDirty =
  execFileSync(
    "git",
    ["status", "--porcelain", "--", "src", "package.json", "package-lock.json"],
    { cwd: root, encoding: "utf8" },
  ).trim() !== "";
const tokenizer = getEncoding(tokenizerName);
const tokens = (text) => tokenizer.encode(text).length;

const driverVersions = Object.fromEntries(
  [...new Set(modelSpecs.map((spec) => spec.driver))].map((name) => [
    name,
    driverFor(name).version(),
  ]),
);

const jobs = [];
for (let sample = 0; sample < samples; sample += 1) {
  for (const scenario of scenarios) {
    for (const arm of armNames) {
      for (const spec of modelSpecs) {
        jobs.push({
          index: jobs.length,
          sample: sample + 1,
          scenario,
          variant: variantForSample(scenario, sample),
          arm,
          spec,
        });
      }
    }
  }
}

if (dryRun) {
  process.stdout.write(
    `${JSON.stringify(
      {
        event: "dry_run",
        jobs: jobs.length,
        models: modelSpecs.map((spec) => spec.spec),
        arms: armNames,
        scenarios: scenarios.map((scenario) => scenario.id),
        samplesPerTaskPerModelPerArm: samples,
        agentSessions: jobs.length,
      },
      null,
      2,
    )}\n`,
  );
  tokenizer.free?.();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const arms = Object.fromEntries(
  await Promise.all(armNames.map(async (arm) => [arm, await probeArm(arm)])),
);

const results = Array.from({ length: jobs.length });
const invariantViolations = [];
let nextJob = 0;
let completed = 0;

async function runJob(job) {
  const server = startGateServer({
    arm: job.arm,
    token: bearer,
    sourceCommit,
  });
  const prompt = promptFor(job.scenario, job.variant);
  try {
    const ready = await server.ready;
    const driver = driverFor(job.spec.driver);
    let transcript;
    let harnessError;
    try {
      transcript = await driver.run({
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        mcpUrl: ready.url,
        token: bearer,
        model: job.spec.model,
        timeoutMs,
        cwd: "/tmp",
      });
      if (transcript.exitCode !== 0) {
        harnessError = `driver exited with ${transcript.exitCode}: ${transcript.stderr.slice(-400)}`;
      }
    } catch (error) {
      harnessError = error instanceof Error ? error.message : String(error);
    }
    const { events: activity, rollbacks } = await readActivity(
      ready.activityUrl,
      bearer,
    );
    const violations = payloadFreeViolations(activity);
    if (violations.length > 0) {
      invariantViolations.push({ job: job.index, keys: violations });
    }
    const measured = measureSample({
      scenario: job.scenario,
      variant: job.variant,
      arm: job.arm,
      transcript,
      activity,
      rollbacks,
      advertisedTools: arms[job.arm].tools,
      toolDefinitionTokens: arms[job.arm].toolDefinitionTokens,
      tokenizer: tokens,
      harnessError,
    });
    return {
      model: job.spec.spec,
      driver: job.spec.driver,
      requestedModel: job.spec.model,
      resolvedModel: transcript?.resolvedModel ?? job.spec.model,
      usageByModel: transcript?.usageByModel ?? {},
      sample: job.sample,
      promptSha256: sha256(prompt),
      ...measured,
      // Transcripts are the audit trail for a disputed sample. They are large,
      // so they are opt-in — and a failed sample keeps its transcript either
      // way, because that is the one you will want to read.
      ...(keepTranscripts || !measured.success
        ? {
            transcript: {
              events: transcript?.events ?? [],
              finalText: transcript?.finalText ?? "",
              stderr: transcript?.stderr ?? "",
            },
          }
        : {}),
    };
  } catch (error) {
    return {
      model: job.spec.spec,
      driver: job.spec.driver,
      requestedModel: job.spec.model,
      resolvedModel: job.spec.model,
      sample: job.sample,
      promptSha256: sha256(prompt),
      ...measureSample({
        scenario: job.scenario,
        variant: job.variant,
        arm: job.arm,
        transcript: undefined,
        activity: [],
        rollbacks: 0,
        advertisedTools: arms[job.arm].tools,
        toolDefinitionTokens: arms[job.arm].toolDefinitionTokens,
        tokenizer: tokens,
        harnessError: error instanceof Error ? error.message : String(error),
      }),
    };
  } finally {
    await stopGateServer(server.child);
  }
}

async function worker() {
  for (;;) {
    const index = nextJob;
    nextJob += 1;
    const job = jobs[index];
    if (!job) return;
    results[index] = await runJob(job);
    completed += 1;
    const outcome = results[index].success ? "ok" : results[index].failure;
    process.stderr.write(
      `[${completed}/${jobs.length}] ${job.spec.spec} ${job.arm} ${job.scenario.id}/${job.variant.id} #${job.sample} → ${outcome}\n`,
    );
  }
}

await Promise.all(
  Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
);

const run = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  label,
  corpusVersion: CORPUS_VERSION,
  source: {
    commit: sourceCommit,
    productDirty,
    nodeVersion: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    tokenizer: tokenizerName,
    driverVersions,
  },
  configuration: {
    samplesPerTask: samples,
    concurrency,
    timeoutMs,
    keepTranscripts,
    arms: armNames,
    models: modelSpecs.map((spec) => spec.spec),
    scenarios: scenarios.map((scenario) => scenario.id),
    variantsPerScenario: Object.fromEntries(
      scenarios.map((scenario) => [
        scenario.id,
        scenario.variants.map((variant) => variant.id),
      ]),
    ),
    systemPromptSha256: sha256(SYSTEM_PROMPT),
    corpusSha256: await fileHash("scenarios.mjs"),
    gateServerSha256: await fileHash("gate-server.ts"),
    measureSha256: await fileHash("measure.mjs"),
    driversSha256: await fileHash("agents.mjs"),
    runnerSha256: await fileHash("run-gate.mjs"),
    isolation:
      "Fresh gate server and throwaway agent session per sample; user configuration, built-in tools, session persistence, and host features disabled.",
    observation:
      "Client-seat transcript plus connecta's payload-free activity events. The harness records no connecta-side payloads and asks connecta to record none.",
  },
  arms,
  invariantViolations,
  samples: results.filter((entry) => entry !== undefined),
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(run, null, 2)}\n`);
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, renderReport(run));
tokenizer.free?.();

process.stdout.write(
  `${JSON.stringify({
    event: "gate_run_complete",
    output: outputPath,
    report: reportPath,
    samples: run.samples.length,
    invariantViolations: invariantViolations.length,
  })}\n`,
);
