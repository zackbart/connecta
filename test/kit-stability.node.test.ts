// Node-only: type-checks the kit's sources with the TypeScript compiler API and reads effect's installed declarations.
import ts from "typescript";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Decision 0010 (Q7): effect 4.x tags each export `@stability stable` or
// `unstable`. The kit and every provider declaration on it may use stable
// members only, except the HTTP area modules, which purity.node.test.ts
// confines to src/http/client.ts, oauth.ts, and vendor.ts. Re-exporting those
// confines them; it does not make them stable, so they stay listed here as
// the one sanctioned exception.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const KIT = join(ROOT, "src", "http");
const PROVIDERS = join(ROOT, "src", "providers");

const files = [
  ...readdirSync(KIT)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(KIT, name)),
  ...readdirSync(PROVIDERS, { recursive: true })
    .filter((name): name is string => typeof name === "string" && name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(PROVIDERS, name)),
];

const UNSTABLE_AREAS = /node_modules\/effect\/dist\/(http|http-api)\//;

interface Use {
  readonly file: string;
  readonly member: string;
  readonly stability: string | undefined;
  readonly declaredIn: string;
}

function uses(): Use[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(ROOT, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    },
  );
  const program = ts.createProgram(files, { ...parsed!.options, noEmit: true });
  const checker = program.getTypeChecker();
  const out: Use[] = [];
  const effectSymbol = (node: ts.Node): ts.Symbol | undefined => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol?.declarations?.[0];
    return declaration && /node_modules\/effect\//.test(declaration.getSourceFile().fileName) ? symbol : undefined;
  };
  // An effect module reached through any local name: `Schema`, `S` for `Schema as S`, a namespace import.
  const isModule = (symbol: ts.Symbol | undefined): boolean => {
    const declaration = symbol?.declarations?.[0];
    return declaration !== undefined && (ts.isSourceFile(declaration) || ts.isModuleDeclaration(declaration));
  };
  // effect tags a renamed export (`try_ as try`) on its export specifier, so read the alias and its target.
  const stabilityOf = (node: ts.Node): string | undefined => {
    const local = checker.getSymbolAtLocation(node);
    const symbols = local && local.flags & ts.SymbolFlags.Alias ? [local, checker.getAliasedSymbol(local)] : [local];
    for (const symbol of symbols) {
      const tag = symbol?.getJsDocTags(checker).find((entry) => entry.name === "stability");
      if (tag)
        return tag.text
          ?.map((part) => part.text)
          .join("")
          .trim();
    }
    return undefined;
  };
  for (const file of files) {
    const source = program.getSourceFile(file)!;
    const visit = (node: ts.Node): void => {
      // `Schema.decodeUnknownEffect`, `Effect.Effect<...>`, and `S.Struct` through an alias alike:
      // the member is resolved through whatever local name reaches it.
      const member = ts.isPropertyAccessExpression(node)
        ? node.name
        : ts.isQualifiedName(node)
          ? node.right
          : undefined;
      const owner = ts.isPropertyAccessExpression(node)
        ? node.expression
        : ts.isQualifiedName(node)
          ? node.left
          : undefined;
      if (member && owner && isModule(effectSymbol(owner))) {
        const symbol = effectSymbol(member);
        if (symbol) {
          out.push({
            file: file.slice(ROOT.length + 1),
            member: `${owner.getText(source)}.${member.getText(source)}`,
            stability: stabilityOf(member),
            declaredIn: symbol.declarations![0]!.getSourceFile().fileName,
          });
        }
      }
      // A directly imported effect function or value, such as `pipe`.
      if (ts.isImportSpecifier(node)) {
        const symbol = effectSymbol(node.name);
        const declaration = symbol?.declarations?.[0];
        if (symbol && declaration && !isModule(symbol)) {
          out.push({
            file: file.slice(ROOT.length + 1),
            member: node.getText(source),
            stability: stabilityOf(node.name),
            declaredIn: declaration.getSourceFile().fileName,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

describe("Effect stability in the provider kit (decision 0010, Q7)", { timeout: 60_000 }, () => {
  it("INV-12: uses only members tagged stable outside the confined HTTP area modules", () => {
    const found = uses();
    // The guard must see the kit's core namespaces and the provider declarations, or it proves nothing.
    const namespaces = new Set(found.map((use) => use.member.split(".")[0]));
    for (const name of ["Schema", "Effect", "Context", "Data", "Stream", "HttpClient", "HttpApiEndpoint"]) {
      expect(namespaces.has(name), name).toBe(true);
    }
    expect(found.some((use) => use.file.endsWith("tithely/tools.ts"))).toBe(true);
    // And it reads the tags: the confined HTTP members are the unstable ones it sees.
    expect(found.some((use) => use.stability === "unstable" && UNSTABLE_AREAS.test(use.declaredIn))).toBe(true);
    const unstable = found.filter((use) => use.stability !== "stable" && !UNSTABLE_AREAS.test(use.declaredIn));
    expect(unstable.map((use) => `${use.file}: ${use.member} (${use.stability ?? "untagged"})`)).toEqual([]);
  });
});
