// Node-only: reads every log call in src/ with Node filesystem APIs.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// INV-6 is enforced at the sink: a log line about a failure is built by
// src/operator-record.ts from typed facts, never from what an error says, and
// `logFailure` refuses any record that module did not build. This scan is a
// secondary lint over every other log call in src/, so a new call site cannot
// quietly hand a logger an error, its message, its name, or its cause, nor
// reach a logger method through an alias the scan would not see.
const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Files that define a sink rather than write to one. */
const SINK_DEFINITIONS = new Set([
  "operator-record.ts",
  // The default logger forwards its arguments to the console.
  "runtime/services.ts",
]);

const LOG_CALL = /\b(?:logger|console|sealer|this\.sealer)\??\.(?:debug|info|warn|error|log)\s*\(/g;
const ERRORISH = "(?:err|error|e|cause|reason|failure|exception|readErr|renameError)";
const ERROR_TEXT = new RegExp(
  [
    "\\bmsg\\(",
    "\\.message\\b",
    "\\.stack\\b",
    "\\.cause\\b",
    "\\.errors\\b",
    `String\\(\\s*${ERRORISH}\\b`,
    // Interpolated, or by its name.
    `\\$\\{\\s*${ERRORISH}\\b`,
    `\\b${ERRORISH}\\.name\\b`,
    // Nested in an object or array: `{ error }`, `{ cause: err }`, `[err]`.
    `[{[,:]\\s*${ERRORISH}\\s*[,}\\]]`,
  ].join("|"),
);
const BARE_ERROR = new RegExp(`^${ERRORISH}$`);
const LOGGER = "(?:logger|console|this\\.opts\\.logger|opts\\.logger|ctx\\.logger|context\\.logger)";
/** A logger method taken out of its call: `const { warn } = logger`, `const w = logger.warn`. */
const ALIAS = new RegExp(
  `\\{[^}]*\\b(?:debug|info|warn|error|log)\\b[^}]*\\}\\s*=\\s*${LOGGER}\\b|` +
    `=\\s*${LOGGER}\\??\\.(?:debug|info|warn|error|log)\\b(?!\\s*\\()`,
  "g",
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && entry.name !== "generated.ts" ? [path] : [];
  });
}

/** The argument text of the call whose `(` is at `open`, split at top-level commas. */
function callArguments(source: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      i = source.indexOf(ch, i + 1);
      while (source[i - 1] === "\\") i = source.indexOf(ch, i + 1);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        args.push(source.slice(start, i).trim());
        return args.filter(Boolean);
      }
    } else if (ch === "," && depth === 1) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  throw new Error(`unterminated call at ${open}`);
}

describe("operator log calls", () => {
  it("INV-6: pass no error, message, cause, or stack to a logger outside the record module", () => {
    const problems: string[] = [];
    let calls = 0;
    for (const file of sourceFiles(SRC)) {
      const name = relative(SRC, file);
      if (SINK_DEFINITIONS.has(name)) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(LOG_CALL)) {
        calls++;
        const open = match.index + match[0].length - 1;
        const args = callArguments(source, open);
        const line = source.slice(0, match.index).split("\n").length;
        for (const arg of args) {
          if (ERROR_TEXT.test(arg) || BARE_ERROR.test(arg)) {
            problems.push(`src/${name}:${line}: ${arg.replace(/\s+/g, " ").slice(0, 120)}`);
          }
        }
      }
      for (const match of source.matchAll(ALIAS)) {
        const line = source.slice(0, match.index).split("\n").length;
        problems.push(`src/${name}:${line}: logger method alias ${match[0].slice(0, 80)}`);
      }
    }
    expect(calls).toBeGreaterThan(50);
    expect(problems).toEqual([]);
  });

  it("recognizes error text in the shapes a call site could hand it over", () => {
    for (const arg of [
      "`failed: ${err}`",
      "`failed (${error.name})`",
      "{ error }",
      "{ connector, cause: err }",
      "[reason]",
      "error",
    ]) {
      expect(ERROR_TEXT.test(arg) || BARE_ERROR.test(arg), arg).toBe(true);
    }
    for (const arg of ['"[connecta] call failed"', "failureRecord({ connector: id }, err)", "{ connector: id }"]) {
      expect(ERROR_TEXT.test(arg) || BARE_ERROR.test(arg), arg).toBe(false);
    }
    for (const alias of ["const { warn } = logger;", "const log = ctx.logger.warn;", "const { error: e } = console;"]) {
      expect([...alias.matchAll(ALIAS)].length, alias).toBe(1);
    }
    expect([..."logger.warn(x); const s = { warn: 1 };".matchAll(ALIAS)]).toEqual([]);
  });

  it("finds an error handed to a logger", () => {
    const source = 'logger.warn("[connecta] failed", { detail: msg(err) });';
    expect(callArguments(source, source.indexOf("("))).toEqual([
      '"[connecta] failed"',
      "{ detail: msg(err) }",
    ]);
  });
});
