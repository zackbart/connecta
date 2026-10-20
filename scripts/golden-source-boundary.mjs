// Test-only source boundary. A capture must never infer quiescence around a
// module loader, nor allow a provider to bypass Web API dispatchers by importing
// Node's native timer/crypto/I/O aliases. The controller is absent in other
// suites; its own loader is the only admitted dynamic-import phase.
import { builtinModules } from "node:module";
import { parse } from "acorn";

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const gate = 'globalThis[Symbol.for("connecta.golden.sources")]?.importSource';

export default function goldenSourceBoundary() {
  return {
    name: "connecta-golden-source-boundary",
    enforce: "post",
    transform(code, id) {
      const path = id.split("?")[0].replaceAll("\\", "/");
      const provider = /\/src\/.*\.[cm]?[jt]s$/.test(path);
      const probe = /\/test\/(?:goldens(?:-harness)?\.test\.ts|goldens\/.*\.ts)$/.test(path);
      if (!provider && !probe) return;
      if (/\/test\/goldens\/(?:harness|setup|sources)\.ts$/.test(path)) return;
      const edits = [];
      const ast = parse(code, { ecmaVersion: "latest", sourceType: "module" });
      const walk = (node) => {
        if (!node || typeof node !== "object") return;
        if (node.type === "ImportExpression") {
          const name = typeof node.source.value === "string" ? node.source.value : "computed specifier";
          const native = builtins.has(name) || name.startsWith("node:");
          edits.push([
            node.start,
            node.end,
            `(${gate}(${JSON.stringify(`dynamic import: ${name}`)}, ${probe && !native}), ${code.slice(node.start, node.end)})`,
          ]);
          return;
        }
        if (
          ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) &&
          node.source
        ) {
          const name = node.source.value;
          if (builtins.has(name) || name.startsWith("node:"))
            edits.push([node.end, node.end, `\n${gate}(${JSON.stringify(`host module: ${name}`)}, false);\n`]);
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) value.forEach(walk);
          else if (value && typeof value === "object") walk(value);
        }
      };
      walk(ast);
      if (!edits.length) return;
      for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0]))
        code = code.slice(0, start) + replacement + code.slice(end);
      return { code, map: null };
    },
  };
}
