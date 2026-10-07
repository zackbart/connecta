import { readFileSync, readdirSync } from "node:fs";

const directory = new URL("../test/", import.meta.url);
const files = readdirSync(directory, { recursive: true }).filter((file) => file.endsWith(".node.test.ts"));
const missing = files.filter((file) => !/^\/\/ Node-only: \S.*\r?\n/.test(readFileSync(new URL(file, directory), "utf8")));
if (missing.length) {
  console.error(`Node-only suites need a first-line // Node-only: <reason> comment:\n${missing.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Node-only suites: ${files.length} reasons present.`);
}
