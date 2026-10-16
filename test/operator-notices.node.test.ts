// Node-only: bundles the operator UI with esbuild and reads license files from node_modules.
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { OPERATOR_UI_ASSETS, OPERATOR_UI_NOTICES_PATH } from "../src/operator-ui/generated.js";

const root = resolve(import.meta.dirname, "..");
const SEPARATOR = "\n\n----------------------------------------\n\n";

/**
 * Every package the operator script actually ships, found independently of
 * the asset build: bundle the entry again and read the packages off its
 * metafile. The two Geist packages ship as fonts through the stylesheet.
 */
async function shippedPackages(): Promise<string[]> {
  const result = await build({
    absWorkingDir: root,
    bundle: true,
    entryPoints: ["src/operator-ui/app/main.tsx"],
    format: "iife",
    jsx: "automatic",
    jsxImportSource: "react",
    define: { "process.env.NODE_ENV": '"production"' },
    minify: true,
    treeShaking: true,
    metafile: true,
    write: false,
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  const packages = new Set(["@fontsource-variable/geist", "@fontsource-variable/geist-mono"]);
  for (const input of Object.keys(result.metafile.inputs)) {
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input);
    if (match) packages.add(match[1]!);
  }
  return [...packages].sort();
}

/** What each package's notice must say, verbatim, from its own files. */
async function expectedText(name: string): Promise<{ text: string; heading: string }> {
  const directory = resolve(root, "node_modules", name);
  const license = (await readdir(directory)).find((file) => /^licen[cs]e(?:\.|$)/i.test(file));
  if (license) return { heading: name, text: await readFile(resolve(directory, license), "utf8") };
  // No LICENSE in the tarball: its declared MIT license, with the grant this repository ships.
  const metadata = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
  expect(metadata.license, `${name} has no license file and no MIT declaration`).toBe("MIT");
  const grant = (await readFile(resolve(root, "LICENSE"), "utf8")).split("Permission is hereby granted")[1];
  return { heading: `${name} ${metadata.version}`, text: `Permission is hereby granted${grant}` };
}

describe("operator dependency notices", () => {
  it("map every shipped package to its own verbatim license text, each distinct text once", async () => {
    const body = OPERATOR_UI_ASSETS[OPERATOR_UI_NOTICES_PATH]!.body;
    const actual = new Map<string, string>();
    const sections = body.split(SEPARATOR);
    for (const section of sections) {
      const split = section.indexOf("\n\n");
      const text = section.slice(split + 2);
      for (const line of section.slice(0, split).split("\n")) {
        // A metadata-derived heading carries version, author and repository lines.
        if (/^(Author|License|Repository): /.test(line)) continue;
        actual.set(line, text);
      }
    }
    const expected = new Map<string, string>();
    for (const name of await shippedPackages()) {
      const { heading, text } = await expectedText(name);
      expected.set(heading, text);
    }
    // The same packages, no more and no fewer, each under exactly its own text.
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [heading, text] of expected) expect(actual.get(heading), heading).toBe(text);
    // Grouping keeps one copy of each distinct text.
    const texts = sections.map((section) => section.slice(section.indexOf("\n\n") + 2));
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts.length).toBe(new Set(expected.values()).size);
  });
});
