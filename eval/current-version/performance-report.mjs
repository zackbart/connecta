import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const here = new URL(".", import.meta.url);
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

async function json(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, here), "utf8"));
}

function ms(value) {
  return Number(value).toFixed(1);
}

function integer(value) {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function mb(value) {
  return (value / 1024 / 1024).toFixed(1);
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

const auditPath = option(
  "--audit",
  "results/current-performance-audit.json",
);
const logicPath = option(
  "--logic",
  "results/current-logic-performance.json",
);
const agentPath = option(
  "--agent",
  "results/current-agent-performance.json",
);
const outputPath = resolve(
  new URL(".", here).pathname,
  option("--output", "results/current-performance-report.md"),
);
const [audit, logic, agent] = await Promise.all([
  json(auditPath),
  json(logicPath),
  json(agentPath),
]);

const logicRows = logic.profiles
  .map(
    (profile) =>
      `| ${profile.name} | ${integer(profile.totalTools)} | ${ms(profile.startupMs)} | ${ms(profile.coldSearchMs)} | ${ms(profile.warmSearch.p50Ms)} / ${ms(profile.warmSearch.p95Ms)} | ${ms(profile.directCall.p50Ms)} / ${ms(profile.directCall.p95Ms)} | ${ms(profile.batch.p50Ms)} / ${ms(profile.batch.p95Ms)} | ${mb(profile.memoryAfterLoad.rss)} | ${mb(profile.memoryAfterLoad.heapUsed)} |`,
  )
  .join("\n");
const loadRows = logic.profiles
  .flatMap((profile) =>
    profile.concurrency.map(
      (row) =>
        `| ${profile.name} | ${row.inFlight} | ${integer(row.calls)} | ${row.throughputPerSecond.toFixed(1)} | ${ms(row.latency.p50Ms)} | ${ms(row.latency.p95Ms)} | ${ms(row.latency.p99Ms)} |`,
    ),
  )
  .join("\n");
const agentRows = agent.cases
  .map(
    (fixture) =>
      `| ${fixture.id} | ${fixture.correct ? "yes" : "NO"} | ${fixture.routeEfficient ? "yes" : "NO"} | ${fixture.contextEfficient ? "yes" : "NO"} | ${fixture.calledTools.map((tool) => `\`${tool}\``).join(" → ")} | ${integer(fixture.mcpResultTokens)} / ${integer(fixture.mcpResultTokenBudget)} | ${(fixture.latencyMs / 1_000).toFixed(1)} s |`,
  )
  .join("\n");
const inefficient = agent.cases.filter((fixture) => !fixture.routeEfficient);
const incorrect = agent.cases.filter((fixture) => !fixture.correct);
const contextHeavy = agent.cases.filter(
  (fixture) => !fixture.contextEfficient,
);
const guided = agent.cases.filter((fixture) => fixture.guidanceFetched);
const locallyExploratory = agent.cases.filter((fixture) =>
  fixture.nonMcpActions.some(
    (action) =>
      (typeof action === "string" ? action : action.type) ===
      "command_execution",
  ),
);
const widestSearch = [...audit.discovery.cases].sort(
  (left, right) => right.responseTokens - left.responseTokens,
)[0];
const largeDistributed = logic.profiles.find(
  (profile) => profile.name === "large-distributed",
);
const soakRss = largeDistributed?.soak.map((round) => mb(round.rss)) ?? [];
const soakHeap =
  largeDistributed?.soak.map((round) => mb(round.heapUsed)) ?? [];

const findings = [
  `The fixed agent-visible surface is ${integer(audit.totals.definitionTokens)} tokens for ${audit.connection.toolCount} meta-tools.`,
  `The held-out discovery suite achieves ${pct(audit.discovery.metrics.top1Accuracy)} top-1 accuracy and ${pct(audit.discovery.metrics.positiveRecall)} recall, with a ${pct(audit.discovery.metrics.falsePositiveRate)} false-positive rate on negative queries.`,
  `Fresh-agent task correctness is ${agent.summary.correct}/${agent.summary.cases}; efficient routing is ${agent.summary.routeEfficient}/${agent.summary.cases}.`,
  `Fresh-agent context efficiency is ${agent.summary.contextEfficient}/${agent.summary.cases} against task-specific budgets derived from the scripted minimal routes.`,
  guided.length > 0
    ? `Connecta's on-demand usage guide was self-fetched in ${guided.length}/${agent.summary.cases} cases (${guided.map((fixture) => `\`${fixture.id}\``).join(", ")}); no user prompt explained the routing workflow.`
    : "No case needed the on-demand usage guide; the always-loaded instructions were sufficient.",
  locallyExploratory.length > 0
    ? `The coding-agent host explored the local filesystem before or alongside Connecta in ${locallyExploratory.length}/${agent.summary.cases} cases (${locallyExploratory.map((fixture) => `\`${fixture.id}\``).join(", ")}). This is host routing overhead, not Connecta call latency.`
    : "The agent went directly to Connecta in every case without unrelated local-tool exploration.",
  `QuickJS costs ${ms(logic.executor.coldNoopMs)} ms cold and ${ms(logic.executor.warmHostCall.p50Ms)} ms p50 for warm executions that make a host call.`,
  widestSearch
    ? `The largest held-out discovery response is \`${widestSearch.id}\` at ${integer(widestSearch.responseTokens)} tokens.`
    : null,
  inefficient.length > 0
    ? `Routing misses occurred in: ${inefficient
        .map(
          (fixture) =>
            `\`${fixture.id}\` (${fixture.forbiddenTools.join(", ") || `missing ${fixture.missingTools.join(", ")}`})`,
        )
        .join("; ")}.`
    : "Every fresh-agent case chose the intended minimal route.",
  incorrect.length > 0
    ? `Incorrect final answers occurred in: ${incorrect.map((fixture) => `\`${fixture.id}\``).join(", ")}.`
    : "Every fresh-agent case produced the correct task result.",
  contextHeavy.length > 0
    ? `Context budgets were exceeded in: ${contextHeavy.map((fixture) => `\`${fixture.id}\` (${integer(fixture.mcpResultTokens)} / ${integer(fixture.mcpResultTokenBudget)} tokens)`).join(", ")}.`
    : "Every fresh-agent case stayed within its Connecta result-token budget.",
  soakRss.length > 0
    ? `After the initial load allocation, the 10,000-tool soak held at ${soakRss.join(" / ")} MB RSS and ${soakHeap.join(" / ")} MB live heap across three rounds; this run shows a plateau, not continuing live-heap growth.`
    : null,
].filter(Boolean);

const report = `# Connecta ${audit.source.commit.slice(0, 12)} performance analysis

Generated: ${logic.generatedAt}

Runtime: Node ${logic.source.nodeVersion} on ${logic.source.platform}; agent client ${agent.source.codexVersion} (${agent.source.model})

## Executive result

${findings.map((finding) => `- ${finding}`).join("\n")}

## Connecta logic

All figures are client-observed over stateless Streamable HTTP on loopback. Search and call columns are p50 / p95 after warm-up.

| Catalog shape | Tools | Startup ms | Cold search ms | Warm search ms | Direct call ms | 10-call batch ms | RSS after GC MB | Live heap MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${logicRows}

### Direct-call load

| Catalog shape | In flight | Calls | Throughput/s | p50 ms | p95 ms | p99 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${loadRows}

### Optional code mode

- Cold sandbox no-op: ${ms(logic.executor.coldNoopMs)} ms
- Warm sandbox + one connector host call: ${ms(logic.executor.warmHostCall.p50Ms)} ms p50; ${ms(logic.executor.warmHostCall.p95Ms)} ms p95

### What the logic measurements say

- Catalog size is not on the hot direct-call path in a meaningful way here: p50 stays near 2–2.4 ms from 100 through 10,000 tools.
- Warm lexical discovery remains near 3 ms p50 at 10,000 tools; cold discovery is about 11 ms because the normalized index is built on first use.
- Moving from 16 to 64 in-flight requests adds little throughput and sharply worsens tail latency. A production deployment should prefer bounded admission near the knee instead of maximizing concurrent work.
- RSS grows after the HTTP load but live heap remains near ${largeDistributed ? mb(largeDistributed.memoryAfterLoad.heapUsed) : "—"} MB at 10,000 tools, and the three-round soak plateaus. Treat RSS as capacity to budget, but this sample does not look like an accumulating JavaScript heap leak.

## Agent experience

Each case starts a fresh Connecta server and a fresh non-interactive Codex session. The user prompt states the task, not the Connecta routing procedure. “Route” means the agent chose the intended smallest execution path without making redundant schema calls or substituting another execution tool. Fetching Connecta's usage guide once is counted separately as successful self-guidance. “Context” compares serialized MCP results with a task budget derived from the scripted minimal path.

| Task | Correct | Route | Context | Tool route | MCP result tokens / budget | Wall time |
| --- | --- | --- | --- | --- | ---: | ---: |
${agentRows}

Codex reported ${integer(agent.summary.totalInputTokens)} total input tokens and ${integer(agent.summary.totalOutputTokens)} output tokens across the fresh sessions. Those are whole-agent figures—including the host system prompt, built-in tool definitions, reasoning context, and Connecta—not Connecta-only costs. The measured Connecta MCP results contributed ${integer(agent.summary.totalMcpResultTokens)} serialized tokens.

## Priorities

1. **Use the harness to evaluate discovery changes without trading away recall.** The unchanged baseline has a ${pct(audit.discovery.metrics.falsePositiveRate)} held-out false-positive rate, and the natural reduction query exceeded its MCP-result budget. Select candidates on independently authored corpora and reserve the release holdout for final regression checks.
2. **Keep the routing contract in server instructions and measure it across repeated fresh sessions.** This sample chose the intended execution path in ${agent.summary.routeEfficient}/${agent.summary.cases} tasks without user coaching. The on-demand skill should remain a fallback, not required ceremony.
3. **Treat code mode as a latency/context trade.** The scripted audit reduced 120 records to a tiny answer in one MCP execution, but code mode pays a roughly ${ms(logic.executor.coldNoopMs)} ms cold start and had ${ms(logic.executor.warmHostCall.p95Ms)} ms p95 in this small sample. Keep it optional and compare it against equivalent direct-call response tokens on real workloads.
4. **Benchmark more hosts before changing the public tool surface.** The Codex lane showed unrelated filesystem exploration in ${locallyExploratory.length}/${agent.summary.cases} cases and an approval stop at \`authorize_connector\`. Add an interactive host and at least one non-coding agent to distinguish Connecta affordances from host policy and coding-agent bias.
5. **Set performance budgets in CI, not machine-specific absolute gates.** Track percentage regression from a pinned runner for 10,000-tool cold/warm search, 16-in-flight p95, definition tokens, discovery quality, and fresh-agent route success.

## Release audit

- Behavioral scenarios: ${audit.tasks.summary.passed}/${audit.tasks.summary.caseCount}
- Qualification gate: ${audit.qualification.passed ? "pass" : "FAIL"}
- Discovery top-1: ${pct(audit.discovery.metrics.top1Accuracy)}
- Discovery positive recall: ${pct(audit.discovery.metrics.positiveRecall)}
- Negative-query false positives: ${pct(audit.discovery.metrics.falsePositiveRate)}
- Complete measured Connecta surface: ${integer(audit.totals.measuredSurfaceTokens)} tokens over ${audit.totals.roundTrips} round trips

## Interpretation limits

- Logic latency is the Connecta/framework floor on one local machine. Real connector and network latency will dominate most production calls.
- Synthetic catalogs isolate Connecta scaling but do not reproduce every downstream MCP schema, pagination behavior, or provider rate limit.
- The agent lane measures one run per task on one Codex CLI/model configuration. Repeated runs showed meaningful routing variance, so it is a behavioral canary, not a stable pass/fail gate or a claim that every host and model will route identically.
- Whole-agent token counts are useful for comparing repeated runs of the same harness; only the MCP definitions, requests, and results are attributable to Connecta.
`;

await writeFile(outputPath, report);
process.stdout.write(
  `${JSON.stringify({
    event: "performance_report_complete",
    output: outputPath,
  })}\n`,
);
