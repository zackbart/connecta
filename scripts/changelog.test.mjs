import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSuiteCollection } from "./check-node-suites.mjs";
import { GUARDS, failureOutput, relatedInputs } from "./check-fast.mjs";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "connecta-changelog-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, ".changes"));
    copyFileSync(new URL("./changelog.mjs", import.meta.url), join(root, "scripts/changelog.mjs"));
    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## 0.28.1 — 2026-10-05\n\nPrevious release.\n");
    writeFileSync(join(root, "narrative.md"), "This release changes contributor tooling.\n\nDeployments need no changes.\n");
    execFileSync("git", ["init", "--quiet", root]);
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    const commit = () => {
      git("add", ".");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Fixture");
    };
    commit();
    const command = (args, nodeArgs = []) => spawnSync(process.execPath, [...nodeArgs, join(root, "scripts/changelog.mjs"), ...args], { cwd: root, encoding: "utf8" });
    const assemble = ["--version", "0.29.0", "--narrative", "narrative.md", "--date", "2026-10-07"];
    run({ root, command, assemble, commit, git });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("assembles every category deterministically, preserves narrative and history, and consumes only fragments", () => {
  fixture(({ root, command, assemble, commit }) => {
    const types = ["security", "removed", "fixed", "changed", "added"];
    for (const [i, type] of types.entries()) {
      writeFileSync(join(root, `.changes/${i}.md`), `---\ntype: ${type}\n${type === "changed" ? "breaking: true\n" : ""}---\n\n${type} entry\ncontinued\n`);
    }
    writeFileSync(join(root, ".changes/.gitkeep"), "");
    const history = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    commit();
    const result = command(assemble);
    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    assert.ok(output.endsWith(history.slice(history.indexOf("## 0.28.1"))));
    assert.match(output, /## 0\.29\.0 — 2026-10-07\n\nThis release changes contributor tooling\.\n\nDeployments need no changes\./);
    assert.deepEqual([...output.matchAll(/^### (\w+)/gm)].map((match) => match[1]), ["Added", "Changed", "Fixed", "Removed", "Security"]);
    assert.match(output, /- \*\*Breaking:\*\* changed entry\n  continued/);
    assert.deepEqual(readdirSync(join(root, ".changes")), [".gitkeep"]);
    assert.equal(command(["--check"]).status, 0);
    writeFileSync(join(root, ".changes/new.md"), "---\ntype: fixed\n---\n\nAnother fix.\n");
    commit();
    assert.match(command(assemble).stderr, /existing version/);
    assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), output);
    assert.ok(readdirSync(join(root, ".changes")).includes("new.md"));
  });
});

test("printed git command restores byte-identical committed inputs after a partial unlink failure or SIGTERM, then permits retry", () => {
  fixture(({ root, command, assemble, commit, git }) => {
    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\r\n\r\n## 0.28.1 — 2026-10-05\r\n\r\nPrevious release.\r\n");
    writeFileSync(join(root, ".changes/a.md"), "---\r\ntype: fixed\r\n---\r\n\r\nFirst fix.  \r\n");
    writeFileSync(join(root, ".changes/b.md"), "---\ntype: added\n---\n\nSecond entry.\n\n");
    writeFileSync(join(root, ".changes/.gitkeep"), "");
    commit();
    const names = readdirSync(join(root, ".changes")).sort();
    const before = new Map(["CHANGELOG.md", ...names.map((name) => `.changes/${name}`)]
      .map((file) => [file, readFileSync(join(root, file))]));
    // Patch the actual CLI's filesystem boundary without relying on platform
    // permissions or immutable-file support. The first unlink must land.
    const fault = join(root, "fault.mjs");
    writeFileSync(fault, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
const unlink = fs.unlinkSync;
fs.unlinkSync = (file) => {
  if (file.endsWith("/b.md")) {
    assert.equal(fs.existsSync(file.replace(/b\\.md$/, "a.md")), false);
    assert.match(fs.readFileSync("CHANGELOG.md", "utf8"), /## 0\\.29\\.0/);
    throw Object.assign(new Error("injected unlink failure"), { code: "EPERM" });
  }
  return unlink(file);
};
syncBuiltinESMExports();
`);
    for (const interrupted of [false, true]) {
      if (interrupted) {
        writeFileSync(fault, readFileSync(fault, "utf8").replace(
          'throw Object.assign(new Error("injected unlink failure"), { code: "EPERM" });',
          'process.kill(process.pid, "SIGTERM");',
        ));
      }
      const result = command(assemble, ["--import", fault]);
      assert.notEqual(result.status, 0);
      if (interrupted) assert.equal(result.signal, "SIGTERM");
      else assert.match(result.stderr, /injected unlink failure/);
      const recovery = result.stdout.match(/Recovery if assembly fails or is interrupted: (git restore[^\n]+)/)?.[1];
      assert.equal(recovery, "git restore --source=HEAD --staged --worktree -- CHANGELOG.md .changes");
      if (!interrupted) assert.ok(result.stderr.includes(`Recover with: ${recovery}`));
      assert.equal(readdirSync(join(root, ".changes")).includes("a.md"), false);
      assert.match(readFileSync(join(root, "CHANGELOG.md"), "utf8"), /## 0\.29\.0/);
      // Restore both index and worktree, even if the partial state was staged.
      git("add", "CHANGELOG.md", ".changes");
      git(...recovery.split(" ").slice(1));
      assert.deepEqual(readdirSync(join(root, ".changes")).sort(), names);
      for (const [file, bytes] of before) assert.deepEqual(readFileSync(join(root, file)), bytes, file);
    }
    const retry = command(assemble);
    assert.equal(retry.status, 0, retry.stderr);
    const output = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    assert.equal([...output.matchAll(/## 0\.29\.0/g)].length, 1);
    assert.equal([...output.matchAll(/First fix\./g)].length, 1);
    assert.equal([...output.matchAll(/Second entry\./g)].length, 1);
    assert.deepEqual(readdirSync(join(root, ".changes")), [".gitkeep"]);
  });
});

test("rejects malformed metadata and empty entries without changing history or consuming fragments", () => {
  for (const text of [
    "No frontmatter", "---\ntype: other\n---\n\nEntry", "---\ntype: added\ntype: fixed\n---\n\nEntry",
    "---\ntype: fixed\nextra: true\n---\n\nEntry", "---\ntype: fixed\nbreaking: false\n---\n\nEntry",
    "---\ntype: fixed\n---\n\n", "---\ntype: fixed\n---\n\n### Section", "---\ntype: fixed\n---\n\n- Entry",
  ]) {
    fixture(({ root, command, assemble, commit }) => {
      writeFileSync(join(root, ".changes/bad.md"), text);
      commit();
      const before = readFileSync(join(root, "CHANGELOG.md"), "utf8");
      assert.notEqual(command(["--check"]).status, 0, text);
      assert.notEqual(command(assemble).status, 0, text);
      assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), before);
      assert.equal(readFileSync(join(root, ".changes/bad.md"), "utf8"), text);
    });
  }
});

test("requires fragments, a narrative, a version, and a real date before writing", () => {
  fixture(({ root, command, assemble, commit }) => {
    assert.notEqual(command(assemble).status, 0);
    writeFileSync(join(root, ".changes/good.md"), "---\r\ntype: fixed\r\n---\r\n\r\nFix.\r\n");
    commit();
    const before = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    for (const args of [[], ["--version", "no"], ["--version", "0.29.0"], [...assemble.slice(0, 4), "--date", "2026-02-30"], [...assemble, "--unknown", "yes"]]) {
      assert.notEqual(command(args).status, 0);
      assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), before);
    }
    writeFileSync(join(root, "narrative.md"), "");
    assert.notEqual(command(assemble).status, 0);
    assert.ok(readdirSync(join(root, ".changes")).includes("good.md"));
  });
});

test("refuses dirty, staged, untracked, and ignored untracked inputs before writing", () => {
  for (const kind of ["dirty changelog", "dirty fragment", "staged fragment", "untracked fragment", "ignored fragment", "untracked changelog"]) {
    fixture(({ root, command, assemble, commit, git }) => {
      const fragment = join(root, ".changes/good.md");
      writeFileSync(fragment, "---\ntype: fixed\n---\n\nFix.\n");
      commit();
      if (kind === "dirty changelog") writeFileSync(join(root, "CHANGELOG.md"), "Dirty history\n");
      if (kind === "dirty fragment" || kind === "staged fragment") writeFileSync(fragment, "Changed fragment\n");
      if (kind === "staged fragment") git("add", ".changes");
      if (kind === "ignored fragment") writeFileSync(join(root, ".gitignore"), ".changes/untracked.md\n");
      if (kind === "untracked fragment") writeFileSync(join(root, ".changes/untracked.md"), "Untracked\n");
      if (kind === "ignored fragment") writeFileSync(join(root, ".changes/untracked.md"), "Ignored\n");
      if (kind === "untracked changelog") git("rm", "--cached", "CHANGELOG.md");
      const files = ["CHANGELOG.md", ...readdirSync(join(root, ".changes")).map((file) => `.changes/${file}`)];
      const before = files.map((file) => readFileSync(join(root, file)));
      const result = command(assemble);
      assert.notEqual(result.status, 0, kind);
      assert.match(result.stderr, /Commit .*before assembling/, kind);
      assert.deepEqual(files.map((file) => readFileSync(join(root, file))), before, kind);
    });
  }
});

test("rejects a committed legacy Unreleased section without touching inputs", () => {
  fixture(({ root, command, assemble, commit }) => {
    writeFileSync(join(root, ".changes/good.md"), "---\ntype: fixed\n---\n\nFix.\n");
    const history = "# Changelog\n\n## Unreleased\n\nLegacy entry.\n";
    writeFileSync(join(root, "CHANGELOG.md"), history);
    commit();
    assert.match(command(assemble).stderr, /unreleased section/);
    assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), history);
    assert.equal(readdirSync(join(root, ".changes")).length, 1);
  });
});

function collection(node, workers, details = {}) {
  return { node, workers, details: Object.fromEntries([...node, ...workers].map((file) => [file, details[file] ?? {}])) };
}

test("collection assertion enforces exact Node-only membership and first-line reasons", () => {
  const file = "test/nested/example.node.test.ts";
  const portable = "test/portable.test.ts";
  for (const firstLine of ["import {};", "// Node-only: ", "// Node-only:    "]) {
    assert.throws(() => assertSuiteCollection(collection([portable, file], [portable], { [file]: { firstLine } })), /first-line/);
  }
  const details = { [file]: { firstLine: "// Node-only: uses TCP sockets." } };
  assert.match(assertSuiteCollection(collection([portable, file], [portable], details)), /1 reasons present/);
  assert.throws(() => assertSuiteCollection(collection([portable, file], [portable, file], details)), /workers must collect none/);
  assert.throws(() => assertSuiteCollection(collection([portable], [])), /exactly the/);
  assert.throws(() => assertSuiteCollection(collection([], [portable])), /not collected by node/);
  assert.throws(() => assertSuiteCollection(collection(["outside/a.test.ts"], ["outside/a.test.ts"])), /under test/);
});

for (const directory of ["ignored", "dist", "worktrees", "symlink", "node_modules"]) {
  test(`collection regression: test/${directory}/ cannot bypass suite checks`, () => {
    const file = `test/${directory}/example.node.test.ts`;
    assert.throws(() => assertSuiteCollection(collection([file], [])), /first-line/);
    if (["dist", "worktrees", "node_modules"].includes(directory)) {
      const portable = `test/${directory}/pkg/portable.test.ts`;
      assert.throws(() => assertSuiteCollection(collection([portable], [portable])), /outside node_modules, dist, and nested worktrees/);
    }
    if (directory === "symlink") {
      assert.throws(() => assertSuiteCollection(collection([file], [], { [file]: { realFile: "outside/example.node.test.ts", firstLine: "// Node-only: sockets." } })), /under test/);
    }
  });
}

test("collection rejects nested git worktrees with arbitrary names and resolved excluded paths", () => {
  const file = "test/nested/portable.test.ts";
  for (const details of [{ inWorktree: true }, { realFile: "test/node_modules/pkg/portable.test.ts" }, { realFile: "test/.claude/portable.test.ts" }]) {
    assert.throws(() => assertSuiteCollection(collection([file], [file], { [file]: details })), /nested worktrees/);
  }
});

test("check:fast always runs the guards and adds suites that name a changed path", () => {
  const suites = [
    { file: "test/ci.node.test.ts", text: 'readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url))' },
    { file: "test/fixture-reader.test.ts", text: 'new URL("./fixtures/catalog.json", import.meta.url)' },
    { file: "test/unrelated.test.ts", text: "import { createConnecta } from '../src/index.js';" },
  ];
  assert.deepEqual(relatedInputs({ changed: [], suites }), { related: [...GUARDS].sort(), deferred: [] });
  const { related, deferred } = relatedInputs({ changed: [".github/workflows/ci.yml", "test/fixtures/catalog.json", "src/server.ts"], suites });
  assert.deepEqual(deferred, []);
  for (const file of [...GUARDS, ".github/workflows/ci.yml", "test/ci.node.test.ts", "test/fixtures/catalog.json", "test/fixture-reader.test.ts", "src/server.ts"]) {
    assert.ok(related.includes(file), file);
  }
  assert.ok(!related.includes("test/unrelated.test.ts"));
});

test("check:fast defers inputs that would make Vitest rerun every suite", () => {
  const changed = ["package.json", "vitest.config.ts", "templates/node/package.json", "src/package.json.ts"];
  const { related, deferred } = relatedInputs({ changed, suites: [] });
  assert.deepEqual(deferred, ["package.json", "vitest.config.ts", "templates/node/package.json"]);
  assert.deepEqual(related, [...GUARDS, "src/package.json.ts"].sort());
});

test("check:fast keeps a failing Vitest run's summary and bounds other output", () => {
  const vitest = ["✓ passing suite", "", "⎯⎯⎯ Failed Tests 1 ⎯⎯⎯", " FAIL test/a.test.ts > breaks", " Test Files  1 failed"].join("\n");
  assert.equal(failureOutput(vitest), ["⎯⎯⎯ Failed Tests 1 ⎯⎯⎯", " FAIL test/a.test.ts > breaks", " Test Files  1 failed"].join("\n"));
  const long = Array.from({ length: 250 }, (_, index) => `line ${index}`).join("\n");
  assert.deepEqual(failureOutput(`${long}\n`).split("\n"), Array.from({ length: 200 }, (_, index) => `line ${index + 50}`));
});
