#!/usr/bin/env node
// Guard the published type surface against Effect.
//
// Connecta runs on Effect inside and publishes Promises outside. The runtime
// half of that rule is easy to keep; the type half is not, because a single
// inferred return type or an un-privatized field is enough for `tsc` to write
// `import("effect")` into a declaration a consumer compiles against. At that
// point Effect's types are part of the public API, and an Effect upgrade is a
// breaking change for every deployment. This script is the check that stops it.
//
// It walks the declaration graph from every `exports[*].types` target —
// following `from "./x.js"`, `export *`, `import("./x.js")`, and
// `/// <reference path>` — and fails, naming `file:line`, when a reachable
// declaration mentions `effect` or `@effect/*`. It also fails when a reachable
// declaration lives under `runtime/` (the Effect-only modules never ship
// types) or references a declaration that is not there.
//
//   node scripts/check-declarations.mjs
//     Emits declarations in memory from tsconfig.build.json. No build needed.
//   node scripts/check-declarations.mjs --dist <packageRoot>
//     Reads the declarations a package actually ships. Stricter: every .d.ts
//     under the declaration roots is scanned, reachable or not, and any file
//     the walk cannot reach is an orphan the build should have pruned.
//
// scripts/prune-declarations.mjs imports the walker below, so what the build
// deletes and what this check calls reachable cannot disagree.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EFFECT_SPECIFIER =
  /(?:\bfrom\s+|\bimport\(\s*|\brequire\(\s*|reference\s+types=)["'](?:effect(?:\/[^"']*)?|@effect\/[^"']+)["']/;

const SPECIFIERS = [
  /\bfrom\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\/\/\/\s*<reference\s+path=["']([^"']+)["']/g,
];

/** Every `types` target in an exports map, as a root-relative posix path. */
export function declarationEntries(manifest) {
  const entries = new Set();
  const visit = (value, key) => {
    if (typeof value === "string") {
      if (key === "types") entries.add(posix.normalize(value));
      return;
    }
    if (value && typeof value === "object") {
      for (const [child, target] of Object.entries(value)) visit(target, child);
    }
  };
  visit(manifest.exports ?? {}, "");
  if (typeof manifest.types === "string") {
    entries.add(posix.normalize(manifest.types));
  }
  return [...entries].sort();
}

/** Declaration files that could satisfy a relative specifier. */
function candidates(from, specifier) {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (base.endsWith(".d.ts") || base.endsWith(".d.mts")) return [base];
  if (base.endsWith(".js")) return [`${base.slice(0, -3)}.d.ts`];
  if (base.endsWith(".mjs")) return [`${base.slice(0, -4)}.d.mts`];
  return [`${base}.d.ts`, `${base}/index.d.ts`];
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/**
 * Walk the declaration graph from `entries`.
 *
 * `read(path)` returns a declaration's text, or undefined when it does not
 * exist. Returns the reachable set and every relative reference that resolved
 * to nothing.
 */
export function reachableDeclarations(entries, read) {
  const reachable = new Set();
  const missing = [];
  const queue = [];
  for (const entry of entries) {
    if (read(entry) === undefined) {
      missing.push({ from: "package.json", line: 0, specifier: entry });
    } else {
      queue.push(entry);
    }
  }
  while (queue.length) {
    const file = queue.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    const source = read(file) ?? "";
    for (const pattern of SPECIFIERS) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier.startsWith(".")) continue;
        const target = candidates(file, specifier).find(
          (candidate) => read(candidate) !== undefined,
        );
        if (target === undefined) {
          missing.push({
            from: file,
            line: lineOf(source, match.index),
            specifier,
          });
        } else if (!reachable.has(target)) {
          queue.push(target);
        }
      }
    }
  }
  return { reachable, missing };
}

/** `file:line` for every Effect specifier in `source`. */
export function effectLeaks(file, source) {
  const leaks = [];
  source.split("\n").forEach((text, index) => {
    if (EFFECT_SPECIFIER.test(text)) {
      leaks.push(`${file}:${index + 1}: ${text.trim()}`);
    }
  });
  return leaks;
}

/** The top-level directories the exports map publishes declarations from. */
export function declarationRoots(entries) {
  return [...new Set(entries.map((entry) => entry.split("/")[0]))].filter(
    (root) => !root.endsWith(".d.ts"),
  );
}

/** Every .d.ts under `root/dir`, as root-relative posix paths. */
export function listDeclarations(root, dir) {
  const found = [];
  const walk = (absolute) => {
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const path = join(absolute, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.d\.m?ts$/.test(entry.name)) {
        found.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  walk(join(root, dir));
  return found.sort();
}

/** Read declarations straight off disk under `root`. */
export function diskReader(root) {
  return (path) => {
    const absolute = join(root, path);
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
  };
}

async function emitInMemory(root) {
  const { default: ts } = await import("typescript");
  const configPath = join(root, "tsconfig.build.json");
  const config = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!config) throw new Error(`Cannot read ${configPath}`);
  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: { ...config.options, noEmit: false, declaration: true },
  });
  const files = new Map();
  const result = program.emit(
    undefined,
    (fileName, text) => {
      files.set(relative(root, fileName).split(sep).join("/"), text);
    },
    undefined,
    true,
  );
  if (result.emitSkipped) {
    const messages = result.diagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
    throw new Error(`Declaration emit failed:\n${messages.join("\n")}`);
  }
  return files;
}

/** Run the check; returns the list of problems (empty when clean). */
export async function checkDeclarations({ root, dist }) {
  const packageRoot = dist ? resolve(dist) : root;
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  const entries = declarationEntries(manifest);
  if (entries.length === 0) {
    return { problems: ["package.json exports no `types` targets"], reachable: new Set() };
  }
  let read;
  if (dist) {
    read = diskReader(packageRoot);
  } else {
    const emitted = await emitInMemory(root);
    read = (path) => emitted.get(path);
  }
  const { reachable, missing } = reachableDeclarations(entries, read);
  const problems = [];
  for (const { from, line, specifier } of missing) {
    problems.push(
      `${from}:${line}: references ${specifier}, which has no declaration`,
    );
  }
  for (const file of [...reachable].sort()) {
    if (file.split("/").includes("runtime")) {
      problems.push(
        `${file}: an internal runtime module is reachable from the published types`,
      );
    }
  }
  const scanned = new Set(reachable);
  if (dist) {
    for (const dir of declarationRoots(entries)) {
      for (const file of listDeclarations(packageRoot, dir)) {
        scanned.add(file);
        if (!reachable.has(file)) {
          problems.push(
            `${file}: orphan declaration — no exports types target reaches it`,
          );
        }
      }
    }
  }
  for (const file of [...scanned].sort()) {
    for (const leak of effectLeaks(file, read(file) ?? "")) {
      problems.push(`${leak}  <- Effect in a published declaration`);
    }
  }
  return { problems, reachable };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const distIndex = args.indexOf("--dist");
  const dist = distIndex >= 0 ? args[distIndex + 1] : undefined;
  if (distIndex >= 0 && !dist) {
    console.error("usage: check-declarations.mjs [--dist <packageRoot>]");
    process.exit(2);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const { problems, reachable } = await checkDeclarations({ root, dist });
    if (problems.length) {
      console.error(
        `check-declarations: ${problems.length} problem(s) in the published types` +
          (dist ? ` (${dist})` : " (in-memory emit)") +
          ":\n" +
          problems.map((problem) => `  ${problem}`).join("\n"),
      );
      process.exit(1);
    }
    console.log(
      `check-declarations: ${reachable.size} reachable declaration(s), no Effect types` +
        (dist ? ` (${dist})` : " (in-memory emit)"),
    );
  } catch (error) {
    console.error(`check-declarations: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
