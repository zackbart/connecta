// Node-only: imports the eval trace parser and fake-service protocol types.
import { describe, expect, it } from "vitest";
import { parseTrace, type StreamEvent } from "../eval/agent/trace.js";

const message = (text: string, phase?: string): StreamEvent => ({
  type: "assistant",
  message: { phase, content: [{ type: "text", text }] },
});

describe("eval final-answer evidence", () => {
  it("does not keep earlier facts when the final message omits them", () => {
    const trace = parseTrace([message("CI run 4812 failed on 9f2c1ab."), message("Done.")], [0], ["Read CI."]);
    expect(trace.finalAnswer).toBe("Done.");
    expect(trace.transcript.filter((t) => t.kind === "assistant")).toHaveLength(2);
  });
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
  it("normalizes the native Claude image shape from the first baseline", () => {
    const trace = parseTrace(
      [
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "badge", name: "mcp__connecta__execute_code", input: {} }] },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "badge",
                content: [
                  { type: "image", source: { type: "base64", media_type: "image/png", data: "png-data" } },
                  { type: "text", text: "Launch badge: approved, revision 7" },
                ],
              },
            ],
          },
        },
      ],
      [0],
      ["Emit badge"],
    );
    expect(trace.toolUses[0]?.resultBlocks).toEqual([
      { type: "image", mimeType: "image/png", data: "png-data" },
      { type: "text", text: "Launch badge: approved, revision 7" },
    ]);
  });
});
