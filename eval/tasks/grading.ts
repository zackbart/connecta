/** Every task check is classified here. Unknown or missing entries fail closed. */
import type { ActiveTask, Check } from "./types.js";
import type { AgentTrace } from "../agent/trace.js";
import type { World } from "../fakes/world.js";
import type { Surface } from "../agent/surface.js";
import { downstreamMetrics } from "../agent/trace.js";

export type Grading = "route" | "outcome";
export function parseGrading(value = "route"): Grading {
  if (value !== "route" && value !== "outcome") throw new Error("--grading must be route or outcome");
  return value;
}

const common = { route: [], outcome: ["correct-destination", "answer-evidence"] };
export const CHECK_KINDS: Record<string, { route: string[]; outcome: string[] }> = {
  "cross-connector-join": {
    route: [],
    outcome: ["one-post", "no-stray-posts", "names-issue", "names-customer", "states-mrr", "no-unrequested-writes"],
  },
  "stale-close-and-summarize": {
    route: [],
    outcome: [
      "closed-exactly-stale",
      "each-write-once",
      "no-other-tracker-writes",
      "one-post",
      "no-stray-posts",
      "summary-lists-closed",
      "summary-after-writes",
    ],
  },
  "auth-required-recovery": {
    route: ["handed-off-route"],
    outcome: [
      "handed-off",
      "handed-off-once",
      "retried-read",
      "one-post",
      "no-stray-posts",
      "correct-total",
      "no-unrequested-writes",
    ],
  },
  "truncated-read-paging": {
    route: ["paged"],
    outcome: [
      "one-post",
      "no-stray-posts",
      "found-real-failure",
      "not-the-flake",
      "log-read-once",
      "no-unrequested-writes",
    ],
  },
  "truncated-write-export": {
    route: ["paged"],
    outcome: [
      "export-once",
      "one-post",
      "no-stray-posts",
      "found-deleter",
      "not-the-requester",
      "no-unrequested-writes",
    ],
  },
  "p5-trusted-program-write": { route: ["program-write"], outcome: ["write-once"] },
  "p5-read-only-program-refusal": {
    route: ["refusal-route"],
    outcome: ["refusal", "structured-outcome", "zero-writes"],
  },
  "p5-result-paging": { route: ["result-api"], outcome: ["one-fetch"] },
  "p5-direct-rich-output": { route: ["image-route"], outcome: ["image-delivered"] },
  "p5-program-image": { route: ["image-route"], outcome: ["image-delivered"] },
  "p5-auth-url-capable": { route: [], outcome: ["connect-visited", "host-mode", "zero-writes"] },
  "p5-auth-connect-incapable": { route: [], outcome: ["connect-visited", "host-mode", "agent-handoff", "zero-writes"] },
  // These check actual budget, prerequisite, URI and discovery behavior, not a top-level route.
  "p5-fanout-over-budget": { route: [], outcome: ["bounded-fanout", "terminal-budget", "reads-only"] },
  "p5-mixpanel-bootstrap": { route: [], outcome: ["bootstrap-order"] },
  "p5-revenuecat-text": { route: [], outcome: ["resolved-project", "authoritative-access"] },
  "p5-supabase-project-ref": { route: [], outcome: ["no-wrong-project"] },
  "p5-absent-github": { route: [], outcome: ["no-lookalike-call", "states-absence", "structured-answer"] },
  "p5-known-read-routing": { route: ["direct-read"], outcome: ["one-read", "reads-only"] },
  "p5-connecta-read": { route: [], outcome: ["program-resource-read", "reads-only"] },
};
const OUTER: Record<string, Grading> = {
  "conversation-completed": "outcome",
  "no-confirmation-needed": "outcome",
  "no-duplicate-writes": "outcome",
};

export function classifyChecks(task: string, checks: Check[]): Check[] {
  const kinds = CHECK_KINDS[task];
  if (!kinds) throw new Error(`No check classification for ${task}`);
  return checks.map((check) => {
    const kind =
      OUTER[check.id] ??
      (kinds.route.includes(check.id)
        ? "route"
        : [...common.outcome, ...kinds.outcome].includes(check.id)
          ? "outcome"
          : undefined);
    if (!kind) throw new Error(`Unclassified check ${task}/${check.id}`);
    return { ...check, kind };
  });
}

export function passes(checks: Check[], grading: Grading = "route"): boolean {
  return checks.every((c) => c.advisory || (grading === "outcome" && c.kind === "route") || c.pass);
}

export function gradeTask(
  task: ActiveTask,
  context: { world: World; trace: AgentTrace },
  surface: Surface = "six",
  grading: Grading = "route",
): Check[] {
  const duplicateWrites = downstreamMetrics(context.world.ledger.calls, []).duplicateWrites;
  return classifyChecks(task.id, [
    ...task.grade({ ...context, surface, grading }),
    {
      id: "no-duplicate-writes",
      description: "no identical downstream write was dispatched twice",
      pass: duplicateWrites === 0,
      detail: `${duplicateWrites} duplicate write(s)`,
    },
  ]);
}
