/** Only route-specific task wording/references change; outcome facts stay fixed. */
import type { Surface } from "../agent/surface.js";
import type { ActiveTask, ReferenceContext } from "./types.js";

const TRUSTED = new Set([
  "cross-connector-join",
  "stale-close-and-summarize",
  "auth-required-recovery",
  "truncated-read-paging",
]);
export function taskForSurface(task: ActiveTask, surface: Surface): ActiveTask {
  if (surface === "six") return task;
  let prompt = task.prompt;
  if (task.id === "p5-result-paging")
    prompt =
      "Read ci.get_run_log for runId 4812 in a program, reduce its full log, and identify the actual failing test and HTTP status. Finish with the source system, record ids, and facts supporting your answer.";
  const reference = task.reference;
  return {
    ...task,
    prompt,
    deployment: { ...task.deployment, ...(TRUSTED.has(task.id) ? { trust: "trusted" } : {}) },
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
