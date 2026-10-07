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
      artifact.versionPrefix("a", "view"), artifact.runPrefix("a")]) {
      within(artifactKeys.family, key);
    }
    // A credential sits in its connector's namespace, under a principal when personal.
    expect(credentialKeys.credential("svc")).toBe(`${scopes.connector("svc")}credential:v1`);
    expect(credentialKeys.credential("svc", "owner"))
      .toBe(`${scopes.principal("owner")}${scopes.connector("svc")}credential:v1`);
  });

  it("are the only place source spells a storage key prefix", () => {
    const prefixes = [
      ...KEY_FAMILIES.flatMap((family) => family.prefixes),
      ...SCOPE_PREFIXES,
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.endsWith(join("storage", "keys.ts"))) continue;
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: import("typescript").Node): void => {
        const fragments: string[] = [];
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) fragments.push(node.text);
        if (ts.isTemplateExpression(node)) {
          fragments.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text));
        }
        for (const text of fragments) {
          const match = prefixes.find((prefix) => text.startsWith(prefix) || text.startsWith(`:${prefix}`));
          if (match) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart());
            offenders.push(`${relative(SRC, file)}:${line + 1} spells "${match}"`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(offenders).toEqual([]);
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
