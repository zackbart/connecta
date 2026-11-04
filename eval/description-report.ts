/**
 * `pnpm exec tsx eval/description-report.ts <result.json>...` prints the arm
 * table and control pairings for a set of description-arm batches, with no
 * model spend. Each file must be one complete arm, host and surface batch.
 */
import { readFile } from "node:fs/promises";
import { descriptionArmOf } from "./deploy/description-arms/index.js";
import { armRow, pairedOutcomes, rowLine } from "./report/descriptions.js";
import type { AgentResultFile } from "./report/summary.js";

const paths = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (!paths.length) throw new Error("Usage: tsx eval/description-report.ts <result.json>...");
const files = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8")) as AgentResultFile));
const groups = new Map<string, AgentResultFile[]>();
for (const file of files) {
  const key = `${file.config.runner} ${file.config.surface}`;
  groups.set(key, [...(groups.get(key) ?? []), file]);
}
for (const [key, group] of groups) {
  console.log(`\n## ${key}`);
  const ordered = [...group].sort((a, b) =>
    descriptionArmOf(a.config.descriptionArm).localeCompare(descriptionArmOf(b.config.descriptionArm)),
  );
  for (const file of ordered)
    console.log(rowLine(armRow(descriptionArmOf(file.config.descriptionArm), file, file.trials)));
  const control = group.find((file) => descriptionArmOf(file.config.descriptionArm) === "control");
  if (!control) continue;
  for (const file of group) {
    const arm = descriptionArmOf(file.config.descriptionArm);
    if (arm === "control") continue;
    const paired = pairedOutcomes({ file: control, trials: control.trials }, { file, trials: file.trials });
    console.log(
      `${arm} vs control: ${paired.pairs} valid pairs (${paired.excluded} excluded), ${paired.gains} gains, ${paired.losses} losses, sign test p=${paired.p.toFixed(3)}, losses by task ${JSON.stringify(paired.taskLosses)}`,
    );
  }
}
