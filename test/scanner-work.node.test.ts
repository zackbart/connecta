// Node-only: verifies scanner-work instrumentation used by Node performance guards.
import { describe, expect, it } from "vitest";
import { stringWork } from "./scanner-work.js";

describe("scanner work accounting", () => {
  it.each([
    ["forward scanned suffix", () => "abcdef".indexOf("x", 2), 4],
    ["reverse scanned prefix", () => "abcdef".lastIndexOf("x", 2), 3],
    ["match input", () => "abcdef".match(/x/), 6],
  ] as const)("counts characters for %s", (_, work, units) => {
    expect(stringWork<unknown>(work).units).toBe(units);
  });
});
