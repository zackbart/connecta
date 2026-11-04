import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const { version } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
if (
  typeof version !== "string" ||
  !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?![\s\S])/.test(version) ||
  version.length > 128
) {
  throw new Error("package.json must contain a bounded package version");
}
const source = `// Generated from package.json by scripts/generate-version.mjs.
// Workers-safe: no runtime filesystem read or deployment override.
export const CONNECTA_VERSION = ${JSON.stringify(version)};
`;
// Worker evals bundle src/ under wrangler's watcher, which reloads on any write.
for (const path of ["src/version.ts", "bin/version.mjs"]) {
  const target = new URL(path, root);
  if ((await readFile(target, "utf8").catch(() => undefined)) !== source) await writeFile(target, source);
}
