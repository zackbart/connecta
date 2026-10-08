/** Correct destination and final-answer evidence are independent required checks. */
import type { ActiveTask, Check } from "./types.js";
import type { AgentTrace } from "../agent/trace.js";
import type { World } from "../fakes/world.js";

export interface Correctness {
  destination(world: World, trace: AgentTrace): boolean;
  /** Every expression must match the final answer, never the tool output. */
  evidence: RegExp[];
  referenceAnswer: string;
}

export function called(world: World, address: string, args: Record<string, unknown> = {}): boolean {
  const [service, tool] = address.split(".");
  return world.ledger.calls.some(call => call.service === service && call.tool === tool && call.outcome === "ok" &&
    Object.entries(args).every(([key, value]) => JSON.stringify(call.args[key]) === JSON.stringify(value)));
}

export function direct(trace: AgentTrace, tool: string, address: string): boolean {
  return trace.toolUses.some(use => use.tool === tool && use.input.address === address && use.isError === false);
}

function correctnessChecks(spec: Correctness, world: World, trace: AgentTrace): Check[] {
  const answer = trace.finalAnswer ?? "";
  return [
    { id: "correct-destination", description: "used the requested connector, tool and target", pass: spec.destination(world, trace) },
    { id: "answer-evidence", description: "the final answer cites every required fake fact",
      pass: spec.evidence.every(pattern => pattern.test(answer)), detail: answer.slice(0, 500) },
  ];
}

export function withCorrectness(task: ActiveTask, spec: Correctness): ActiveTask {
  return {
    ...task,
    prompt: `${task.prompt} Finish with the source system, record ids, and facts supporting your answer.`,
    grade: ctx => [...task.grade(ctx), ...correctnessChecks(spec, ctx.world, ctx.trace)],
    reference: async ctx => { await task.reference(ctx); ctx.answer(spec.referenceAnswer); },
  };
}

/** Existing outcome graders remain, with source/evidence requirements added. */
export const EXISTING_CORRECTNESS: Record<string, Correctness> = {
  "cross-connector-join": {
    destination: w => called(w, "tracker.search_issues") && called(w, "analytics.get_account_metrics", { accountId: "acc_06" }) && called(w, "chat.post_message", { channel: "triage" }),
    evidence: [/tracker/i, /analytics/i, /API-207/, /Stark/i, /56[, ]?500|56\.5k/i],
    referenceAnswer: "Tracker API-207 affects Stark Industries. Analytics acc_06 MRR is $56,500. Posted to #triage.",
  },
  "stale-close-and-summarize": {
    destination: w => ["WEB-103", "WEB-105", "WEB-107", "WEB-110"].every(id => called(w, "tracker.close_issue", { id })) && called(w, "chat.post_message", { channel: "eng" }),
    evidence: [/tracker/i, /WEB-103/, /WEB-105/, /WEB-107/, /WEB-110/, /closed/i],
    referenceAnswer: "Tracker closed WEB-103, WEB-105, WEB-107 and WEB-110. Posted the closure summary to #eng.",
  },
  "auth-required-recovery": {
    destination: w => called(w, "billing.list_invoices", { customerId: "cus_N7" }) && called(w, "chat.post_message", { channel: "finance" }),
    evidence: [/billing/i, /Northwind Traders/i, /5[,]?650\.50/, /in_1002/, /in_1003/, /in_1005/],
    referenceAnswer: "Billing Northwind Traders cus_N7 owes $5,650.50 on in_1002, in_1003 and in_1005. Posted to #finance.",
  },
  "truncated-read-paging": {
    destination: w => called(w, "ci.get_run_log", { runId: 4812 }) && called(w, "chat.post_message", { channel: "ci" }),
    evidence: [/\bCI\b/i, /4812/, /test\/payments\/refund\.test\.ts/, /409/],
    referenceAnswer: "CI run 4812 failed test/payments/refund.test.ts with status 409. Posted to #ci.",
  },
  "truncated-write-export": {
    destination: w => called(w, "audit.export_events") && called(w, "chat.post_message", { channel: "security" }),
    evidence: [/audit/i, /prod-db/, /project\.deleted/, /dana\.whitfield@example\.com/],
    referenceAnswer: "Audit export shows prod-db project.deleted by dana.whitfield@example.com. Posted to #security.",
  },
  "p2-build-page": {
    destination: w => called(w, "tracker.search_issues") && called(w, "analytics.get_account_metrics") &&
      called(w, "chat.post_message", { channel: "triage" }) && Boolean(w.artifacts?.artifacts.some(a => a.id === "open-bugs")),
    evidence: [/tracker/i, /analytics/i, /\/artifacts\/open-bugs/, /7/, /3/, /2/],
    referenceAnswer: "Tracker open bugs: web 7, api 3, mobile 2. Analytics supplies MRR. Shared /artifacts/open-bugs in #triage.",
  },
  "p2-fix-chart-title": {
    destination: (w, t) => direct(t, "call_destructive_tool", "artifacts.patch_artifact") && Boolean(w.artifacts?.artifacts.some(a => a.id === "open-bugs")),
    evidence: [/artifact/i, /open-bugs/, /Open bugs by project/, /patch|title/i],
    referenceAnswer: "Patched the open-bugs artifact chart title to Open bugs by project.",
  },
  "p2-refresh-weekly": {
    destination: (w, t) => direct(t, "call_destructive_tool", "artifacts.set_refresh") && called(w, "tracker.search_issues") && Boolean(w.artifacts?.artifacts.some(a => a.id === "open-bugs")),
    evidence: [/open-bugs/, /weekly/i, /\b8\b/, /tracker/i],
    referenceAnswer: "The open-bugs weekly refresh read the tracker after WEB-999 arrived; web count is now 8.",
  },
};
