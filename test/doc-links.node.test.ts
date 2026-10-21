// Node-only: spawns the Node documentation checker against filesystem fixtures.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnChecker, tempFixture } from "./fixtures/node.js";

// check:docs and the package smoke run this checker; these cases prove it
// still fails on the defects it exists for.
const checker = fileURLToPath(new URL("../scripts/check-doc-links.mjs", import.meta.url));

describe("documentation link checker", () => {
  it("reports a broken file with its source line and target", async () => {
    const root = await tempFixture("connecta-doc-links-", { "README.md": "[missing](./missing.md)\n" });
    expect(spawnChecker(checker, ["--root", root, "--skip-structure"])).toMatchObject({
      status: 1,
      output: expect.stringContaining('README.md:1: missing local target "./missing.md"'),
    });
  });

  it("reports a broken fragment with its source line and target", async () => {
    const root = await tempFixture("connecta-doc-links-", {
      "README.md": "[missing](./guide.md#absent)\n",
      "guide.md": "# Present\n",
    });
    expect(spawnChecker(checker, ["--root", root, "--skip-structure"])).toMatchObject({
      status: 1,
      output: expect.stringContaining(
        'README.md:1: missing fragment "#absent" in "guide.md" (target "./guide.md#absent")',
      ),
    });
  });

  it("rejects a packed relative link to a path the tarball does not carry", async () => {
    const root = await tempFixture("connecta-packed-links-", {
      "documentation/guide.md": ["# Guide", "", "Measured in [`eval/run.md`](../eval/run.md).", ""].join("\n"),
      "eval/run.md": "# Evidence\n",
      "packed-paths.txt": "documentation/guide.md",
    });
    const result = spawnChecker(checker, ["--packed", "--root", root, "--files", join(root, "packed-paths.txt")]);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'documentation/guide.md:3: relative link "../eval/run.md" resolves to eval/run.md, which the tarball does not carry',
    );
  });
});
