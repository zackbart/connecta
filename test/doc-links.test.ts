import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const checker = fileURLToPath(
  new URL("../scripts/check-doc-links.mjs", import.meta.url),
);
const fixtures: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "connecta-doc-links-"));
  fixtures.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  return root;
}

function check(root: string, structure = false) {
  const result = spawnSync(
    process.execPath,
    [checker, "--root", root, ...(structure ? [] : ["--skip-structure"])],
    { encoding: "utf8" },
  );
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

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

  it("reports an active stale source-code reference", async () => {
    const root = await fixture({
      "README.md": "# Fixture\n",
      "src/example.ts":
        "// See docs/documentation.md#16-scoped-views.\n",
    });

    expect(check(root)).toMatchObject({
      status: 1,
      output: expect.stringContaining(
        'src/example.ts:1: stale documentation reference "docs/documentation.md#16-scoped-views"',
      ),
    });
  });

  it("reports a stale numbered-manual reference", async () => {
    const root = await fixture({
      "README.md": "# Fixture\n",
      "src/example.ts": "// See docs/documentation.md §16.\n",
    });

    expect(check(root)).toMatchObject({
      status: 1,
      output: expect.stringContaining(
        'src/example.ts:1: stale documentation reference "docs/documentation.md §16"',
      ),
    });
  });

  it.each([
    "README.md",
    "src/example.ts",
    "documentation/guide.md",
    "examples/Dockerfile",
  ])("reports a bare numbered citation in %s", async (path) => {
    const root = await fixture({
      [path]: "See (§16) for details.\n",
    });

    expect(check(root)).toMatchObject({
      status: 1,
      output: expect.stringContaining(
        `${path}:1: stale documentation reference "§16"`,
      ),
    });
  });

  it("deliberately permits historical numbered citations in CHANGELOG", async () => {
    const root = await fixture({
      "CHANGELOG.md": "- Preserved the old (§16) behavior.\n",
    });

    expect(check(root)).toMatchObject({
      status: 0,
      output: expect.stringContaining("documentation check passed"),
    });
  });

  it("accepts the full expected structure", async () => {
    const root = await fixture({
      "README.md": "# Fixture\n",
      "ethos.md": "# Ethos\n",
      "documentation/architecture.md": "# Architecture\n",
    });

    expect(check(root, true)).toMatchObject({
      status: 0,
      output: expect.stringContaining("structure verified"),
    });
  });

  it("requires README.md, ethos.md, and a documentation/ directory", async () => {
    const root = await fixture({
      "CHANGELOG.md": "history\n",
    });
    const result = check(root, true);

    expect(result.status).toBe(1);
    expect(result.output).toContain("README.md:1: missing README.md");
    expect(result.output).toContain("ethos.md:1: missing ethos.md");
    expect(result.output).toContain(
      'documentation:1: missing "documentation/" directory',
    );
  });

  it("rejects a resurrected docs/ directory", async () => {
    const root = await fixture({
      "README.md": "# Fixture\n",
      "ethos.md": "# Ethos\n",
      "documentation/architecture.md": "# Architecture\n",
      "docs/old.md": "# Retired manual\n",
    });

    expect(check(root, true)).toMatchObject({
      status: 1,
      output: expect.stringContaining(
        'docs:1: retired "docs/" directory exists; guides belong in "documentation/"',
      ),
    });
  });

  it("enforces the ethos and guide length limits", async () => {
    const root = await fixture({
      "README.md": "# Fixture\n",
      "ethos.md": Array(150).fill("ethos line").join("\n"),
      "documentation/architecture.md": Array(800)
        .fill("architecture line")
        .join("\n"),
    });
    const result = check(root, true);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "ethos.md:1: ethos.md has 150 lines; expected fewer than 150 — terseness is the point",
    );
    expect(result.output).toContain(
      "documentation/architecture.md:1: guide has 800 lines; expected fewer than 800",
    );
  });

  it("rejects non-Markdown entries and an otherwise-empty documentation/", async () => {
    const root = await fixture({
      "README.md": "# Fixture\n",
      "ethos.md": "# Ethos\n",
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
      "ethos.md": "# Ethos\n",
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
