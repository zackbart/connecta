// Node-only: walks the package tree with Node filesystem APIs.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { ConnectaConfig, RemoteMcpOptions } from "../src/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const discoveryModule = new URL("../scripts/providers.mjs", import.meta.url).href;
const { discoverProviders } = (await import(discoveryModule)) as {
  discoverProviders(root: string): Promise<{ name: string; index: string }[]>;
};
const providers = await discoverProviders(ROOT);
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
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
    const ceiling = major > 0 ? [major + 1, 0, 0] : minor > 0 ? [0, minor + 1, 0] : [0, 0, patch + 1];
    return compare(candidate, [major, minor, patch]) >= 0 && compare(candidate, ceiling) < 0;
  });
}

// pnpm-lock.yaml read with two patterns rather than a YAML dependency, for the
// reason above. pnpm 12 writes a leading document that pins pnpm itself; the
// project's lockfile is the last document.
function lockedVersions(name: string): { resolved: string | undefined; locked: string[] } {
  const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8").split(/^---$/m).at(-1) ?? "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const key = name.startsWith("@") ? `'${escaped}'` : escaped;
  // The root importer's entry: `name:` then its `specifier:` and `version:` lines.
  const resolved = new RegExp(`^      ${key}:\\n        specifier: .+\\n        version: ([^(\\s]+)`, "m").exec(
    lock,
  )?.[1];
  // Every package key (`name@version` or `'@scope/name@version(peers)'`).
  const locked = [...lock.matchAll(new RegExp(`^  '?${escaped}@([^(':]+)`, "gm"))].map((match) => match[1]!);
  return { resolved, locked: [...new Set(locked)] };
}

describe("public package boundary", () => {
  it("is configured as a public package that ships built output", () => {
    expectTypeOf<RemoteMcpOptions["headers"]>().toEqualTypeOf<Record<string, string> | undefined>();
    expectTypeOf<NonNullable<ConnectaConfig["classification"]>[string][string]>().toEqualTypeOf<
      "read" | "write" | "hidden"
    >();
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.publishConfig?.access).toBe("public");
    // node:sqlite, behind ./sqlite, is unflagged from Node 22.13.
    expect(packageJson.engines?.node).toBe(">=22.13.0");
    expect(packageJson.files).toEqual(
      expect.arrayContaining(["bin", "dist", "documentation", "templates", "README.md", "LICENSE"]),
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
        "./ui",
        "./credentials",
        "./activity",
        "./auth/access-tokens",
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

  // The rule is about the exports map, not the tarball: `examples/worker`
  // ships because it is the Workers starting template a consumer copies, and
  // nothing under examples/ is importable from the package.
  it("keeps the shipped example adapters out of the importable surface", () => {
    expect(packageJson.files).toContain("examples/worker");
    // `./package.json` is the manifest itself — a data file, not a code path
    // (#374) — so it is the one export that legitimately sits outside dist/.
    const targets = Object.entries(packageJson.exports ?? {})
      .filter(([subpath]) => subpath !== "./package.json")
      .flatMap(([, entry]) => (typeof entry === "string" ? [entry] : Object.values(entry as Record<string, string>)));
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target, `${target} resolves outside dist/`).toMatch(/^\.\/dist\//);
    }
  });

  it("INV-13: keeps Clerk behind an optional adapter subpath", () => {
    expect(packageJson.dependencies).not.toHaveProperty("@clerk/backend");
    expect(packageJson.peerDependencies).toHaveProperty("@clerk/backend", "^3.12.0");
    expect(packageJson.peerDependenciesMeta?.["@clerk/backend"]).toEqual({
      optional: true,
    });
    expect(packageJson.exports).toHaveProperty("./auth/clerk");
  });

  it("INV-13: keeps QuickJS behind an optional executor subpath", () => {
    expect(packageJson.dependencies).not.toHaveProperty("quickjs-emscripten");
    expect(packageJson.peerDependencies).toHaveProperty("quickjs-emscripten", "^0.32.0");
    expect(packageJson.peerDependenciesMeta?.["quickjs-emscripten"]).toEqual({
      optional: true,
    });
    expect(packageJson.exports).toHaveProperty("./quickjs");
    expect(readFileSync(join(ROOT, "src", "executors", "quickjs.ts"), "utf8")).toContain('from "node:child_process"');
    expect(readdirSync(join(ROOT, "src", "executors")).sort()).toEqual([
      "quickjs-child.ts",
      "quickjs-protocol.ts",
      "quickjs-runtime.ts",
      "quickjs.ts",
    ]);
  });

  it("INV-13: keeps Eve outside the core package", () => {
    // The deployment supplies eve; declaring even an optional peer makes pnpm
    // resolve it into every install of this repository.
    for (const field of [packageJson.dependencies, packageJson.devDependencies, packageJson.peerDependencies]) {
      expect(field).not.toHaveProperty("eve");
    }
    expect(packageJson.exports).not.toHaveProperty("./eve");
    expect(packageJson.dependencies).not.toHaveProperty("@zackbart/connecta-eve");
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
    const { resolved } = lockedVersions("@cloudflare/codemode");
    expect(resolved, "@cloudflare/codemode is not in the lockfile").toBeTruthy();
    expect(
      satisfiesCaretRange(resolved ?? "", published ?? ""),
      `locked @cloudflare/codemode ${resolved} is outside the published ` + `peer range ${published}`,
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
      expect(packageJson.exports, `src/providers/${name}/index.ts needs a ./providers/${name} export`).toHaveProperty(
        `./providers/${name}`,
        {
          types: `./dist/providers/${name}/index.d.ts`,
          import: `./dist/providers/${name}/index.js`,
        },
      );
      // A runtime specifier: the provider is loaded, not statically linked, so
      // adding one never widens what the root entry pulls in.
      const provider = (await import(pathToFileURL(index).href)) as Record<string, unknown>;
      for (const symbol of Object.keys(provider)) {
        expect(core, `core entry re-exports ${symbol} from providers/${name}`).not.toHaveProperty(symbol);
      }
    }
  }, 30_000);
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

    it("INV-13: fails on an Effect import in a reachable declaration and names it", () => {
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

  it("pins Effect v4 to one exact version", () => {
    // An exact pin: within the 4.x long-term-support line the http, http-api,
    // schema, and sql area modules still carry `@stability unstable`, so every
    // Effect upgrade is its own deliberate pull request. A deployment that also
    // depends on Effect (Alchemy, for one) must pin this same version to
    // resolve a single copy.
    const pin = packageJson.dependencies?.effect;
    expect(pin, "effect is not a runtime dependency").toBeTruthy();
    expect(pin).toMatch(/^4\.\d+\.\d+$/);
    expect(packageJson.peerDependencies).not.toHaveProperty("effect");
    expect(packageJson.devDependencies).not.toHaveProperty("effect");
    const effect = lockedVersions("effect");
    expect(effect.resolved, "locked effect differs from the pin").toBe(pin);
    expect(effect.locked, "a second copy of effect is locked").toEqual([pin]);
  });
});
