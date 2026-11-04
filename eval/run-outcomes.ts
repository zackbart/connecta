/**
 * `pnpm run eval:outcomes [--out path]` — the required behavioral check: a
 * few representative tasks played by their scripted references against fresh
 * fake vendors and the published-edge Node deployment (SQLite, QuickJS,
 * stored agent tokens). No CLI, model, login or external network.
 *
 * Each reference must pass and doing nothing must fail, graded on downstream
 * state, the physical write ledger and the final answer rather than the route.
 * The controls then prove the yardstick cannot pass a real mutation to the
 * wrong place, a duplicate write, a missing final completion, an interrupted
 * trial, or an agent batch with omitted, skipped or cached-only results.
 *
 * Failures exit nonzero and save their grading inputs to the results file.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { playReference } from "./agent/reference.js";
import { regradeTrial } from "./agent/regrade.js";
import type { TrialResult } from "./agent/run.js";
import { saveGradeInputs } from "./agent/saved.js";
import { batchFailures, trialOutcome } from "./agent/verdict.js";
import type { AgentResultFile } from "./report/summary.js";
import { flags, ROOT, runMeta, stamp } from "./support/meta.js";
import { isDeepStrictEqual } from "node:util";
import { QB_COMPANIES } from "./deploy/quickbooks.js";
import { CCB_NEW_EMAIL, CCB_TARGET, ccbState } from "./fakes/ccb.js";
import { QB_PRIVATE, quickbooksState, runSearch } from "./fakes/quickbooks.js";
import { followDossier } from "./tasks/quickbooks.js";
import { followPlan } from "./tasks/quickbooks-writes.js";
import { overflowState } from "./fakes/overflow.js";
import { ACTIVE_TASKS } from "./tasks/index.js";
import { deliveredReducedCount, deliveredValues } from "./tasks/correctness.js";
import { NO_CODE_CAPABILITY_MISMATCHES, taskForSurface } from "./tasks/surface.js";
import { noCodeDecisionLines, WORKER_COMPARISON } from "./worker-comparison-plan.js";
import type { Surface } from "./agent/surface.js";
import { PROVIDER_EVALS } from "./tasks/providers.generated.js";
import type { ActiveTask } from "./tasks/types.js";

/** Provider-local outcome enrollments (src/providers/<name>/eval/tasks.ts), played first. */
const PROVIDER_OUTCOMES = PROVIDER_EVALS.flatMap(({ tasks }) => Object.entries(tasks.outcomes ?? {}));

const SCENARIOS: Record<string, string> = {
  ...Object.fromEntries(PROVIDER_OUTCOMES.map(([id, outcome]) => [id, outcome.scenario])),
  "cross-connector-join": "join two paged sources, then post one answer",
  "p5-result-paging": "page a retained result without refetching",
  "stripe-step2-refund-once": "one requested refund, no other mutation",
  "stripe-step2-refund-recovery": "reconcile a committed write answered HTTP 500 without a second refund",
  "p5-read-only-program-refusal": "a read-only pool refuses the write and the agent says so",
  "p5-auth-connect-incapable": "identity-checked /connect handoff through an incapable host",
  "801-vercel-env-value-safety": "rotate a secret without ever reading or echoing a value",
  "ccb-advanced-search": "route a read-only POST search without mutating church records",
  "pco-step2-plan-join": "join Services plans, items and scheduled people in a read-only pool",
  "breeze-update-recovery": "reconcile a GET-shaped mutation without repeating it",
  "overflow-donor-paging": "count matching donors across every vendor page",
  "google-gmail-7": "refuse to rebuild a draft with carried attachments and preserve its MIME parts",
  "google-forms-7": "recover from a revision conflict before changing the form once",
  "google-docs-3": "page document indexes without losing paragraph positions",
  "google-sheets-3": "page whole rows across ranges and retain every requested cell",
  "google-slides-7": "report a saved deck separately from an unconfirmed comment",
  "tithely-cancel-recovery": "reconcile a cancelled recurring gift without repeating the cancellation",
  "github-release-once": "create one draft release with the requested repository, tag and body",
  "github-ci-scope-gap": "report one repository's permission gap and finish a CI read on another",
  "cloudflare-step2-dns-recovery": "reconcile a committed DNS update after a failed acknowledgement",
  "vercel-step2-env-recovery": "reconcile a committed environment update without exposing the secret",
  "google-drive-2": "distinguish direct permissions from inherited shared-drive access",
  "google-docs-7": "recover the created document id after its initial text failed to save",
  "quickbooks-accounting-journey": "actual company accounting, consent, restart, rotation, privacy and isolation",
  "quickbooks-write-journey": "actual names, CAS conflict, unsent invoices and read reconciliation",
};

const args = flags(process.argv.slice(2));
const out = resolve(args.get("out") ?? join(ROOT, "eval", "results", `outcomes-${stamp()}.json`));
const watchdog = setTimeout(() => {
  console.error("[outcomes] FAIL: exceeded 10 minutes");
  process.exit(1);
}, 10 * 60_000);
watchdog.unref();

interface Row {
  name: string;
  pass: boolean;
  detail?: string;
  trial?: TrialResult;
}
const rows: Row[] = [];
const record = (name: string, pass: boolean, detail?: string, trial?: TrialResult) => {
  rows.push({ name, pass, ...(detail ? { detail } : {}), ...(trial && !pass ? { trial } : {}) });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

function task(id: string): ActiveTask {
  const found = ACTIVE_TASKS.find((t) => t.id === id);
  if (!found) throw new Error(`No active task ${id}`);
  return found;
}

type Call = Parameters<ActiveTask["reference"]>[0]["call"];

/** Play once and grade the saved inputs exactly as a finished Codex trial would be regraded. */
async function trial(
  t: ActiveTask,
  mode: "reference" | "noop",
  wrap?: (call: Call) => Call,
  surface: Surface = "six",
): Promise<TrialResult> {
  t = taskForSurface(t, surface);
  const played = wrap
    ? {
        ...t,
        reference: (ctx: Parameters<ActiveTask["reference"]>[0]) => t.reference({ ...ctx, call: wrap(ctx.call) }),
      }
    : t;
  const saved = await playReference(played, { mode, surface }, ({ world, trace }) =>
    structuredClone(saveGradeInputs(world, trace)),
  );
  const turns = saved.trace.resultSubtypes.length;
  const finished: TrialResult = {
    task: t.id,
    runner: "codex",
    surface,
    grading: "outcome",
    model: "reference",
    repeat: 1,
    status: "pass",
    saved,
    checks: [],
    metrics: {
      wallMs: 0,
      apiMs: 0,
      modelTurns: 0,
      conversationTurns: turns,
      tokens: saved.trace.tokens,
      costUsd: undefined,
      metaTools: {},
      otherTools: {},
      toolErrors: 0,
      confirmationNudges: 0,
      downstream: {
        reads: 0,
        writes: 0,
        duplicateReads: 0,
        duplicateWrites: 0,
        errors: 0,
        unauthorizedRequests: 0,
        byTool: {},
      },
    },
    approvals: { allowed: [], denied: [], gated: [], exercised: [], permissionDenials: [] },
    transcript: saved.trace.transcript,
    finalAnswer: saved.trace.finalAnswer ?? "",
    ledger: [],
    codex: {
      requestedModel: "reference",
      servedModel: "reference",
      version: "scripted",
      exitCode: 0,
      timedOut: false,
      aborted: false,
      resultSubtypes: saved.trace.resultSubtypes,
      stderrTail: "",
      argv: [],
      loadedTools: [],
    },
    startedAt: new Date().toISOString(),
  };
  return regradeTrial(t, finished, "codex", "outcome");
}

const passed = (t: TrialResult) => trialOutcome(t, "codex", "outcome").pass;
const failedChecks = (t: TrialResult) =>
  t.checks
    .filter((c) => !c.pass && !c.advisory && c.kind !== "route")
    .map((c) => c.id)
    .join(", ");

// ---------------------------------------------------------------- scenarios

async function run() {
  const references: TrialResult[] = [];
  const selected = args.get("tasks")?.split(",");
  if (selected?.some((id) => !(id in SCENARIOS))) throw new Error("Unknown required outcome task");
  const scenarios = Object.fromEntries(Object.entries(SCENARIOS).filter(([id]) => !selected || selected.includes(id)));
  for (const [id, what] of Object.entries(scenarios)) {
    const reference = await trial(task(id), "reference");
    references.push(reference);
    record(
      `${id}: ${what}`,
      passed(reference),
      passed(reference) ? undefined : `failed ${failedChecks(reference)}`,
      reference,
    );
    const noop = await trial(task(id), "noop");
    record(`${id}: doing nothing fails`, !passed(noop), undefined, noop);
    const fabricated = structuredClone(noop);
    fabricated.finalAnswer = reference.finalAnswer ?? "";
    fabricated.saved!.trace.finalAnswer = reference.finalAnswer ?? "";
    const grade = regradeTrial(task(id), fabricated, "codex", "outcome");
    record(`${id}: a fabricated answer without the work fails`, !passed(grade), failedChecks(grade), grade);
  }

  for (const [id, { withoutCalls }] of PROVIDER_OUTCOMES) {
    const reference = withoutCalls && references.find((t) => t.task === id);
    if (!reference) continue;
    const fabricated = structuredClone(reference);
    fabricated.saved!.world.calls = [];
    const grade = regradeTrial(task(id), fabricated, "codex", "outcome");
    record(
      `control: fabricated ${withoutCalls} without physical reads fails`,
      !passed(grade),
      failedChecks(grade),
      grade,
    );
  }
  const quickbooks = references.find((t) => t.task === "quickbooks-accounting-journey");
  if (quickbooks) {
    const fabricated = structuredClone(quickbooks);
    fabricated.saved!.world.calls = [];
    const fakeGrade = regradeTrial(task(quickbooks.task), fabricated, "codex", "outcome");
    record(
      "control: fabricated QuickBooks answer without vendor reads fails",
      !passed(fakeGrade),
      failedChecks(fakeGrade),
      fakeGrade,
    );
  }
  if (quickbooks) {
    // Passable as written: other legitimate queries, renamed fields, a fenced dossier.
    const followed = await trial({ ...task(quickbooks.task), reference: followDossier }, "reference");
    record(
      "control: following the QuickBooks accounting prompt by other queries passes",
      passed(followed),
      failedChecks(followed),
      followed,
    );
    const mutated = (change: (saved: NonNullable<TrialResult["saved"]>) => void) => {
      const copy = structuredClone(followed);
      change(copy.saved!);
      return regradeTrial(task(quickbooks.task), copy, "codex", "outcome");
    };
    for (const [name, change] of [
      ["a wrong amount", (s) => (s.trace.finalAnswer = s.trace.finalAnswer!.replace("125.5", "125.6"))],
      ["a missing invoice", (s) => (s.trace.finalAnswer = s.trace.finalAnswer!.replaceAll('"43"', '"99"'))],
      ["a flattened report", (s) => (s.trace.finalAnswer = s.trace.finalAnswer!.replaceAll('"Consulting"', '"Other"'))],
      [
        "a report with its empty cells dropped",
        (s) => (s.trace.finalAnswer = s.trace.finalAnswer!.replaceAll('""', '"-"')),
      ],
      ["a leaked private value", (s) => (s.trace.finalAnswer += ` ${QB_PRIVATE}`)],
      [
        "skipped credential renewals",
        (s) => (s.world.calls = s.world.calls.filter((c) => c.args.grant !== "refresh_token")),
      ],
    ] as [string, (saved: NonNullable<TrialResult["saved"]>) => void][]) {
      const grade = mutated(change);
      record(`control: QuickBooks accounting with ${name} fails`, !passed(grade), failedChecks(grade), grade);
    }
    // Every query search_records builds runs against live rows; nothing else does.
    const company = quickbooksState().companies[QB_COMPANIES.alice]!;
    const accepted: [string, string[]][] = [
      ["SELECT * FROM Customer WHERE DisplayName = 'Alice\\'s \\\\ studio' STARTPOSITION 1 MAXRESULTS 11", ["9"]],
      ["SELECT * FROM Customer STARTPOSITION 1 MAXRESULTS 101", ["9", "11"]],
      ["SELECT * FROM Customer WHERE Active = false STARTPOSITION 1 MAXRESULTS 26", ["10"]],
      ["SELECT * FROM Invoice WHERE CustomerRef = '9' STARTPOSITION 2 MAXRESULTS 101", ["42", "43"]],
      ["SELECT * FROM Invoice WHERE CustomerRef = '9' AND Balance > 120 STARTPOSITION 1 MAXRESULTS 26", ["41", "42"]],
      ["SELECT * FROM Invoice WHERE DocNumber = 'INV-42' STARTPOSITION 1 MAXRESULTS 26", ["42"]],
      ["SELECT * FROM Invoice WHERE CustomerRef = '12345' STARTPOSITION 1 MAXRESULTS 26", []],
      ["SELECT * FROM Vendor STARTPOSITION 1 MAXRESULTS 26", []],
    ];
    const refused = [
      "",
      "select * from Invoice",
      "SELECT * FROM Employee STARTPOSITION 1 MAXRESULTS 26",
      "SELECT Id FROM Invoice STARTPOSITION 1 MAXRESULTS 26",
      "SELECT * FROM Invoice",
      "SELECT * FROM Invoice STARTPOSITION 0 MAXRESULTS 26",
      "SELECT * FROM Invoice STARTPOSITION 1 MAXRESULTS 1001",
      "SELECT * FROM Invoice WHERE Secret = 'x' STARTPOSITION 1 MAXRESULTS 26",
      "SELECT * FROM Invoice WHERE DisplayName = 'x' STARTPOSITION 1 MAXRESULTS 26",
      "SELECT * FROM Invoice WHERE CustomerRef > '9' STARTPOSITION 1 MAXRESULTS 26",
      "SELECT * FROM Invoice WHERE CustomerRef = '9' OR Id = '41' STARTPOSITION 1 MAXRESULTS 26",
      "SELECT * FROM Invoice WHERE CustomerRef = '9' AND STARTPOSITION 1 MAXRESULTS 26",
      "SELECT * FROM Customer WHERE DisplayName = 'x' OR '1'='1' STARTPOSITION 1 MAXRESULTS 26",
      "SELECT * FROM Customer WHERE DisplayName = 'unterminated STARTPOSITION 1 MAXRESULTS 26",
      "SELECT * FROM Customer WHERE Active = 'true' STARTPOSITION 1 MAXRESULTS 26",
      "SELECT * FROM Invoice; DROP TABLE Invoice STARTPOSITION 1 MAXRESULTS 26",
    ];
    const rowIds = (query: string) => {
      const rows = runSearch(company, query);
      return (
        rows &&
        Object.values(rows)
          .flat()
          .map((row) => (row as { Id: string }).Id)
      );
    };
    const wrongAccepted = accepted.filter(([query, ids]) => !isDeepStrictEqual(rowIds(query), ids));
    record(
      "control: the QuickBooks fake answers every search_records query from live rows",
      wrongAccepted.length === 0,
      wrongAccepted.map(([query]) => `${query} -> ${JSON.stringify(rowIds(query))}`).join("; "),
    );
    const wrongRefused = refused.filter((query) => rowIds(query) !== undefined);
    record(
      "control: the QuickBooks fake refuses queries search_records cannot build",
      wrongRefused.length === 0,
      wrongRefused.join("; "),
    );
  }
  const qbWrites = references.find((t) => t.task === "quickbooks-write-journey");
  if (qbWrites) {
    // Passable as written: only the prompt's steps, with no knowledge of the reference's probes.
    const followed = await trial({ ...task(qbWrites.task), reference: followPlan }, "reference");
    record(
      "control: following the QuickBooks write prompt step by step passes",
      passed(followed),
      failedChecks(followed),
      followed,
    );
    const mutated = (change: (saved: NonNullable<TrialResult["saved"]>) => void) => {
      const copy = structuredClone(followed);
      change(copy.saved!);
      return regradeTrial(task(qbWrites.task), copy, "codex", "outcome");
    };
    for (const [name, change] of [
      [
        "the wrong race winner",
        (s) => (s.trace.finalAnswer = s.trace.finalAnswer!.replace(/"raceWinner":"[AB]"/, '"raceWinner":"C"')),
      ],
      [
        "an unknown outcome reported as known",
        (s) => (s.trace.finalAnswer = s.trace.finalAnswer!.replace('"invoice-recover",', "")),
      ],
      [
        "a resent ambiguous intent",
        (s) => {
          const resent = structuredClone(
            s.world.calls.find((c) => (c.args.query as any)?.requestid === "invoice-recover")!,
          );
          (resent.args.query as any).requestid = "invoice-recover-2";
          s.world.calls.push(resent);
        },
      ],
      [
        "no reconciliation read",
        (s) =>
          (s.world.calls = s.world.calls.filter(
            (c) => !String((c.args.query as any)?.query ?? "").includes("SERVICES-RECOVER"),
          )),
      ],
      [
        "no refused read-only attempt",
        (s) => {
          s.trace.toolUses = s.trace.toolUses.filter((u) => !JSON.stringify(u).includes("read_only_endpoint"));
        },
      ],
    ] as [string, (saved: NonNullable<TrialResult["saved"]>) => void][]) {
      const grade = mutated(change);
      record(`control: QuickBooks writes with ${name} fails`, !passed(grade), failedChecks(grade), grade);
    }
    for (const mode of ["no-dispatch", "duplicate", "fabricated-state"] as const) {
      const fabricated = structuredClone(qbWrites);
      const world = fabricated.saved!.world;
      if (mode === "no-dispatch") world.calls = world.calls.filter((c) => c.kind !== "write");
      if (mode === "duplicate") world.calls.push(structuredClone(world.calls.find((c) => c.kind === "write")!));
      if (mode === "fabricated-state") world.quickbooks!.companies["111111"]!.Invoice.pop();
      const grade = regradeTrial(task(qbWrites.task), fabricated, "codex", "outcome");
      record(`control: QuickBooks ${mode} fails`, !passed(grade), failedChecks(grade), grade);
    }
  }
  for (const id of [
    "tithely-cancel-recovery",
    "github-release-once",
    "cloudflare-step2-dns-recovery",
    "vercel-step2-env-recovery",
  ]) {
    const reference = references.find((t) => t.task === id);
    if (!reference) continue;
    const duplicated = structuredClone(reference);
    duplicated.saved!.world.calls.push(structuredClone(duplicated.saved!.world.calls.find((c) => c.kind === "write")!));
    const grade = regradeTrial(task(id), duplicated, "codex", "outcome");
    record(`${id}: duplicate physical mutation fails`, !passed(grade), failedChecks(grade), grade);
  }
  const ciGap = references.find((t) => t.task === "github-ci-scope-gap");
  if (ciGap) {
    const regressed = structuredClone(ciGap);
    for (const use of regressed.saved!.trace.toolUses)
      if (use.isError) {
        use.resultText = JSON.stringify({ error: { code: "auth_required" } });
        use.resultBlocks = [{ type: "text", text: use.resultText }];
      }
    const handoff = regradeTrial(task(ciGap.task), regressed, "codex", "outcome");
    record(
      "control: github-ci-scope-gap refusal surfaced as auth_required fails",
      !passed(handoff) && handoff.checks.some((c) => c.id === "no-credential-handoff" && !c.pass),
      failedChecks(handoff),
      handoff,
    );
    const clean = structuredClone(ciGap);
    clean.saved!.trace.finalAnswer = clean.saved!.trace.finalAnswer!.replace(/^gadget:.*$/m, "gadget: none");
    const falsePass = regradeTrial(task(ciGap.task), clean, "codex", "outcome");
    record(
      "control: github-ci-scope-gap unread repository reported clean fails",
      !passed(falsePass) && falsePass.checks.some((c) => c.id === "answer-evidence" && !c.pass),
      failedChecks(falsePass),
      falsePass,
    );
    const answerWith = (finalAnswer: string) => {
      const trial = structuredClone(ciGap);
      trial.saved!.trace.finalAnswer = finalAnswer;
      return regradeTrial(task(ciGap.task), trial, "codex", "outcome");
    };
    const finalLines = "widget: integration-tests\ngadget: unread: checks=read";
    const reset = answerWith(`Reset the GitHub credential to restore gadget access.\n${finalLines}`);
    record(
      "control: github-ci-scope-gap credential reset advised above the final lines fails",
      !passed(reset) && reset.checks.some((c) => c.id === "answer-evidence" && !c.pass),
      failedChecks(reset),
      reset,
    );
    const notNeeded = answerWith(`Resetting the credential isn't needed.\n${finalLines}`);
    record(
      "control: github-ci-scope-gap answer saying a reset isn't needed passes",
      passed(notNeeded),
      failedChecks(notNeeded),
    );
    const declined = answerWith(`The key may be fine, so do not reset the credential yet.\n${finalLines}`);
    record(
      "control: github-ci-scope-gap answer declining a credential reset passes",
      passed(declined),
      failedChecks(declined),
      declined,
    );
  }
  const tithely = references.find((t) => t.task === "tithely-cancel-recovery");
  if (tithely) {
    for (const mode of ["failed-read", "empty-object", "empty-list", "malformed", "incomplete-page"] as const) {
      const lost = structuredClone(tithely);
      const use = lost.saved!.trace.toolUses.at(-1)!;
      if (mode === "failed-read") {
        lost.saved!.world.calls.at(-1)!.outcome = "tool_error";
        use.isError = true;
        use.resultText = JSON.stringify({ error: { code: "connector_call_failed", status: 503 } });
      } else
        use.resultText =
          mode === "malformed"
            ? "upstream unavailable"
            : JSON.stringify(
                mode === "empty-object"
                  ? {}
                  : mode === "empty-list"
                    ? { items: [], page: { hasMore: false } }
                    : { ...JSON.parse(use.resultText!), page: { hasMore: true } },
              );
      use.resultBlocks = [{ type: "text", text: use.resultText! }];
      const grade = regradeTrial(task(tithely.task), lost, "codex", "outcome");
      record(
        `tithely-cancel-recovery: ${mode} cannot prove reconciliation`,
        !passed(grade) && grade.checks.some((check) => check.id === "reconciled" && !check.pass),
        failedChecks(grade),
        grade,
      );
    }
  }
  if (selected) return;

  // ----------------------------------------------- no-false-pass controls

  // Keep the real vendor ledger, continuations and canned answer intact while
  // deleting the facts delivered over MCP. Calls alone cannot prove a read.
  for (const id of [
    ...PROVIDER_OUTCOMES.filter(([, outcome]) => outcome.withoutDeliveredFacts).map(([id]) => id),
    "quickbooks-accounting-journey",
    "quickbooks-write-journey",
    "ccb-advanced-search",
    "pco-step2-plan-join",
    "overflow-donor-paging",
    "google-docs-3",
    "google-sheets-3",
    "google-drive-2",
    "google-docs-7",
    "github-ci-scope-gap",
  ]) {
    const lost = structuredClone(references.find((reference) => reference.task === id)!);
    for (const use of lost.saved!.trace.toolUses) {
      if (use.isError) continue;
      const body = JSON.parse(use.resultText ?? "{}");
      const page = body.page ?? body.result?.page;
      const text = JSON.stringify({ page, result: { page } });
      use.resultText = text;
      use.resultBlocks = [{ type: "text", text }];
      for (const entry of lost.saved!.trace.transcript) {
        if (entry.kind === "tool_result" && entry.id === use.id) {
          entry.text = text;
          entry.chars = text.length;
        }
      }
    }
    const graded = regradeTrial(task(id), lost, "codex", "outcome");
    record(
      `control: ${id} loses delivered data`,
      !passed(graded) && graded.checks.some((check) => check.id === "delivered-data" && !check.pass),
      failedChecks(graded),
      graded,
    );
  }
  const compactTrials = (
    [
      ["google-sheets-3", { ids: Array.from({ length: 6 }, (_, i) => `record${i + 1}`), total: 210 }],
      [
        "google-drive-2",
        { id: "pdf1", direct: "reviewer@example.com", inherited: "alice@example.com", driveId: "shared1" },
      ],
      ["google-docs-7", { id: "new-doc", text: "Recovered opening." }],
    ] as const
  ).map(([id, result]) => {
    const reduced = structuredClone(references.find((reference) => reference.task === id)!);
    for (const use of reduced.saved!.trace.toolUses) {
      use.resultText = "{}";
      use.resultBlocks = [{ type: "text", text: "{}" }];
    }
    reduced.saved!.trace.toolUses.at(-1)!.resultText = JSON.stringify({ result });
    for (const use of reduced.saved!.trace.toolUses) {
      use.resultBlocks = [{ type: "text", text: use.resultText! }];
      for (const entry of reduced.saved!.trace.transcript) {
        if (entry.kind === "tool_result" && entry.id === use.id) {
          entry.text = use.resultText!;
          entry.chars = entry.text.length;
        }
      }
    }
    const summary = regradeTrial(task(id), reduced, "codex", "outcome");
    record(`control: a compact delivered ${id} summary passes`, passed(summary), failedChecks(summary), summary);
    return reduced;
  });
  // A program may reduce records to a count under any field name, or rows to
  // their ids. Neither paging metadata nor the wrong number can stand in for it.
  const reduceTo = (id: string, result: unknown, tool = "execute_code") => {
    const reduced = structuredClone(references.find((reference) => reference.task === id)!);
    const uses = reduced.saved!.trace.toolUses;
    uses.forEach((use, index) => {
      use.resultText = index === uses.length - 1 ? JSON.stringify({ result, hostCalls: { attempted: 137 } }) : "{}";
      use.resultBlocks = [{ type: "text", text: use.resultText }];
      if (index === uses.length - 1) use.tool = tool;
    });
    const graded = regradeTrial(task(id), reduced, "codex", "outcome");
    return { graded, delivered: graded.checks.find((check) => check.id === "delivered-data")?.pass === true };
  };
  const inactivePeople = ccbState().people.filter((person) => !person.active);
  const careDonors = overflowState().donors.filter((donor) => donor.email.endsWith("@care.example"));
  for (const [id, count] of [
    ["ccb-advanced-search", inactivePeople.length],
    ["overflow-donor-paging", careDonors.length],
  ] as const) {
    const named = reduceTo(id, { n: count });
    record(`control: ${id} accepts a reduced count under any field name`, named.delivered, failedChecks(named.graded));
    const wrong = reduceTo(id, { n: count + 1 });
    record(`control: ${id} refuses the wrong reduced count`, !wrong.delivered, failedChecks(wrong.graded));
    const paging = reduceTo(id, { page: { hasMore: false, total: count } });
    record(`control: ${id} refuses a count from paging metadata`, !paging.delivered, failedChecks(paging.graded));
    const nestedPaging = reduceTo(id, { rows: [], pagination: { total: count } });
    record(
      `control: ${id} refuses a count from nested paging`,
      !nestedPaging.delivered,
      failedChecks(nestedPaging.graded),
    );
    const direct = reduceTo(id, { n: count }, "call_tool");
    record(`control: ${id} refuses a bare number from a direct read`, !direct.delivered, failedChecks(direct.graded));
  }
  for (const [id, records] of [
    ["ccb-advanced-search", inactivePeople],
    ["overflow-donor-paging", careDonors],
  ] as const) {
    const ids = (rows: readonly unknown[]) => ({ rows: rows.map((row) => ({ id: (row as { id: unknown }).id })) });
    const idsOnly = reduceTo(id, ids(records));
    record(`control: ${id} accepts rows reduced to id`, idsOnly.delivered, failedChecks(idsOnly.graded));
    const missing = reduceTo(id, ids(records.slice(1)));
    record(`control: ${id} refuses a missing row`, !missing.delivered, failedChecks(missing.graded));
  }

  // read_result pages are partial JSON until every byte range is present.
  const log = JSON.stringify({ rows: [{ id: 7, email: "ü@example.com" }] });
  const encoded = new TextEncoder().encode(log);
  const split = 11;
  const decode = (from: number, to: number) => new TextDecoder().decode(encoded.subarray(from, to));
  const pagedTrace = (pages: { from: number; to: number }[]) => {
    const page = ({ from, to }: { from: number; to: number }, index: number) => ({
      id: `page-${index}`,
      turn: 1,
      tool: "read_result",
      input: { id: "r1", offset: from },
      isError: false,
      resultText: `${JSON.stringify({ resultId: "r1", offset: from, bytes: to - from, totalBytes: encoded.length, hasMore: to < encoded.length })}\n${decode(from, to)}`,
    });
    return {
      ...references[0]!.saved!.trace,
      toolUses: [
        {
          id: "notice",
          turn: 1,
          tool: "call_tool",
          input: {},
          isError: false,
          resultText: `${JSON.stringify({ truncated: true, resultId: "r1", totalBytes: encoded.length, nextOffset: split })}\n${decode(0, split)}`,
        },
        ...pages.map(page),
      ],
    };
  };
  const hasRow = (pages: { from: number; to: number }[]) =>
    deliveredValues(pagedTrace(pages)).some((row) => row?.id === 7);
  record(
    "control: read_result pages reassemble in byte order before parsing",
    hasRow([
      { from: 20, to: encoded.length },
      { from: split, to: 20 },
    ]),
  );
  record("control: read_result without the final page proves nothing", !hasRow([{ from: split, to: 20 }]));
  record(
    "control: read_result with a gap proves nothing",
    !hasRow([
      { from: split, to: 15 },
      { from: 20, to: encoded.length },
    ]),
  );
  record(
    "control: a reassembled result carries no reduced count",
    !deliveredReducedCount(pagedTrace([{ from: split, to: encoded.length }]), 7),
  );

  // Native arms: what each cannot do is scored fairly, and fabrication still fails.
  const fabricated = (trial: TrialResult, answer: string) => {
    const changed = structuredClone(trial);
    changed.saved!.trace.finalAnswer = answer;
    return regradeTrial(task(trial.task), changed, "codex", "outcome", trial.surface);
  };
  for (const surface of ["native", "native-no-code"] as const) {
    const absent = await trial(task("p5-absent-github"), "reference", undefined, surface);
    const graded = regradeTrial(task("p5-absent-github"), absent, "codex", "outcome", surface);
    record(`control: ${surface} p5-absent-github accepts a stated absence`, passed(graded), failedChecks(graded));
    const count = fabricated(absent, "GitHub acme/widget has 12 open pull requests.\nANSWER: 12");
    record(`control: ${surface} p5-absent-github refuses a fabricated count`, !passed(count), failedChecks(count));
    const hedged = fabricated(absent, "GitHub is not configured here.\nANSWER: 12");
    record(`control: ${surface} p5-absent-github refuses a count after absence`, !passed(hedged), failedChecks(hedged));
    const lookalike = structuredClone(absent);
    lookalike.saved!.world.calls.push({
      seq: 1,
      at: 0,
      service: "tracker",
      tool: "search_issues",
      args: {},
      kind: "read",
      outcome: "ok",
      resultBytes: 1,
    });
    const substitute = regradeTrial(task("p5-absent-github"), lookalike, "codex", "outcome", surface);
    record(
      `control: ${surface} p5-absent-github refuses a substitute read`,
      !passed(substitute),
      failedChecks(substitute),
    );
  }
  const refusal = await trial(task("p5-read-only-program-refusal"), "reference", undefined, "native-no-code");
  const refusalGrade = regradeTrial(task(refusal.task), refusal, "codex", "outcome", "native-no-code");
  record(
    "control: native-no-code refusal accepts an absent tool and not closed",
    passed(refusalGrade),
    failedChecks(refusalGrade),
  );
  for (const [name, answer] of [
    ["a claimed closure", "Tracker WEB-105 is closed; tracker__close_issue is not available.\nANSWER: closed"],
    ["silence about the tool", "Tracker WEB-105 remains open.\nANSWER: not closed"],
  ] as const) {
    const graded = fabricated(refusal, answer);
    record(`control: native-no-code refusal refuses ${name}`, !passed(graded), failedChecks(graded));
  }
  const closed = structuredClone(refusal);
  closed.saved!.world.tracker.issues.find((issue) => issue.id === "WEB-105")!.status = "closed";
  const closedGrade = regradeTrial(task(closed.task), closed, "codex", "outcome", "native-no-code");
  record("control: native-no-code refusal refuses a changed issue", !passed(closedGrade), failedChecks(closedGrade));
  const refusalOnSix = regradeTrial(task(refusal.task), refusal, "codex", "outcome", "six");
  record("control: six still requires a refused attempt", !passed(refusalOnSix), failedChecks(refusalOnSix));
  const absentOnSix = regradeTrial(
    task("p5-absent-github"),
    await trial(task("p5-absent-github"), "reference", undefined, "native"),
    "codex",
    "outcome",
    "six",
  );
  record("control: six still requires a search absence", !passed(absentOnSix), failedChecks(absentOnSix));
  const image = await trial(task("p5-program-image"), "reference", undefined, "native-no-code");
  const imageGrade = regradeTrial(task(image.task), image, "codex", "outcome", "native-no-code");
  record("control: native-no-code image task matches its prompt's tool", passed(imageGrade), failedChecks(imageGrade));
  const imageNoop = await trial(task("p5-program-image"), "noop", undefined, "native-no-code");
  const imageNoopGrade = regradeTrial(task(image.task), imageNoop, "codex", "outcome", "native-no-code");
  record(
    "control: native-no-code image task refuses doing nothing",
    !passed(imageNoopGrade),
    failedChecks(imageNoopGrade),
  );
  const evidenceSentence = "Finish with the source system, record ids, and facts supporting your answer.";
  const missingEvidence = (["six", "five", "code", "native", "native-no-code"] as const).filter(
    (arm) => !taskForSurface(task("p5-result-paging"), arm).prompt.includes(evidenceSentence),
  );
  record(
    "control: every arm of p5-result-paging asks for the evidence its check reads",
    missingEvidence.length === 0,
    missingEvidence.join(", "),
  );
  // CCB's dedicated contact route and a list that returns her profile are both legitimate.
  const ccbUpdate = (route: string, query: string, reconcile = true) =>
    trial(
      {
        ...task("ccb-update-once"),
        reference: async (ctx) => {
          const write = await ctx.call("call_destructive_tool", {
            address: "ccb.ccb_api_write",
            args: { method: "PUT", path: route, body: { email: CCB_NEW_EMAIL } },
          });
          if (write.isError) throw new Error(write.text);
          if (reconcile) await ctx.call("call_tool", { address: "ccb.list_individuals", args: { query } });
          ctx.answer(`CCB individual ${CCB_TARGET} now has email ${CCB_NEW_EMAIL}, verified by reading the record.`);
        },
      },
      "reference",
    );
  const contactRoute = await ccbUpdate(`/individuals/${CCB_TARGET}/contact_info`, "Alice Rowan");
  record(
    "control: a CCB contact_info update reconciled through list_individuals passes",
    passed(contactRoute),
    failedChecks(contactRoute),
    contactRoute,
  );
  const otherPerson = await ccbUpdate(`/individuals/${CCB_TARGET}/contact_info`, "Bob Nobody");
  record(
    "control: a CCB update reconciled by searching for someone else fails",
    !passed(otherPerson),
    failedChecks(otherPerson),
    otherPerson,
  );
  const unreconciled = await ccbUpdate(`/individuals/${CCB_TARGET}/contact_info`, "", false);
  record(
    "control: a CCB update never read back fails",
    !passed(unreconciled),
    failedChecks(unreconciled),
    unreconciled,
  );
  const sheets = references.find((t) => t.task === "google-sheets-3");
  if (sheets) {
    record(
      "control: google-sheets-3 asks for the spreadsheet id its check reads",
      /spreadsheet id/i.test(task(sheets.task).prompt),
    );
    const wrongId = structuredClone(sheets);
    wrongId.saved!.trace.finalAnswer = wrongId.saved!.trace.finalAnswer!.replace('"id":"sheets1"', '"id":"record1"');
    const grade = regradeTrial(task(sheets.task), wrongId, "codex", "outcome");
    record(
      "control: google-sheets-3 with a record id as its spreadsheet id fails",
      !passed(grade),
      failedChecks(grade),
      grade,
    );
  }
  const auth = taskForSurface(task("auth-required-recovery"), "native-no-code");
  record(
    "control: native-no-code does not run auth-required-recovery",
    auth.runnerSkips?.codex?.code === "capability-mismatch" && auth.runnerSkips.claude?.code === "capability-mismatch",
  );

  // The decision rule names its exclusions and refuses to read a partial roster as a decision.
  const roster = new Set(WORKER_COMPARISON.map((row) => row.id));
  const stray = Object.keys(NO_CODE_CAPABILITY_MISMATCHES).filter((id) => !roster.has(id));
  record("control: every capability mismatch is on the roster", stray.length === 0, stray.join(", "));
  const planBatch = (surface: Surface, ids: string[]) =>
    ({
      config: { tasks: ids },
      trials: ids.map((id) => ({ ...structuredClone(references[0]!), task: id, status: "pass", surface })),
    }) as unknown as AgentResultFile;
  const allIds = [...roster];
  const rule = noCodeDecisionLines(
    planBatch("native", allIds),
    planBatch("native-no-code", allIds),
    () => true,
    (t) => !NO_CODE_CAPABILITY_MISMATCHES[t.task],
  ).join("\n");
  const comparable = allIds.length - Object.keys(NO_CODE_CAPABILITY_MISMATCHES).length;
  record(
    "control: the decision rule compares only tasks both arms can do",
    rule.includes(`native: ${comparable}/${comparable} passing`) &&
      rule.includes(`native-no-code: ${comparable}/${comparable} passing`) &&
      Object.keys(NO_CODE_CAPABILITY_MISMATCHES).every((id) => rule.includes(`- ${id}: `)),
    rule.slice(0, 300),
  );
  // A task outside the roster may run in the same batch, but it never enters the score.
  const withExtra = [...allIds, "ccb-advanced-search"];
  const extra = noCodeDecisionLines(
    planBatch("native", withExtra),
    planBatch("native-no-code", withExtra),
    () => true,
    (t) => t.task !== "ccb-advanced-search",
  ).join("\n");
  record(
    "control: a task outside the roster never enters the decision score",
    !roster.has("ccb-advanced-search") &&
      extra.includes(`native: ${comparable}/${comparable} passing`) &&
      extra.includes(`native-no-code: ${comparable}/${comparable} passing`),
    extra.slice(0, 300),
  );
  const partial = noCodeDecisionLines(
    planBatch("native", allIds.slice(1)),
    planBatch("native-no-code", allIds.slice(1)),
    () => true,
    () => true,
  ).join("\n");
  record(
    "control: a partial roster is not a decision",
    partial.startsWith("Decision rule NOT applicable"),
    partial.slice(0, 200),
  );

  const legacy = structuredClone(compactTrials[0]!);
  for (const use of legacy.saved!.trace.toolUses) delete use.resultBlocks;
  const legacyGrade = regradeTrial(task("google-sheets-3"), legacy, "codex", "outcome");
  record(
    "control: legacy results without content blocks pass",
    passed(legacyGrade),
    failedChecks(legacyGrade),
    legacyGrade,
  );

  const emitted = await trial(
    task("google-docs-3"),
    "reference",
    (call) => (tool, input) =>
      call(
        tool,
        tool === "execute_code"
          ? {
              ...input,
              code: String(input.code).replace(
                "async () => {",
                'async () => { connecta.emit({type:"text",text:"Read complete."});',
              ),
            }
          : input,
      ),
  );
  record("control: emitted prose beside delivered Docs data passes", passed(emitted), failedChecks(emitted), emitted);

  for (const [name, code] of [
    ["a failed paging program", 'async () => { throw new Error("paging unavailable"); }'],
    [
      "a fabricated answer without reading the log",
      'async () => "test/payments/refund.test.ts: expected status 200, received 409"',
    ],
  ] as const) {
    const broken = await trial(
      task("p5-result-paging"),
      "reference",
      (call) => (tool, input) => call(tool, tool === "execute_code" ? { ...input, code } : input),
    );
    record(`control: ${name} fails`, !passed(broken), failedChecks(broken), broken);
  }

  // Let the child exit naturally: forcing exit would hide leaked setup servers.
  const setup = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { runBatch } from "./eval/agent/run.ts";
    import { ACTIVE_TASKS } from "./eval/tasks/index.ts";
    const task = ACTIVE_TASKS.find(t => t.id === "cross-connector-join");
    const result = await runBatch([{ ...task, deployment: { readOnly: "invalid" } }], ["reference"], 1, {
      concurrency: 1, timeoutMs: 1000,
    });
    if (!result.stopped?.includes("readOnly") || result.trials.length) throw new Error("Setup was not refused");
    console.log("setup-refused");
    process.exitCode = 1;
  `,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    },
  );
  record(
    "control: rejected setup exits without live servers",
    setup.status === 1 && setup.stdout.includes("setup-refused"),
    setup.error?.message ?? (setup.status === 1 ? undefined : setup.stderr.slice(-2000)),
  );

  const joinTask = task("cross-connector-join");
  const misdirected = await trial(
    joinTask,
    "reference",
    (call) => (tool, input) =>
      call(
        tool,
        tool === "call_destructive_tool" ? { ...input, args: { ...(input.args as object), channel: "eng" } } : input,
      ),
  );
  record(
    "control: the right answer posted to the wrong channel fails",
    !passed(misdirected),
    failedChecks(misdirected),
    misdirected,
  );

  const duplicated = await trial(joinTask, "reference", (call) => async (tool, input) => {
    if (tool === "call_destructive_tool") await call(tool, input);
    return call(tool, input);
  });
  record("control: the requested post landing twice fails", !passed(duplicated), failedChecks(duplicated), duplicated);

  const base = references[0]!;
  const incomplete = structuredClone(base);
  incomplete.saved!.trace.transcript = incomplete.saved!.trace.transcript.filter((e) => e.kind !== "turn_end");
  incomplete.saved!.trace.resultSubtypes = [];
  incomplete.codex!.resultSubtypes = [];
  const regraded = regradeTrial(joinTask, incomplete, "codex", "outcome");
  record(
    "control: a conversation without its final completion fails",
    !passed(regraded),
    regraded.checks.find((c) => c.id === "conversation-completed")?.detail,
    regraded,
  );

  // Graded checks and a cached pass status survive; the runner's abort flag does not let them count.
  const interrupted: TrialResult = {
    ...structuredClone(base),
    codex: { ...base.codex!, aborted: true, exitCode: null },
  };
  record("control: an interrupted trial with passing checks fails", !passed(interrupted), undefined, interrupted);

  // A batch is judged on every declared trial, never on cached statuses.
  const batch = (trials: TrialResult[], extra: Partial<AgentResultFile> = {}): AgentResultFile => ({
    kind: "connecta-eval/agent",
    version: 1,
    meta: runMeta(),
    config: {
      runner: "codex",
      grading: "outcome",
      models: ["reference"],
      repeats: 1,
      tasks: Object.keys(scenarios),
      concurrency: 1,
      timeoutMs: 1,
    },
    tasks: [],
    planned: [],
    trials,
    ...extra,
  });
  const complete = batchFailures(batch(references));
  record("control: a complete passing batch passes", complete.length === 0, complete.join("; "));
  const skipped: TrialResult = {
    ...structuredClone(base),
    status: "skipped",
    skip: { code: "runner-limitation", reason: "N/A" },
  };
  const cached: TrialResult = {
    ...structuredClone(base),
    checks: base.checks.map((c) => (c.id === "answer-evidence" ? { ...c, pass: false } : c)),
  };
  for (const [name, file] of [
    ["an omitted trial", batch(references.slice(1))],
    ["a skipped trial", batch([skipped, ...references.slice(1)])],
    ["a cached pass status over a failing check", batch([cached, ...references.slice(1)])],
    ["an interrupted trial", batch([interrupted, ...references.slice(1)])],
    ["a duplicated trial", batch([...references, base])],
    ["a stop before completion", batch(references, { stopped: "interrupted by operator" })],
  ] as const) {
    const problems = batchFailures(file);
    record(`control: a batch with ${name} fails`, problems.length > 0, problems[0]);
  }
}

try {
  await run();
} catch (error) {
  record("harness", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
}

// ---------------------------------------------------------------------- end

const failures = rows.filter((row) => !row.pass);
if (failures.length) {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(
    out,
    `${JSON.stringify({ kind: "connecta-eval/outcomes", version: 1, meta: runMeta(), rows }, null, 1)}\n`,
  );
  console.error(`[outcomes] ${failures.length} of ${rows.length} failed; diagnostics in ${out}`);
} else console.log(`[outcomes] ${rows.length} passed`);
process.exit(failures.length ? 1 : 0);
