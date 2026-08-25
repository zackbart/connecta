import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONNECTA_VERSION } from "../src/version.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("version constant", () => {
  it("matches package.json", () => {
    // src/version.ts is the Workers-safe source of truth for /health and for
    // the downstream MCP client handshake. If a release bumps package.json
    // alone, this fails instead of shipping a stale version.
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { version: string };
    expect(CONNECTA_VERSION).toBe(pkg.version);
  });

  it("matches the Node template's exact pin", () => {
    const template = JSON.parse(
      readFileSync(join(ROOT, "templates", "node", "package.json"), "utf8"),
    ) as { dependencies: { "@zackbart/connecta": string } };
    expect(template.dependencies["@zackbart/connecta"]).toBe(CONNECTA_VERSION);
  });
});
