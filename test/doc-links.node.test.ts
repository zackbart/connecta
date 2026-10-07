// Node-only: spawns the Node documentation checker against filesystem fixtures.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnChecker, tempFixture } from "./fixtures/node.js";

const checker = fileURLToPath(
  new URL("../scripts/check-doc-links.mjs", import.meta.url),
);
async function fixture(files: Record<string, string>): Promise<string> {
  return tempFixture("connecta-doc-links-", files);
}

function check(root: string, structure = false) {
  return spawnChecker(checker, [
    "--root",
    root,
    ...(structure ? [] : ["--skip-structure"]),
  ]);
}

describe("documentation link checker", () => {
  it("accepts local files, GitHub-style fragments, and fenced examples", async () => {
    const root = await fixture({
      "README.md": [
        "[code](./guide.md#code-mode-execute_code)",
        "[punctuation](./guide.md#rock--roll)",
        "[duplicate](./guide.md#repeat-1)",
        "[colliding base](./guide.md#foo-1-1)",
        "[later duplicate](./guide.md#foo-2)",
        "",
        "```md",
        "[not active](./missing.md)",
        "See docs/documentation.md#16-scoped-views",
        "See (§16).",
        "```",
        "",
      ].join("\n"),
      "guide.md": [
        "# Code mode (`execute_code`)",
        "",
        "## Rock & Roll",
        "",
        "## Repeat",
        "",
        "## Repeat",
        "",
        "## Foo",
        "",
        "## Foo",
        "",
        "## Foo-1",
        "",
        "## Foo",
        "",
      ].join("\n"),
    });

    expect(check(root)).toMatchObject({
      status: 0,
      output: expect.stringContaining("documentation check passed"),
    });
  });

  it("reports a broken file with its source line and target", async () => {
    const root = await fixture({
      "README.md": "[missing](./missing.md)\n",
    });

    expect(check(root)).toMatchObject({
      status: 1,
      output: expect.stringContaining(
        'README.md:1: missing local target "./missing.md"',
      ),
    });
  });

  it("ignores agent-owned nested worktrees", async () => {
    const root = await fixture({
      "README.md": "# Current checkout\n",
      ".claude/worktrees/old/README.md": "[stale](./missing.md)\n",
    });

    expect(check(root)).toMatchObject({
      status: 0,
      output: expect.stringContaining("documentation check passed"),
    });
  });

  it("holds repository URLs, raw image forms included, to the checkout", async () => {
    const root = await fixture({
      "README.md": [
        "![hero](https://raw.githubusercontent.com/zackbart/connecta/main/assets/hero.png)",
        "[script](https://github.com/zackbart/connecta/blob/main/scripts/tool.mjs)",
        "[elsewhere](https://raw.githubusercontent.com/someone/else/main/gone.png)",
        "[moved](https://raw.githubusercontent.com/zackbart/connecta/main/assets/gone.png)",
        "",
      ].join("\n"),
      "assets/hero.png": "not really a png\n",
      "scripts/tool.mjs": "export {};\n",
    });
    const result = check(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'README.md:4: missing local target ' +
        '"https://raw.githubusercontent.com/zackbart/connecta/main/assets/gone.png"',
    );
    expect(result.output).not.toContain("hero.png");
    expect(result.output).not.toContain("someone/else");
  });

  it("reports a broken fragment with its source line and target", async () => {
    const root = await fixture({
      "README.md": "[missing](./guide.md#absent)\n",
      "guide.md": "# Present\n",
    });

    expect(check(root)).toMatchObject({
      status: 1,
      output: expect.stringContaining(
        'README.md:1: missing fragment "#absent" in "guide.md" (target "./guide.md#absent")',
      ),
    });
  });

  it("accepts the full expected structure", async () => {
    const root = await fixture({
      "README.md": "# Fixture\n",
      "PRINCIPLES.md": "# Principles\n",
      "documentation/architecture.md": "# Architecture\n",
    });

    expect(check(root, true)).toMatchObject({
      status: 0,
      output: expect.stringContaining("structure verified"),
    });
  });

  it("requires README.md, PRINCIPLES.md, and a documentation/ directory", async () => {
    const root = await fixture({
      "CHANGELOG.md": "history\n",
    });
    const result = check(root, true);

    expect(result.status).toBe(1);
    expect(result.output).toContain("README.md:1: missing README.md");
    expect(result.output).toContain("PRINCIPLES.md:1: missing PRINCIPLES.md");
    expect(result.output).toContain(
      'documentation:1: missing "documentation/" directory',
    );
  });

  it("rejects non-Markdown entries and an otherwise-empty documentation/", async () => {
    const root = await fixture({
      "README.md": "# Fixture\n",
      "PRINCIPLES.md": "# Principles\n",
      "documentation/notes.txt": "not a guide\n",
    });
    const result = check(root, true);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'documentation/notes.txt:1: non-Markdown entry in "documentation/"; guides are Markdown files only',
    );
    expect(result.output).toContain(
      'documentation:1: "documentation/" contains no guides',
    );
  });

  it("rejects duplicate guide heading slugs", async () => {
    const root = await fixture({
      "README.md": "# Fixture\n",
      "PRINCIPLES.md": "# Principles\n",
      "documentation/architecture.md": "# Repeat\n\n# Repeat\n",
    });

    expect(check(root, true)).toMatchObject({
      status: 1,
      output: expect.stringContaining(
        'documentation/architecture.md:3: duplicate guide heading anchor "#repeat"',
      ),
    });
  });
});
