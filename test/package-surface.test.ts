import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  exports?: Record<string, unknown>;
  files?: string[];
  engines?: Record<string, string>;
  private?: boolean;
  publishConfig?: { access?: string };
};

describe("public package boundary", () => {
  it("is configured as a public package that ships built output", () => {
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(packageJson.engines?.node).toBe(">=20.9.0");
    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        "bin",
        "dist",
        "documentation",
        "templates",
        "README.md",
        "LICENSE",
      ]),
    );
    // Nothing in `exports` resolves outside dist/, so src/ only ever fed the
    // source and declaration maps — and both were retired with it (#346).
    // assets/ is the README hero image, which npmjs.com renders straight from
    // the repository. Neither belongs in every install.
    expect(packageJson.files).not.toContain("src");
    expect(packageJson.files).not.toContain("assets");
  });

  it("ships only generic connector factories and their shared machinery", () => {
    // guarded-fetch.ts is transport, not a third authoring path: it knows no
    // provider, and a provider-named file here would still be a failure.
    expect(readdirSync(join(ROOT, "src", "connectors")).sort()).toEqual([
      "api.ts",
      "guarded-fetch.ts",
      "remote-mcp.ts",
    ]);
  });

  it("keeps platform storage implementations in examples", () => {
    expect(readdirSync(join(ROOT, "src", "storage")).sort()).toEqual([
      "file.ts",
      "memory.ts",
    ]);
  });

  it("keeps Clerk behind an optional adapter subpath", () => {
    expect(packageJson.dependencies).not.toHaveProperty("@clerk/backend");
    expect(packageJson.peerDependencies).toHaveProperty(
      "@clerk/backend",
      "^3.12.0",
    );
    expect(packageJson.peerDependenciesMeta?.["@clerk/backend"]).toEqual({
      optional: true,
    });
    expect(packageJson.exports).toHaveProperty("./auth/clerk");
  });

  it("keeps QuickJS behind an optional executor subpath", () => {
    expect(packageJson.dependencies).not.toHaveProperty("quickjs-emscripten");
    expect(packageJson.peerDependencies).toHaveProperty(
      "quickjs-emscripten",
      "^0.32.0",
    );
    expect(packageJson.peerDependenciesMeta?.["quickjs-emscripten"]).toEqual({
      optional: true,
    });
    expect(packageJson.exports).toHaveProperty("./quickjs");
    expect(
      readFileSync(join(ROOT, "src", "executors", "quickjs.ts"), "utf8"),
    ).toContain('from "node:child_process"');
    expect(readdirSync(join(ROOT, "src", "executors")).sort()).toEqual([
      "quickjs-child.ts",
      "quickjs-protocol.ts",
      "quickjs-runtime.ts",
      "quickjs.ts",
    ]);
  });

  it("publishes every provider independently from the root entry", async () => {
    const providers = readdirSync(join(ROOT, "src", "providers"))
      .filter((file) => file.endsWith(".ts"))
      .sort();
    expect(providers.length).toBeGreaterThan(0);
    const core = await import("../src/index.js");
    for (const file of providers) {
      const name = file.slice(0, -3);
      expect(
        packageJson.exports,
        `src/providers/${file} needs a ./providers/${name} export`,
      ).toHaveProperty(`./providers/${name}`);
      // A runtime specifier: the provider is loaded, not statically linked, so
      // adding one never widens what the root entry pulls in.
      const provider = (await import(
        pathToFileURL(join(ROOT, "src", "providers", file)).href
      )) as Record<string, unknown>;
      for (const symbol of Object.keys(provider)) {
        expect(
          core,
          `core entry re-exports ${symbol} from providers/${name}`,
        ).not.toHaveProperty(symbol);
      }
    }
  });

  it("exports validateToolInput from the core entry", async () => {
    const core = await import("../src/index.js");
    expect(typeof core.validateToolInput).toBe("function");
  });

  it("publishes the JSON Schema validator under an explicit subpath", async () => {
    expect(packageJson.exports).toHaveProperty("./json-schema");
    expect(packageJson.exports?.["./json-schema"]).toEqual({
      types: "./dist/json-schema.d.ts",
      import: "./dist/json-schema.js",
    });
    // The re-export keeps downstream build-time validation off npm hoisting.
    expect(packageJson.dependencies).toHaveProperty("@cfworker/json-schema");
    const { Validator } = await import("../src/json-schema.js");
    expect(typeof Validator).toBe("function");
  });

  // The Cloudflare prebuilt connection is hand-written fetch against the
  // documented v4 REST API. That is a deliberate choice over wrapping the
  // generated `cloudflare` SDK, so the SDK must not appear as a dependency, an
  // optional peer, or a dev dependency — any of the three would make the
  // no-dependency claim in documentation/cloudflare.md untrue.
  it("does not depend on the Cloudflare service API SDK", () => {
    expect(packageJson.dependencies).not.toHaveProperty("cloudflare");
    expect(packageJson.peerDependencies).not.toHaveProperty("cloudflare");
    expect(packageJson.devDependencies).not.toHaveProperty("cloudflare");
  });

  it("keeps the Cloudflare provider free of bare-specifier imports", () => {
    const source = readFileSync(
      join(ROOT, "src", "providers", "cloudflare.ts"),
      "utf8",
    );
    // Every import must be relative: a bare specifier here would be a runtime
    // dependency the package never declares.
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
      expect(match[1], `${match[1]} is not a relative import`).toMatch(/^\./);
    }
  });
});
