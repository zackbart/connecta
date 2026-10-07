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
    const command = (args) => spawnSync(process.execPath, [join(root, "scripts/changelog.mjs"), ...args], { cwd: root, encoding: "utf8" });
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
