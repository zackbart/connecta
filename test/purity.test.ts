import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guardrail: the main entry (src/index.ts) must stay Workers-clean. Anything
// node-specific (node: builtins, the listen() adapter, fileStorage) lives only
// behind the "@zackbart/connecta/node" subpath and must NOT be reachable from index.ts.
//
// Kept dependency-free on purpose: it statically walks the relative-import graph
// with regex + fs, no bundler or TS API. node:fs / node:path here in the test
// are fine — the rule applies to src/, not to this file.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "src");
const ENTRY = join(SRC, "index.ts");

const FORBIDDEN_NODE_IMPORT = /\bfrom\s+["']node:/;
const FORBIDDEN_NODE_REQUIRE = /\brequire\(\s*["']node:/;

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
      if (m[1].startsWith(".")) specs.push(m[1]);
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
    const source = readFileSync(file, "utf8");
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
    }
  });

  it("never reaches the node-only modules (node.ts, storage/file.ts)", () => {
    const nodeAdapter = join(SRC, "node.ts");
    const fileStorage = join(SRC, "storage", "file.ts");
    expect(graph.has(nodeAdapter)).toBe(false);
    expect(graph.has(fileStorage)).toBe(false);
  });
});
