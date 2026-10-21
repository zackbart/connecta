import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The agent inner loop: the static checks, the guards, and the Vitest suites
// whose import graph reaches a file changed since the merge base, all at once.
// It is partial, so the coverage reporter skips invariant and spec checks.
// `pnpm run check` remains the gate. The precheck:fast hook checks the
// operator UI before the typecheck hook regenerates it.
const root = fileURLToPath(new URL("../", import.meta.url));
const vitest = join(root, "node_modules/vitest/vitest.mjs");

// Guards that read source as text, which an import graph does not connect.
const GUARDS = ["test/purity.node.test.ts", "test/package-surface.node.test.ts", "test/deployment-shapes.node.test.ts"];

// A failing Vitest run prints every passing suite first. Keep everything from
// its first failure section; other output is limited to its last lines.
function failureOutput(output) {
  const summary = output.search(/^.*(?:Failed Suites|Failed Tests|Unhandled Errors|Errors\s+\d+).*$/m);
  if (summary !== -1) return output.slice(summary).trimEnd();
  return output.trimEnd().split("\n").slice(-200).join("\n");
}

// Run steps concurrently and buffer their output, so a failure prints whole.
function run(name, command, args) {
  const started = performance.now();
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, FORCE_COLOR: "0" } });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => (output += `${error.message}\n`));
    child.on("close", (code) => {
      done({ name, ok: code === 0, seconds: ((performance.now() - started) / 1000).toFixed(1), output });
    });
  });
}

const args = process.argv.slice(2);
const base = args[0] === "--base" && args.length === 2 ? args[1] : args.length === 0 ? "origin/main" : undefined;
if (!base) throw new Error("usage: pnpm run check:fast [--base <ref>]");
const started = performance.now();
const pnpm = (name, script) => run(name, "pnpm", ["--silent", "run", script]);
const results = await Promise.all([
  pnpm("format", "format:check"),
  pnpm("providers", "check:providers-generated"),
  pnpm("docs", "check:docs"),
  pnpm("changes", "check:changes"),
  pnpm("clerk-sdk", "check:clerk-sdk"),
  pnpm("lint", "check:lint"),
  pnpm("unused", "check:unused"),
  pnpm("typecheck", "typecheck"),
  run("vitest guards", process.execPath, [vitest, "run", "--project", "node", "--passWithNoTests", ...GUARDS]),
  // Vitest reruns everything when package.json or its config changed.
  run(`vitest changed since ${base}`, process.execPath, [vitest, "run", "--changed", base, "--passWithNoTests"]),
]);
for (const result of results) {
  console.log(`${result.ok ? "ok  " : "FAIL"} ${result.name} ${result.seconds}s`);
  if (!result.ok) console.log(failureOutput(result.output).replace(/^/gm, "  "));
  else if (result.name.startsWith("vitest"))
    for (const line of result.output.split("\n").filter((line) => /^\s*(Test Files|Tests) /.test(line)))
      console.log(`  ${line.trim()}`);
}
const failed = results.filter(({ ok }) => !ok).length;
const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log(
  `check:fast ${failed ? `failed (${failed} steps)` : "passed"} in ${seconds}s. Partial: run pnpm run check before claiming done.`,
);
if (failed) process.exitCode = 1;
