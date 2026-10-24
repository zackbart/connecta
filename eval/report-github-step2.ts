/** Reproduce the committed GitHub summary from the four retained full result files. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_TASK_IDS } from "./tasks/github.js";
import type { AgentResultFile } from "./report/summary.js";

const folder = process.argv[2];
if (!folder) throw new Error("Pass the directory containing before-final/after GitHub result JSON.");
const runs = ["before-final-luna", "before-final-sonnet", "after-luna", "after-sonnet"].map((name) => {
  const file = JSON.parse(readFileSync(join(folder, `${name}.json`), "utf8")) as AgentResultFile;
  if (file.trials.length !== 14 || GITHUB_TASK_IDS.some((id) => file.trials.filter((t) => t.task === id).length !== 2))
    throw new Error(`${name}: expected two observations for each of the seven frozen tasks.`);
  const trials = file.trials.map((trial) => {
    const uses = new Map(trial.transcript.filter((e) => e.kind === "tool_use").map((e) => [e.id, e] as const));
    const discovery = trial.transcript.flatMap((entry) => {
      if (entry.kind !== "tool_result") return [];
      const use = uses.get(entry.id);
      if (!use) return [];
      const input = JSON.stringify(use.input);
      const isDiscovery =
        ["skills", "search_tools"].includes(use.tool) ||
        (use.tool === "execute_code" && /connecta\.(?:search|skill|describe|manifest)\s*\(/.test(input)) ||
        /github_api_(?:search|details)/.test(input);
      return isDiscovery ? [Buffer.byteLength(entry.text ?? "")] : [];
    });
    const programs = trial.saved?.world.programs ?? [];
    const selectedTools: Record<string, number> = {};
    for (const program of programs)
      for (const call of program.calls)
        if (call.name === "connecta.call" && typeof call.args[1] === "string")
          selectedTools[call.args[1]] = (selectedTools[call.args[1]] ?? 0) + 1;
    for (const use of uses.values()) {
      const input = use.input as { tool?: unknown; address?: unknown };
      const tool = input.tool ?? input.address;
      if (["call_tool", "call_destructive_tool"].includes(use.tool) && typeof tool === "string")
        selectedTools[tool] = (selectedTools[tool] ?? 0) + 1;
    }
    return {
      task: trial.task,
      repeat: trial.repeat,
      status: trial.status,
      failures: trial.checks.filter((c) => !c.pass && !c.advisory).map((c) => c.id),
      mcpCalls: Object.values(trial.metrics.metaTools).reduce((a, b) => a + b, 0),
      selectedTools,
      discoveryBytes: discovery.reduce((a, b) => a + b, 0),
      maxDiscoveryReplyBytes: Math.max(0, ...discovery),
      writes: trial.metrics.downstream.writes,
      duplicateWrites: trial.metrics.downstream.duplicateWrites,
      authHandoffs: trial.metrics.metaTools.authorize_connector ?? 0,
      downstreamReads: trial.metrics.downstream.reads,
      wallMs: trial.metrics.wallMs,
    };
  });
  const comparable = trials.filter((t) => t.task !== "github-contents-hatch");
  return {
    name,
    meta: file.meta,
    protocol: file.protocol,
    config: file.config,
    cli: "codexVersion" in file ? file.codexVersion : "claudeVersion" in file ? file.claudeVersion : undefined,
    score: { passed: trials.filter((t) => t.status === "pass").length, total: trials.length },
    comparable: { passed: comparable.filter((t) => t.status === "pass").length, total: comparable.length },
    tasks: GITHUB_TASK_IDS.map((task) => ({
      task,
      passed: trials.filter((t) => t.task === task && t.status === "pass").length,
      total: 2,
    })),
    totals: {
      mcpCalls: trials.reduce((n, t) => n + t.mcpCalls, 0),
      discoveryBytes: trials.reduce((n, t) => n + t.discoveryBytes, 0),
      maxDiscoveryReplyBytes: Math.max(...trials.map((t) => t.maxDiscoveryReplyBytes)),
      writes: trials.reduce((n, t) => n + t.writes, 0),
      duplicateWrites: trials.reduce((n, t) => n + t.duplicateWrites, 0),
      authHandoffs: trials.reduce((n, t) => n + t.authHandoffs, 0),
    },
    trials,
  };
});
writeFileSync(
  new URL("./baselines/github-step2.json", import.meta.url),
  JSON.stringify({ version: 1, runs }, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    runs.map(({ name, score, comparable, totals }) => ({ name, score, comparable, totals })),
    null,
    2,
  ),
);
