// Node-only: reads package.json with Node filesystem APIs.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONNECTA_VERSION } from "../src/version.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("version constant", () => {
  it("matches package.json", () => {
    // The build generates the Workers-safe constant from package.json.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
    expect(CONNECTA_VERSION).toBe(pkg.version);
    expect(readFileSync(join(ROOT, "bin", "version.mjs"), "utf8")).toBe(
      readFileSync(join(ROOT, "src", "version.ts"), "utf8"),
    );
  });
});
