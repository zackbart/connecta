// Read git diff --no-renames --name-only -z on stdin and print the providers a
// pull request's drift scan covers: "all", or space-separated provider names
// (empty when nothing is in scope). Drift tooling is shared by every provider,
// so a change there scans all of them. A change under src/providers/_shared/
// scans the providers whose source names that shared area (`_shared/rest`).
// The weekly scheduled run still scans every provider.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverProviders, repositoryRoot } from "./providers.mjs";

const TOOLING = new Set([
  ".github/workflows/provider-drift.yml",
  "scripts/ci-drift-providers.mjs",
  "scripts/drift-check.mjs",
  "scripts/drift-record.mjs",
  "scripts/drift-validate.mjs",
  "scripts/generate-openapi.mjs",
  "scripts/providers.mjs",
  "scripts/value-safety.mjs",
  "scripts/vercel-inventory.mjs",
]);
const SHARED = "src/providers/_shared/";

/** The shared areas a provider folder's source names: `rest` for `../_shared/rest/tools.js`. */
function importedAreas(directory) {
  const areas = new Set();
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    const source = readFileSync(join(entry.parentPath, entry.name), "utf8");
    for (const match of source.matchAll(/_shared\/([A-Za-z0-9_-]+)/g)) areas.add(match[1]);
  }
  return areas;
}

/** @returns {Promise<"all" | string[]>} */
async function selectDriftProviders(paths) {
  if (paths.some((path) => TOOLING.has(path))) return "all";
  // Discovery requires every provider folder to carry its drift.json record.
  const providers = await discoverProviders(repositoryRoot);
  const selected = new Set();
  const changedAreas = new Set();
  for (const path of paths) {
    // A shared area is a top-level entry of _shared, a folder or a single module.
    if (path.startsWith(SHARED))
      changedAreas.add(
        path
          .slice(SHARED.length)
          .split("/")[0]
          .replace(/\.[^.]+$/, ""),
      );
    else if (path.startsWith("src/providers/")) selected.add(path.split("/")[2]);
  }
  for (const { name, directory } of providers)
    if (changedAreas.size && [...importedAreas(directory)].some((area) => changedAreas.has(area))) selected.add(name);
  return providers.map(({ name }) => name).filter((name) => selected.has(name));
}

const selection = await selectDriftProviders(readFileSync(0, "utf8").split("\0").filter(Boolean));
console.log(selection === "all" ? "all" : selection.join(" "));
