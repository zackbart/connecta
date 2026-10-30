import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Provider-local eval wiring (eval/support/provider-eval.ts): file → the export it must declare. */
export const EVAL_FILES = { "fake.ts": "evalFake", "tasks.ts": "evalTasks", "deploy.ts": "evalDeploy" };
/** The optional dedicated `worker-<name>` smoke composition. */
export const EVAL_WORKER = "worker.ts";

// Discovery reads files only. Definitions and fixtures are loaded by consumers
// after the generated skill modules have been computed.
export async function discoverProviders(root = repositoryRoot) {
  const directory = join(root, "src", "providers");
  const entries = await readdir(directory, { withFileTypes: true });
  const providers = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.name === "_shared") continue;
    if (!entry.isDirectory()) {
      throw new Error(`src/providers/${entry.name}: provider implementations must live in folders`);
    }
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(entry.name)) {
      throw new Error(`src/providers/${entry.name}: invalid provider folder name`);
    }
    const folder = join(directory, entry.name);
    const required = ["index.ts", "SKILL.md", "drift.json", "fixtures.ts"];
    const files = await readdir(folder);
    const test = files.includes("provider.test.ts") ? "provider.test.ts" : "provider.node.test.ts";
    for (const file of [...required, test]) {
      if (!files.includes(file) || !(await stat(join(folder, file))).isFile()) {
        throw new Error(`src/providers/${entry.name}: missing required file ${file}`);
      }
    }
    let evals;
    if (files.includes("eval")) {
      const present = await readdir(join(folder, "eval"));
      for (const file of present) {
        if (!(file in EVAL_FILES) && file !== EVAL_WORKER) {
          throw new Error(
            `src/providers/${entry.name}/eval/${file}: eval/ holds only fake.ts, tasks.ts, deploy.ts and worker.ts`,
          );
        }
      }
      for (const file of Object.keys(EVAL_FILES)) {
        if (!present.includes(file)) throw new Error(`src/providers/${entry.name}: eval/ requires ${file}`);
      }
      evals = {
        ...Object.fromEntries(Object.keys(EVAL_FILES).map((file) => [file.slice(0, -3), join(folder, "eval", file)])),
        ...(present.includes(EVAL_WORKER) ? { worker: join(folder, "eval", EVAL_WORKER) } : {}),
      };
    }
    providers.push({
      name: entry.name,
      directory: folder,
      index: join(folder, "index.ts"),
      fixtures: join(folder, "fixtures.ts"),
      skill: join(folder, "SKILL.md"),
      drift: join(folder, "drift.json"),
      test: join(folder, test),
      ...(evals ? { eval: evals } : {}),
    });
  }
  return providers;
}
