import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

export interface TestTitle {
  file: string;
  title: string;
  kind: "test" | "suite";
  disabled?: true;
}

// Resolve test-framework imports so a same-named local function cannot certify a test.
// Only module statements and suite callbacks register evidence; test bodies and
// unused helper functions do not. Parameterized titles keep their format string.
export function sourceTitles(file: string, source: string): TestTitle[] {
  const path = `/${file}`;
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const options = { noLib: true, noResolve: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => name === path ? tree : undefined;
  const checker = ts.createProgram([path], options, host).getTypeChecker();
  const titles: TestTitle[] = [];

  function testImport(identifier: ts.Identifier): string | undefined {
    const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
    if (!declaration || !ts.isImportSpecifier(declaration)) return undefined;
    const imported = declaration.propertyName ?? declaration.name;
    const module = declaration.parent.parent.parent;
    return ts.isImportDeclaration(module) && ts.isStringLiteral(module.moduleSpecifier) &&
      ["vitest", "@playwright/test"].includes(module.moduleSpecifier.text) ? imported.text : undefined;
  }
  function registration(expression: ts.Expression): string | undefined {
    if (ts.isIdentifier(expression)) return testImport(expression);
    if (ts.isPropertyAccessExpression(expression)) {
      const base = registration(expression.expression);
      if (base === "test" && expression.name.text === "describe") return "describe";
      return ["each", "for", "only", "skip", "todo", "fails", "skipIf", "runIf", "concurrent", "sequential"]
        .includes(expression.name.text) ? base : undefined;
    }
    if (ts.isCallExpression(expression)) return registration(expression.expression);
    if (ts.isTaggedTemplateExpression(expression)) return registration(expression.tag);
    return undefined;
  }
  function disabled(expression: ts.Expression): boolean {
    if (ts.isPropertyAccessExpression(expression)) {
      return ["skip", "todo", "skipIf", "runIf"].includes(expression.name.text) || disabled(expression.expression);
    }
    if (ts.isCallExpression(expression)) return disabled(expression.expression);
    if (ts.isTaggedTemplateExpression(expression)) return disabled(expression.tag);
    return false;
  }
  function visit(node: ts.Node, inactive = false) {
    // Suite callbacks are entered explicitly below; other functions are not
    // registration contexts, even if their bodies spell a real test-framework call.
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const name = registration(node.expression);
      if (["it", "test", "describe"].includes(name ?? "")) {
        const title = node.arguments[0];
        const skipped = inactive || disabled(node.expression);
        if (title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) {
          titles.push({
            file, title: title.text, kind: name === "describe" ? "suite" : "test",
            ...(skipped ? { disabled: true } : {}),
          });
        }
        if (name === "describe") {
          for (const argument of node.arguments.slice(1)) {
            if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
              visit(argument.body, skipped);
            }
          }
        }
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, inactive));
  }
  visit(tree);
  return titles;
}

export function repositoryTitles(root: string): TestTitle[] {
  function walk(directory: string): TestTitle[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walk(path);
      if (!/\.(?:test|spec)\.ts$/.test(entry.name)) return [];
      const file = relative(root, path).split(sep).join("/");
      return sourceTitles(file, readFileSync(path, "utf8"));
    });
  }
  return walk(join(root, "test"));
}
