// Node-only: reads package.json with Node filesystem APIs.
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONNECTA_VERSION } from "../src/version.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("version constant", () => {
  it("matches package.json", () => {
    // The build generates the Workers-safe constant from package.json.
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { version: string };
    expect(CONNECTA_VERSION).toBe(pkg.version);
    expect(readFileSync(join(ROOT, "bin", "version.mjs"), "utf8")).toBe(readFileSync(join(ROOT, "src", "version.ts"), "utf8"));
  });

  it("generates both runtime constants from the package version at build time", () => {
    const fixture = mkdtempSync(join(tmpdir(), "connecta-version-"));
    try {
      for (const folder of ["scripts", "src", "bin"]) mkdirSync(join(fixture, folder));
      copyFileSync(join(ROOT, "scripts", "generate-version.mjs"), join(fixture, "scripts", "generate-version.mjs"));
      writeFileSync(join(fixture, "package.json"), JSON.stringify({ version: "9.8.7-rc.1+build.2" }));
      execFileSync(process.execPath, [join(fixture, "scripts", "generate-version.mjs")]);
      const generated = readFileSync(join(fixture, "src", "version.ts"), "utf8");
      expect(generated).toContain('export const CONNECTA_VERSION = "9.8.7-rc.1+build.2";');
      expect(readFileSync(join(fixture, "bin", "version.mjs"), "utf8")).toBe(generated);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it("matches the Node template's exact pin", () => {
    const template = JSON.parse(
      readFileSync(join(ROOT, "templates", "node", "package.json"), "utf8"),
    ) as { dependencies: { "@zackbart/connecta": string } };
    expect(template.dependencies["@zackbart/connecta"]).toBe(CONNECTA_VERSION);
  });
});
