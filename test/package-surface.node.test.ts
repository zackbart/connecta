// Node-only: walks the package tree with Node filesystem APIs.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const discoveryModule = new URL("../scripts/providers.mjs", import.meta.url).href;
const { discoverProviders } = await import(discoveryModule) as {
  discoverProviders(root: string): Promise<{ name: string; index: string }[]>;
};
const providers = await discoverProviders(ROOT);
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

// Enough semver to answer "is this version inside this caret range", which is
// the only shape the manifest's peer ranges use. Pulling `semver` in to ask a
// one-line question would put a dependency in the gate that guards the
// dependency list.
function satisfiesCaretRange(version: string, range: string): boolean {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    if (!match) throw new Error(`Unparseable semver: ${value}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  };
  const compare = (left: readonly number[], right: readonly number[]) => {
    for (let index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) {
        return (left[index] ?? 0) < (right[index] ?? 0) ? -1 : 1;
      }
    }
    return 0;
  };
  const candidate = parse(version);
  return range.split("||").some((arm) => {
    const trimmed = arm.trim();
    if (!trimmed.startsWith("^")) {
      throw new Error(`Only caret ranges are supported here: ${trimmed}`);
    }
    const [major, minor, patch] = parse(trimmed.slice(1));
    // Caret on a 0.x line only widens the rightmost non-zero component.
    const ceiling =
      major > 0
        ? [major + 1, 0, 0]
        : minor > 0
          ? [0, minor + 1, 0]
          : [0, 0, patch + 1];
    return (
      compare(candidate, [major, minor, patch]) >= 0 &&
      compare(candidate, ceiling) < 0
    );
  });
}

describe("public package boundary", () => {
  it("is configured as a public package that ships built output", () => {
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.publishConfig?.access).toBe("public");
    // node:sqlite, behind ./sqlite, is unflagged from Node 22.13.
    expect(packageJson.engines?.node).toBe(">=22.13.0");
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
    // No code export resolves outside dist/ — the manifest data export
    // (`./package.json`, #374) is the one exception, and it ships anyway — so
    // src/ only ever fed the source and declaration maps, and both were
    // retired with it (#346).
    // assets/ is the README hero image, which npmjs.com renders straight from
    // the repository. Neither belongs in every install.
    expect(packageJson.files).not.toContain("src");
    expect(packageJson.files).not.toContain("assets");
  });

  it("keeps repository agent instructions and decision history out of the package", () => {
    for (const file of ["AGENTS.md", "CLAUDE.md", "PRINCIPLES.md", "decisions", "spec"]) {
      expect(packageJson.files).not.toContain(file);
    }
  });

  it("exports exactly the documented subpaths plus the manifest", () => {
    // The manifest is a courtesy the ecosystem expects — bundler plugins,
    // framework build steps, and version probes resolve `<pkg>/package.json`
    // to read a field, and an `exports` map without it answers
    // ERR_PACKAGE_PATH_NOT_EXPORTED instead (#374). It resolves to a data
    // file, so it widens nothing: no code path becomes importable, and the
    // root entry's purity boundary is untouched.
    const providerExports = providers.map(({ name }) => `./providers/${name}`);
    expect(Object.keys(packageJson.exports ?? {}).sort()).toEqual(
      [
        ".",
        "./ui", "./credentials", "./activity", "./auth/access-tokens",
        "./package.json",
        "./node",
        "./sqlite",
        "./d1",
        "./json-schema",
        "./quickjs",
        "./worker",
        "./auth/clerk",
        "./auth/cloudflare-access",
        ...providerExports,
      ].sort(),
    );
    expect(packageJson.exports?.["./package.json"]).toBe("./package.json");
  });

  it("ships only generic connector factories and their shared machinery", () => {
    // guarded-fetch.ts is transport, not a third authoring path: it knows no
    // provider, and a provider-named file here would still be a failure.
    // api-connector.ts is api() itself without its OAuth grant, split so the
    // providers do not carry machinery they never use.
    // option-shapes.ts holds the closed option shapes those factories and the
    // providers walk for unknown keys; it builds nothing.
    // negotiation-cache.ts stores redacted protocol verdicts, without a client.
    // resource-uri.ts matches advertised templates without fetching any URI.
    expect(readdirSync(join(ROOT, "src", "connectors")).sort()).toEqual([
      "api-connector.ts",
      "api.ts",
      "guarded-fetch.ts",
      "negotiation-cache.ts",
      "option-shapes.ts",
      "remote-mcp.ts",
      "resource-uri.ts",
    ]);
  });

  it("ships one SQL store with two drivers and no other storage backend", () => {
    // The shared core, the key families, and the in-memory default. The two
    // drivers are the /d1 and /sqlite subpaths; no KV or file store remains.
    expect(readdirSync(join(ROOT, "src", "storage")).sort()).toEqual([
      "keys.ts",
      "memory.ts",
      "sql.ts",
    ]);
    expect(packageJson.exports?.["./d1"]).toEqual({ types: "./dist/d1.d.ts", import: "./dist/d1.js" });
    expect(packageJson.exports?.["./sqlite"]).toEqual({ types: "./dist/sqlite.d.ts", import: "./dist/sqlite.js" });
    expect(readdirSync(join(ROOT, "examples", "worker", "src")).sort()).toEqual([
      "connecta.config.ts",
      "index.ts",
    ]);
  });

  // The rule is about the exports map, not the tarball: `examples/worker`
  // ships because it is the Workers starting template a consumer copies, and
  // nothing under examples/ is importable from the package.
  it("keeps the shipped example adapters out of the importable surface", () => {
    expect(packageJson.files).toContain("examples/worker");
    // `./package.json` is the manifest itself — a data file, not a code path
    // (#374) — so it is the one export that legitimately sits outside dist/.
    const targets = Object.entries(packageJson.exports ?? {})
      .filter(([subpath]) => subpath !== "./package.json")
      .flatMap(([, entry]) =>
        typeof entry === "string"
          ? [entry]
          : Object.values(entry as Record<string, string>),
      );
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target, `${target} resolves outside dist/`).toMatch(/^\.\/dist\//);
    }

  });

  it("INV-13: keeps Clerk behind an optional adapter subpath", () => {
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

  it("keeps Cloudflare Access dependency-free behind its Worker subpath", () => {
    expect(packageJson.exports).toHaveProperty("./auth/cloudflare-access");
    const source = readFileSync(
      join(ROOT, "src", "auth", "cloudflare-access.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["'][^./]/);
  });

  it("INV-13: keeps QuickJS behind an optional executor subpath", () => {
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

  it("INV-13: keeps the Workers executor an optional peer with a published range", () => {
    // Every Cloudflare deployment installs `@cloudflare/codemode` by hand, and
    // until #376 the only range anywhere in the package was a devDependency
    // nobody who installs the package can read. A declared optional peer makes
    // npm answer the question — silence when the version is one this release
    // supports, an ERESOLVE the consumer can act on when it is not — while the
    // optional flag keeps it out of a default install exactly like the other
    // two heavyweight peers.
    expect(packageJson.dependencies).not.toHaveProperty("@cloudflare/codemode");
    expect(packageJson.peerDependenciesMeta?.["@cloudflare/codemode"]).toEqual({
      optional: true,
    });
    const published = packageJson.peerDependencies?.["@cloudflare/codemode"];
    expect(published).toBeTruthy();
    // A published range the repository does not develop against is a claim
    // nothing checks, so the dev pin must be one of the range's own arms: the
    // two cannot drift without this line failing.
    const arms = (published ?? "").split("||").map((arm) => arm.trim());
    expect(arms).toContain(packageJson.devDependencies?.["@cloudflare/codemode"]);
    // …and the version actually resolved has to sit inside it, which is the
    // half a range string cannot state on its own.
    const lock = JSON.parse(
      readFileSync(join(ROOT, "package-lock.json"), "utf8"),
    ) as { packages?: Record<string, { version?: string }> };
    const resolved = lock.packages?.["node_modules/@cloudflare/codemode"]
      ?.version;
    expect(resolved, "@cloudflare/codemode is not in the lockfile").toBeTruthy();
    expect(
      satisfiesCaretRange(resolved ?? "", published ?? ""),
      `locked @cloudflare/codemode ${resolved} is outside the published ` +
        `peer range ${published}`,
    ).toBe(true);
    // A range in the manifest and a different one in the prose a deployment
    // follows is the same drift one file over.
    const doc = join("examples", "worker", "README.md");
    expect(
      readFileSync(join(ROOT, doc), "utf8"),
      `${doc} does not state the published @cloudflare/codemode range`,
    ).toContain(published);
  });

  // Transforms and loads every provider module cold: CPU-bound, with no timing
  // behavior. On a loaded host that outran the 5s default, so the budget here
  // is only a hang guard.
  it("publishes every provider independently from the root entry", async () => {
    expect(providers.length).toBeGreaterThan(0);
    const core = await import("../src/index.js");
    for (const { name, index } of providers) {
      expect(
        packageJson.exports,
        `src/providers/${name}/index.ts needs a ./providers/${name} export`,
      ).toHaveProperty(`./providers/${name}`, {
        types: `./dist/providers/${name}/index.d.ts`,
        import: `./dist/providers/${name}/index.js`,
      });
      // A runtime specifier: the provider is loaded, not statically linked, so
      // adding one never widens what the root entry pulls in.
      const provider = (await import(
        pathToFileURL(index).href
      )) as Record<string, unknown>;
      for (const symbol of Object.keys(provider)) {
        expect(
          core,
          `core entry re-exports ${symbol} from providers/${name}`,
        ).not.toHaveProperty(symbol);
      }
    }
  }, 30_000);

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
  // optional peer, or a dev dependency — any of the three would reintroduce the
  // install weight the hand-written surface exists to avoid.
  it("does not depend on the Cloudflare service API SDK", () => {
    expect(packageJson.dependencies).not.toHaveProperty("cloudflare");
    expect(packageJson.peerDependencies).not.toHaveProperty("cloudflare");
    expect(packageJson.devDependencies).not.toHaveProperty("cloudflare");
  });

  it("keeps the Cloudflare provider free of bare-specifier imports", () => {
    const source = readFileSync(
      join(ROOT, "src", "providers", "cloudflare", "index.ts"),
      "utf8",
    );
    // Every import must be relative: a bare specifier here would be a runtime
    // dependency the package never declares.
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
      expect(match[1], `${match[1]} is not a relative import`).toMatch(/^\./);
    }
  });

  it("keeps the Planning Center provider free of bare-specifier imports", () => {
    const source = readFileSync(
      join(ROOT, "src", "providers", "planning-center", "index.ts"),
      "utf8",
    );
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
      expect(match[1], `${match[1]} is not a relative import`).toMatch(/^\./);
    }
  });

  it("keeps the Vercel provider dependency-free and out of the root entry", () => {
    expect(packageJson.dependencies).not.toHaveProperty("@vercel/sdk");
    expect(packageJson.peerDependencies).not.toHaveProperty("@vercel/sdk");
    expect(packageJson.devDependencies).not.toHaveProperty("@vercel/sdk");
    const source = readFileSync(
      join(ROOT, "src", "providers", "vercel", "index.ts"),
      "utf8",
    );
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
      expect(match[1], `${match[1]} is not a relative import`).toMatch(/^\./);
    }
  });

  it("keeps the CCB provider dependency-free and out of the root entry", () => {
    // Its OAuth grant is core's `api()` machinery, not an OAuth client library.
    const source = readFileSync(
      join(ROOT, "src", "providers", "ccb", "index.ts"),
      "utf8",
    );
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
      expect(match[1], `${match[1]} is not a relative import`).toMatch(/^\./);
    }
  });

  it("keeps the Overflow provider dependency-free and behind its own subpath", () => {
    expect(packageJson.exports).toHaveProperty("./providers/overflow");
    const source = readFileSync(
      join(ROOT, "src", "providers", "overflow", "index.ts"),
      "utf8",
    );
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
      expect(match[1], `${match[1]} is not a relative import`).toMatch(/^\./);
    }
  });

  it("keeps the Tithe.ly provider dependency-free", () => {
    const source = readFileSync(
      join(ROOT, "src", "providers", "tithely", "index.ts"),
      "utf8",
    );
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
      expect(match[1], `${match[1]} is not a relative import`).toMatch(/^\./);
    }
  });

  // Breeze has no SDK worth wrapping and gets none: its API is keyed GETs
  // against one church's host, so the provider stays Web-API fetch.
  it("keeps the Breeze provider dependency-free and out of the root entry", () => {
    const source = readFileSync(
      join(ROOT, "src", "providers", "breeze", "index.ts"),
      "utf8",
    );
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
      expect(match[1], `${match[1]} is not a relative import`).toMatch(/^\./);
    }
    expect(source).not.toContain("remote-mcp");
  });

  // Delegated Workspace access signs its own RS256 assertions with Web Crypto
  // (#678): no Google auth library, no OAuth client, no MCP SDK. The shared
  // layer under providers/_shared/google/ is imported, never exported.
  it("keeps the Workspace providers and their shared layer dependency-free", () => {
    for (const file of [
      join(ROOT, "src", "providers", "gmail", "index.ts"),
      join(ROOT, "src", "providers", "drive", "index.ts"),
      join(ROOT, "src", "providers", "docs", "index.ts"),
      join(ROOT, "src", "providers", "sheets", "index.ts"),
      join(ROOT, "src", "providers", "slides", "index.ts"),
      join(ROOT, "src", "providers", "forms", "index.ts"),
      ...readdirSync(join(ROOT, "src", "providers", "_shared", "google")).map((name) =>
        join(ROOT, "src", "providers", "_shared", "google", name),
      ),
    ]) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
        expect(match[1], `${file}: ${match[1]} is not a relative import`).toMatch(/^\./);
        expect(match[1]).not.toMatch(/remote-mcp|static-oauth|downstream-oauth/);
      }
    }
    expect(Object.keys(packageJson.exports ?? {}).some((key) => key.includes("google"))).toBe(false);
  });
});

// Effect is the core's implementation and must never become its API: a
// published declaration that names an Effect type turns every Effect upgrade
// into a breaking change for deployments that never chose Effect. These run
// the same checker the build and the tarball smoke use.
describe("Effect behind the published surface", () => {
  const checker = join(ROOT, "scripts", "check-declarations.mjs");
  const runChecker = (args: string[]) =>
    spawnSync(process.execPath, [checker, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });

  it("INV-13: publishes no Effect type in any reachable declaration", () => {
    const result = runChecker([]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no Effect types");
  }, 60_000);

  describe("a checker that can fail", () => {
    const fixture = (files: Record<string, string>) => {
      const dir = mkdtempSync(join(tmpdir(), "connecta-declarations-"));
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "fixture",
          exports: {
            ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
          },
        }),
      );
      mkdirSync(join(dir, "dist"));
      for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(dir, "dist", name), text);
      }
      return dir;
    };

    it("fails on an Effect import in a reachable declaration and names it", () => {
      const dir = fixture({
        "index.d.ts":
          'export { thing } from "./thing.js";\n' +
          'import type { Effect } from "effect";\n' +
          "export declare const run: Effect.Effect<void>;\n",
        "thing.d.ts": "export declare const thing: number;\n",
      });
      try {
        const result = runChecker(["--dist", dir]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("dist/index.d.ts:2");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    it("fails on a declaration no exports target reaches", () => {
      const dir = fixture({
        "index.d.ts": "export declare const value: number;\n",
        "orphan.d.ts": "export declare const internal: string;\n",
      });
      try {
        const result = runChecker(["--dist", dir]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("dist/orphan.d.ts: orphan declaration");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  });

  it("depends on stable Effect v4 through a compatible range", () => {
    // A caret range: the root import graph uses only the stable `effect`
    // module (test/purity.test.ts), so a v4 minor cannot break it, and
    // a deployment that also uses Effect (Alchemy, for one) dedupes to a
    // single copy instead of installing a second beside an exact pin.
    // Adopting an unstable subpath, or a new major, is its own pull request.
    const range = packageJson.dependencies?.effect;
    expect(range, "effect is not a runtime dependency").toBeTruthy();
    expect(range).toMatch(/^\^4\.\d+\.\d+$/);
    expect(packageJson.peerDependencies).not.toHaveProperty("effect");
    expect(packageJson.devDependencies).not.toHaveProperty("effect");
    const lock = JSON.parse(
      readFileSync(join(ROOT, "package-lock.json"), "utf8"),
    ) as { packages?: Record<string, { version?: string }> };
    const locked = lock.packages?.["node_modules/effect"]?.version ?? "";
    const [floorMinor = 0, floorPatch = 0] = range!.slice(3).split(".").map(Number);
    const [major, minor = 0, patch = 0] = locked.split(".").map(Number);
    expect(major, `locked effect ${locked}`).toBe(4);
    expect(minor * 1e6 + patch, `locked effect ${locked} is below ${range}`)
      .toBeGreaterThanOrEqual(floorMinor * 1e6 + floorPatch);
    const nested = Object.keys(lock.packages ?? {}).filter((path) =>
      path.endsWith("/node_modules/effect"),
    );
    expect(nested, "a second copy of effect is locked").toEqual([]);
  });

  it("declares exactly the core runtime dependencies", () => {
    // Meta-tool inputs stay Zod: the measured Effect Schema conversion cost
    // more bytes without clarifying validation. See architecture.md.
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([
      "@cfworker/json-schema",
      "@modelcontextprotocol/client",
      "@modelcontextprotocol/server",
      "acorn",
      "effect",
      "zod",
    ]);
  });
});
