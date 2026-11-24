import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "../support/meta.js";

function newestMtime(directory: string): { path: string; ms: number } {
  let newest = { path: directory, ms: 0 };
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const path = join(entry.parentPath, entry.name);
    const ms = statSync(path).mtimeMs;
    if (ms > newest.ms) newest = { path, ms };
  }
  return newest;
}

/** `eval:perf` measures the built package, never `src/` through tsx. */
export function assertBuiltPackage(): void {
  const entry = join(ROOT, "dist", "index.js");
  if (!existsSync(entry)) throw new Error("eval:perf measures dist/, which is missing. Run `pnpm run build` first.");
  const resolved = fileURLToPath(import.meta.resolve("@zackbart/connecta"));
  if (resolved !== entry) {
    throw new Error(
      `@zackbart/connecta resolved to ${resolved}, not ${entry}. Run eval:perf through \`pnpm run eval:perf\`, which loads eval/perf/tsconfig.json.`,
    );
  }
  const source = newestMtime(join(ROOT, "src"));
  if (source.ms > statSync(entry).mtimeMs) {
    throw new Error(`dist/ is older than ${source.path}. Run \`pnpm run build\` first.`);
  }
}
