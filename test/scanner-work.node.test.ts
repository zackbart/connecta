// Node-only: bundles an in-memory source mutation with esbuild; production files stay unchanged.
import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { linearWork, SCAN_HANG_GUARD_MS, stringWork } from "./scanner-work.js";
import { withholdSignedLinks } from "../src/providers/_shared/rest/value-safety.js";

const sourceUrl = new URL("../src/providers/_shared/rest/value-safety.ts", import.meta.url);
const hosts = { domains: ["file.notion.so"], buckets: ["prod-files-secure"] };

/** Bundle the exact review mutation without altering any production file. */
function suffixSearchMutation(): typeof withholdSignedLinks {
  const source = readFileSync(sourceUrl, "utf8");
  const anchor = "const char = text[at]!;";
  expect(source.split(anchor), "the hostLinks mutation must match exactly once").toHaveLength(2);
  const mutation =
    'if (at % 512 === 0 && text.indexOf("REVIEW_MISSING_SENTINEL", at) !== -1) throw new Error("unexpected sentinel");';
  const { outputFiles } = buildSync({
    stdin: {
      contents: source.replace(anchor, `${mutation}\n${anchor}`),
      sourcefile: sourceUrl.pathname,
      resolveDir: new URL(".", sourceUrl).pathname,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const module = { exports: {} as { withholdSignedLinks: typeof withholdSignedLinks } };
  new Function("module", "exports", outputFiles[0]!.text)(module, module.exports);
  return module.exports.withholdSignedLinks;
}

describe("scanner work accounting", () => {
  it.each([
    ["forward failed suffix", () => "abcdef".indexOf("missing", 2), 0],
    ["forward scanned suffix", () => "abcdef".indexOf("x", 2), 4],
    ["forward found needle", () => "abcabc".indexOf("bc", 1), 2],
    ["forward negative position", () => "abcdef".indexOf("x", -2), 6],
    ["forward infinite position", () => "abcdef".indexOf("x", Infinity), 0],
    ["empty needle", () => "abcdef".indexOf("", 2), 0],
    ["reverse scanned prefix", () => "abcdef".lastIndexOf("x", 2), 3],
    ["reverse found needle", () => "abcabc".lastIndexOf("bc"), 2],
    ["reverse NaN position", () => "abcabc".lastIndexOf("bc", NaN), 2],
    ["includes scanned suffix", () => "abcdef".includes("x", 2), 4],
    ["includes found needle", () => "abcabc".includes("bc", 1), 2],
    ["startsWith comparison window", () => "abcdef".startsWith("cd", 2), 2],
    ["endsWith comparison window", () => "abcdef".endsWith("cd", 4), 2],
    ["endsWith NaN position", () => "abcdef".endsWith("ab", NaN), 0],
    ["search input", () => "abcdef".search(/x/), 6],
    ["match input", () => "abcdef".match(/x/), 6],
    ["split input", () => "abcdef".split("x"), 6],
  ] as const)("counts characters for %s", (_, work, units) => {
    expect(stringWork<unknown>(work).units).toBe(units);
  });

  it("keeps an elapsed-time backstop for native regex work that the counter cannot observe", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(20_001);
    try {
      expect(() => linearWork("a", (text) => text.charCodeAt(0))).toThrow(
        /native scanning\/backtracking wall-clock backstop/,
      );
    } finally {
      clock.mockRestore();
    }
  });

  it(
    "INV-5: rejects the review's hostLinks suffix search every 512 characters by work count",
    () => {
      const input = "a".repeat(5 * 1024 * 1024);
      expect(linearWork(input, (text) => withholdSignedLinks(text, hosts))).toBe(input);
      const mutant = suffixSearchMutation();
      const originals = Object.getOwnPropertyDescriptors(String.prototype);
      expect(() => linearWork(input, (text) => mutant(text, hosts))).toThrow(
        /^Scanner character-work budget exceeded:/,
      );
      for (const [name, descriptor] of Object.entries(originals)) {
        const restored = Object.getOwnPropertyDescriptor(String.prototype, name);
        expect(restored?.value, name).toBe(descriptor.value);
        expect(restored?.writable, name).toBe(descriptor.writable);
        expect(restored?.enumerable, name).toBe(descriptor.enumerable);
        expect(restored?.configurable, name).toBe(descriptor.configurable);
      }
    },
    SCAN_HANG_GUARD_MS,
  );
});
