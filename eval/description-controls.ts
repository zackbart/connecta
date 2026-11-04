/**
 * `pnpm run eval:selftest --description-arms-only`: unpaid controls for the
 * description arms. Every planned task's scripted reference must still pass on
 * every arm, so text is all an arm changes, and doing nothing must still fail.
 * The arm's text must be what a deployment serves, on Node and on workerd.
 */
import { playReference } from "./agent/reference.js";
import { DESCRIPTION_ARMS, OVERRIDES } from "./deploy/description-arms/index.js";
import { DESCRIPTION_PLAN } from "./description-plan.js";
import { gradeTask } from "./tasks/grading.js";
import { ACTIVE_TASKS } from "./tasks/index.js";
import type { ActiveTask } from "./tasks/types.js";

const task = (id: string): ActiveTask => {
  const found = ACTIVE_TASKS.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown planned task ${id}`);
  return found;
};
const failed = (checks: ReturnType<typeof gradeTask>) =>
  checks.filter((check) => !check.pass && !check.advisory && check.kind !== "route").map((check) => check.id);

for (const arm of DESCRIPTION_ARMS) {
  for (const { id } of DESCRIPTION_PLAN.stageA.tasks) {
    const planned = task(id);
    const problems = await playReference(planned, { mode: "reference", descriptionArm: arm }, ({ world, trace }) =>
      failed(gradeTask(planned, { world, trace }, "six", "outcome")),
    );
    if (problems.length) throw new Error(`${arm} ${id}: reference failed ${problems.join(", ")}`);
  }
  console.log(`ok   ${arm}: every planned reference passes`);
}

const { id } = DESCRIPTION_PLAN.stageA.tasks[0];
const noop = task(id);
const emptyFails = await playReference(noop, { mode: "noop", descriptionArm: "terse" }, ({ world, trace }) =>
  failed(gradeTask(noop, { world, trace }, "six", "outcome")),
);
if (!emptyFails.length) throw new Error("A no-op trial passed under an arm");
console.log("ok   a no-op still fails under an arm");

for (const target of ["node", "worker"] as const) {
  const expected = OVERRIDES.stripe!.tools.get_stripe_account_info!.terse;
  for (const [arm, wanted] of [
    ["terse", true],
    ["control", false],
  ] as const) {
    await playReference(
      noop,
      {
        mode: "noop",
        target,
        descriptionArm: arm,
        before: async ({ session }) => {
          const result = await session.call("search_tools", { query: "get_stripe_account_info", limit: 1 });
          if (result.text.includes(expected) !== wanted)
            throw new Error(`${target} ${arm}: served text ${wanted ? "lacks" : "has"} the arm's: ${result.text}`);
        },
      },
      () => undefined,
    );
  }
  console.log(`ok   ${target}: the arm's text is what search serves, and control's is today's`);
}
