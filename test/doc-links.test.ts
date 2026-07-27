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

function check(root: string) {
  const result = spawnSync(
    process.execPath,
    [checker, "--root", root, "--skip-structure"],
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
        "See docs/documentation.md#16-toolkits-scoped-views",
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
        "// See docs/documentation.md#16-toolkits-scoped-views.\n",
    });

    expect(check(root)).toMatchObject({
      status: 1,
      output: expect.stringContaining(
        'src/example.ts:1: stale documentation reference "docs/documentation.md#16-toolkits-scoped-views"',
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
});
