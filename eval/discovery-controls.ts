/**
 * `pnpm run eval:selftest --discovery-only [--targets node,worker] [--arms six,native] [--tasks a,b]`
 *
 * No model. Every hard-discovery task's scripted reference passes on every arm
 * and target, with padding mixed in; a no-op, a fabricated answer, a duplicate
 * write and a plausible wrong route played against real fakes all fail; and a
 * program that reduces every read to meaningless fields still passes.
 */
import assert from "node:assert/strict";
import { playReference } from "./agent/reference.js";
import { restoreGradeInputs, saveGradeInputs, type SavedGradeInputs } from "./agent/saved.js";
import type { Surface } from "./agent/surface.js";
import type { Target } from "./deploy/targets.js";
import { DISCOVERY_CONNECTORS, discoveryState } from "./fakes/discovery.js";
import { NO_INJECTION, type Injection } from "./fakes/injection.js";
import { flags } from "./support/meta.js";
import { connectMcp } from "./support/mcp.js";
import { startDeployment } from "./deploy/targets.js";
import { World } from "./fakes/world.js";
import {
  DISCOVERY_ANSWER_CONTROLS,
  DISCOVERY_TASKS,
  DISCOVERY_WRONG_ROUTES,
  INVENTORY_ONLY_TASKS,
} from "./tasks/discovery.js";
import { gradeTask, passes } from "./tasks/grading.js";
import { taskForSurface } from "./tasks/surface.js";
import type { ActiveTask, ReferenceContext } from "./tasks/types.js";

const args = flags(process.argv.slice(2));
const targets = (args.get("targets")?.split(",") ?? ["node", "worker"]) as Target[];
const arms = (args.get("arms")?.split(",") ?? ["six", "five", "native", "native-no-code", "code"]) as Surface[];
const only = args.get("tasks")?.split(",");
const tasks = only ? DISCOVERY_TASKS.filter((task) => only.includes(task.id)) : DISCOVERY_TASKS;
if (only && tasks.length !== only.length) throw new Error(`Unknown --tasks entry in ${only.join(",")}`);
const injection: Injection = { ...NO_INJECTION, catalogTools: 60 };
let failures = 0;
const record = (name: string, pass: boolean, detail?: string) => {
  if (!pass) failures += 1;
  if (!pass) console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};

const failed = (checks: ReturnType<typeof gradeTask>) =>
  checks
    .filter((check) => !check.pass && !check.advisory)
    .map((check) => check.id)
    .join(", ");

function gradeSaved(task: ActiveTask, saved: SavedGradeInputs, surface: Surface) {
  const restored = restoreGradeInputs(structuredClone(saved));
  return gradeTask(task, restored, surface, "outcome");
}

/** Nothing happened: fresh state, no calls and no programs, keeping only a final answer. */
function untouched(saved: SavedGradeInputs, finalAnswer: string): SavedGradeInputs {
  const empty = structuredClone(saved);
  empty.world.calls = [];
  empty.world.programs = [];
  empty.world.discovery = discoveryState();
  empty.trace.toolUses = [];
  empty.trace.finalAnswer = finalAnswer;
  return empty;
}

/** Every read goes through a program that reduces it to fields no grader could name. */
function reduced(reference: ActiveTask["reference"]): ActiveTask["reference"] {
  return (ctx: ReferenceContext) =>
    reference({
      ...ctx,
      call: (tool, input) =>
        tool === "call_tool"
          ? ctx.call("execute_code", {
              code: `async () => { const r = await connecta.call(${JSON.stringify(input.address)}, ${JSON.stringify(input.args ?? {})}); return { v: JSON.stringify(r.data).length }; }`,
            })
          : ctx.call(tool, input),
    });
}

async function catalogControl(): Promise<void> {
  const task = DISCOVERY_TASKS[0]!;
  const world = new World(task.world, injection);
  await world.start();
  let deployment;
  let mcp;
  try {
    deployment = await startDeployment("node", world, task, "native");
    mcp = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
    const tools = await mcp.listTools();
    const connector = (name: string | undefined) => name?.split(".")[0] ?? "";
    const own = tools.filter((tool) => DISCOVERY_CONNECTORS.includes(connector(tool.address)));
    const padded = tools.filter((tool) => world.injected.ids().includes(connector(tool.address)));
    assert.equal(padded.length, 60, "padding is served beside the task's own catalog");
    assert.ok(own.length >= 100, `task catalog holds ${own.length} tools`);
    assert.equal(new Set(own.map((tool) => connector(tool.address))).size, DISCOVERY_CONNECTORS.length);
    const before = world.ledger.calls.length;
    assert.equal((await mcp.call(padded[0]!.name, {})).isError, false);
    assert.equal(world.ledger.calls.length, before, "a padded tool stays out of the task ledger");
    assert.ok(world.ledger.calls.length === 0);
    console.log(`ok   catalog: ${own.length} task tools across ${DISCOVERY_CONNECTORS.length} connectors, 60 padded`);
  } finally {
    await mcp?.close();
    await deployment?.close();
    await world.stop();
  }
}

function proseControls(task: ActiveTask, saved: SavedGradeInputs, surface: Surface): void {
  const controls = DISCOVERY_ANSWER_CONTROLS[task.id];
  if (!controls) return;
  for (const answer of controls.accept) {
    const copy = structuredClone(saved);
    copy.trace.finalAnswer = answer;
    const checks = gradeSaved(task, copy, surface);
    record(`${task.id}: accepts ${JSON.stringify(answer)}`, passes(checks, "outcome"), failed(checks));
  }
  for (const answer of controls.reject) {
    const copy = structuredClone(saved);
    copy.trace.finalAnswer = answer;
    record(`${task.id}: rejects ${JSON.stringify(answer)}`, !passes(gradeSaved(task, copy, surface), "outcome"));
  }
}

await catalogControl();

for (const target of targets) {
  for (const surface of arms) {
    if (surface === "code" && target === "worker") continue;
    for (const original of tasks) {
      const task = taskForSurface(original, surface);
      const name = `${target}/${surface} ${original.id}`;
      assert.equal(task.prompt, original.prompt, `${name}: prompts are identical across arms`);
      const saved = await playReference(task, { mode: "reference", target, surface, injection }, ({ world, trace }) =>
        structuredClone(saveGradeInputs(world, trace)),
      );
      const reference = gradeSaved(task, saved, surface);
      record(`${name}: reference passes`, passes(reference, "outcome"), failed(reference));
      record(`${name}: a no-op fails`, !passes(gradeSaved(task, untouched(saved, ""), surface), "outcome"));
      const fabricated = gradeSaved(task, untouched(saved, saved.trace.finalAnswer ?? ""), surface);
      if (surface.startsWith("native") && INVENTORY_ONLY_TASKS.includes(original.id))
        record(`${name}: inventory-only answer passes by construction`, passes(fabricated, "outcome"));
      else record(`${name}: a fabricated answer fails`, !passes(fabricated, "outcome"));
      const write = saved.world.calls.find((call) => call.kind === "write");
      if (write) {
        const duplicated = structuredClone(saved);
        duplicated.world.calls.push(structuredClone(write));
        record(`${name}: a duplicate write fails`, !passes(gradeSaved(task, duplicated, surface), "outcome"));
      }
      const wrong = DISCOVERY_WRONG_ROUTES[original.id]!;
      const wrongChecks = await playReference(
        taskForSurface({ ...original, reference: wrong.play }, surface),
        { mode: "reference", target, surface, injection },
        ({ world, trace }) => gradeTask(task, { world, trace }, surface, "outcome"),
      );
      record(
        `${name}: the wrong route fails ${wrong.fails}`,
        wrongChecks.some((check) => check.id === wrong.fails && !check.pass) && !passes(wrongChecks, "outcome"),
        failed(wrongChecks) || "passed",
      );
      if (target === "node" && surface === "six") proseControls(original, saved, surface);
      if (surface !== "native-no-code" && surface !== "code") {
        const programs = await playReference(
          { ...task, reference: reduced(task.reference) },
          { mode: "reference", target, surface, injection },
          ({ world, trace }) => gradeTask(task, { world, trace }, surface, "outcome"),
        );
        record(`${name}: reduced program output passes`, passes(programs, "outcome"), failed(programs));
      }
      console.log(`done ${name}`);
    }
  }
}

if (failures) {
  console.error(`${failures} discovery control(s) failed.`);
  process.exit(1);
}
console.log(`ok   discovery controls: ${tasks.length} tasks on ${targets.join(", ")} × ${arms.join(", ")}`);
