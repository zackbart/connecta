/**
 * How the real Claude Code ToolSearch ranks everyday wording, with no paid model.
 * A scripted model sends fixed keyword queries against a real Worker deployment.
 * Each query is scored by the rank of the tool it should find.
 *
 *   pnpm exec tsx eval/search-rank.ts [--surfaces native,native-hints] [--catalog-tools 300]
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude } from "./agent/claude.js";
import type { Surface } from "./agent/surface.js";
import { startDeployment } from "./deploy/targets.js";
import { NO_INJECTION } from "./fakes/injection.js";
import { World } from "./fakes/world.js";
import { flags } from "./support/meta.js";
import { connectMcp } from "./support/mcp.js";
import { claudeWrapper, scriptedClaudeModel } from "./support/scripted-model.js";
import { ACTIVE_TASKS } from "./tasks/index.js";

/** Fixed before any ranking was seen: the words a model would lift from each paraphrase task. */
const QUERIES: { query: string; expect: string[] }[] = [
  { query: "pipeline green red main branch", expect: ["ci__list_runs", "ci__get_run"] },
  { query: "latest pipeline status", expect: ["ci__list_runs", "ci__get_run"] },
  { query: "build failed", expect: ["ci__list_runs", "ci__get_run"] },
  { query: "owe overdue balance", expect: ["billing__list_invoices"] },
  { query: "unpaid bills customer", expect: ["billing__list_invoices"] },
  { query: "mark ticket done", expect: ["tracker__close_issue"] },
  { query: "resolve ticket", expect: ["tracker__close_issue"] },
  { query: "tell room announce", expect: ["chat__post_message"] },
  { query: "send message channel", expect: ["chat__post_message"] },
  { query: "post to chat", expect: ["chat__post_message"] },
];

const TASK = ACTIVE_TASKS.find((task) => task.id === "p5-known-read-routing")!;
const args = flags(process.argv.slice(2));
const catalogTools = Number(args.get("catalog-tools") ?? 300);
for (const surface of (args.get("surfaces") ?? "native,native-hints").split(",") as Surface[]) {
  const world = new World({}, { ...NO_INJECTION, catalogTools });
  await world.start();
  const deployment = await startDeployment("worker", world, TASK, surface);
  const root = await mkdtemp(join(tmpdir(), "connecta-rank-"));
  const session = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
  const names = (await session.listTools()).map((tool) => tool.name);
  await session.close();
  // A found tool stops being deferred and leaves later searches, so each query gets a fresh host.
  const ranks = [];
  let offered: boolean | undefined;
  for (const { query, expect } of QUERIES) {
    const model = await scriptedClaudeModel([[{ tool: "ToolSearch", input: { query, max_results: 5 } }]]);
    await runClaude({
      model: "claude-sonnet-5-5",
      surface,
      mcpUrl: deployment.mcpUrl,
      token: deployment.token,
      allowedTools: names,
      deniedTools: [],
      timeoutMs: 120_000,
      firstPrompt: "Search.",
      nextTurn: async () => undefined,
      testHost: { executable: await claudeWrapper(root, model.url, true), args: [] },
    });
    offered ??= model.offered[0]?.includes("ToolSearch");
    const found = [...JSON.stringify(model.toolResults).matchAll(/mcp__connecta__([A-Za-z0-9_-]+)/g)].map(
      (match) => match[1]!,
    );
    const rank = found.findIndex((name) => expect.includes(name));
    ranks.push({ query, rank: rank < 0 ? null : rank + 1, top: found.slice(0, 5) });
    await model.close();
  }
  console.log(
    JSON.stringify({
      surface,
      catalogTools,
      offeredToolSearch: offered,
      hitsInTop5: ranks.filter((rank) => rank.rank !== null).length,
      hitsAtTop: ranks.filter((rank) => rank.rank === 1).length,
      of: ranks.length,
      ranks,
    }),
  );
  await rm(root, { recursive: true, force: true });
  await Promise.allSettled([deployment.close(), world.stop()]);
}
process.exit(0);
