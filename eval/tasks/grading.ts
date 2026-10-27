import { GOOGLE_EXPECTED } from "./google.js";
import { GOOGLE_PRODUCTS } from "../fakes/google.js";
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
  "granola-workspace-journey": { route: [], outcome: ["delivered-data", "privacy", "read-only"] },
  "quickbooks-write-journey": {
    route: [],
    outcome: [
      "delivered-data",
      "budget",
      "contradictions",
      "physical-intents",
      "customer-state",
      "invoice-state",
      "invoice-body",
      "unknown-no-replay",
      "refusal",
      "privacy",
      "company-isolation",
    ],
  },
  "quickbooks-accounting-journey": {
    route: [],
    outcome: ["delivered-data", "privacy", "durable-rotation", "revoked", "reads-only"],
  },
  ...Object.fromEntries(
    GOOGLE_PRODUCTS.flatMap((product) =>
      Array.from({ length: 7 }, (_, i) => {
        const task = i + 1;
        const readOnly =
          task < 4 ||
          (task === 4 && ["gmail", "drive"].includes(product)) ||
          (task === 7 && ["gmail", "sheets"].includes(product));
        return [
          `google-${product}-${task}`,
          {
            route: [],
            outcome: [
              ...(readOnly ? ["reads-only"] : ["only-requested-writes", "once", "state"]),
              ...(task === 6 ? ["reconciled"] : []),
              ...((GOOGLE_EXPECTED[product][i] as Record<string, unknown>).ids ? ["complete-evidence"] : []),
              ...(task === 3 ? ["full-pages"] : []),
              ...((task === 3 && ["docs", "sheets"].includes(product)) ||
              (product === "drive" && task === 2) ||
              (product === "docs" && task === 7)
                ? ["delivered-data"]
                : []),
              ...(task === 2 && ["docs", "sheets", "slides"].includes(product) ? ["joined"] : []),
              ...(product === "drive" && task === 4 ? ["revisions"] : []),
              ...(product === "sheets" && task === 7 ? ["metadata-read"] : []),
              ...(product === "forms" && task === 7 ? ["fresh-revision"] : []),
              ...(product === "gmail" && task === 7 ? ["attachments-preserved"] : []),
              "hatch-diagnostic",
            ],
          },
        ];
      }),
    ),
  ),
  ...Object.fromEntries(
    ["filtered-dns", "account-zone-join", "dns-paging", "kv-hatch", "analytics"].map((suffix) => [
      `cloudflare-step2-${suffix}`,
      { route: [], outcome: ["reads-only"] },
    ]),
  ),
  "cloudflare-step2-purge-once": { route: [], outcome: ["once", "state", "only-requested-writes"] },
  "cloudflare-step2-dns-recovery": { route: [], outcome: ["once", "state", "only-requested-writes", "reconciled"] },
  ...Object.fromEntries(
    ["filtered-individuals", "family-group-join", "individual-paging", "advanced-search", "campus-hatch"].map((s) => [
      `ccb-${s}`,
      { route: [], outcome: ["reads-only", ...(s === "advanced-search" ? ["delivered-data"] : [])] },
    ]),
  ),
  ...Object.fromEntries(
    ["update-once", "update-recovery"].map((s) => [
      `ccb-${s}`,
      { route: [], outcome: ["state", "only-requested-writes", "reconciled"] },
    ]),
  ),
  ...Object.fromEntries(
    [
      "filtered-deployments",
      "team-project-alias",
      "deployment-paging",
      "domain-hatch",
      "bounded-logs",
      "env-once",
      "env-recovery",
    ].map((suffix) => [
      `vercel-step2-${suffix}`,
      {
        route: [],
        outcome: [
          "secret-safe",
          ...(suffix.startsWith("env-")
            ? ["state", "once", ...(suffix === "env-recovery" ? ["reconciled"] : [])]
            : ["reads-only"]),
        ],
      },
    ]),
  ),
  ...Object.fromEntries(
    ["scope-balance", "filtered-customers", "decline-join", "customer-paging", "tax-settings"].map((suffix) => [
      `stripe-step2-${suffix}`,
      { route: [], outcome: ["reads-only"] },
    ]),
  ),
  "stripe-step2-refund-once": { route: [], outcome: ["state", "once", "only-requested-writes"] },
  "stripe-step2-refund-recovery": { route: [], outcome: ["state", "once", "only-requested-writes", "reconciled"] },
  "801-stripe-failed-payment": { route: [], outcome: ["reads-only", "no-guessed-search", "efficient-route"] },
  "801-stripe-guessed-parameter-recovery": { route: [], outcome: ["recovery", "reads-only"] },
  "801-stripe-idempotent-refund": { route: [], outcome: ["state", "idempotency", "only-requested-writes"] },
  "801-cloudflare-dns-ttl": { route: [], outcome: ["state", "only-requested-writes", "efficient-route"] },
  "801-cloudflare-pin-refusal": { route: [], outcome: ["zero-writes", "no-bypass"] },
  "801-cloudflare-read-only-analytics": { route: [], outcome: ["reads-only"] },
  "801-vercel-failed-build": { route: [], outcome: ["no-stream", "reads-only", "efficient-route"] },
  "801-vercel-env-value-safety": { route: [], outcome: ["state", "value-safety", "only-requested-writes"] },
  "pco-step2-filtered-people": { route: [], outcome: ["reads-only", "filtered"] },
  "pco-step2-group-services-join": { route: [], outcome: ["reads-only"] },
  "pco-step2-plan-join": { route: [], outcome: ["reads-only", "delivered-data"] },
  "pco-step2-people-paging": { route: [], outcome: ["reads-only"] },
  "pco-step2-merger-hatch": { route: [], outcome: ["reads-only"] },
  "pco-step2-note-once": { route: [], outcome: ["state", "only-requested-writes"] },
  "pco-step2-update-recovery": { route: [], outcome: ["state", "only-requested-writes", "reconciled"] },
  "github-filtered-issues": { route: [], outcome: ["reads-only"] },
  "github-repository-pr-join": { route: [], outcome: ["reads-only"] },
  "github-repository-paging": { route: [], outcome: ["reads-only"] },
  "github-contents-hatch": { route: [], outcome: ["reads-only"] },
  "github-release-once": { route: [], outcome: ["state", "only-requested-writes"] },
  "github-merge-once": { route: [], outcome: ["state", "only-requested-writes"] },
  "github-search-recovery": { route: [], outcome: ["reads-only", "recovered"] },
  "overflow-filtered-gifts": { route: [], outcome: ["reads-only"] },
  "overflow-recurring-join": { route: [], outcome: ["reads-only"] },
  "overflow-donor-paging": { route: [], outcome: ["reads-only", "delivered-data"] },
  "overflow-deposit-reconciliation": { route: [], outcome: ["reads-only"] },
  "overflow-tap-hatch": { route: [], outcome: ["reads-only"] },
  "overflow-refund-once": { route: [], outcome: ["state", "only-requested-writes", "reconciled"] },
  "overflow-donor-update-recovery": { route: [], outcome: ["state", "only-requested-writes", "reconciled"] },
  "breeze-filtered-people": { route: [], outcome: ["reads-only", "filtered"] },
  "breeze-attendance-join": { route: [], outcome: ["reads-only"] },
  "breeze-people-paging": { route: [], outcome: ["reads-only"] },
  "breeze-pledge-hatch": { route: [], outcome: ["reads-only"] },
  "breeze-create-once": { route: [], outcome: ["state", "only-requested-writes"] },
  "breeze-update-recovery": { route: [], outcome: ["state", "only-requested-writes", "reconciled"] },
  "breeze-giving-totals": { route: [], outcome: ["reads-only"] },
  "tithely-fund-totals": { route: [], outcome: ["reads-only", "date-filter"] },
  "tithely-recurring-join": { route: [], outcome: ["reads-only"] },
  "tithely-account-paging": { route: [], outcome: ["reads-only"] },
  "tithely-widget-hatch": { route: [], outcome: ["reads-only"] },
  "tithely-donor-contact": { route: [], outcome: ["reads-only"] },
  "tithely-refund-duplicate": { route: [], outcome: ["state", "only-requested-writes"] },
  "tithely-cancel-recovery": {
    route: [],
    outcome: ["no-blind-resend", "reconciled", "state", "only-requested-writes"],
  },
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
  "p5-result-paging": { route: ["result-api"], outcome: ["one-fetch", "log-facts"] },
  "p5-direct-rich-output": { route: ["image-route"], outcome: ["image-delivered"] },
  "p5-program-image": { route: ["image-route"], outcome: ["image-delivered"] },
  "p5-auth-url-capable": { route: [], outcome: ["connect-visited", "host-mode", "zero-writes"] },
  "p5-auth-connect-incapable": { route: [], outcome: ["connect-visited", "host-mode", "agent-handoff", "zero-writes"] },
  // These check actual budget, prerequisite, URI and discovery behavior, not a top-level route.
  "p5-fanout-over-budget": { route: [], outcome: ["bounded-fanout", "terminal-budget", "reads-only"] },
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
