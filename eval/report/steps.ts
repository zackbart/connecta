/**
 * Step metrics from a trial's saved grading inputs: the ordered MCP calls and
 * guest bridge calls an agent actually made. No new trial field is recorded,
 * so any saved trial can be measured. These are diagnostics; graders never
 * read them.
 */
import type { TrialResult } from "../agent/run.js";
import { NEXT_HINTS } from "../deploy/step-arms.js";

type StepKind = "discovery" | "guide" | "vendor" | "other";
interface Step {
  kind: StepKind;
  address?: string;
  ok: boolean;
  code?: string;
  top: boolean;
  /** Which top-level use this step belongs to. */
  topIndex: number;
  /** The guide a guide step fetched. */
  guide?: string;
}

export interface TrialSteps {
  topLevelSteps: number;
  nestedCalls: number;
  discoverySteps: number;
  /** Every step before the first successful vendor call; absent when none succeeded. */
  stepsToFirstVendorOk: number | undefined;
  /** Top-level round trips up to and including that call. */
  topStepsToFirstVendorOk: number | undefined;
  /** Refused guesses about an operation's location: a wrong path, or an unknown tool or operation. */
  wrongPathErrors: number;
  invalidArgs: number;
  unknownTool: number;
  /** Further failed attempts after a first invalid_args/unknown_tool, before a success on that connector. */
  retriesToSuccess: number;
  /** invalid_args/unknown_tool failures no later success on that connector resolved. */
  unresolvedErrors: number;
  /** Discovery steps between a successful hinted list and the next vendor call. */
  searchesBetweenListAndDetail: number;
  /** A failed call to one tool of an overlapping group, then a call to another tool of that group. */
  wrongToolCalls: number;
  guideFetches: number;
  /** Vendor calls on a connector before its connector guide was fetched in this trial. */
  callsBeforeGuide: number;
}

const OVERLAP_GROUPS = [
  ["vercel_rest.upsert_project_env_var", "vercel_rest.update_project_env_var"],
  ["vercel_rest.get_deployment_build_logs", "vercel_rest.get_runtime_logs"],
];

function kindOf(address: string | undefined): StepKind {
  if (!address) return "other";
  return /_api_(?:search|details)$/.test(address) ? "discovery" : "vendor";
}

/** `{ok:false,error:{code}}` on a top-level reply; absent on anything else. */
function replyCode(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  try {
    const code = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return /"code"\s*:\s*"([a-z_]+)"/.exec(text)?.[1];
  }
}

function trialFlow(trial: TrialResult): Step[] {
  const uses = trial.saved?.trace?.toolUses ?? [];
  const programs = [...(trial.saved?.world?.programs ?? [])];
  const steps: Step[] = [];
  // A host's own tool loading is not a Connecta step, on any arm.
  uses
    .filter((use) => use.tool !== "ToolSearch")
    .forEach((use, topIndex) => {
      const input = (use.input ?? {}) as Record<string, unknown>;
      if (use.tool === "execute_code") {
        // Programs are recorded in dispatch order inside the executor's wrapper; a refused request has none.
        const source = typeof input.code === "string" ? input.code : "";
        const at = programs.findIndex((program) => source !== "" && program.code.includes(source));
        const program = at >= 0 ? programs.splice(at, 1)[0] : undefined;
        if (!program) {
          steps.push({ kind: "other", ok: use.isError !== true, top: true, topIndex });
          return;
        }
        program.calls.forEach((call, index) => {
          const ok = call.outcome === "ok";
          const code = call.errorCode;
          const base = { ok, ...(code ? { code } : {}), top: index === 0, topIndex };
          if (call.name === "connecta.call") {
            const address = String(call.args[0]);
            steps.push({ ...base, kind: kindOf(address), address });
          } else if (call.name === "connecta.skill")
            steps.push({ ...base, kind: "guide", guide: String(call.args[0]) });
          else if (call.name === "connecta.search" || call.name === "connecta.describe")
            steps.push({ ...base, kind: "discovery" });
          else steps.push({ ...base, kind: "other" });
        });
        if (!program.calls.length) steps.push({ kind: "other", ok: use.isError !== true, top: true, topIndex });
        return;
      }
      const ok = use.isError !== true;
      const code = ok ? undefined : replyCode(use.resultText);
      const base = { ok, ...(code ? { code } : {}), top: true, topIndex };
      if (use.tool === "call_tool" || use.tool === "call_destructive_tool") {
        const address = String(input.address ?? "");
        steps.push({ ...base, kind: kindOf(address), address });
      } else if (use.tool === "search_tools") steps.push({ ...base, kind: "discovery" });
      else if (use.tool === "skills")
        steps.push(
          typeof input.name === "string" && input.name
            ? { ...base, kind: "guide", guide: input.name }
            : { ...base, kind: "discovery" },
        );
      else steps.push({ ...base, kind: "other" });
    });
  return steps;
}

const connectorOf = (address: string | undefined) => address?.slice(0, address.indexOf("."));

function stepsOf(flow: readonly Step[]): TrialSteps {
  const first = flow.findIndex((step) => step.kind === "vendor" && step.ok);
  const repaired = (step: Step) => step.code === "invalid_args" || step.code === "unknown_tool";
  let retriesToSuccess = 0;
  let unresolvedErrors = 0;
  // Walk each connector's run of failures: the first is the wrong guess, the rest are retries.
  const open = new Map<string, number>();
  for (const step of flow) {
    const connector = connectorOf(step.address);
    if (!connector) continue;
    if (repaired(step)) {
      if (open.has(connector)) {
        retriesToSuccess += 1;
        open.set(connector, open.get(connector)! + 1);
      } else open.set(connector, 1);
    } else if (step.ok && step.kind === "vendor") open.delete(connector);
  }
  for (const count of open.values()) unresolvedErrors += count;
  let searchesBetweenListAndDetail = 0;
  flow.forEach((step, index) => {
    const connector = connectorOf(step.address);
    const tool = connector ? step.address!.slice(connector.length + 1) : "";
    if (!step.ok || !connector || !NEXT_HINTS[connector]?.[tool]) return;
    for (const next of flow.slice(index + 1)) {
      if (next.kind === "vendor") break;
      if (next.kind === "discovery") searchesBetweenListAndDetail += 1;
    }
  });
  let wrongToolCalls = 0;
  flow.forEach((step, index) => {
    if (step.ok || !step.address) return;
    const group = OVERLAP_GROUPS.find((members) => members.includes(step.address!));
    if (!group) return;
    const next = flow.slice(index + 1).find((later) => later.address && group.includes(later.address));
    if (next && next.address !== step.address) wrongToolCalls += 1;
  });
  const fetched = new Set<string>();
  let callsBeforeGuide = 0;
  for (const step of flow) {
    if (step.guide) fetched.add(step.guide);
    const connector = connectorOf(step.address);
    if (step.kind === "vendor" && connector && !fetched.has(`connector:${connector}`)) callsBeforeGuide += 1;
  }
  return {
    topLevelSteps: new Set(flow.map((step) => step.topIndex)).size,
    nestedCalls: flow.filter((step) => !step.top).length,
    discoverySteps: flow.filter((step) => step.kind === "discovery").length,
    stepsToFirstVendorOk: first < 0 ? undefined : first,
    topStepsToFirstVendorOk: first < 0 ? undefined : new Set(flow.slice(0, first + 1).map((s) => s.topIndex)).size,
    wrongPathErrors: flow.filter(
      (step) =>
        step.code === "unknown_tool" ||
        step.code === "not_found" ||
        (step.code === "invalid_args" && /_api_/.test(step.address ?? "")),
    ).length,
    invalidArgs: flow.filter((step) => step.code === "invalid_args").length,
    unknownTool: flow.filter((step) => step.code === "unknown_tool").length,
    retriesToSuccess,
    unresolvedErrors,
    searchesBetweenListAndDetail,
    wrongToolCalls,
    guideFetches: flow.filter((step) => step.kind === "guide").length,
    callsBeforeGuide,
  };
}

export function trialSteps(trial: TrialResult): TrialSteps {
  return stepsOf(trialFlow(trial));
}

const TREATMENT: Readonly<Record<string, RegExp>> = {
  "teach-errors": /"teach":\{/,
  "ready-rows": /"call":\{"address":/,
  "next-hints": /"nextStep":\{/,
  "merged-tools": /upsert_project_env\b|vercel_rest\.get_logs/,
};

/** Replies in this trial carrying the arm's treatment. An arm that rarely fires cannot be judged. */
export function treatmentExposures(trial: TrialResult, arm: string): number {
  const pattern = TREATMENT[arm];
  if (!pattern) return 0;
  const replies = [
    ...(trial.saved?.trace?.toolUses ?? []).map((use) => use.resultText ?? ""),
    ...(trial.saved?.world?.programs ?? []).flatMap((program) =>
      program.calls.map((call) => JSON.stringify(call.result ?? {})),
    ),
  ];
  return replies.filter((text) => pattern.test(text.replace(/\\"/g, '"'))).length;
}

/**
 * Paired deltas of arm minus control, lower is better. `pairsNeeded` is the
 * smallest number of decisive pairs at this win rate whose two-sided sign test
 * reaches 0.05: a stopping estimate, not a significance claim.
 */
export function signTest(deltas: readonly number[]): {
  better: number;
  worse: number;
  tied: number;
  pairsNeeded: number | undefined;
} {
  const better = deltas.filter((delta) => delta < 0).length;
  const worse = deltas.filter((delta) => delta > 0).length;
  const decisive = better + worse;
  const rate = decisive ? Math.max(better, worse) / decisive : 0;
  let pairsNeeded: number | undefined;
  if (rate > 0.5) {
    const choose = (n: number, k: number) => {
      let value = 1;
      for (let i = 1; i <= k; i++) value = (value * (n - k + i)) / i;
      return value;
    };
    for (let n = 2; n <= 2000; n++) {
      const wins = Math.ceil(n * rate);
      let tail = 0;
      for (let k = wins; k <= n; k++) tail += choose(n, k) / 2 ** n;
      if (n > 1000) break;
      if (Math.min(1, 2 * tail) <= 0.05) {
        pairsNeeded = n;
        break;
      }
    }
  }
  return { better, worse, tied: deltas.length - decisive, pairsNeeded };
}
