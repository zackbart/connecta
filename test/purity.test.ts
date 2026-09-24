import ts from "typescript";
import { required } from "./helpers.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKERS_SUITES } from "../vitest.config.js";

// Guardrail: the main entry (src/index.ts) must stay Workers-clean and free of
// optional adapters. Node-only code and provider-specific auth integrations live
// behind explicit package subpaths and must NOT be reachable from index.ts.
//
// Kept dependency-free on purpose: it statically walks the relative-import graph
// with regex + fs, no bundler or TS API. node:fs / node:path here in the test
// are fine — the rule applies to src/, not to this file.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "src");
const ENTRY = join(SRC, "index.ts");

const FORBIDDEN_NODE_IMPORT = /\bfrom\s+["']node:/;
const FORBIDDEN_NODE_REQUIRE = /\brequire\(\s*["']node:/;
// A dynamic import is the one way a node: builtin can reach the Workers-clean
// entry without matching either pattern above.
const FORBIDDEN_NODE_DYNAMIC_IMPORT = /\bimport\(\s*["']node:/;

/** Extract relative import/export specifiers (the `"./x.js"` in `from "./x.js"`). */
function relativeSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g, // import ... from "x"; export ... from "x"
    /\bimport\s+["']([^"']+)["']/g, // bare side-effect import "x"
    /\bimport\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("x")
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      if (required(m[1]).startsWith(".")) specs.push(required(m[1]));
    }
  }
  return specs;
}

/** Resolve an ESM specifier (`./x.js`) to its on-disk TypeScript source. */
function resolveToTs(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec);
  const candidates = base.endsWith(".js")
    ? [base.slice(0, -3) + ".ts"]
    : [base + ".ts", join(base, "index.ts"), base];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`Cannot resolve "${spec}" imported from ${fromFile}`);
}

/** BFS over the relative-import graph starting at `entry`. */
function importGraph(entry: string): Set<string> {
  const visited = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
    for (const spec of relativeSpecifiers(source)) {
      const target = resolveToTs(file, spec);
      if (!visited.has(target)) queue.push(target);
    }
  }
  return visited;
}

describe("src/index.ts import purity (Workers-clean entry)", () => {
  const graph = importGraph(ENTRY);

  it("reaches a non-trivial graph rooted at index.ts", () => {
    expect(graph.has(ENTRY)).toBe(true);
    expect(graph.size).toBeGreaterThan(1);
  });

  it("contains no `node:` builtin imports or requires", () => {
    for (const file of graph) {
      const source = readFileSync(file, "utf8");
      expect(
        FORBIDDEN_NODE_IMPORT.test(source),
        `${file} imports a node: builtin`,
      ).toBe(false);
      expect(
        FORBIDDEN_NODE_REQUIRE.test(source),
        `${file} requires a node: builtin`,
      ).toBe(false);
      expect(
        FORBIDDEN_NODE_DYNAMIC_IMPORT.test(source),
        `${file} dynamically imports a node: builtin`,
      ).toBe(false);
    }
  });

  it("never reaches node-only modules or optional auth adapters", () => {
    const nodeAdapter = join(SRC, "node.ts");
    const fileStorage = join(SRC, "storage", "file.ts");
    const quickJsExecutor = join(SRC, "executors", "quickjs.ts");
    const quickJsChild = join(SRC, "executors", "quickjs-child.ts");
    const clerkAdapter = join(SRC, "auth", "clerk.ts");
    expect(graph.has(nodeAdapter)).toBe(false);
    expect(graph.has(fileStorage)).toBe(false);
    expect(graph.has(quickJsExecutor)).toBe(false);
    expect(graph.has(quickJsChild)).toBe(false);
    expect(graph.has(clerkAdapter)).toBe(false);
    for (const file of ["ui.ts", "operator-ui/generated.ts", "credentials.ts", "activity.ts", "auth/bearer.ts", "artifacts.ts"]) expect(graph.has(join(SRC, file)), file).toBe(false);
    const withUi = importGraph(join(SRC, "ui.ts"));
    for (const file of ["credentials.ts", "activity.ts", "routes/activity.ts", "artifacts.ts"]) expect(withUi.has(join(SRC, file)), `UI imports ${file}`).toBe(false);
    // The artifacts module is one subpath: nothing of it rides the root entry,
    // and the operator UI reaches artifact pages only through their JSON API.
    const artifactFiles = readdirSync(join(SRC, "artifacts")).filter((file) => file.endsWith(".ts"));
    expect(artifactFiles.length).toBeGreaterThan(0);
    for (const file of artifactFiles) {
      expect(graph.has(join(SRC, "artifacts", file)), `root reaches artifacts/${file}`).toBe(false);
      expect(withUi.has(join(SRC, "artifacts", file)), `UI imports artifacts/${file}`).toBe(false);
    }
  });

  it("never imports this package by its own name", () => {
    // tsconfig.json maps `@zackbart/connecta` to src/index.ts so a suite can
    // typecheck template code that imports the package the way a deployment
    // does. Inside src/ that specifier would be a cycle through the public
    // entry, invisible to the relative-import walk above and resolvable only
    // because of that mapping — so it is banned here rather than left to
    // taste.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith(".ts") ? [full] : [];
      });
    // Import positions only: the name also appears in doc comments and in
    // error messages that tell a deployment which subpath to reach for.
    const selfImports = [
      /^\s*(?:import|export)[^;]*?["']@zackbart\/connecta/m,
      /\bimport\(\s*["']@zackbart\/connecta/,
    ];
    for (const file of walk(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const pattern of selfImports) {
        expect(
          pattern.test(source),
          `${file} imports @zackbart/connecta instead of a relative path`,
        ).toBe(false);
      }
    }
  });

  it("never reaches a prebuilt provider connection", () => {
    // Derived from the directory: a provider added without its own subpath
    // fails here rather than silently riding the root entry.
    const providers = readdirSync(join(SRC, "providers")).filter((file) =>
      file.endsWith(".ts"),
    );
    expect(providers.length).toBeGreaterThan(0);
    for (const file of providers) {
      const provider = join(SRC, "providers", file);
      expect(graph.has(provider), `${file} is reachable from index.ts`).toBe(
        false,
      );
    }
  });
});

// Effect is the core's implementation, never its API, and never a license to
// run fibers from anywhere. These walks hold the lines the Promise edge
// (src/runtime/run.ts) depends on; see ethos.md's Effect decision.

const ROOT = resolve(SRC, "..");
const RUNNER = join(SRC, "runtime", "run.ts");
// The root entry may import Effect's stable core and nothing else: the
// `effect/unstable/*` modules are allowed behind subpaths, where their minor-
// release churn and their bytes are opt-in.
const ROOT_EFFECT_ALLOWED = new Set(["effect"]);
// Test clocks, test layers, and platform runtimes belong to a test run or a
// specific host, never to a runtime graph that ships to both Node and Workers.
const FORBIDDEN_EFFECT_PACKAGES = [
  /^effect\/testing(?:\/|$)/,
  /^@effect\/vitest(?:\/|$)/,
  /^@effect\/platform-(?:node|bun|node-shared)(?:\/|$)/,
];
// Only the edge runner may start a fiber. Anything else that does escapes the
// caller's signal, the microtask scheduler, and the error mapping, and on
// Workers a daemon fiber outlives the request that owns it.
const FIBER_STARTERS = [
  /\bEffect\.run(?:Promise|Sync|Fork|Callback)/,
  /\brunFork\b/,
  /\bforkDaemon\b/,
  /\bManagedRuntime\.make/,
];

/** Every module specifier a source file names, type-only imports included. */
function allSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const re of [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of source.matchAll(re)) specs.push(required(match[1]));
  }
  return specs;
}

const isEffectSpecifier = (spec: string) =>
  /^effect(?:\/|$)/.test(spec) || spec.startsWith("@effect/");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** The source with comments removed, so prose about a rule never trips it. */
function codeOnly(file: string): string {
  return ts.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      removeComments: true,
    },
  }).outputText;
}

/** Relative-import closure over test and source files, type imports included. */
function testGraph(entry: string): Set<string> {
  const visited = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const spec of allSpecifiers(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const base = resolve(dirname(file), spec);
      const stem = base.replace(/\.js$/, "");
      const target = [`${stem}.ts`, `${stem}.tsx`, join(base, "index.ts"), base]
        .find((candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate));
      if (target && !visited.has(target)) queue.push(target);
    }
  }
  return visited;
}

describe("Effect boundaries", () => {
  const everySource = sourceFiles(SRC);

  it("keeps test and platform-runtime Effect packages out of src/", () => {
    for (const file of everySource) {
      for (const spec of allSpecifiers(readFileSync(file, "utf8"))) {
        for (const pattern of FORBIDDEN_EFFECT_PACKAGES) {
          expect(pattern.test(spec), `${file} imports ${spec}`).toBe(false);
        }
      }
    }
  });

  it("lets the root entry reach only Effect's stable core", () => {
    const graph = importGraph(ENTRY);
    for (const file of graph) {
      for (const spec of allSpecifiers(readFileSync(file, "utf8"))) {
        if (!isEffectSpecifier(spec)) continue;
        expect(
          ROOT_EFFECT_ALLOWED.has(spec),
          `${file} is reachable from index.ts and imports ${spec}`,
        ).toBe(true);
      }
    }
  });

  it("starts fibers only in the edge runner", () => {
    expect(existsSync(RUNNER)).toBe(true);
    for (const file of everySource) {
      if (file === RUNNER) continue;
      const code = codeOnly(file);
      for (const pattern of FIBER_STARTERS) {
        expect(pattern.test(code), `${file} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("never logs through Effect's logger", () => {
    // Logging goes through the configured Logger, which is what honors
    // `logger: "silent"` and keeps the line format a deployment greps for.
    for (const file of everySource) {
      expect(/\bEffect\.log/.test(codeOnly(file)), `${file} calls Effect.log*`)
        .toBe(false);
    }
  });

  it("keeps effect/testing out of every suite the Workers project runs", () => {
    for (const suite of WORKERS_SUITES) {
      for (const file of testGraph(join(ROOT, suite))) {
        for (const spec of allSpecifiers(readFileSync(file, "utf8"))) {
          expect(
            /^effect\/testing(?:\/|$)/.test(spec),
            `${file} (reached from ${suite}) imports ${spec}`,
          ).toBe(false);
        }
      }
    }
  });
});
