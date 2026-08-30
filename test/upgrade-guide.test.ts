import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The upgrade guide is read by an agent inside somebody else's deployment,
// with no way to check its claims against this repository. Every claim it
// makes about what `connecta init` generates, what `connecta doctor` demands,
// and which releases broke something is therefore pinned here: a template that
// gains a file, a surface that gains a tool, or a version that never shipped
// fails this suite rather than misleading a reader who cannot tell (#380).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...segments: string[]) =>
  readFileSync(join(ROOT, ...segments), "utf8");

const guide = read("documentation", "upgrading.md");

/** Backticked file-shaped tokens in one Markdown table cell. */
function filesNamedIn(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)]
    .map(([, token]) => token ?? "")
    .filter((token) => /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(token));
}

function generationRow(label: string): string {
  const row = guide
    .split("\n")
    .find((line) => line.startsWith(`| **${label}** |`));
  expect(row, `no generation "${label}" row in the guide's layout table`)
    .toBeTypeOf("string");
  return (row as string).split("|")[3] ?? "";
}

describe("the upgrade guide", () => {
  it("describes the deployment `connecta init` actually generates", () => {
    // What init produces: the template tree, with `src` expanded, plus the
    // .gitignore and CLAUDE.md symlink the CLI restores (npm strips both from
    // a packed dependency). Generations A and B partition that inventory —
    // A is what every generation has had, B is what 0.16.0 added.
    const template = join(ROOT, "templates", "node");
    const generated = readdirSync(template)
      .flatMap((entry) =>
        entry === "src"
          ? readdirSync(join(template, entry)).map((file) => `src/${file}`)
          : [entry],
      )
      .sort();
    const described = [
      ...new Set([
        ...filesNamedIn(generationRow("A")),
        ...filesNamedIn(generationRow("B")),
      ]),
    ].sort();
    expect(
      described,
      "the guide's generation table names a different file set than " +
        "templates/node generates; a reader inside an old deployment cannot " +
        "tell which of you is wrong",
    ).toEqual(generated);
  });

  it("names the seven tools doctor demands, and only those", () => {
    const cli = read("bin", "connecta.mjs");
    const expected = [
      ...(cli.match(/const expected = \[([\s\S]*?)\];/)?.[1] ?? "").matchAll(
        /"([a-z_]+)"/g,
      ),
    ].map(([, name]) => name);
    expect(expected).toHaveLength(7);
    const verification = guide.slice(guide.indexOf("\n## Verify"));
    for (const tool of expected) {
      expect(
        verification,
        `the verification section never names the tool "${tool}"`,
      ).toContain(`\`${tool}\``);
    }
  });

  it("only names version boundaries that shipped", () => {
    const boundaries = [...guide.matchAll(/^### (\d+\.\d+\.[\dx]+) → (\d+\.\d+\.[\dx]+)$/gm)];
    expect(boundaries.length).toBeGreaterThan(0);
    const changelog = read("CHANGELOG.md");
    for (const [, from, to] of boundaries) {
      for (const version of [from ?? "", to ?? ""]) {
        if (version === "" || version.endsWith(".x")) continue;
        expect(
          changelog,
          `the guide names a ${version} boundary; CHANGELOG.md has no such release`,
        ).toContain(`\n## ${version} — `);
      }
    }
  });

  it("dates every removed option to the release that removed it", () => {
    // A reader on 0.9.x cannot check this table against anything. Dating a
    // removal to the wrong release tells them a construction throw belongs to
    // a boundary they have already crossed, so each row's release must exist
    // and must be the section that names the row's issue.
    const changelog = read("CHANGELOG.md");
    const sections = new Map(
      [...changelog.matchAll(/\n## (\d+\.\d+\.\d+) — [^\n]*\n([\s\S]*?)(?=\n## |$)/g)].map(
        ([, version, body]) => [version ?? "", body ?? ""],
      ),
    );
    const rows = [
      ...guide.matchAll(/^\| [^|]+ \| (\d+\.\d+\.[\dx]+)(?: \(#(\d+)\))? \|/gm),
    ];
    expect(rows.length).toBeGreaterThan(0);
    for (const [row, version, issue] of rows) {
      // An `0.10.x`-shaped cell is not a released version and is exactly how a
      // removal ends up dated to the wrong boundary, so it fails here too.
      const body = sections.get(version ?? "");
      expect(
        body,
        `the guide dates a removal to ${version}; CHANGELOG.md has no such release\n${row}`,
      ).toBeTypeOf("string");
      if (issue === undefined) continue;
      expect(
        body,
        `the guide says #${issue} was removed in ${version}, but that release ` +
          `never mentions the issue\n${row}`,
      ).toContain(`#${issue}`);
    }
  });

  it("tells a reader to bump to the version this package is", () => {
    const { version } = JSON.parse(read("package.json")) as { version: string };
    const pinned = [
      ...guide.matchAll(/@zackbart\/connecta[@=](\d+\.\d+\.\d+)/g),
    ].map(([, found]) => found ?? "");
    // The one illustrative old pin in the identification walkthrough is the
    // deployment's own generation, not a target. Everything at or above the
    // current version is a target and must be this release.
    const targets = pinned.filter((found) => found === version);
    expect(
      targets.length,
      `the guide's upgrade commands name no ${version}; a release bump ` +
        "leaves it telling readers to upgrade to the previous version",
    ).toBeGreaterThanOrEqual(2);
    for (const found of pinned) {
      expect(
        found <= version,
        `the guide names @zackbart/connecta ${found}, which is ahead of ${version}`,
      ).toBe(true);
    }
  });

  it("opens the boundary list with this release", () => {
    const { version } = JSON.parse(read("package.json")) as { version: string };
    const first = guide.match(/^### (\d+\.\d+\.\d+) → (\d+\.\d+\.\d+)$/m);
    expect(first?.slice(1)).toEqual(["0.20.0", version]);
    expect(guide).toContain(`| **B** | 0.16.0 – ${version} |`);
  });

  it("is reachable from where a reader starts", () => {
    expect(read("README.md")).toContain("./documentation/upgrading.md");
    expect(read("documentation", "operations.md")).toContain("./upgrading.md");
    // The next agent inside a generated deployment reads AGENTS.md, and has
    // no copy of this repository — so that pointer has to be absolute.
    expect(read("templates", "node", "AGENTS.md")).toContain(
      "https://github.com/zackbart/connecta/blob/main/documentation/upgrading.md",
    );
  });
});
