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

/**
 * A checkout on disk plus the subset of it that `npm pack` would carry — the
 * two inputs the gate takes, kept separate on purpose: the defect it exists
 * for is a file that is present in the repository and absent from the tarball.
 */
async function fixture(
  files: Record<string, string>,
  packed: string[],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "connecta-packed-links-"));
  fixtures.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  await writeFile(join(root, "packed-paths.txt"), packed.join("\n"));
  return root;
}

function check(root: string) {
  const result = spawnSync(
    process.execPath,
    [checker, "--packed", "--root", root, "--files", join(root, "packed-paths.txt")],
    { encoding: "utf8" },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("packed Markdown link gate", () => {
  it("accepts shipped targets, repository URLs, fragments, and examples", async () => {
    const root = await fixture(
      {
        "README.md": [
          "![hero](https://raw.githubusercontent.com/zackbart/connecta/main/assets/hero.png)",
          "[guide](./documentation/guide.md#anchor)",
          "[here](#anchor)",
          "[evidence](https://github.com/zackbart/connecta/blob/main/eval/run.md)",
          "",
          "```md",
          "[an example, not a pointer](../eval/run.md)",
          "```",
          "",
        ].join("\n"),
        "documentation/guide.md": "# Anchor\n",
        "eval/run.md": "# Evidence\n",
        "assets/hero.png": "not really a png\n",
      },
      ["README.md", "documentation/guide.md"],
    );

    expect(check(root)).toMatchObject({
      status: 0,
      output: expect.stringContaining("packed link check passed"),
    });
  });

  it("rejects a relative link to a path the tarball does not carry", async () => {
    const root = await fixture(
      {
        "documentation/guide.md": [
          "# Guide",
          "",
          "Measured in [`eval/run.md`](../eval/run.md).",
          "",
        ].join("\n"),
        "eval/run.md": "# Evidence\n",
      },
      ["documentation/guide.md"],
    );
    const result = check(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'documentation/guide.md:3: relative link "../eval/run.md" resolves to ' +
        "eval/run.md, which the tarball does not carry; ship the target or " +
        "cite it as https://github.com/zackbart/connecta/blob/main/eval/run.md",
    );
  });

  it("rejects a link to a directory nothing under which ships", async () => {
    const root = await fixture(
      {
        "documentation/guide.md": "See [`scripts/drift/`](../scripts/drift/).\n",
        "scripts/drift/notion.json": "{}\n",
      },
      ["documentation/guide.md"],
    );
    const result = check(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "cite it as https://github.com/zackbart/connecta/blob/main/scripts/drift",
    );
  });

  it("sees reference-style definitions, not only inline links", async () => {
    const root = await fixture(
      {
        "README.md": ["Read the [notes].", "", "[notes]: ./test/notes.md", ""]
          .join("\n"),
        "test/notes.md": "# Notes\n",
      },
      ["README.md"],
    );

    expect(check(root)).toMatchObject({
      status: 1,
      output: expect.stringContaining("README.md:3: relative link"),
    });
  });

  it("still catches a packed guide linking an unpacked guide", async () => {
    const root = await fixture(
      {
        "documentation/guide.md": "See [the stub](./stub.md).\n",
        "documentation/stub.md": "> **Stub.**\n",
      },
      ["documentation/guide.md"],
    );

    expect(check(root)).toMatchObject({
      status: 1,
      output: expect.stringContaining(
        "resolves to documentation/stub.md, which the tarball does not carry",
      ),
    });
  });

  it("exempts the changelog, which quotes paths as a record", async () => {
    const root = await fixture(
      { "CHANGELOG.md": "Removed [`eval/old.md`](./eval/old.md).\n" },
      ["CHANGELOG.md"],
    );

    expect(check(root)).toMatchObject({
      status: 0,
      output: expect.stringContaining("packed link check passed"),
    });
  });
});
