/** Only route-specific task wording/references change; outcome facts stay fixed. */
import type { Surface } from "../agent/surface.js";
import type { StepArm } from "../deploy/step-arms.js";
import type { ActiveTask, ReferenceContext } from "./types.js";

/** An arm never changes a prompt or grader; only a reference names merged tools. */
export function taskForStepArm(task: ActiveTask, arm: StepArm | undefined): ActiveTask {
  if (arm !== "merged-tools") return task;
  const original = task.reference;
  const merged = (args: Record<string, any>) => {
    const tool = String(args.address ?? "");
    const input = (args.args ?? {}) as Record<string, unknown>;
    if (tool === "vercel_rest.upsert_project_env_var" || tool === "vercel_rest.update_project_env_var")
      return { ...args, address: "vercel_rest.upsert_project_env" };
    if (tool === "vercel_rest.get_deployment_build_logs")
      return { ...args, address: "vercel_rest.get_logs", args: { ...input, kind: "build" } };
    if (tool === "vercel_rest.get_runtime_logs")
      return { ...args, address: "vercel_rest.get_logs", args: { ...input, kind: "runtime" } };
    return args;
  };
  return {
    ...task,
    reference: (ctx) =>
      original({
        ...ctx,
        call: (tool, args) =>
          ctx.call(tool, tool === "call_tool" || tool === "call_destructive_tool" ? merged(args) : args),
      }),
  };
}

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
          ? "Read ci.get_run_log for runId 4812 with ci__get_run_log. Page its retained result using connecta.result inside programs, and identify the actual failing test and HTTP status."
          : "Read ci.get_run_log for runId 4812 with ci__get_run_log. Page its retained result using read_result, and identify the actual failing test and HTTP status.";
    if (surface === "native-no-code") {
      if (task.id === "p5-trusted-program-write")
        prompt =
          "In this writable pool, close tracker issue WEB-105 using tracker__close_issue and confirm its resulting status.";
      if (task.id === "p5-read-only-program-refusal") prompt = task.prompt.replace("a program", "tracker__close_issue");
      if (task.id === "p5-program-image")
        prompt =
          "Read assets.get_badge_image using assets__get_badge_image, preserve its image and caption, and confirm the badge approval and revision.";
    }
    return { ...task, prompt, ...(task.id === "p5-read-only-program-refusal" ? { approvals: {} } : {}) };
  }
  let prompt = task.prompt;
  if (task.id === "p5-result-paging")
    prompt =
      "Read ci.get_run_log for runId 4812 in a program, reduce its full log, and identify the actual failing test and HTTP status. Finish with the source system, record ids, and facts supporting your answer.";
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
