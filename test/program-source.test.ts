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
  ])("recovers one wrapped program", (code, expected) => {
    expect(normalizeProgramSource(code)).toBe(expected);
  });

  it.each(["async () => 42; 1 + 1", "Before\n```js\nasync () => 1\n```\n```js\nasync () => 2\n```"])(
    "leaves unsupported source %j unchanged",
    (code) => {
      expect(normalizeProgramSource(code)).toBe(code);
    },
  );
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
    ["async () => {\n}; // done;\n/* ; */ ;", "async () => {\n} // done;\n/* ; */ "],
    ["async () => `${`;${1}`}`;", "async () => `${`;${1}`}`"],
    ["async () => /;[;/]/.test(x);", "async () => /;[;/]/.test(x)"],
  ])("strips the terminator from %j", (code, expected) => {
    expect(withoutProgramTerminator(code)).toBe(expected);
  });

  it.each(["async () => 1; 2", "while (poll());", 'async () => "a;'])("leaves %j unchanged", (code) => {
    expect(withoutProgramTerminator(code)).toBe(code);
  });
});
