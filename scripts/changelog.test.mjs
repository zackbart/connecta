import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "connecta-changelog-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, ".changes"));
    copyFileSync(new URL("./changelog.mjs", import.meta.url), join(root, "scripts/changelog.mjs"));
    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## 0.28.1 — 2026-10-05\n\nPrevious release.\n");
    writeFileSync(join(root, "narrative.md"), "This release changes contributor tooling.\n\nDeployments need no changes.\n");
    const command = (args, nodeArgs = []) => spawnSync(process.execPath, [...nodeArgs, join(root, "scripts/changelog.mjs"), ...args], { cwd: root, encoding: "utf8" });
    const assemble = ["--version", "0.29.0", "--narrative", "narrative.md", "--date", "2026-10-07"];
    run({ root, command, assemble });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("assembles every category deterministically, preserves narrative and history, and consumes only fragments", () => {
  fixture(({ root, command, assemble }) => {
    const types = ["security", "removed", "fixed", "changed", "added"];
    for (const [i, type] of types.entries()) {
      writeFileSync(join(root, `.changes/${i}.md`), `---\ntype: ${type}\n${type === "changed" ? "breaking: true\n" : ""}---\n\n${type} entry\ncontinued\n`);
    }
    writeFileSync(join(root, ".changes/.gitkeep"), "");
    const history = readFileSync(join(root, "CHANGELOG.md"), "utf8");
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
    assert.notEqual(command(assemble).status, 0);
    assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), output);
    assert.ok(readdirSync(join(root, ".changes")).includes("new.md"));
  });
});

test("restores byte-identical history and all fragments after a partial unlink failure, then permits retry", () => {
  fixture(({ root, command, assemble }) => {
    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\r\n\r\n## 0.28.1 — 2026-10-05\r\n\r\nPrevious release.\r\n");
    writeFileSync(join(root, ".changes/a.md"), "---\r\ntype: fixed\r\n---\r\n\r\nFirst fix.  \r\n");
    writeFileSync(join(root, ".changes/b.md"), "---\ntype: added\n---\n\nSecond entry.\n\n");
    writeFileSync(join(root, ".changes/.gitkeep"), "");
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
    const result = command(assemble, ["--import", fault]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /injected unlink failure.*Original changelog and fragments restored/);
    assert.deepEqual(readdirSync(join(root, ".changes")).sort(), names);
    for (const [file, bytes] of before) assert.deepEqual(readFileSync(join(root, file)), bytes, file);
    assert.ok(!readdirSync(root).includes("CHANGELOG.md.tmp"));
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
    fixture(({ root, command, assemble }) => {
      writeFileSync(join(root, ".changes/bad.md"), text);
      const before = readFileSync(join(root, "CHANGELOG.md"), "utf8");
      assert.notEqual(command(["--check"]).status, 0, text);
      assert.notEqual(command(assemble).status, 0, text);
      assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), before);
      assert.equal(readFileSync(join(root, ".changes/bad.md"), "utf8"), text);
    });
  }
});

test("requires fragments, a narrative, a version, and a real date before writing", () => {
  fixture(({ root, command, assemble }) => {
    assert.notEqual(command(assemble).status, 0);
    writeFileSync(join(root, ".changes/good.md"), "---\r\ntype: fixed\r\n---\r\n\r\nFix.\r\n");
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

test("Node-only reason check rejects a missing or blank first-line comment", () => {
  const root = mkdtempSync(join(tmpdir(), "connecta-node-suites-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "test/nested"), { recursive: true });
    copyFileSync(new URL("./check-node-suites.mjs", import.meta.url), join(root, "scripts/check-node-suites.mjs"));
    copyFileSync(new URL("./test-suites.mjs", import.meta.url), join(root, "scripts/test-suites.mjs"));
    execFileSync("git", ["init", "--quiet", root]);
    const file = join(root, "test/nested/example.node.test.ts");
    for (const text of ["import {};\n", "// Node-only: \n"]) {
      writeFileSync(file, text);
      const result = spawnSync(process.execPath, [join(root, "scripts/check-node-suites.mjs")], { encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /example\.node\.test\.ts/);
    }
    writeFileSync(file, "// Node-only: uses real TCP sockets.\n");
    execFileSync(process.execPath, [join(root, "scripts/check-node-suites.mjs")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("suite guard rejects tracked and untracked off-tree suites and ignores generated directories", () => {
  const root = mkdtempSync(join(tmpdir(), "connecta-node-suites-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "test/nested"), { recursive: true });
    mkdirSync(join(root, "outside"));
    for (const file of ["check-node-suites.mjs", "test-suites.mjs"]) {
      copyFileSync(new URL(file, import.meta.url), join(root, "scripts", file));
    }
    execFileSync("git", ["init", "--quiet", root]);
    writeFileSync(join(root, ".gitignore"), "ignored/\n");
    for (const directory of ["node_modules", "dist", "worktrees", "ignored"]) {
      mkdirSync(join(root, directory));
      writeFileSync(join(root, directory, "generated.node.test.ts"), "import {};\n");
    }
    writeFileSync(join(root, "test/nested/portable.test.ts"), "import {};\n");
    writeFileSync(join(root, "test/nested/example.node.test.ts"), "// Node-only: uses real TCP sockets.\n");
    const check = () => spawnSync(process.execPath, [join(root, "scripts/check-node-suites.mjs")], { cwd: root, encoding: "utf8" });
    assert.equal(check().status, 0);
    writeFileSync(join(root, "outside/a.node.test.ts"), "import {};\n");
    writeFileSync(join(root, "outside/b.test.ts"), "import {};\n");
    execFileSync("git", ["-C", root, "add", "outside/b.test.ts"]);
    const result = check();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not collected by Vitest:\noutside\/a\.node\.test\.ts\noutside\/b\.test\.ts/);
    assert.match(result.stderr, /first-line.*\noutside\/a\.node\.test\.ts/);
    writeFileSync(join(root, "outside/a.node.test.ts"), "// Node-only: uses real TCP sockets.\n");
    const reasonPresent = check();
    assert.notEqual(reasonPresent.status, 0);
    assert.match(reasonPresent.stderr, /not collected by Vitest/);
    assert.doesNotMatch(reasonPresent.stderr, /need a first-line/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
