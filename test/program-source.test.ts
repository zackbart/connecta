// P1's trailing-terminator courtesy, shared by both executors: execute_code
// strips it before either one sees the program. The executor arms of the
// guest contract prove the stripped programs run; this pins what is and is
// not stripped.

import { describe, expect, it } from "vitest";
import { normalizeProgramSource, withoutProgramTerminator } from "../src/program-source.js";

describe("normalizeProgramSource", () => {
  it.each([
    ["I will read the value.\n```js\nasync () => 42;\n```\nHere is the program.", "async () => 42"],
    ["export default async () => ({ value: 42 });", "async () => ({ value: 42 })"],
    ["async function main() { return 42; }", "async (...args) => (async function main() { return 42; })(...args)"],
    ["async function read(value) { return { value, text: \"}\" }; };", "async (...args) => (async function read(value) { return { value, text: \"}\" }; })(...args)"],
    ["async function read() { return /}/.test('}'); } // done", "async (...args) => (async function read() { return /}/.test('}'); })(...args) // done"],
  ])("recovers one wrapped program", (code, expected) => {
    expect(normalizeProgramSource(code)).toBe(expected);
  });

  it.each([
    "return 42;",
    "async () => 42; 1 + 1",
    "async function first() { return 1; }\nasync function second() { return 2; }",
    "Before\n```js\nasync () => 1\n```\n```js\nasync () => 2\n```",
    "Before\n```js\nreturn 42;\n```\nAfter",
  ])("leaves unsupported source %j unchanged", (code) => {
    expect(normalizeProgramSource(code)).toBe(code);
  });
  it("keeps code after a default export for the executor to reject", () => {
    expect(normalizeProgramSource("export default async () => 42; 1 + 1")).toBe("async () => 42; 1 + 1");
  });
  it("does not extract a fence from a valid arrow's comment", () => {
    const code = `async () => {
/*
\`\`\`js
async () => 42
\`\`\`
*/
return "original";
}`;
    expect(normalizeProgramSource(code)).toBe(code);
  });
});

describe("withoutProgramTerminator", () => {
  it.each([
    ["async () => 1;", "async () => 1"],
    ["async () => 1;;", "async () => 1"],
    ["async () => {\n  return 1;\n};\n", "async () => {\n  return 1;\n}\n"],
    ["(async () => 1);", "(async () => 1)"],
    ["// note\nasync () => 1;", "// note\nasync () => 1"],
    // Comments after the terminator stay, and so do the semicolons in them.
    ["async () => {\n}; // done;\n/* ; */ ;", "async () => {\n} // done;\n/* ; */ "],
    // Semicolons in strings, templates, and regexes are data.
    ['async () => "a;b";', 'async () => "a;b"'],
    ["async () => `;${\"}\"};`;", "async () => `;${\"}\"};`"],
    ["async () => `${`;${1}`}`;", "async () => `${`;${1}`}`"],
    ["async () => /;[;/]/.test(x);", "async () => /;[;/]/.test(x)"],
    ["async () => a / b / c;", "async () => a / b / c"],
    ["async () => { return /;/g; };", "async () => { return /;/g; }"],
    // A fence is looked through, and dropped once a terminator comes out.
    ["```js\nasync () => 1;\n```", "async () => 1"],
  ])("strips the terminator from %j", (code, expected) => {
    expect(withoutProgramTerminator(code)).toBe(expected);
  });

  it.each([
    // Already an expression.
    "async () => 1",
    "```js\nasync () => 1\n```",
    // More code after the semicolon is not a terminator; P1 stays one expression.
    "async () => 1; 2",
    "async () => 1; // done\nfoo();",
    // A bare statement body is never touched: its `;` may be an empty loop body.
    "return 1;",
    "while (poll());",
    // Anything the lexer cannot close is left for the executor to report.
    'async () => "a;',
    "async () => { return 1;",
    "async () => 1; /* open",
    "async () => `${1;",
    "async () => 1 });",
  ])("leaves %j unchanged", (code) => {
    expect(withoutProgramTerminator(code)).toBe(code);
  });
});
