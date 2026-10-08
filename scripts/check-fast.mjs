import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The agent inner loop. It is deliberately partial: Vitest runs only suites
// related to the diff, so the coverage reporter skips invariant and spec checks.
// `npm run check` remains the gate.
const root = fileURLToPath(new URL("../", import.meta.url));

// Cheap structural guards that run on every invocation, whatever changed.
export const GUARDS = [
  "test/purity.node.test.ts",
  "test/package-surface.node.test.ts",
  "test/deployment-shapes.node.test.ts",
];

// Vitest reruns every suite when one of these is related. Leave them to `check`.
const FULL_RUN = /(^|\/)(package\.json|(vitest|vite)\.config\.[^/]+)$/;

// Plain data in, plain data out: the related inputs for a diff. A suite that
// names a changed path in its source (a workflow, a script, a fixture it reads)
// is related even though no import connects them.
export function relatedInputs({ changed, suites, deleted = [] }) {
  const related = new Set(GUARDS);
  const deferred = [];
  // A removed module has no current import graph. Run both projects rather
  // than guessing which former dependents Vitest can still discover.
  const fullRun = deleted.some((path) => /\.[cm]?[jt]sx?$/.test(path));
  for (const path of changed) {
    if (FULL_RUN.test(path)) {
      deferred.push(path);
      continue;
    }
    if (!deleted.includes(path)) related.add(path);
    const names = path.startsWith("test/") ? [path, path.slice("test/".length)] : [path];
    for (const { file, text } of suites) {
      if (names.some((name) => text.includes(name))) related.add(file);
    }
  }
  return { related: [...related].sort(), deferred, fullRun };
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function changedPaths(base, cwd = root) {
  let mergeBase;
  try {
    mergeBase = git(["merge-base", base, "HEAD"], cwd).trim();
  } catch {
    throw new Error(`check:fast: cannot find a merge base with ${base}; run git fetch origin or pass --base <ref>.`);
  }
  // Working tree against the merge base: commits, staged, and unstaged edits.
  const listed = [
    ...git(["diff", "--no-renames", "--name-only", "-z", mergeBase], cwd).split("\0"),
    ...git(["ls-files", "--others", "--exclude-standard", "-z"], cwd).split("\0"),
  ];
  // --no-renames retains both the old and new path, including deletions.
  return [...new Set(listed)].filter(Boolean);
}

function suiteSources() {
  const suites = [];
  const walk = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".test.ts")) suites.push({ file: path, text: readFileSync(join(root, path), "utf8") });
    }
  };
  walk("test");
  walk("src/providers");
  return suites;
}

// A failing Vitest run prints every passing suite first. Keep everything from
// its first failure section, including suite failures and unhandled errors.
// Only output without a Vitest failure section is limited to its last lines.
export function failureOutput(output) {
  const summary = output.search(/^.*(?:Failed Suites|Failed Tests|Unhandled Errors|Errors\s+\d+).*$/m);
  if (summary !== -1) return output.slice(summary).trimEnd();
  const lines = output.trimEnd().split("\n");
  return lines.slice(-200).join("\n");
}

// Run steps concurrently and buffer their output, so a failure prints whole.
function run(name, command, args) {
  const started = performance.now();
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, FORCE_COLOR: "0" } });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      output += `${error.message}\n`;
    });
    child.on("close", (code) => {
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      done({ name, ok: code === 0, seconds, output });
    });
  });
}

async function main() {
  const started = performance.now();
  const args = process.argv.slice(2);
  const index = args.indexOf("--base");
  const base = index === -1 ? "origin/main" : args[index + 1];
  if (!base || args.length !== (index === -1 ? 0 : 2)) throw new Error("usage: npm run check:fast [-- --base <ref>]");
  const changed = changedPaths(base);
  const deleted = changed.filter((path) => !existsSync(join(root, path)));
  const { related, deferred, fullRun } = relatedInputs({ changed, deleted, suites: suiteSources() });
  if (fullRun) console.log(`Deleted modules require a full Vitest run: ${deleted.join(", ")}.`);
  const vitest = join(root, "node_modules/vitest/vitest.mjs");
  const results = await Promise.all([
    run("format", "npm", ["run", "-s", "format:check"]),
    run("docs", "npm", ["run", "-s", "check:docs"]),
    run("changes", "npm", ["run", "-s", "check:changes"]),
    run("operator-ui", "npm", ["run", "-s", "check:operator-ui"]),
    run("clerk-sdk", "npm", ["run", "-s", "check:clerk-sdk"]),
    run("lint", "npm", ["run", "-s", "check:lint"]),
    run("unused", "npm", ["run", "-s", "check:unused"]),
    run("typecheck", "npm", ["run", "-s", "typecheck"]),
    fullRun
      ? run("vitest full (deleted modules)", process.execPath, [vitest, "run"])
      : run(`vitest related (${related.length} inputs)`, process.execPath, [vitest, "related", "--run", ...related]),
  ]);
  for (const result of results) {
    console.log(`${result.ok ? "ok  " : "FAIL"} ${result.name} ${result.seconds}s`);
    if (!result.ok) console.log(failureOutput(result.output).replace(/^/gm, "  "));
    else if (result.name.startsWith("vitest")) {
      for (const line of result.output.split("\n").filter((line) => /^\s*(Test Files|Tests) /.test(line)))
        console.log(`  ${line.trim()}`);
    }
  }
  if (deferred.length && !fullRun)
    console.log(`Not run here (Vitest would rerun every suite): ${deferred.join(", ")}. npm run check covers them.`);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const failed = results.filter(({ ok }) => !ok).length;
  console.log(
    `check:fast ${failed ? `failed (${failed} steps)` : "passed"} in ${seconds}s against ${base}. Partial: run npm run check before claiming done.`,
  );
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
