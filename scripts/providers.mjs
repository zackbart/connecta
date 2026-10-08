import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
    providers.push({
      name: entry.name,
      directory: folder,
      index: join(folder, "index.ts"),
      fixtures: join(folder, "fixtures.ts"),
      skill: join(folder, "SKILL.md"),
      drift: join(folder, "drift.json"),
      test: join(folder, test),
    });
  }
  return providers;
}
