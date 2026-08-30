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
    expect(packageJson.engines?.node).toBe(">=22.0.0");
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

  it("exports exactly the documented subpaths plus the manifest", () => {
    // The manifest is a courtesy the ecosystem expects — bundler plugins,
    // framework build steps, and version probes resolve `<pkg>/package.json`
    // to read a field, and an `exports` map without it answers
    // ERR_PACKAGE_PATH_NOT_EXPORTED instead (#374). It resolves to a data
    // file, so it widens nothing: no code path becomes importable, and the
    // root entry's purity boundary is untouched.
    const providers = readdirSync(join(ROOT, "src", "providers"))
      .filter((file) => file.endsWith(".ts"))
      .map((file) => `./providers/${file.slice(0, -3)}`);
    expect(Object.keys(packageJson.exports ?? {}).sort()).toEqual(
      [
        ".",
        "./package.json",
        "./node",
        "./json-schema",
        "./quickjs",
        "./auth/clerk",
        "./auth/cloudflare-access",
        ...providers,
      ].sort(),
    );
    expect(packageJson.exports?.["./package.json"]).toBe("./package.json");
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

  // The rule is about the exports map, not the tarball: `examples/worker`
  // ships — Cloudflare KV and D1 adapters included — because it is the Workers
  // starting template a consumer copies, and nothing under examples/ is
  // importable from the package. AGENTS.md is the canonical instruction file,
  // so a sentence there that reads stricter than the artifact invites the next
  // agent to "fix" the artifact instead of the words (#377).
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
    const rule = readFileSync(join(ROOT, "AGENTS.md"), "utf8")
      .split("\n- **")
      .find((bullet) => bullet.startsWith("The published surface."));
    expect(rule).toBeDefined();
    expect(rule).toContain("examples/worker");
    expect(rule).toContain("exports");
    // The adapters are unimportable reference source, not an absent file.
    expect(rule).not.toMatch(/not the package/);
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

  it("keeps Cloudflare Access dependency-free behind its Worker subpath", () => {
    expect(packageJson.exports).toHaveProperty("./auth/cloudflare-access");
    const source = readFileSync(
      join(ROOT, "src", "auth", "cloudflare-access.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["'][^./]/);
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

  it("keeps the Workers executor an optional peer with a published range", () => {
    // Every Cloudflare deployment installs `@cloudflare/codemode` by hand, and
    // until #376 the only range anywhere in the artifact was a devDependency
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
    for (const doc of [
      join("examples", "worker", "README.md"),
      join("documentation", "operations.md"),
    ]) {
      expect(
        readFileSync(join(ROOT, doc), "utf8"),
        `${doc} does not state the published @cloudflare/codemode range`,
      ).toContain(published);
    }
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
