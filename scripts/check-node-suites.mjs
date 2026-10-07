import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_DIRECTORY } from "./test-suites.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = [...new Set(execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0"))]
  .filter((file) => file.endsWith(".test.ts") && !/(^|\/)(node_modules|dist|\.git|worktrees)(\/|$)/.test(file))
  .sort();
const outside = files.filter((file) => !file.startsWith(`${TEST_DIRECTORY}/`));
const nodeOnly = files.filter((file) => file.endsWith(".node.test.ts"));
const missing = nodeOnly.filter((file) => !/^\/\/ Node-only: \S.*\r?\n/.test(readFileSync(join(root, file), "utf8")));
if (outside.length) {
  console.error(`Suites outside ${TEST_DIRECTORY}/ are not collected by Vitest:\n${outside.join("\n")}`);
  process.exitCode = 1;
}
if (missing.length) {
  console.error(`Node-only suites need a first-line // Node-only: <reason> comment:\n${missing.join("\n")}`);
  process.exitCode = 1;
}
if (!outside.length && !missing.length) {
  console.log(`Node-only suites: ${nodeOnly.length} reasons present; all ${files.length} suites are collected.`);
}
