/** Only route-specific task wording/references change; outcome facts stay fixed. */
import type { Surface } from "../agent/surface.js";
import type { ActiveTask, ReferenceContext } from "./types.js";

/**
 * Tasks whose native-no-code outcome is decided by the arm's capabilities, not by
 * how well an agent uses tools. `eval/worker-comparison-plan.ts` keeps them out of
 * the code-versus-no-code decision rule; their rows stay visible in results.
 */
export const NO_CODE_CAPABILITY_MISMATCHES: Record<string, string> = {
  "p5-fanout-over-budget": "It measures the guest host-call budget, which only a program spends.",
  "p5-connecta-read": "It requires connecta.read, and native-no-code has no program to call it.",
  "p5-program-image":
    "Turning get_badge's JSON into a native image block needs connecta.emit. Without code it degenerates into the direct read that p5-direct-rich-output already measures.",
  "p5-read-only-program-refusal":
    "A read-only native pool lists no write tool, so the host cannot attempt the write that this task exists to see refused.",
  "auth-required-recovery":
    "billing__* tools appear only after the credential is saved, but the host's tool list is fixed for the session: Connecta advertises no list_changed, Claude's allowlist is set at spawn, and Codex CLI 0.166.0's config/mcpServer/reload did not expose them on the next turn. Not run on this arm.",
};
const NO_CODE_NOT_RUN = "auth-required-recovery";
/** The answer-evidence check reads this sentence, so every arm of a task must ask for it. */
const EVIDENCE_SENTENCE = "Finish with the source system, record ids, and facts supporting your answer.";

export function taskForSurface(task: ActiveTask, surface: Surface): ActiveTask {
  if (surface === "six") return task;
  if (surface === "five")
    return {
      ...task,
      reference: async (ctx) =>
        task.reference({
          ...ctx,
          call: (tool, args) =>
            tool === "search_tools"
              ? ctx.call("execute_code", { code: `async () => await connecta.search(${JSON.stringify(args)})` })
              : ctx.call(tool, args),
        }),
    };
  if (surface === "native" || surface === "native-no-code") {
    let prompt = task.prompt;
    if (task.id === "p5-result-paging")
      prompt =
        surface === "native"
          ? `Read ci.get_run_log for runId 4812 with ci__get_run_log. Page its retained result using connecta.result inside programs, and identify the actual failing test and HTTP status. ${EVIDENCE_SENTENCE}`
          : `Read ci.get_run_log for runId 4812 with ci__get_run_log. Page its retained result using read_result, and identify the actual failing test and HTTP status. ${EVIDENCE_SENTENCE}`;
    if (surface === "native-no-code") {
      if (task.id === "p5-trusted-program-write")
        prompt =
          "In this writable pool, close tracker issue WEB-105 using tracker__close_issue and confirm its resulting status.";
      if (task.id === "p5-read-only-program-refusal")
        prompt = `${task.prompt.replace("a program", "tracker__close_issue")} If this pool does not list that tool, say so instead of attempting it.`;
      if (task.id === "p5-program-image")
        prompt =
          "Read assets.get_badge_image using assets__get_badge_image, preserve its image and caption, and confirm the badge approval and revision.";
    }
    const answerOnly = async (ctx: ReferenceContext, answer: string) => ctx.answer(answer);
    return {
      ...task,
      prompt,
      ...(task.id === "p5-read-only-program-refusal" ? { approvals: {} } : {}),
      ...(surface === "native-no-code" && task.id === NO_CODE_NOT_RUN
        ? {
            runnerSkips: Object.fromEntries(
              (["claude", "codex"] as const).map((runner) => [
                runner,
                { code: "capability-mismatch" as const, reason: NO_CODE_CAPABILITY_MISMATCHES[task.id]! },
              ]),
            ),
          }
        : {}),
      // References for what these arms can actually do. Other tasks keep theirs.
      ...(task.id === "p5-absent-github"
        ? {
            reference: (ctx: ReferenceContext) =>
              answerOnly(
                ctx,
                "GitHub is not configured here. I cannot determine open pull requests for acme/widget from these connectors.\nANSWER: unavailable",
              ),
          }
        : {}),
      ...(surface === "native-no-code" && task.id === "p5-read-only-program-refusal"
        ? {
            reference: (ctx: ReferenceContext) =>
              answerOnly(
                ctx,
                "Tracker WEB-105 remains open: tracker__close_issue is not available in this read-only pool, so nothing was attempted.\nANSWER: not closed",
              ),
          }
        : {}),
      ...(surface === "native-no-code" && task.id === "p5-program-image"
        ? {
            reference: async (ctx: ReferenceContext) => {
              await ctx.call("call_tool", { address: "assets.get_badge_image", args: {} });
              ctx.answer("Brand assets launch badge is approved, revision 7.");
            },
          }
        : {}),
    };
  }
  let prompt = task.prompt;
  if (task.id === "p5-result-paging")
    prompt = `Read ci.get_run_log for runId 4812 in a program, reduce its full log, and identify the actual failing test and HTTP status. ${EVIDENCE_SENTENCE}`;
  const reference = task.reference;
  return {
    ...task,
    prompt,
    ...(task.id === "p5-read-only-program-refusal" ? { approvals: {} } : {}),
    reference: async (ctx) => {
      const programCall: ReferenceContext["call"] = (tool, args) => {
        if (tool === "call_tool" || tool === "call_destructive_tool")
          return ctx.call("execute_code", {
            code: `async () => (await connecta.call(${JSON.stringify(args.address)}, ${JSON.stringify(args.args ?? {})})).data`,
          });
        if (tool === "search_tools")
          return ctx.call("execute_code", { code: `async () => await connecta.search(${JSON.stringify(args)})` });
        return ctx.call(tool, args);
      };
      if (["p5-result-paging", "truncated-read-paging"].includes(task.id)) {
        await ctx.call("execute_code", {
          code: `async () => {
          const { data } = await connecta.call("ci.get_run_log", { runId: 4812 });
          return data.split("\\n").filter(line => /refund.test.ts|expected status/.test(line));
        }`,
        });
        if (task.id === "truncated-read-paging")
          await programCall("call_destructive_tool", {
            address: "chat.post_message",
            args: { channel: "ci", text: "run 4812 failed: test/payments/refund.test.ts" },
          });
        ctx.answer(
          task.id === "p5-result-paging"
            ? "CI run 4812: test/payments/refund.test.ts failed, expected 200, received 409."
            : "CI run 4812 failed test/payments/refund.test.ts with status 409. Posted to #ci.",
        );
      } else if (task.id === "truncated-write-export") {
        await ctx.call("execute_code", {
          code: `async () => {
          const { data } = await connecta.call("audit.export_events", { since: new Date(Date.now() - 7 * 86400000).toISOString() });
          const event = data.split("\\n").map(line => { try { return JSON.parse(line); } catch { return null; } }).find(e => e && e.action === "project.deleted" && e.target === "prod-db");
          await connecta.call("chat.post_message", { channel: "security", text: "prod-db deleted by: " + event.actor });
          return event;
        }`,
        });
        ctx.answer("Audit export shows prod-db project.deleted by dana.whitfield@example.com. Posted to #security.");
      } else if (task.id === "p5-direct-rich-output") {
        await ctx.call("execute_code", {
          code: `async () => { const { data } = await connecta.call("assets.get_badge_image", {}); for (const block of data.content) connecta.emit(block); return { caption: "Launch badge: approved, revision 7" }; }`,
        });
        ctx.answer("Brand assets launch badge is approved, revision 7.");
      } else await reference({ ...ctx, call: programCall });
    },
  };
}
