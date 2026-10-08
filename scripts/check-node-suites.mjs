import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Collection and filesystem inspection happen at the edge; assertions accept
// plain data so regressions need no Vitest process or repository fixture.
export function assertSuiteCollection({ node, workers, details }) {
  const errors = [];
  const files = [...new Set([...node, ...workers])];
  for (const file of files) {
    const { realFile = file, inWorktree = false } = details[file];
    if ([file, realFile].some((path) => !(path.startsWith("test/") || /^src\/providers\/[^/]+\//.test(path)) || /(^|\/)(node_modules|dist|\.claude|worktrees)(\/|$)/.test(path)) || inWorktree) {
      errors.push(`${file}: collected suites must be under test/ or src/providers/<name>/ and outside node_modules, dist, and nested worktrees`);
    }
    const nodeOnly = file.endsWith(".node.test.ts");
    if (nodeOnly !== (node.includes(file) && !workers.includes(file))) {
      errors.push(`${file}: Node-only collection must be exactly the *.node.test.ts files; workers must collect none`);
    }
    if (!node.includes(file)) errors.push(`${file}: workers suite is not collected by node`);
    if (nodeOnly && !/^\/\/ Node-only: \S.*$/.test(details[file].firstLine ?? "")) {
      errors.push(`${file}: needs a first-line // Node-only: <reason> comment`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return `Node-only suites: ${node.length - workers.length} reasons present; Vitest collects ${node.length} node and ${workers.length} workers suites.`;
}

function main() {
  const started = performance.now();
  const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  const temporary = mkdtempSync(join(tmpdir(), "connecta-suite-list-"));
  try {
    const collection = {};
    for (const project of ["node", "workers"]) {
      const output = join(temporary, `${project}.json`);
      execFileSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "list", "--project", project, "--filesOnly", `--json=${output}`], { cwd: root, stdio: "pipe" });
      collection[project] = JSON.parse(readFileSync(output, "utf8")).map(({ file }) => relative(root, file).replaceAll("\\", "/"));
    }
    collection.details = {};
    for (const file of new Set([...collection.node, ...collection.workers])) {
      const actual = realpathSync(join(root, file));
      let inWorktree = false;
      // A nested worktree can have any name and a .git file, not only .git/.
      for (let directory = dirname(actual); directory !== root && directory !== dirname(directory); directory = dirname(directory)) {
        if (existsSync(join(directory, ".git"))) inWorktree = true;
      }
      collection.details[file] = {
        realFile: relative(root, actual).replaceAll("\\", "/"),
        inWorktree,
        firstLine: file.endsWith(".node.test.ts") ? readFileSync(actual, "utf8").split(/\r?\n/, 1)[0] : undefined,
      };
    }
    console.log(`${assertSuiteCollection(collection)} Guard: ${((performance.now() - started) / 1000).toFixed(2)}s.`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
