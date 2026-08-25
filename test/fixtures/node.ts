import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import {
  quickJsExecutor,
  type QuickJsExecutorOptions,
} from "../../src/executors/quickjs.js";
import type { AdmittingExecutor } from "../../src/types.js";

const executors: AdmittingExecutor[] = [];
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    executors.splice(0).map(async (executor) => executor.close?.()),
  );
  await Promise.all(
    fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

export function trackedQuickJs(
  options?: QuickJsExecutorOptions,
): AdmittingExecutor {
  const executor = quickJsExecutor(options);
  executors.push(executor);
  return executor;
}

export async function tempFixture(
  prefix: string,
  files: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  fixtures.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  return root;
}

export function spawnChecker(checker: string, args: string[]) {
  const result = spawnSync(process.execPath, [checker, ...args], {
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
