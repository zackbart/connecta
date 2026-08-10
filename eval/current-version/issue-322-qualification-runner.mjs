import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
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

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function round(value, places = 3) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function logChoose(n, k) {
  if (k < 0 || k > n) return Number.NEGATIVE_INFINITY;
  const selected = Math.min(k, n - k);
  let result = 0;
  for (let index = 1; index <= selected; index += 1) {
    result += Math.log(n - selected + index) - Math.log(index);
  }
  return result;
}

function fisherProbability(a, rowOne, columnOne, total) {
  return Math.exp(
    logChoose(columnOne, a) +
      logChoose(total - columnOne, rowOne - a) -
      logChoose(total, rowOne),
  );
}

function fisherTwoSided(a, b, c, d) {
  const rowOne = a + b;
  const rowTwo = c + d;
  const columnOne = a + c;
  const total = rowOne + rowTwo;
  const minimum = Math.max(0, rowOne - (total - columnOne));
  const maximum = Math.min(rowOne, columnOne);
  const observed = fisherProbability(a, rowOne, columnOne, total);
  let sum = 0;
  for (let candidate = minimum; candidate <= maximum; candidate += 1) {
    const probability = fisherProbability(
      candidate,
      rowOne,
      columnOne,
      total,
    );
    if (probability <= observed + 1e-12) sum += probability;
  }
  return Math.min(1, sum);
}

const planPath = resolve(here, "issue-322-qualification-plan.json");
const planText = await readFile(planPath, "utf8");
const plan = JSON.parse(planText);
const offWorktree = resolve(option("--off-worktree"));
const trailingWorktree = resolve(option("--trailing-worktree"));
const outputOption = option("--output-dir");
const outputDirectory = outputOption
  ? resolve(outputOption)
  : resolve(here, "results");
const batchDirectory = resolve(outputDirectory, ".issue-322-batches");
const model = process.env.CONNECTA_EVAL_AGENT_MODEL;
const nodeVersion = process.versions.node;
const codexVersion = execFileSync("codex", ["--version"], {
  encoding: "utf8",
}).trim();

if (model !== plan.environment.model) {
  throw new Error(
    `CONNECTA_EVAL_AGENT_MODEL must be ${plan.environment.model}; got ${model ?? "unset"}.`,
  );
}
if (nodeVersion !== plan.environment.nodeVersion) {
  throw new Error(
    `Node must be ${plan.environment.nodeVersion}; got ${nodeVersion}.`,
  );
}
if (codexVersion !== plan.environment.codexVersion) {
  throw new Error(
    `Codex must be ${plan.environment.codexVersion}; got ${codexVersion}.`,
  );
}

const armPaths = { off: offWorktree, trailing: trailingWorktree };
const preregistrationCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: resolve(here, "../.."),
  encoding: "utf8",
}).trim();
for (const [arm, worktree] of Object.entries(armPaths)) {
  const evalRoot = resolve(worktree, "eval/current-version");
  const hashes = {
    harnessSha256: sha256(
      await readFile(resolve(evalRoot, "agent-lookup-benchmark.mjs")),
    ),
    corpusSha256: sha256(
      `${await readFile(resolve(evalRoot, "discovery-holdout.json"), "utf8")}\0${await readFile(resolve(evalRoot, "discovery-development.json"), "utf8")}`,
    ),
    sandboxSha256: sha256(
      await readFile(resolve(evalRoot, "sandbox-server.ts")),
    ),
  };
  for (const [key, expected] of Object.entries({
    harnessSha256: plan.environment.harnessSha256,
    corpusSha256: plan.environment.corpusSha256,
    sandboxSha256: plan.environment.sandboxSha256,
  })) {
    if (hashes[key] !== expected) {
      throw new Error(`${arm} ${key} mismatch: ${hashes[key]} != ${expected}.`);
    }
  }
}

const offCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: offWorktree,
  encoding: "utf8",
}).trim();
if (offCommit !== preregistrationCommit) {
  throw new Error(
    `Coverage-off base must equal preregistration commit ${preregistrationCommit}; got ${offCommit}.`,
  );
}
const trailingCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: trailingWorktree,
  encoding: "utf8",
}).trim();
if (trailingCommit !== plan.arms.trailing.productCommit) {
  throw new Error(`Trailing source mismatch: ${trailingCommit}.`);
}
const offPatch = execFileSync(
  "git",
  ["diff", "--", "src/catalog-service.ts"],
  { cwd: offWorktree, encoding: "utf8" },
);
if (sha256(offPatch) !== plan.arms.off.patchSha256) {
  throw new Error(`Coverage-off patch mismatch: ${sha256(offPatch)}.`);
}

async function runBatch(arm, batchIndex) {
  const prefix = `issue-322-${arm}-batch-${String(batchIndex).padStart(2, "0")}`;
  const output = resolve(batchDirectory, `${prefix}.json`);
  const report = resolve(batchDirectory, `${prefix}.md`);
  const worktree = armPaths[arm];
  const commandArgs = [
    "--prefix",
    "eval/current-version",
    "run",
    "perf:lookup",
    "--",
    "--case",
    plan.environment.case,
    "--repetitions",
    String(plan.environment.batchRepetitions),
    "--concurrency",
    String(plan.environment.concurrency),
    "--output",
    output,
    "--report",
    report,
  ];
  const startedAt = new Date().toISOString();
  const child = spawn("npm", commandArgs, {
    cwd: worktree,
    env: {
      ...process.env,
      CONNECTA_EVAL_AGENT_MODEL: plan.environment.model,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
  if (exitCode !== 0) {
    throw new Error(`${arm} batch ${batchIndex} exited with ${exitCode}.`);
  }
  const artifactText = await readFile(output, "utf8");
  const artifact = JSON.parse(artifactText);
  return {
    arm,
    batchIndex,
    startedAt,
    completedAt: new Date().toISOString(),
    artifactSha256: sha256(artifactText),
    source: artifact.source,
    configuration: artifact.configuration,
    cases: artifact.cases,
    stdoutSha256: sha256(stdout),
  };
}

await rm(batchDirectory, { recursive: true, force: true });
await mkdir(batchDirectory, { recursive: true });
const armBatchCounts = { off: 0, trailing: 0 };
const schedule = [];
for (const arm of plan.scheduling.batchOrder) {
  armBatchCounts[arm] += 1;
  schedule.push(await runBatch(arm, armBatchCounts[arm]));
}

function summarize(cases) {
  const metricValues = {
    wholeInput: cases.map((entry) => entry.usage.input_tokens ?? 0),
    nonCachedInput: cases.map((entry) => entry.nonCachedInputTokens),
    roundTrips: cases.map((entry) => entry.connectaRoundTrips),
    latency: cases.map((entry) => entry.latencyMs),
    searchTokens: cases.map((entry) => entry.searchResultTokens),
    searchNoiseTokens: cases.map(
      (entry) => entry.estimatedLookupNoiseTokens,
    ),
    connectaTokens: cases.map((entry) => entry.connectaMcpResultTokens),
  };
  const distributions = Object.fromEntries(
    Object.entries(metricValues).map(([name, values]) => [
      name,
      {
        mean: round(mean(values), 1),
        median: round(median(values), 1),
        min: Math.min(...values),
        max: Math.max(...values),
      },
    ]),
  );
  const count = (select) => cases.filter(select).length;
  return {
    runs: cases.length,
    combinedCorrect: count((entry) => entry.routingResultCorrect),
    cleanRoute: count((entry) => entry.routeClean),
    addressCorrect: count((entry) => entry.addressAccurate),
    argumentCorrect: count((entry) => entry.argumentCorrect),
    finalCorrect: count((entry) => entry.finalCorrect),
    retrievalTop1: count((entry) => entry.retrievalTop1),
    retrievalRecallComplete: count((entry) => entry.retrievalRecall === 1),
    hostActions: cases.reduce(
      (sum, entry) => sum + entry.hostActionCount,
      0,
    ),
    foreignCalls: cases.reduce(
      (sum, entry) => sum + entry.foreignToolCalls,
      0,
    ),
    distributions,
  };
}

const arms = Object.fromEntries(
  Object.keys(armPaths).map((arm) => {
    const batches = schedule.filter((entry) => entry.arm === arm);
    const cases = batches.flatMap((entry, batchIndex) =>
      entry.cases.map((run) => ({
        ...run,
        repetition: batchIndex * plan.environment.batchRepetitions + run.repetition,
      })),
    );
    return [arm, { batches, summary: summarize(cases), cases }];
  }),
);

for (const [arm, artifact] of Object.entries(arms)) {
  if (artifact.cases.length !== plan.environment.repetitionsPerArm) {
    throw new Error(`${arm} produced ${artifact.cases.length} runs.`);
  }
  if (
    artifact.summary.hostActions !== plan.environment.requiredHostActions ||
    artifact.summary.foreignCalls !== plan.environment.requiredForeignCalls
  ) {
    throw new Error(`${arm} violated host isolation.`);
  }
}

const off = arms.off.summary;
const trailing = arms.trailing.summary;
const rate = (successes, runs) => successes / runs;
const ratio = (candidate, baseline) => candidate / baseline;
const combinedDelta =
  rate(trailing.combinedCorrect, trailing.runs) -
  rate(off.combinedCorrect, off.runs);
const routeDelta =
  rate(trailing.cleanRoute, trailing.runs) -
  rate(off.cleanRoute, off.runs);
const fisherP = fisherTwoSided(
  trailing.cleanRoute,
  trailing.runs - trailing.cleanRoute,
  off.cleanRoute,
  off.runs - off.cleanRoute,
);
const meanRatios = Object.fromEntries(
  ["wholeInput", "nonCachedInput", "roundTrips"].map((name) => [
    name,
    round(
      ratio(
        trailing.distributions[name].mean,
        off.distributions[name].mean,
      ),
      4,
    ),
  ]),
);
const medianRatios = Object.fromEntries(
  ["wholeInput", "nonCachedInput", "roundTrips"].map((name) => [
    name,
    round(
      ratio(
        trailing.distributions[name].median,
        off.distributions[name].median,
      ),
      4,
    ),
  ]),
);
const latencyRatio = round(
  ratio(
    trailing.distributions.latency.mean,
    off.distributions.latency.mean,
  ),
  4,
);
const gates = [
  {
    id: "combined-noninferiority",
    actual: round(combinedDelta, 4),
    minimum: -0.1,
    passed: combinedDelta >= -0.1,
  },
  {
    id: "clean-route-improvement",
    actualDifference: round(routeDelta, 4),
    minimumDifference: 0.2,
    fisherTwoSidedP: round(fisherP, 6),
    maximumP: 0.05,
    passed: routeDelta >= 0.2 && fisherP < 0.05,
  },
  {
    id: "mean-efficiency",
    ratios: meanRatios,
    maximumRatio: 1.1,
    passed: Object.values(meanRatios).every((value) => value <= 1.1),
  },
  {
    id: "median-efficiency",
    ratios: medianRatios,
    maximumRatio: 1.1,
    passed: Object.values(medianRatios).every((value) => value <= 1.1),
  },
  {
    id: "latency",
    meanRatio: latencyRatio,
    maximumRatio: 1.1,
    passed: latencyRatio <= 1.1,
  },
  {
    id: "isolation",
    off: { hostActions: off.hostActions, foreignCalls: off.foreignCalls },
    trailing: {
      hostActions: trailing.hostActions,
      foreignCalls: trailing.foreignCalls,
    },
    passed:
      off.hostActions === 0 &&
      off.foreignCalls === 0 &&
      trailing.hostActions === 0 &&
      trailing.foreignCalls === 0,
  },
];

const comparison = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  preregistration: {
    plan: "issue-322-qualification-plan.json",
    planSha256: sha256(planText),
    commit: preregistrationCommit,
  },
  environment: {
    ...plan.environment,
    nodeVersion,
    codexVersion,
  },
  schedule: schedule.map(({ arm, batchIndex, startedAt, completedAt, artifactSha256 }) => ({
    arm,
    batchIndex,
    startedAt,
    completedAt,
    artifactSha256,
  })),
  arms: {
    off: off,
    trailing: trailing,
  },
  analysis: {
    combinedDelta: round(combinedDelta, 4),
    cleanRouteDelta: round(routeDelta, 4),
    cleanRouteFisherTwoSidedP: round(fisherP, 6),
    meanRatios,
    medianRatios,
    latencyMeanRatio: latencyRatio,
  },
  gates,
  passed: gates.every((gate) => gate.passed),
};

const armOutput = async (arm) => {
  const artifact = {
    schemaVersion: 1,
    generatedAt: comparison.generatedAt,
    preregistration: comparison.preregistration,
    arm,
    source: arms[arm].batches[0].source,
    configuration: arms[arm].batches[0].configuration,
    batches: arms[arm].batches.map(
      ({ batchIndex, startedAt, completedAt, artifactSha256, stdoutSha256 }) => ({
        batchIndex,
        startedAt,
        completedAt,
        artifactSha256,
        stdoutSha256,
      }),
    ),
    summary: arms[arm].summary,
    cases: arms[arm].cases,
  };
  await writeFile(
    resolve(outputDirectory, `issue-322-preregistered-${arm}.json`),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all([armOutput("off"), armOutput("trailing")]);
await writeFile(
  resolve(outputDirectory, "issue-322-preregistered-comparison.json"),
  `${JSON.stringify(comparison, null, 2)}\n`,
);

const percentage = (value) => `${(value * 100).toFixed(1)}%`;
const markdown = `# Issue #322 preregistered off-vs-trailing qualification

Plan SHA-256: \`${comparison.preregistration.planSha256}\`

Preregistration commit: \`${comparison.preregistration.commit}\`

Result: **${comparison.passed ? "PASS" : "FAIL"}**

| Gate | Result |
| --- | --- |
${gates.map((gate) => `| ${gate.id} | ${gate.passed ? "pass" : "FAIL"} |`).join("\n")}

## Correctness

| Metric | Off | Trailing | Movement |
| --- | ---: | ---: | ---: |
| Combined exact result | ${off.combinedCorrect}/${off.runs} | ${trailing.combinedCorrect}/${trailing.runs} | ${percentage(combinedDelta)} |
| Clean intended route | ${off.cleanRoute}/${off.runs} | ${trailing.cleanRoute}/${trailing.runs} | ${percentage(routeDelta)} |
| Clean-route Fisher p | — | — | ${comparison.analysis.cleanRouteFisherTwoSidedP} |

## Efficiency

| Metric | Off mean | Trailing mean | Ratio | Off median | Trailing median | Ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${["wholeInput", "nonCachedInput", "roundTrips", "latency", "searchTokens", "connectaTokens"].map((name) => {
  const offMetric = off.distributions[name];
  const trailingMetric = trailing.distributions[name];
  return `| ${name} | ${offMetric.mean} | ${trailingMetric.mean} | ${round(trailingMetric.mean / offMetric.mean, 3)} | ${offMetric.median} | ${trailingMetric.median} | ${round(trailingMetric.median / offMetric.median, 3)} |`;
}).join("\n")}

Search and Connecta MCP tokens are reported but do not offset a failed primary
gate. Every arm used 30 fresh sessions in the preregistered six-by-five batch
schedule with concurrency five. Host actions and foreign calls were zero.
`;
await writeFile(
  resolve(outputDirectory, "issue-322-preregistered-comparison.md"),
  markdown,
);
await rm(batchDirectory, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ event: "qualification_complete", comparison })}\n`);
if (!comparison.passed) process.exitCode = 1;
