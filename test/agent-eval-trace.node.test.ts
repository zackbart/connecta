// Node-only: imports the eval trace parser and fake-service protocol types.
import { describe, expect, it } from "vitest";
import { parseTrace, type StreamEvent } from "../eval/agent/trace.js";

const message = (text: string, phase?: string): StreamEvent => ({
  type: "assistant",
  message: { phase, content: [{ type: "text", text }] },
});

describe("eval final-answer evidence", () => {
  it("keeps Codex commentary out of final evidence", () => {
    expect(parseTrace([message("CI run 4812 failed on 9f2c1ab.", "commentary")], [0], ["Read CI."]).finalAnswer).toBe(
      "",
    );
    expect(
      parseTrace(
        [message("Searching.", "commentary"), message("CI run 4812 failed on 9f2c1ab.", "final_answer")],
        [0],
        ["Read CI."],
      ).finalAnswer,
    ).toContain("9f2c1ab");
  });
  it("does not double-count cached Codex input", () => {
    const trace = parseTrace(
      [{ type: "codex_usage", total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 } }],
      [],
      [],
    );
    expect(trace.tokens).toEqual({ input: 60, cacheRead: 40, output: 10, cacheCreation: 0 });
  });
});
