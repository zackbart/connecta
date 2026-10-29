/**
 * Which deployment a trial runs against. `node` is the template shape
 * (SQLite, QuickJS, `listen()`); `worker` is the production shape on workerd
 * (D1, the Dynamic Worker executor, Access), booted per trial under
 * `wrangler dev`. Both serve the same composition (compose.ts), so the same
 * tasks and graders apply. A task the Worker cannot serve is refused with its
 * reason, never run, skipped or passed.
 */
import type { Surface } from "../agent/surface.js";
import type { World } from "../fakes/world.js";
import type { ActiveTask } from "../tasks/types.js";
import { startNodeDeployment, type Deployment } from "./node.js";
import { startWorkerDeployment } from "./worker.js";

export type Target = "node" | "worker";

export function parseTarget(value = "node"): Target {
  if (value !== "node" && value !== "worker") throw new Error("--target must be node or worker");
  return value;
}

function serializable(value: unknown): boolean {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(serializable);
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.values(value as object).every(serializable);
  return false;
}

/** Why the Worker target cannot serve this task, or undefined when it can. */
export function workerRefusal(task: ActiveTask, surface: Surface = "six"): string | undefined {
  if (surface !== "six")
    return "the code surface arm wraps the Node deployment's fetch and QuickJS bridge (eval/deploy/code-surface.ts)";
  if (task.world?.oauth || task.host)
    return "the fake OAuth inbound auth, connector and URL-elicitation host are in-process Node objects";
  if (task.deployment && !serializable(task.deployment))
    return "its deployment passthrough holds values that cannot cross into the Worker as JSON";
  return undefined;
}

export async function startDeployment(
  target: Target,
  world: World,
  task: ActiveTask,
  surface: Surface,
  everyPool: string[] = [],
): Promise<Deployment> {
  if (target === "node")
    return startNodeDeployment(
      world.connectorSpecs(),
      task.deployment,
      task.world?.oauth ? world.oauth : undefined,
      surface,
      everyPool,
    );
  const refusal = workerRefusal(task, surface);
  if (refusal) throw new Error(`Task ${task.id} is refused on the worker target: ${refusal}.`);
  return startWorkerDeployment(world.connectorSpecs(), task.deployment, everyPool);
}

/** Observed programs, refreshed from out-of-process deployments. */
export async function observedPrograms(deployment: Deployment) {
  return deployment.observe ? await deployment.observe() : deployment.programs;
}
