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
import { ACTIVE_TASKS } from "./tasks/index.js";
import type { ActiveTask } from "./tasks/types.js";

const SCENARIOS: Record<string, string> = {
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
async function trial(t: ActiveTask, mode: "reference" | "noop", wrap?: (call: Call) => Call): Promise<TrialResult> {
  const played = wrap
    ? {
        ...t,
        reference: (ctx: Parameters<ActiveTask["reference"]>[0]) => t.reference({ ...ctx, call: wrap(ctx.call) }),
      }
    : t;
  const saved = await playReference(played, { mode }, ({ world, trace }) =>
    structuredClone(saveGradeInputs(world, trace)),
  );
  const turns = saved.trace.resultSubtypes.length;
  const finished: TrialResult = {
    task: t.id,
    runner: "codex",
    surface: "six",
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
  const qbWrites = references.find((t) => t.task === "quickbooks-write-journey");
  if (qbWrites) {
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
  if (selected) return;

  // ----------------------------------------------- no-false-pass controls

  // Keep the real vendor ledger, continuations and canned answer intact while
  // deleting the facts delivered over MCP. Calls alone cannot prove a read.
  for (const id of [
    "ccb-advanced-search",
    "pco-step2-plan-join",
    "overflow-donor-paging",
    "google-docs-3",
    "google-sheets-3",
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
  const reduced = structuredClone(references.find((reference) => reference.task === "google-sheets-3")!);
  for (const use of reduced.saved!.trace.toolUses) {
    use.resultText = "{}";
    use.resultBlocks = [{ type: "text", text: "{}" }];
  }
  reduced.saved!.trace.toolUses.at(-1)!.resultText = JSON.stringify({
    result: { ids: Array.from({ length: 6 }, (_, i) => `record${i + 1}`), total: 210 },
  });
  for (const use of reduced.saved!.trace.toolUses) {
    use.resultBlocks = [{ type: "text", text: use.resultText! }];
    for (const entry of reduced.saved!.trace.transcript) {
      if (entry.kind === "tool_result" && entry.id === use.id) {
        entry.text = use.resultText!;
        entry.chars = entry.text.length;
      }
    }
  }
  const summary = regradeTrial(task("google-sheets-3"), reduced, "codex", "outcome");
  record("control: a compact delivered Sheets summary passes", passed(summary), failedChecks(summary), summary);
  const legacy = structuredClone(reduced);
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
