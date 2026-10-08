// Node-only: parses the source tree with the TypeScript compiler to find stray key prefixes.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  accessTokenKeys,
  artifactKeys,
  catalogKeys,
  credentialKeys,
  KEY_FAMILIES,
  oauthConnectKeys,
  oauthHandoffKeys,
  oauthKeys,
  resultKeys,
  scopes,
  stashLedgerKeys,
} from "../src/storage/keys.js";

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const SCOPE_PREFIXES = [
  scopes.principal(""),
  scopes.connector(""),
  scopes.results,
  scopes.subject(""),
];

describe("storage key families", () => {
  it("declare a version, codec, and TTL policy each, under unique names", () => {
    expect(new Set(KEY_FAMILIES.map((family) => family.name)).size).toBe(KEY_FAMILIES.length);
    for (const family of KEY_FAMILIES) {
      expect(family.prefixes.length, family.name).toBeGreaterThan(0);
      expect(Number.isInteger(family.version.number) && family.version.number > 0, family.name).toBe(true);
      expect(["text", "json"]).toContain(family.codec.name);
      if (family.ttl.kind === "fixed") expect(family.ttl.seconds).toBeGreaterThan(0);
      // A durable family is one a deployment cannot recreate; it never expires.
      if (family.durable) expect(family.ttl.kind, family.name).toBe("durable");
      if (family.version.in === "key") {
        for (const prefix of family.prefixes) {
          expect(prefix, family.name).toContain(`v${family.version.number}`);
        }
      }
    }
  });

  it("never claim overlapping keys within one scope", () => {
    for (const scope of ["root", "partition", "connector"] as const) {
      const claimed = KEY_FAMILIES
        .filter((family) => family.scope === scope)
        .flatMap((family) => family.prefixes.map((prefix) => ({ family: family.name, prefix })));
      // Root keys share the root with the scopes core nests inside it.
      if (scope === "root") {
        claimed.push(...SCOPE_PREFIXES.map((prefix) => ({ family: "scope", prefix })));
      }
      for (const a of claimed) {
        for (const b of claimed) {
          if (a === b || a.family === b.family) continue;
          expect(b.prefix.startsWith(a.prefix), `${a.family} ${a.prefix} vs ${b.family} ${b.prefix}`)
            .toBe(false);
        }
      }
    }
  });

  it("build keys inside the prefixes their families declare", () => {
    const within = (family: { prefixes: readonly string[] }, key: string) =>
      expect(family.prefixes.some((prefix) => key.startsWith(prefix)), key).toBe(true);
    within(resultKeys.family, resultKeys.chunk("id", 0));
    within(resultKeys.family, resultKeys.chunk("id", 3));
    within(stashLedgerKeys.family, stashLedgerKeys.ledger);
    within(catalogKeys.family, catalogKeys.manifest("svc"));
    within(catalogKeys.family, catalogKeys.chunk("svc", "rev", 1));
    within(oauthHandoffKeys.family, oauthHandoffKeys.handoff("svc", "hash"));
    within(accessTokenKeys.family, accessTokenKeys.record("id"));
    within(accessTokenKeys.family, accessTokenKeys.lookup("hash"));
    within(accessTokenKeys.family, accessTokenKeys.active);
    within(oauthConnectKeys.family, oauthConnectKeys.used("nonce"));
    within(oauthKeys.family, oauthKeys.generation);
    within(oauthKeys.family, oauthKeys.value(oauthKeys.field.tokens, "v2:epoch"));
    within(oauthKeys.family, oauthKeys.cleanup("v2:epoch"));
    within(oauthKeys.family, oauthKeys.cleanupAt("v2:epoch"));
    const artifact = artifactKeys.under("artifact:");
    for (const key of [artifact.head("a"), artifact.blob("b"), artifact.scanCursor,
      artifact.versionPrefix("a", "view"), artifact.runPrefix("a"), artifact.run("a", "0", "r")]) {
      within(artifactKeys.family, key);
    }
    expect(artifact.run("a", "0", "r").startsWith(artifact.runPrefix("a"))).toBe(true);
    // A credential sits in its connector's namespace, under a principal when personal.
    expect(credentialKeys.credential("svc")).toBe(`${scopes.connector("svc")}credential:v1`);
    expect(credentialKeys.credential("svc", "owner"))
      .toBe(`${scopes.principal("owner")}${scopes.connector("svc")}credential:v1`);
  });

  it("are the only place source spells a storage key prefix", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.endsWith(join("storage", "keys.ts")))
      .flatMap((file) => strayKeys(relative(SRC, file), readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("rejects NUL in every unencoded key component, including identity scopes", () => {
    const bad = "a\0b";
    const artifact = artifactKeys.under("artifact:");
    const builders = [
      () => scopes.principal(bad),
      () => scopes.subject(bad),
      () => scopes.connector(bad),
      () => resultKeys.chunk(bad, 0),
      () => resultKeys.chunk(bad, 1),
      () => catalogKeys.manifest(bad),
      () => catalogKeys.chunk(bad, "rev", 1),
      () => catalogKeys.chunk("svc", bad, 1),
      () => oauthHandoffKeys.handoff(bad, "hash"),
      () => oauthHandoffKeys.handoff("svc", bad),
      () => accessTokenKeys.record(bad),
      () => accessTokenKeys.lookup(bad),
      () => credentialKeys.credential(bad),
      () => credentialKeys.credential("svc", bad),
      () => artifactKeys.under(bad),
      () => artifact.head(bad),
      () => artifact.versionPrefix(bad, "view"),
      () => artifact.versionPrefix("id", bad),
      () => artifact.runPrefix(bad),
      () => artifact.run(bad, "0", "run"),
      () => artifact.run("id", bad, "run"),
      () => artifact.run("id", "0", bad),
      () => artifact.blob(bad),
      () => oauthKeys.value(oauthKeys.field.tokens, bad),
      () => oauthConnectKeys.used(bad),
    ];
    for (const build of builders) {
      expect(build).toThrow(/U\+0000 \(NUL\)/);
    }
    // These existing builders encode the component, so NUL remains safe and
    // distinct from a literal percent escape without changing their layout.
    expect(oauthKeys.cleanup(bad)).toBe("oauth:cleanup:a%00b");
    expect(oauthKeys.cleanupAt(bad)).toBe("oauth:cleanup-at:a%00b");
    expect(oauthKeys.cleanup("a%00b")).not.toBe(oauthKeys.cleanup(bad));
  });

  it.each([
    ["a split prefix", `storage.set("result" + ":" + id, value);`],
    ["a prefix in pieces outside a call", `const key = "res" + "ult:" + id;`],
    ["a template of constants", "const key = `${\"result\"}:${id}`;"],
    ["a prefix held in a constant", `const P = "result"; const key = \`\${P}:\${id}\`;`],
    ["a scope prefix after a variable", `kv.get(partition + "principal:" + id);`],
    ["a literal key at a storage call", `storage.get("cursor");`],
    ["a literal in a computed key", `this.opts.storage.delete(\`\${id}:cursor\`);`],
    ["a literal reached through a constant", `const key = "cursor:" + id; await storageSet(key, value);`],
  ])("refuse %s", (_, code) => {
    expect(strayKeys("fixture.ts", code)).not.toEqual([]);
  });

  it.each([
    ["a family builder", `storage.get(resultKeys.chunk(id, 0));`],
    ["a namespaced pass-through", `storage.set(prefix + key, value);`],
    ["a builder through a constant", `const key = stashLedgerKeys.ledger; storageGet(key);`],
    ["a literal on something that is not storage", `cache.get("result");`],
    ["an unrelated string", `const label = "results" + " page";`],
    ["a parameter sharing a constant's name", `const get = (key) => kv.get(key); const put = () => { const key = "x:" + id; };`],
  ])("accept %s", (_, code) => {
    expect(strayKeys("fixture.ts", code)).toEqual([]);
  });
});

const PREFIXES = [
  ...KEY_FAMILIES.flatMap((family) => family.prefixes),
  ...SCOPE_PREFIXES,
];
/** Storage operations whose first argument is a key. */
const KEY_METHODS = new Set(["get", "set", "delete", "list", "compareAndSet"]);
const KEY_HELPERS = new Set(["storageGet", "storageSet", "storageDelete", "storageCompareAndSet"]);
/** A receiver that is a KVStorage by the names source gives one. */
const STORAGE_RECEIVER = /(?:storage|^kv)$/i;

/**
 * Where one file spells a key outside `src/storage/keys.ts`. Two rules, both
 * lint-level, on constant text after folding `+`, template literals, and
 * identifiers bound once to a constant in the same file:
 *
 * - no run of constant text anywhere starts with a family or scope prefix;
 * - a key passed to a storage operation holds no constant text at all, so
 *   every spelled key comes from a family builder.
 */
function strayKeys(name: string, text: string): string[] {
  type Node = import("typescript").Node;
  type Expression = import("typescript").Expression;
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  // A name bound more than once in a file, as a variable or a parameter, is
  // in more than one scope; only a name bound once, to a constant, resolves.
  const declared = new Map<string, Expression | null>();
  const collect = (node: Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) {
      const constant = ts.isVariableDeclaration(node) && node.initializer &&
        ts.isVariableDeclarationList(node.parent) && node.parent.flags & ts.NodeFlags.Const;
      declared.set(node.name.text,
        declared.has(node.name.text) || !constant ? null : node.initializer ?? null);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  // An expression as pieces: constant text, or null where a value is unknown.
  const pieces = (node: Expression, seen = new Set<string>()): (string | null)[] => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isParenthesizedExpression(node)) return pieces(node.expression, seen);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return [...pieces(node.left, seen), ...pieces(node.right, seen)];
    }
    if (ts.isTemplateExpression(node)) {
      return [node.head.text, ...node.templateSpans.flatMap((span) =>
        [...pieces(span.expression, seen), span.literal.text])];
    }
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const bound = declared.get(node.text);
      if (bound) return pieces(bound, new Set(seen).add(node.text));
    }
    return [null];
  };
  const runs = (node: Expression): string[] =>
    pieces(node).reduce<string[]>((all, piece) => {
      if (piece === null) all.push("");
      else all[all.length - 1] += piece;
      return all;
    }, [""]).filter(Boolean);

  const offenders: string[] = [];
  const report = (node: Node, problem: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    offenders.push(`${name}:${line + 1} ${problem}`);
  };
  const visit = (node: Node): void => {
    // Outermost string expressions only: a nested one is part of its parent's runs.
    const parent = node.parent as Node | undefined;
    const nested = parent !== undefined && (ts.isParenthesizedExpression(parent) ||
      ts.isTemplateSpan(parent) ||
      (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken));
    if (!nested && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node) ||
      (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken))) {
      for (const run of runs(node)) {
        const match = PREFIXES.find((prefix) => run.startsWith(prefix) || run.startsWith(`:${prefix}`));
        if (match) report(node, `spells "${match}"`);
      }
    }
    if (ts.isCallExpression(node) && node.arguments[0] && isStorageCall(node.expression)) {
      const key = node.arguments[0];
      if (runs(key).length > 0) report(key, "passes a key spelled outside storage/keys.ts");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offenders;
}

function isStorageCall(callee: import("typescript").Expression): boolean {
  if (ts.isIdentifier(callee)) return KEY_HELPERS.has(callee.text);
  if (!ts.isPropertyAccessExpression(callee) || !KEY_METHODS.has(callee.name.text)) return false;
  const receiver = callee.expression;
  const last = ts.isPropertyAccessExpression(receiver) ? receiver.name.text
    : ts.isIdentifier(receiver) ? receiver.text
    : undefined;
  return last !== undefined && STORAGE_RECEIVER.test(last);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
