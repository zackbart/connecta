/** One completion per CLI conversation turn, shared by live and saved grading. */
import type { Check } from "../tasks/types.js";
import type { AgentTrace } from "./trace.js";

export function conversationCompletion(
  trace: AgentTrace,
  conversationTurns: number,
  timedOut = false,
  aborted = false,
): { available: boolean; check: Check } {
  const turns = Math.max(
    1,
    conversationTurns,
    ...trace.transcript.map((e) => e.turn),
    ...trace.toolUses.map((u) => u.turn),
  );
  const ends = trace.transcript.filter((e) => e.kind === "turn_end");
  const available =
    trace.resultSubtypes.length === turns &&
    Array.from({ length: turns }, (_, i) => i + 1).every((turn) => ends.filter((e) => e.turn === turn).length === 1);
  return {
    available,
    check: {
      id: "conversation-completed",
      description: "every turn ended normally within the time limit",
      pass:
        available &&
        !timedOut &&
        !aborted &&
        trace.resultSubtypes.every((s) => s === "success") &&
        ends.every((e) => e.subtype === "success" && !e.isError),
      detail: timedOut
        ? "timed out"
        : available
          ? trace.resultSubtypes.join(", ")
          : `missing completion evidence (${trace.resultSubtypes.length}/${turns} turns)`,
    },
  };
}
