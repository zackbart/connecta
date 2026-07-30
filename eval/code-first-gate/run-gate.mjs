// The runner. One sample is one fresh gate server plus one throwaway agent
// session, so samples are independent by construction rather than by promise.
//
//   node run-gate.mjs --models claude:opus,codex:gpt-5 --samples 20
//
// Jobs are ordered sample-major: after five of twenty samples you have five
// samples of every task, arm, and model rather than a complete picture of the
// first model and nothing about the second. A campaign interrupted halfway is
// therefore still balanced evidence.
//
// A failed job becomes a recorded sample with `harnessError`, never an aborted
// campaign — hundreds of agent runs is too much spend to lose to one flake.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
  ARM_NAMES,
  CANDIDATE_ARM,
  CONTROL_ARM,
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

function nonNegativeInteger(name, fallback, minimum = 1) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}.`);
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
const samples = nonNegativeInteger("--samples", 20);
const concurrency = nonNegativeInteger("--concurrency", 2);
const timeoutMs = nonNegativeInteger("--timeout-ms", 300_000);
const downstreamDelayMs = nonNegativeInteger("--downstream-delay-ms", 0, 0);
const catalog = option("--catalog", "core");
const armNames = list(option("--arms", ARM_NAMES.join(",")));
const scenarioFilter = option("--scenarios", "all");
const label = option("--label", "gate");
const dryRun = flag("--dry-run");
const keepTranscripts = flag("--keep-transcripts");
const tokenizerName = process.env.CONNECTA_GATE_TOKENIZER ?? "o200k_base";
// The MCP bearer goes to the agent under test. The activity token never does —
// an instrument the subject can read is not an instrument.
const bearer = "connecta-code-first-gate-token";
const activityToken = `gate-activity-${randomBytes(16).toString("hex")}`;
const outputPath = resolve(here, option("--output", `results/${label}.json`));
const reportPath = resolve(here, option("--report", `results/${label}.md`));

for (const arm of armNames) {
  if (!ARMS[arm]) {
    throw new Error(
      `Unknown arm "${arm}". Choose one or more of ${ARM_NAMES.join(", ")}.`,
    );
  }
}
if (!armNames.includes(CONTROL_ARM)) {
  process.stderr.write(
    `warning: running without the ${CONTROL_ARM} control arm — token, round-trip, and regression comparisons will be absent.\n`,
  );
}
if (!armNames.includes(CANDIDATE_ARM)) {
  process.stderr.write(
    `warning: running without the ${CANDIDATE_ARM} arm — no flip verdict is available from this run.\n`,
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

const serverOptions = {
  token: bearer,
  activityToken,
  sourceCommit,
  catalog,
  downstreamDelayMs,
};

/**
 * The fixed cost of an arm: what its tool list actually advertises, read from the
 * client seat because that is what the model sees. Identical for every sample, so
 * it is measured once. A surface that does not match its declared shape is a
 * harness bug, not a finding, so it fails here rather than skewing a campaign.
 */
async function probeArm(arm) {
  const server = startGateServer({ arm, ...serverOptions });
  try {
    const ready = await server.ready;
    const client = new Client({
      name: "connecta-code-first-gate",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(new URL(ready.url), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    await client.connect(transport);
    const listed = await client.listTools();
    await transport.close();
    const names = listed.tools.map((tool) => tool.name).sort();
    const expected = ARMS[arm].expectedToolCount;
    if (names.length !== expected) {
      throw new Error(
        `Arm "${arm}" advertised ${names.length} tools, expected ${expected}: ${names.join(", ")}.`,
      );
    }
    for (const hidden of ARMS[arm].suppress) {
      if (names.includes(hidden)) {
        throw new Error(`Arm "${arm}" still advertises suppressed "${hidden}".`);
      }
    }
    return {
      arm,
      role: ARMS[arm].role,
      toolCount: names.length,
      tools: names,
      suppressed: [...ARMS[arm].suppress].sort(),
      toolDefinitionTokens: tokens(JSON.stringify(listed.tools)),
    };
  } finally {
    await stopGateServer(server.child);
  }
}

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
        sessionsPerModel: jobs.length / modelSpecs.length,
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

function measureFor(job, transcript, activity, mutations, harnessError) {
  return measureSample({
    scenario: job.scenario,
    variant: job.variant,
    arm: job.arm,
    transcript,
    activity,
    mutations,
    advertisedTools: arms[job.arm].tools,
    toolDefinitionTokens: arms[job.arm].toolDefinitionTokens,
    tokenizer: tokens,
    harnessError,
  });
}

function record(job, transcript, measured) {
  return {
    model: job.spec.spec,
    driver: job.spec.driver,
    requestedModel: job.spec.model,
    resolvedModel: transcript?.resolvedModel ?? `unresolved:${job.spec.model}`,
    usageByModel: transcript?.usageByModel ?? {},
    sample: job.sample,
    promptSha256: sha256(promptFor(job.scenario, job.variant)),
    ...measured,
    // Transcripts are the audit trail for a disputed sample. They are large, so
    // they are opt-in — and a failed sample keeps its transcript either way,
    // because that is the one you will want to read.
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
}

async function runJob(job) {
  const server = startGateServer({ arm: job.arm, ...serverOptions });
  try {
    const ready = await server.ready;
    const driver = driverFor(job.spec.driver);
    let transcript;
    let harnessError;
    try {
      transcript = await driver.run({
        prompt: promptFor(job.scenario, job.variant),
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
    const { events: activity, mutations } = await readActivity(
      ready.activityUrl,
      activityToken,
    );
    const violations = payloadFreeViolations(activity);
    if (violations.length > 0) {
      invariantViolations.push({ job: job.index, keys: violations });
    }
    return record(
      job,
      transcript,
      measureFor(job, transcript, activity, mutations, harnessError),
    );
  } catch (error) {
    return record(
      job,
      undefined,
      measureFor(
        job,
        undefined,
        [],
        { rollbacks: 0, purgeAttempts: 0 },
        error instanceof Error ? error.message : String(error),
      ),
    );
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
  schemaVersion: 2,
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
    catalog,
    downstreamDelayMs,
    arms: armNames,
    candidateArm: CANDIDATE_ARM,
    controlArm: CONTROL_ARM,
    models: modelSpecs.map((spec) => spec.spec),
    scenarios: scenarios.map((scenario) => scenario.id),
    variantsPerScenario: Object.fromEntries(
      scenarios.map((scenario) => [
        scenario.id,
        scenario.variants.map((variant) => variant.id),
      ]),
    ),
    intendedRoutes: Object.fromEntries(
      scenarios.map((scenario) => [scenario.id, scenario.intendedRoute ?? {}]),
    ),
    keepTranscripts,
    systemPromptSha256: sha256(SYSTEM_PROMPT),
    corpusSha256: await fileHash("scenarios.mjs"),
    gateServerSha256: await fileHash("gate-server.ts"),
    measureSha256: await fileHash("measure.mjs"),
    driversSha256: await fileHash("agents.mjs"),
    runnerSha256: await fileHash("run-gate.mjs"),
    isolation:
      "Fresh gate server and throwaway agent session per sample; user configuration, built-in tools, session persistence, and host features disabled. The activity token is never exported to a driver.",
    observation:
      "Client-seat transcript, connecta's payload-free activity events, and the fixtures' own mutation counters. The harness records no connecta-side payloads and asks connecta to record none.",
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
