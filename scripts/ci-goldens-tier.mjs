// Read git diff --no-renames --name-only -z. Only proven unrelated PRs use
// "always". Unknown paths, imports, parse/read/resolution errors select "full".
import { builtinModules } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const explicit =
  /^(?:src\/(?:providers|connectors|http|storage)\/|test\/(?:goldens(?:\/|[.-])|fixtures\/|providers\/)|vitest[^/]*\.|(?:.*\/)?(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$|scripts\/(?:ci-goldens-tier|golden-source-boundary)|\.github\/workflows\/ci\.yml$)/;
const documentation = /^(?:documentation\/[^/]+\.md$|decisions\/|\.changes\/|(?:[^/]+\/)*[^/]+\.md$)/;

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  });
}

/** Derive the transitive local graph, including type imports, exports and lazy imports. */
async function providerDependencies(repository) {
  const { default: ts } = await import("typescript");
  const manifest = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
  const external = new Set([
    ...builtinModules.flatMap((name) => [name, `node:${name}`]),
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const pending = [
    ...sources(join(repository, "src/providers")),
    join(repository, "test/goldens/harness.ts"),
    join(repository, "test/goldens/setup.ts"),
  ];
  const graph = new Set();
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };
  while (pending.length) {
    const file = pending.pop();
    if (graph.has(file)) continue;
    graph.add(file);
    const source = readFileSync(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    if (ast.parseDiagnostics.length) throw new Error(`Cannot parse ${file}`);
    const imports = new Set(ts.preProcessFile(source, true, true).importedFiles.map(({ fileName }) => fileName));
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === "require")
      ) {
        if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0]))
          throw new Error(`Unknown dynamic dependency in ${file}`);
        imports.add(node.arguments[0].text);
      }
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "import.meta.glob") {
        // The only generated edges in the graph: the harness's maintained specs.
        if (relative(repository, file) !== "test/goldens/harness.ts" || node.arguments[0]?.text !== "./*/spec.ts")
          throw new Error(`Unknown glob dependency in ${file}`);
        for (const path of sources(join(repository, "test/goldens"))) if (path.endsWith("/spec.ts")) pending.push(path);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    for (const name of imports) {
      if (!name.startsWith(".")) {
        if (![...external].some((pkg) => name === pkg || name.startsWith(`${pkg}/`)))
          throw new Error(`Unknown external dependency ${name} in ${file}`);
        continue; // Manifest/lockfile changes always select full.
      }
      const resolved = ts.resolveModuleName(name, file, options, ts.sys).resolvedModule?.resolvedFileName;
      if (!resolved || !resolve(resolved).startsWith(`${resolve(repository)}/`))
        throw new Error(`Unresolved local dependency ${name} in ${file}`);
      pending.push(resolve(resolved));
    }
  }
  return new Set([...graph].map((file) => relative(repository, file)));
}

/** Dependency-free first pass. "graph" alone requires installing TypeScript. */
export function selectGoldensFastTier(paths, { repository = root } = {}) {
  try {
    if (
      !paths.length ||
      paths.some(
        (path) =>
          typeof path !== "string" ||
          !path ||
          path.startsWith("/") ||
          path.split("/").some((part) => !part || part === "." || part === "..") ||
          path.includes("\0"),
      )
    )
      return "full";
    if (paths.some((path) => explicit.test(path))) return "full";
    const code = paths.filter((path) => !documentation.test(path));
    if (!code.length) return "always";
    // Only existing source/test modules need the TypeScript graph. All other
    // unknown inputs fail full without paying for dependency setup.
    if (code.some((path) => !/^(?:src|test)\/.*\.[cm]?[jt]sx?$/.test(path) || !existsSync(join(repository, path))))
      return "full";
    return "graph";
  } catch (error) {
    console.error(`Goldens fast classification failed; running full: ${error.message}`);
    return "full";
  }
}

/** Exported for fault-injection tests; CI uses the NUL-delimited stdin wrapper. */
export async function selectGoldensTier(paths, { repository = root, dependencies = providerDependencies } = {}) {
  try {
    const fast = selectGoldensFastTier(paths, { repository });
    if (fast !== "graph") return fast;
    const code = paths.filter((path) => !documentation.test(path));
    const graph = await dependencies(repository);
    for (const path of code) {
      if (graph.has(path)) return "full";
      // Known existing source/test files outside the graph are unrelated.
      // Missing/deleted paths, fixtures, tooling and future configuration fail full.
      if (!/^(?:src|test)\/.*\.[cm]?[jt]sx?$/.test(path) || !existsSync(join(repository, path))) return "full";
    }
    return "always";
  } catch (error) {
    console.error(`Goldens tier classification failed; running full: ${error.message}`);
    return "full";
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = readFileSync(0, "utf8");
    const select = process.argv[2] === "--fast" ? selectGoldensFastTier : selectGoldensTier;
    console.log(!input.endsWith("\0") ? "full" : await select(input.slice(0, -1).split("\0")));
  } catch (error) {
    console.error(`Goldens tier input failed; running full: ${error.message}`);
    console.log("full");
  }
}
