/**
 * `npm run eval:selftest` — the harness checking itself, with no LLM.
 *
 * For every active task, a scripted MCP client plays the ideal route against a
 * fresh world and deployment, and the grader must pass it; an agent that does
 * nothing must fail it. A grader that passes a no-op or fails the reference is
 * a broken yardstick, and every later phase would be measured with it.
 */
import { CODE_INSTRUCTIONS, CODE_USAGE, codeValue, forSurface } from "./deploy/code-surface.js";
import type { Connecta } from "@zackbart/connecta";
import { taskForSurface } from "./tasks/surface.js";
import { gradeTask, passes, CHECK_KINDS, type Grading } from "./tasks/grading.js";
import { assertSurface, type Surface } from "./agent/surface.js";
import { compare } from "./compare.js";
import type { AgentResultFile } from "./report/summary.js";
import { World } from "./fakes/world.js";
import { startNodeDeployment } from "./deploy/node.js";
import { connectMcp } from "./support/mcp.js";
import type { AgentTrace, ToolUse, TranscriptEntry } from "./agent/trace.js";
import { counterexamples, positiveVariants } from "./tasks/counterexamples.js";
import { ACTIVE_TASKS } from "./tasks/index.js";
import { startAuthHost } from "./agent/auth-host.js";
import { parseTrace, type StreamEvent } from "./agent/trace.js";
import { flags, runProtocol } from "./support/meta.js";
import type { ActiveTask, Check } from "./tasks/types.js";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { saveGradeInputs } from "./agent/saved.js";
import { regradeTrial } from "./agent/regrade.js";
import { summarize } from "./report/summary.js";
import type { TrialResult } from "./agent/run.js";
import { BADGE_PNG, LEGACY_BADGE_PNG } from "./fakes/prerequisites.js";
import { spawnSync } from "node:child_process";
import { inflateSync } from "node:zlib";

function validPng(base64: string): boolean {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return false;
  const imageData: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + 8 + size;
    if (end + 4 > bytes.length) return false;
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, end)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if ((crc ^ 0xffffffff) >>> 0 !== bytes.readUInt32BE(end)) return false;
    if (bytes.subarray(offset + 4, offset + 8).toString() === "IDAT") imageData.push(bytes.subarray(offset + 8, end));
    offset = end + 4;
  }
  return inflateSync(Buffer.concat(imageData)).length === 32 * (1 + 32 * 3);
}
if (!validPng(BADGE_PNG) || validPng(LEGACY_BADGE_PNG)) throw new Error("Badge PNG integrity controls failed");

interface TrialControl {
  task: string;
  runner: string;
  repeat: number;
  checks: string[];
  finalAnswer: string;
  channel?: string;
  urlElicitations?: AgentTrace["urlElicitations"];
  expectedFailures?: string[];
  program?: string;
  programResult?: string;
}
const trialControls = JSON.parse(
  await readFile(new URL("./tasks/fixtures/baseline-909b-controls.json", import.meta.url), "utf8"),
) as TrialControl[];

function emptyTrace(toolUses: ToolUse[], finalAnswer = "", transcript: TranscriptEntry[] = []): AgentTrace {
  const turns = Math.max(1, ...toolUses.map((u) => u.turn), ...transcript.map((e) => e.turn));
  const completions: TranscriptEntry[] = Array.from({ length: turns }, (_, i) => ({
    kind: "turn_end",
    turn: i + 1,
    subtype: "success",
    isError: false,
  }));
  return {
    finalAnswer,
    transcript: [...transcript, ...completions],
    toolUses,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    costUsd: undefined,
    apiMs: 0,
    modelTurns: 0,
    permissionDenials: [],
    resultSubtypes: Array.from({ length: turns }, () => "success"),
    model: undefined,
    claudeCodeVersion: undefined,
    loadedTools: [],
    rateLimit: undefined,
  };
}

async function play(
  task: ActiveTask,
  mode: "reference" | "noop",
  surface: Surface = "six",
  grading: Grading = "route",
): Promise<{
  correct: Check[];
  wrongDestination: Check[];
  missingEvidence: Check[];
  regressions: ReturnType<typeof counterexamples>;
  positives: ReturnType<typeof positiveVariants>;
}> {
  const original = taskForSurface(task, surface);
  task = {
    ...original,
    grade: (ctx) =>
      gradeTask(original, ctx, surface, grading).map((c) =>
        grading === "outcome" && c.kind === "route" ? { ...c, advisory: true } : c,
      ),
  };
  const world = new World(task.world);
  await world.start();
  for (const { service, fault } of task.faults ?? []) world.service(service).faults.push(fault);
  const deployment = await startNodeDeployment(
    world.connectorSpecs(),
    task.deployment,
    task.world?.oauth ? world.oauth : undefined,
    surface,
  );
  const hostEvents: StreamEvent[] = [];
  const host = task.host
    ? await startAuthHost(deployment, task.host.urlElicitation === "capable", (e) => hostEvents.push(e))
    : undefined;
  const session = await connectMcp(host?.mcpUrl ?? deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
  const toolUses: ToolUse[] = [];
  const transcript: TranscriptEntry[] = [];
  let turn = 1;
  let finalAnswer = "";
  try {
    if (!task.world?.oauth && !/^cta_[A-Za-z0-9_-]{43}$/.test(deployment.token)) {
      throw new Error("Node eval did not provision a managed machine token");
    }
    for (const headers of [{}, { Authorization: "Bearer eval-provisioning" }]) {
      const response = await fetch(deployment.mcpUrl, { headers });
      await response.body?.cancel();
      if (response.status !== 401) throw new Error("Node eval admitted an unprovisioned client");
    }
    assertSurface(
      (await session.listTools()).map((t) => t.name),
      surface,
    );
    if (surface === "code") {
      for (const hidden of ["call_tool", "call_destructive_tool", "search_tools"]) {
        let refused = false;
        try {
          refused = (
            await session.call(hidden, {
              address: "tracker.close_issue",
              args: { id: "WEB-105" },
              query: "close issue",
            })
          ).isError;
        } catch {
          refused = true;
        }
        if (!refused || world.ledger.calls.length) throw new Error(`Hidden tool ${hidden} was dispatched`);
      }
    }
    if (mode === "reference") {
      // A schema rejection must not shift the observer-to-tool correlation.
      if (task.id === "p5-fanout-over-budget") {
        const rejected = await session.call("execute_code", {});
        if (!rejected.isError) throw new Error("Expected malformed execute_code to be rejected");
        toolUses.push({
          id: "ref-invalid",
          turn,
          tool: "execute_code",
          input: {},
          isError: true,
          resultText: rejected.text,
          resultBlocks: rejected.content,
        });
      }
      await task.reference({
        world,
        answer: (text) => {
          finalAnswer = text;
          transcript.push({ kind: "assistant", turn, text });
        },
        call: async (tool, args) => {
          const result = await session.call(tool, args);
          toolUses.push({
            id: `ref-${toolUses.length + 1}`,
            turn,
            tool,
            input: args,
            isError: result.isError,
            resultText: result.text,
            resultBlocks: result.content,
          });
          transcript.push({
            kind: "tool_result",
            turn,
            id: toolUses.at(-1)!.id,
            isError: result.isError,
            text: result.text,
            chars: result.text.length,
          });
          return result;
        },
        nextTurn: async () => {
          const followUp = task.followUps?.[turn - 1];
          turn += 1;
          const proceed = await followUp?.before?.({
            world,
            deployment,
            trace: emptyTrace(toolUses, finalAnswer, transcript),
            note: () => {},
          });
          return proceed !== false;
        },
      });
    }
    world.programs = deployment.programs;
    const trace = emptyTrace(toolUses, finalAnswer, transcript);
    trace.urlElicitations = parseTrace(hostEvents, [], []).urlElicitations ?? [];
    const correct = task.grade({ world, trace });
    const legacyControls = surface === "six" && grading === "route";
    const regressions = mode === "reference" && legacyControls ? counterexamples(task, world, trace) : [];
    const positives = mode === "reference" && legacyControls ? positiveVariants(task, world, trace) : [];
    if (mode === "reference" && legacyControls) {
      for (const control of trialControls.filter((c) => c.task === task.id)) {
        const saved = structuredClone(saveGradeInputs(world, trace));
        saved.trace.finalAnswer = control.finalAnswer;
        if (control.urlElicitations) saved.trace.urlElicitations = control.urlElicitations;
        if (control.channel)
          for (const call of saved.world.calls) {
            if (call.service === "chat" && call.tool === "post_message") call.args.channel = control.channel;
          }
        if (control.program) {
          // Same observed refused target, but the actual trial caught the
          // rejection and successfully returned its error code to the host.
          const use = saved.trace.toolUses.find((u) => u.tool === "execute_code")!;
          use.input.code = control.program;
          use.isError = false;
          use.resultText = control.programResult;
        }
        const trial: TrialResult = {
          task: task.id,
          model: "control",
          repeat: 1,
          status: "fail",
          saved,
          checks: [],
          metrics: {
            wallMs: 0,
            apiMs: 0,
            modelTurns: 0,
            conversationTurns: 1,
            tokens: trace.tokens,
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
          ledger: [],
          startedAt: "control",
        };
        // Grade without the runner skip to exercise corrected evidence even
        // when the live CLI cannot deliver the task's rich output.
        const graded = regradeTrial({ ...task, runnerSkips: {} }, trial, "codex");
        positives.push({
          name: `saved ${control.runner} #${control.repeat}: ${control.checks.join(", ")}`,
          passed:
            control.checks.every((id) => graded.checks.some((c) => c.id === id && c.pass)) &&
            !graded.regrade?.unavailable.length,
        });
        if (control.expectedFailures) {
          const measured = regradeTrial(task, trial, control.runner as "claude" | "codex");
          regressions.push({
            name: `saved ${control.runner} #${control.repeat}: measurable URL-auth failure`,
            rejected:
              measured.status === "fail" &&
              !measured.skip &&
              control.expectedFailures.every((id) => measured.checks.some((c) => c.id === id && !c.pass)),
          });
        }
        const missing = regradeTrial(
          { ...task, runnerSkips: {} },
          { ...trial, saved: { ...saved, trace: { ...saved.trace, finalAnswer: "Completed." } } },
          "codex",
        );
        regressions.push({
          name: `saved ${control.runner} #${control.repeat} without evidence`,
          rejected: missing.checks.some((c) => c.id === "answer-evidence" && !c.pass),
        });
        const wrong = structuredClone(saved);
        for (const call of wrong.world.calls) call.service = "wrong_destination";
        for (const program of wrong.world.programs)
          for (const call of program.calls) {
            call.args[0] = "wrong_destination";
            if (call.name === "connecta.search") call.result = { absence: { service: "wrong_destination" } };
          }
        for (const use of wrong.trace.toolUses) {
          if (use.tool === "search_tools") {
            use.input.query = "wrong_destination";
            use.input.connector = "wrong_destination";
          }
        }
        const bad = regradeTrial({ ...task, runnerSkips: {} }, { ...trial, saved: wrong }, "codex");
        regressions.push({
          name: `saved ${control.runner} #${control.repeat} wrong destination`,
          rejected: bad.checks.some((c) => c.id === "correct-destination" && !c.pass),
        });
        if (task.runnerSkips?.claude) {
          const skipped = regradeTrial(task, trial, "claude");
          const summary = summarize([skipped])[0]!;
          positives.push({
            name: "typed runner skip excluded from pass rate",
            passed:
              skipped.status === "skipped" &&
              skipped.skip?.code === "runner-limitation" &&
              summary.passRate === undefined &&
              summary.skipped === 1,
          });
        }
      }
    }
    if (mode === "reference" && legacyControls && task.id === "p5-absent-github") {
      for (const route of ["search_tools", "execute_code"]) {
        const programs = world.programs;
        if (route === "search_tools") world.programs = [];
        const controls = task.grade({
          world,
          trace: { ...trace, toolUses: trace.toolUses.filter((u) => u.tool === route) },
        });
        world.programs = programs;
        if (controls.some((c) => !c.advisory && !c.pass)) throw new Error(`Valid ${route} absence discovery failed`);
      }
    }
    if (mode === "reference") {
      const classified = gradeTask(original, { world, trace }, surface, grading);
      const expected = [
        ...CHECK_KINDS[task.id]!.route,
        ...CHECK_KINDS[task.id]!.outcome,
        "correct-destination",
        "answer-evidence",
        "no-duplicate-writes",
      ].sort();
      if (JSON.stringify(classified.map((c) => c.id).sort()) !== JSON.stringify(expected))
        throw new Error(`Incomplete classification for ${task.id}`);
      for (const otherMode of ["route", "outcome"] as const) {
        const missing = gradeTask(
          original,
          { world, trace: { ...trace, finalAnswer: "Completed." } },
          surface,
          otherMode,
        );
        regressions.push({
          name: `${surface}/${otherMode}: missing outcome evidence`,
          rejected: !passes(missing, otherMode),
        });
        const write = world.ledger.calls.find((c) => c.kind === "write");
        if (write) {
          world.ledger.calls.push({ ...write });
          const duplicates = gradeTask(original, { world, trace }, surface, otherMode);
          world.ledger.calls.pop();
          regressions.push({
            name: `${surface}/${otherMode}: duplicate write`,
            rejected:
              !passes(duplicates, otherMode) && duplicates.some((c) => c.id === "no-duplicate-writes" && !c.pass),
          });
        }
      }
      if (task.id === "p5-known-read-routing" && surface === "six") {
        const alternate = {
          ...trace,
          toolUses: trace.toolUses.map((u) => ({
            ...u,
            tool: "execute_code",
            input: { code: 'async () => (await connecta.call("ci.get_run", { runId: 4812 })).data' },
          })),
        };
        const checks = gradeTask(original, { world, trace: alternate }, surface, "outcome");
        positives.push({
          name: "real outcome with route-only failure passes outcome grading",
          passed: passes(checks, "outcome") && !passes(checks, "route"),
        });
      }
    }
    if (mode === "reference") {
      const mutate = (name: string, change: (saved: ReturnType<typeof saveGradeInputs>) => void) => {
        const saved = structuredClone(saveGradeInputs(world, trace));
        change(saved);
        const graded = regradeTrial(
          original,
          {
            task: task.id,
            model: "control",
            repeat: 1,
            status: "pass",
            saved,
            checks: [],
            metrics: {
              wallMs: 0,
              apiMs: 0,
              modelTurns: 0,
              conversationTurns: 1,
              tokens: trace.tokens,
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
            transcript: [],
            ledger: [],
            startedAt: "control",
          },
          "codex",
          grading,
          surface,
        );
        regressions.push({ name: `${surface}/${grading}: ${name}`, rejected: graded.status === "fail" });
      };
      if (task.id.includes("rich-output") || task.id === "p5-program-image")
        mutate("PNG delivered only as JSON data", (saved) => {
          for (const use of saved.trace.toolUses)
            use.resultBlocks = use.resultBlocks?.filter((b) => b.type !== "image") ?? [];
        });
      if (task.id === "p5-read-only-program-refusal") {
        mutate("wrong refused target", (saved) => {
          for (const p of saved.world.programs)
            for (const c of p.calls) if (c.name === "connecta.call") c.args[1] = { id: "WEB-103" };
        });
        mutate("refusal changed destination state", (saved) => {
          saved.world.tracker.issues.find((i) => i.id === "WEB-105")!.status = "closed";
        });
      }
      if (task.id.startsWith("p5-auth-")) {
        mutate("duplicate auth visit", (saved) => {
          saved.world.oauth.visits += 1;
          saved.world.oauth.starts += 1;
        });
        mutate("wrong host mode", (saved) => {
          saved.trace.urlElicitations =
            task.host?.urlElicitation === "capable" ? [] : [{ connector: "oauth", action: "accept", url: "wrong" }];
        });
        if (task.host?.urlElicitation === "incapable")
          mutate("missing agent auth handoff", (saved) => {
            saved.trace.transcript = saved.trace.transcript.filter(
              (e) => e.kind !== "assistant" || !e.text.includes("/connect/oauth"),
            );
          });
      }
      if (task.id === "p5-absent-github")
        mutate("fabricated absence without discovery", (saved) => {
          saved.world.programs = [];
          saved.trace.toolUses = [];
        });
    }
    const missingEvidence = task.grade({ world, trace: { ...trace, finalAnswer: "Completed." } });
    // Keep the successful state and answer, but attribute every source call
    // to another destination. This isolates source enforcement from evidence.
    for (const call of world.ledger.calls) call.service = "wrong_destination";
    for (const p of world.programs)
      for (const c of p.calls) {
        if (typeof c.args[0] === "string") c.args[0] = c.args[0].replace(/^[^.]+/, "wrong_destination");
        if (c.name === "connecta.search") c.result = { absence: { service: "wrong_destination" } };
      }
    const wrongUses = toolUses.map((use) => ({
      ...use,
      input: {
        ...use.input,
        ...(typeof use.input.address === "string"
          ? { address: use.input.address.replace(/^[^.]+/, "wrong_destination") }
          : {}),
        ...(typeof use.input.connector === "string" ? { connector: "wrong_destination" } : {}),
        ...(typeof use.input.query === "string" ? { query: "wrong_destination" } : {}),
        ...(typeof use.input.code === "string"
          ? {
              code: use.input.code.replace(
                /tracker|ci|assets|oauth|mixpanel|supabase|revenuecat|github/gi,
                "wrong_destination",
              ),
            }
          : {}),
      },
    }));
    const wrongDestination = task.grade({ world, trace: { ...trace, toolUses: wrongUses } });
    return { correct, missingEvidence, wrongDestination, regressions, positives };
  } finally {
    await session.close();
    await host?.close();
    await deployment.close();
    await world.stop();
  }
}

const required = (checks: Check[]) => checks.filter((item) => !item.advisory);
let failures = 0;
const args = flags(process.argv.slice(2));
const include = new Set((args.get("include-skipped") ?? "").split(","));
for (const task of ACTIVE_TASKS) {
  if (task.skip && !include.has(task.skip.flag)) {
    console.log(`skip ${task.id}: ${task.skip.reason} Enable with --include-skipped ${task.skip.flag}.`);
    continue;
  }
  const played = await play(task, "reference");
  const caught = trialControls.find((c) => c.task === task.id && c.program);
  if (caught) {
    const actual = await play(
      {
        ...task,
        reference: async (ctx) => {
          await ctx.call("execute_code", { code: caught.program! });
          // Historical prose is retained; this synthetic replay uses the new prompt contract.
          ctx.answer(`${caught.finalAnswer}\nANSWER: not closed`);
        },
      },
      "reference",
    );
    if (required(actual.correct).some((c) => !c.pass)) {
      failures += 1;
      console.log(`FAIL ${task.id}: replay of the real caught-refusal program against fresh fakes`);
    } else console.log(`ok   ${task.id}: real caught-refusal program against fresh fakes`);
  }
  const reference = played.correct;
  const refFailed = required(reference).filter((item) => !item.pass);
  const noop = (await play(task, "noop")).correct;
  const noopPassed = required(noop).every((item) => item.pass);
  const destinationRejected =
    played.wrongDestination.some((c) => c.id === "correct-destination" && !c.pass) &&
    played.wrongDestination.some((c) => c.id === "answer-evidence" && c.pass);
  const evidenceRejected =
    played.missingEvidence.some((c) => c.id === "answer-evidence" && !c.pass) &&
    played.missingEvidence.some((c) => c.id === "correct-destination" && c.pass);
  const ok =
    refFailed.length === 0 &&
    !noopPassed &&
    destinationRejected &&
    evidenceRejected &&
    played.regressions.every((c) => c.rejected) &&
    played.positives.every((c) => c.passed);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${task.id}`);
  for (const item of refFailed) {
    console.log(`       reference failed ${item.id}: ${item.description}${item.detail ? ` (${item.detail})` : ""}`);
  }
  for (const item of reference.filter((entry) => entry.advisory && !entry.pass)) {
    console.log(`       reference advisory miss ${item.id}${item.detail ? ` (${item.detail})` : ""}`);
  }
  for (const c of played.regressions) console.log(`       ${c.rejected ? "rejected" : "FAIL accepted"}: ${c.name}`);
  for (const c of played.positives) console.log(`       ${c.passed ? "passed" : "FAIL rejected"}: ${c.name}`);
  if (!destinationRejected)
    console.log("       wrong-destination answer did not fail the destination check independently");
  if (!evidenceRejected)
    console.log("       right-destination answer without facts did not fail evidence independently");
  if (noopPassed) console.log("       a no-op agent passed the grader");
}
for (const surface of ["six", "code"] as const)
  for (const grading of ["route", "outcome"] as const) {
    if (surface === "six" && grading === "route") continue;
    for (const task of ACTIVE_TASKS) {
      const played = await play(task, "reference", surface, grading);
      const noop = await play(task, "noop", surface, grading);
      const ok =
        required(played.correct).every((c) => c.pass) &&
        !required(noop.correct).every((c) => c.pass) &&
        played.missingEvidence.some((c) => c.id === "answer-evidence" && !c.pass) &&
        played.wrongDestination.some((c) => c.id === "correct-destination" && !c.pass) &&
        played.regressions.every((c) => c.rejected) &&
        played.positives.every((c) => c.passed);
      console.log(`${ok ? "ok  " : "FAIL"} ${surface}/${grading} ${task.id}`);
      if (!ok) {
        failures++;
        console.log(
          JSON.stringify({
            failed: required(played.correct).filter((c) => !c.pass),
            regressions: played.regressions.filter((c) => !c.rejected),
            positives: played.positives.filter((c) => !c.passed),
          }),
        );
      }
    }
  }
if (failures) {
  console.error(`${failures} task(s) have a broken grader or reference.`);
  process.exitCode = 1;
}

// Exercise the deployed arm selector and both HTTP encodings. Six returns
// the original server itself, so its instructions, skills and errors are bytes
// from the normal implementation, with no adapter or serialization pass.
{
  const errors = [
    {
      code: "destructive_tool_requires_approval",
      message: "Use call_destructive_tool",
      retryable: true,
      nextAction: { tool: "call_destructive_tool" },
      retry: "call_destructive_tool",
    },
    {
      code: "invalid_args",
      message: "Use search_tools",
      retryable: true,
      nextAction: { tool: "search_tools", arguments: { query: "ci" } },
    },
    ...["call_tool", "call_destructive_tool"].map((tool) => ({
      code: "not_found",
      message: `Use ${tool}`,
      retryable: true,
      nextAction: { tool },
    })),
  ];
  const fixtures = [
    { method: "initialize", params: {}, result: { instructions: "Main instructions" } },
    {
      method: "tools/list",
      params: {},
      result: {
        tools: [
          {
            name: "execute_code",
            description:
              "One known read: call_tool. Everything else: execute_code. Read-only pool: programs read; writes use call_destructive_tool.",
          },
        ],
      },
    },
    ...errors.map((error) => ({
      method: "tools/call",
      params: { name: "execute_code" },
      result: {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error }) }],
        structuredContent: { error },
      },
    })),
  ];
  for (const type of ["application/json", "text/event-stream"])
    for (const fixture of fixtures) {
      const original = JSON.stringify({ jsonrpc: "2.0", id: 1, result: fixture.result });
      const bytes = type === "application/json" ? original : `event: message\ndata: ${original}\n\n`;
      const raw = {
        fetch: async () => new Response(bytes, { headers: { "content-type": type } }),
      } as unknown as Connecta;
      const request = new Request("http://eval/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: fixture.method,
          params: fixture.params,
        }),
      });
      const sixServer = forSurface(raw, "six");
      if (sixServer !== raw || (await (await sixServer.fetch(request)).text()) !== bytes)
        throw new Error("Six guidance was not byte-identical to the normal server");
      const changed = await (await forSurface(raw, "code").fetch(request)).text();
      const result = JSON.parse(type === "application/json" ? changed : changed.match(/^data: (.+)$/m)![1]!).result;
      if (fixture.method === "initialize" && result.instructions !== CODE_INSTRUCTIONS)
        throw new Error("Code initialization guidance differs by HTTP encoding");
      if (
        fixture.method === "tools/list" &&
        result.tools[0].description !==
          "Every operation uses execute_code. Read-only pool: programs cannot write; a write is terminally refused."
      )
        throw new Error("Code tool guidance differs by HTTP encoding");
      if (
        result.isError &&
        (JSON.stringify(JSON.parse(result.content[0].text)) !== JSON.stringify(result.structuredContent) ||
          JSON.stringify(result.structuredContent) !==
            JSON.stringify(
              codeValue("structuredContent" in fixture.result ? fixture.result.structuredContent : undefined),
            ))
      )
        throw new Error("Rewritten error envelope representations disagree");
    }
  console.log("ok   six byte parity and code instructions/tool/error guidance in JSON and SSE");
}

// Boundary controls use actual QuickJS failures, including errors caught by a guest.
{
  const world = new World({ prerequisites: true });
  await world.start();
  const deployment = await startNodeDeployment(world.connectorSpecs(), {}, undefined, "code");
  const session = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
  try {
    const hidden = /\b(call_tool|call_destructive_tool|search_tools)\b/;
    if (session.instructions !== CODE_INSTRUCTIONS)
      throw new Error("Code server instructions differ from the registered guide");
    const tools = await session.listTools();
    if (
      tools.some((t) => hidden.test(t.description ?? "")) ||
      !tools.find((t) => t.name === "execute_code")?.description?.includes("Every operation uses execute_code.")
    )
      throw new Error("Code tool descriptions differ from the registered guidance");
    for (const name of ["usage", "skill://connecta/usage", "skill://connecta/usage/SKILL.md"]) {
      const direct = await session.call("skills", { name });
      if (direct.text !== CODE_USAGE || (direct.structured as { text: string }).text !== CODE_USAGE)
        throw new Error(`Code usage text/structured parity failed for ${name}`);
      const guest = await session.call("execute_code", {
        code: `async () => await connecta.skill(${JSON.stringify(name)})`,
      });
      const fromText = JSON.parse(guest.text).result;
      const fromStructured = (guest.structured as { result: { text: string } }).result;
      if (fromText.text !== CODE_USAGE || fromStructured.text !== CODE_USAGE)
        throw new Error(`Guest usage text/structured parity failed for ${name}`);
      if (name !== "usage") {
        const resource = (await session.readResource(name)) as { contents: { text: string }[] };
        if (resource.contents.length !== 1 || resource.contents[0]!.text !== CODE_USAGE)
          throw new Error(`Code resource usage differed for ${name}`);
      }
    }
    for (const result of [
      await session.call("skills", { name: "connector:mixpanel" }),
      await session.call("execute_code", { code: 'async () => await connecta.call("ci.no_such_tool", {})' }),
      await session.call("execute_code", {
        code: 'async () => await connecta.call("ci.get_run", { runId: "invalid" })',
      }),
    ]) {
      if (hidden.test(result.text)) throw new Error("Code skill/error leaked a hidden route");
      const textValue = result.isError
        ? JSON.parse(result.text)
        : { name: "connector:mixpanel", format: "text", text: result.text };
      if (JSON.stringify(textValue) !== JSON.stringify(result.structured))
        throw new Error("Connector skill/error text and structured guidance differ");
    }
    const refusal = await session.call("execute_code", {
      code: 'async () => await connecta.call("tracker.close_issue", { id: "WEB-105" })',
    });
    const caught = await session.call("execute_code", {
      code: 'async () => { try { await connecta.call("tracker.close_issue", { id: "WEB-105" }); } catch (e) { return { code: e.code, retryable: e.retryable, nextAction: e.nextAction, details: e.details }; } }',
    });
    for (const result of [refusal, caught])
      if (JSON.stringify(JSON.parse(result.text)) !== JSON.stringify(result.structured))
        throw new Error("Caught/uncaught refusal text and structured guidance differ");
    const uncaughtError = (refusal.structured as { error: Record<string, unknown> }).error;
    const caughtError = (caught.structured as { result: Record<string, unknown> }).result;
    for (const error of [uncaughtError, caughtError])
      if (
        error.code !== "pool_read_only" ||
        error.retryable !== false ||
        error.nextAction ||
        hidden.test(JSON.stringify(error))
      )
        throw new Error("Read-only code refusal was not terminal");
    if (
      world.ledger.calls.some((c) => c.kind === "write") ||
      world.tracker.issues.find((i) => i.id === "WEB-105")?.status !== "open"
    )
      throw new Error("Code boundary dispatched a refused write");
    console.log("ok   code boundary: instructions, skills, recovery and caught/uncaught terminal refusal");
  } finally {
    await session.close();
    await deployment.close();
    await world.stop();
  }
}

// Raw batches must not bypass the eval adapter, including trusted endpoints.
{
  const world = new World();
  await world.start();
  const deployment = await startNodeDeployment(world.connectorSpecs(), { trust: "trusted" }, undefined, "code");
  try {
    for (const name of ["call_tool", "call_destructive_tool", "search_tools"]) {
      const response = await fetch(deployment.mcpUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deployment.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name, arguments: { address: "tracker.close_issue", args: { id: "WEB-105" }, query: "tracker" } },
          },
        ]),
      });
      const reply = (await response.json()) as { error?: { code?: number } };
      if (response.status !== 400 || reply.error?.code !== -32600)
        throw new Error(`A batch reached the code surface: ${name}`);
    }
    if (world.ledger.calls.length || world.tracker.issues.find((i) => i.id === "WEB-105")?.status !== "open")
      throw new Error("A hidden batch call dispatched or wrote state");
    console.log("ok   code boundary: batches refused before dispatch even in a trusted pool");
  } finally {
    await deployment.close();
    await world.stop();
  }
}

// Native skill hosts verify every advertised file, not just the usage tool.
for (const arm of ["six", "code"] as const) {
  const world = new World({ prerequisites: true });
  await world.start();
  const deployment = await startNodeDeployment(world.connectorSpecs(), {}, undefined, arm);
  try {
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await fetch(deployment.mcpUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deployment.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          ...(params.uri ? { "Mcp-Name": String(params.uri) } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "connecta-eval-selftest", version: "1.0.0" },
            },
          },
        }),
      });
      const reply = (await response.json()) as Record<string, any>;
      if (!response.ok || reply.error) throw new Error(`Native ${arm} ${method} failed: ${JSON.stringify(reply)}`);
      return reply.result;
    };
    let cursor: string | undefined;
    const listed: Record<string, any>[] = [];
    do {
      const page = await rpc("skills/list", cursor ? { cursor } : {});
      listed.push(...page.skills);
      cursor = page.nextCursor;
    } while (cursor);
    const resources: Record<string, any>[] = [];
    do {
      const page = await rpc("resources/list", cursor ? { cursor } : {});
      resources.push(...page.resources);
      cursor = page.nextCursor;
    } while (cursor);
    for (const entry of listed) {
      const fetched = (await rpc("skills/get", { uri: entry.uri })).skill;
      if (JSON.stringify(entry) !== JSON.stringify(fetched)) throw new Error(`${arm} native list/get disagree`);
      for (const file of entry.resources) {
        const contents = (await rpc("resources/read", { uri: file.uri })).contents;
        if (contents.length !== 1) throw new Error(`${arm} native resource not singular`);
        const served = contents[0];
        const bytes = served.text !== undefined ? Buffer.from(served.text, "utf8") : Buffer.from(served.blob, "base64");
        const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        const resource = resources.find((r) => r.uri === file.uri);
        if (file.digest !== digest || file.size !== bytes.length || resource?.size !== bytes.length)
          throw new Error(`${arm} native manifest differs from served bytes: ${file.uri}`);
        if (
          arm === "code" &&
          entry.frontmatter.name === "usage" &&
          (served.text !== CODE_USAGE ||
            entry.frontmatter.description !== CODE_USAGE.split("description: ")[1]!.split("\n")[0])
        )
          throw new Error("Code usage frontmatter/bytes disagree with manifest");
      }
    }
    console.log(`ok   ${arm} native skills/list, skills/get and resources/list integrity for every served guide`);
  } finally {
    await deployment.close();
    await world.stop();
  }
}

// Frozen saved facts exercise outcome regrading and the paired decision rule.
const frozen = JSON.parse(
  await readFile(new URL("./baselines/gpt-6-luna-0.29.json", import.meta.url), "utf8"),
) as AgentResultFile;
for (const [name, expected, denominator] of [
  ["sonnet-5-5", 30, 34],
  ["gpt-6-luna", 36, 38],
] as const) {
  const file = JSON.parse(
    await readFile(new URL(`./baselines/${name}-0.29.json`, import.meta.url), "utf8"),
  ) as AgentResultFile;
  const trials = file.trials.map((t) =>
    regradeTrial(
      ACTIVE_TASKS.find((task) => task.id === t.task)!,
      t,
      file.config.runner ?? (file.claudeVersion ? "claude" : "codex"),
      "outcome",
    ),
  );
  if (
    trials.filter((t) => t.status === "pass").length !== expected ||
    trials.filter((t) => t.status !== "skipped").length !== denominator ||
    trials.some((t) => t.regrade?.unavailable.length)
  )
    throw new Error(`Unexpected ${name} frozen outcome regrade`);
  console.log(`ok   frozen ${name} outcome regrade ${expected}/${denominator}`);
}
{
  const source = frozen.trials.find((t) => t.task === "p5-read-only-program-refusal")!;
  const invalid = structuredClone(source);
  invalid.saved!.trace.toolUses.find((u) => u.tool === "call_destructive_tool")!.resultText =
    '{"error":{"code":"invalid_args"}}';
  const task = ACTIVE_TASKS.find((t) => t.id === invalid.task)!;
  for (const grading of ["route", "outcome"] as const)
    if (regradeTrial(task, invalid, "codex", grading).status !== "fail")
      throw new Error("An argument failure counted as a write refusal");
  console.log("ok   direct refusal requires recorded host denial, not an arbitrary tool error");
}
function expectRefusal(action: () => unknown, message: string) {
  let refused = false;
  try {
    action();
  } catch {
    refused = true;
  }
  if (!refused) throw new Error(message);
}
{
  const source = frozen.trials.find((t) => t.task === "p5-read-only-program-refusal")!;
  const task = ACTIVE_TASKS.find((t) => t.id === source.task)!;
  const incomplete = structuredClone(source);
  incomplete.saved!.world.tracker = { issues: [] };
  expectRefusal(
    () => regradeTrial(task, incomplete, "codex", "outcome"),
    "Partial tracker state inherited fresh seed data",
  );
  const unfinished = structuredClone(source);
  unfinished.saved!.trace.resultSubtypes = [];
  unfinished.saved!.trace.transcript = unfinished.saved!.trace.transcript.filter((e) => e.kind !== "turn_end");
  unfinished.checks = unfinished.checks.filter((c) => c.id !== "conversation-completed");
  const graded = regradeTrial(task, unfinished, "codex", "outcome");
  if (graded.status !== "fail" || !graded.regrade?.unavailable.includes("conversation-completed"))
    throw new Error("Missing completion evidence silently passed");
  const auth = frozen.trials.find((t) => t.task === "auth-required-recovery" && t.repeat === 1)!;
  for (const remove of ["subtype", "turn_end"] as const) {
    const partial = structuredClone(auth);
    if (remove === "subtype") partial.saved!.trace.resultSubtypes.pop();
    else
      partial.saved!.trace.transcript = partial.saved!.trace.transcript.filter(
        (e) => e.kind !== "turn_end" || e.turn !== 2,
      );
    const graded = regradeTrial(
      ACTIVE_TASKS.find((t) => t.id === auth.task)!,
      partial,
      "codex",
      "outcome",
    );
    if (graded.status !== "fail" || !graded.regrade?.unavailable.includes("conversation-completed"))
      throw new Error("A partial multi-turn completion silently passed");
  }
  const contradiction = structuredClone(frozen.trials.find((t) => t.task === "p5-known-read-routing")!);
  contradiction.saved!.trace.finalAnswer += " Commit 9f2c1ab passed.";
  const knownRead = ACTIVE_TASKS.find((t) => t.id === contradiction.task)!;
  if (regradeTrial(knownRead, contradiction, "codex", "outcome").status !== "fail")
    throw new Error("Contradictory CI commit passed");
  contradiction.saved!.world.ci = [];
  expectRefusal(() => regradeTrial(knownRead, contradiction, "codex", "outcome"), "Empty CI state hid a contradiction");
  const wrote = structuredClone(frozen.trials.find((t) => t.task === "p5-known-read-routing")!);
  const write = frozen.trials
    .find((t) => t.task === "p5-trusted-program-write")!
    .saved!.world.calls.find((c) => c.kind === "write")!;
  wrote.saved!.world.calls.push({ ...write });
  wrote.saved!.world.tracker.issues.find((i) => i.id === "WEB-105")!.status = "closed";
  wrote.saved!.trace.toolUses.push({
    id: "extra-write",
    turn: 1,
    tool: "call_destructive_tool",
    input: { address: "tracker.close_issue", args: { id: "WEB-105" } },
    isError: false,
    resultText: "closed",
  });
  for (const surface of ["six", "code"] as const)
    for (const grading of ["route", "outcome"] as const) {
      const graded = regradeTrial(knownRead, wrote, "codex", grading, surface);
      if (graded.status !== "fail" || !graded.checks.some((c) => c.id === "reads-only" && !c.pass))
        throw new Error("Known-read routing hid an unrelated business write");
    }
  const conflict = structuredClone(frozen.trials.find((t) => t.task === "truncated-write-export")!);
  conflict.saved!.world.programs[0]!.calls.push({
    name: "connecta.result",
    args: ["control"],
    outcome: "ok",
    result: ["project.deleted", "project.delete_requested"]
      .map((action) => JSON.stringify({ target: "prod-db", actor: "redacted-email-999", action }))
      .join("\n"),
  });
  expectRefusal(
    () =>
      regradeTrial(
        ACTIVE_TASKS.find((t) => t.id === conflict.task)!,
        conflict,
        "codex",
        "outcome",
      ),
    "Conflicting sanitized audit roles were accepted",
  );
  console.log("ok   incomplete state/completion and conflicting sanitized actor roles fail closed");
}
function comparisonFixture(arm: Surface, repeats: number, task?: string): AgentResultFile {
  const tasks = task ? [task] : ACTIVE_TASKS.map((t) => t.id);
  const fixture: AgentResultFile = {
    ...structuredClone(frozen),
    protocol: runProtocol("synthetic-selftest-pair"),
    config: { ...frozen.config, surface: arm, grading: "outcome", tasks, repeats },
    trials: tasks.flatMap((id) => {
      const source = frozen.trials.find((t) => t.task === id && t.repeat === 1)!;
      return Array.from({ length: repeats }, (_, index) => ({
        ...structuredClone(source),
        surface: arm,
        runner: "codex",
        grading: "outcome",
        taskDefinitionsHash: runProtocol().taskDefinitionsHash,
        timeoutMs: ACTIVE_TASKS.find((t) => t.id === id)!.limits?.timeoutMs ?? frozen.config.timeoutMs,
        repeat: index + 1,
      }));
    }),
  };
  delete fixture.regrade;
  return fixture;
}
const six = comparisonFixture("six", 20),
  code = comparisonFixture("code", 20);
if (!compare(six, code).includes("Decision PASS")) throw new Error("Equal full-batch outcomes failed comparison");
for (const trial of code.trials.filter((t) => t.task === "p5-known-read-routing").slice(0, 3))
  trial.saved!.trace.finalAnswer = "Completed.";
if (!compare(six, code).includes("task drops require triage: p5-known-read-routing (3 of 20)"))
  throw new Error("Comparison missed task-drop rule");
const atBar = comparisonFixture("code", 20),
  aboveBar = comparisonFixture("six", 20);
// 19 losses out of 380 is exactly five percentage points, spread over tasks
// so no per-task drop reaches the separate three-trial veto.
let losses = 0;
const byTask = new Map<string, number>();
for (const trial of atBar.trials) {
  if (losses === 20) break;
  if ((byTask.get(trial.task) ?? 0) >= 2) continue;
  const task = ACTIVE_TASKS.find((t) => t.id === trial.task)!;
  if (regradeTrial(task, trial, "codex", "outcome", "code").status !== "pass") continue;
  const answer = trial.saved!.trace.finalAnswer;
  trial.saved!.trace.finalAnswer = "Completed.";
  if (regradeTrial(task, trial, "codex", "outcome", "code").status !== "fail") {
    if (answer === undefined) delete trial.saved!.trace.finalAnswer;
    else trial.saved!.trace.finalAnswer = answer;
    continue;
  }
  losses++;
  byTask.set(trial.task, (byTask.get(trial.task) ?? 0) + 1);
  if (losses === 19 && !compare(aboveBar, atBar).includes("Decision PASS"))
    throw new Error("Comparison rejected exact five-point boundary");
}
if (losses !== 20 || !compare(aboveBar, atBar).includes("more than 5 percentage points"))
  throw new Error("Comparison missed rate rule");
for (const [task, needle] of [
  ["p5-trusted-program-write", "code duplicate write"],
  ["truncated-write-export", "code export-once violation"],
] as const) {
  const left = comparisonFixture("six", 1),
    right = comparisonFixture("code", 1);
  const saved = right.trials.find((t) => t.task === task)!.saved!;
  saved.world.calls.push({ ...saved.world.calls.find((c) => c.kind === "write")! });
  if (!compare(left, right).includes(needle)) throw new Error(`Comparison missed ${needle}`);
}
const subsetA = comparisonFixture("six", 1, "p5-known-read-routing"),
  subsetB = comparisonFixture("code", 1, "p5-known-read-routing");
if (!compare(subsetA, subsetB).includes("Decision NOT EVALUATED"))
  throw new Error("A diagnostic subset established the registered decision");
for (const mutate of [
  (f: AgentResultFile) => {
    f.trials.pop();
  },
  (f: AgentResultFile) => {
    f.config.effort = "xhigh";
  },
  (f: AgentResultFile) => {
    f.codexVersion = "different CLI";
  },
  (f: AgentResultFile) => {
    f.config.maxBudgetUsd = 2;
  },
  (f: AgentResultFile) => {
    f.trials[0]!.status = "skipped";
  },
]) {
  const badPair = comparisonFixture("code", 20);
  mutate(badPair);
  expectRefusal(
    () => compare(six, badPair),
    "Comparison accepted missing pairs, mismatched settings or an unsupported skip",
  );
}
// Round 2 reproductions must refuse even when BOTH arms share the same defect.
{
  const controls: [string, (t: TrialResult) => void][] = [
    [
      "missing observations",
      (t) => {
        delete t.codex;
      },
    ],
    [
      "missing requested model",
      (t) => {
        delete (t.codex as Record<string, unknown>).requestedModel;
      },
    ],
    [
      "missing served model",
      (t) => {
        delete (t.codex as Record<string, unknown>).servedModel;
      },
    ],
    [
      "wrong requested model",
      (t) => {
        t.codex!.requestedModel = "same-wrong-model";
      },
    ],
    [
      "wrong served model",
      (t) => {
        t.codex!.servedModel = "same-wrong-model";
      },
    ],
    [
      "missing CLI",
      (t) => {
        delete (t.codex as Record<string, unknown>).version;
      },
    ],
    [
      "wrong CLI",
      (t) => {
        t.codex!.version = "same-wrong-CLI";
      },
    ],
    [
      "missing runner",
      (t) => {
        delete t.runner;
      },
    ],
    [
      "missing arm",
      (t) => {
        delete t.surface;
      },
    ],
    [
      "missing grading",
      (t) => {
        delete t.grading;
      },
    ],
    [
      "missing task hash",
      (t) => {
        delete t.taskDefinitionsHash;
      },
    ],
    [
      "wrong task hash",
      (t) => {
        t.taskDefinitionsHash = "a".repeat(64);
      },
    ],
    [
      "missing task",
      (t) => {
        delete (t as Partial<TrialResult>).task;
      },
    ],
    [
      "unknown status",
      (t) => {
        (t as { status: string }).status = "complete";
      },
    ],
    [
      "missing status",
      (t) => {
        delete (t as Partial<TrialResult>).status;
      },
    ],
    [
      "missing deadline",
      (t) => {
        delete t.timeoutMs;
      },
    ],
    [
      "wrong deadline",
      (t) => {
        t.timeoutMs = 1;
      },
    ],
    [
      "missing timeout flag",
      (t) => {
        delete (t.codex as Record<string, unknown>).timedOut;
      },
    ],
    [
      "missing interruption flag",
      (t) => {
        delete (t.codex as Record<string, unknown>).aborted;
      },
    ],
    [
      "nonboolean timeout",
      (t) => {
        (t.codex as Record<string, unknown>).timedOut = "false";
      },
    ],
    [
      "missing exit",
      (t) => {
        delete (t.codex as Record<string, unknown>).exitCode;
      },
    ],
    [
      "missing completion",
      (t) => {
        delete (t.codex as Record<string, unknown>).resultSubtypes;
      },
    ],
    [
      "unknown trial flag",
      (t) => {
        (t as unknown as Record<string, unknown>).deadlineExceeded = true;
      },
    ],
    [
      "unknown runner flag",
      (t) => {
        (t.codex as Record<string, unknown>).deadlineExceeded = true;
      },
    ],
  ];
  const dir = await mkdtemp(join(tmpdir(), "connecta-round2-"));
  const args = [
    "--import",
    "tsx",
    new URL("./compare.ts", import.meta.url).pathname,
    "--a",
    join(dir, "six.json"),
    "--b",
    join(dir, "code.json"),
  ];
  try {
    for (const [name, mutate] of controls) {
      const left = comparisonFixture("six", 2),
        right = comparisonFixture("code", 2);
      for (const file of [left, right]) mutate(file.trials.find((t) => t.task === "p5-known-read-routing")!);
      expectRefusal(() => compare(left, right), `Round 2 accepted ${name}`);
      if (name !== "missing task") {
        const report = compare(left, right, { allowMismatch: true });
        if (!report.includes("NON-COMPARABLE") || report.includes("Decision PASS"))
          throw new Error(`Round 2 override did not mark ${name}`);
      }
      if (name === "missing observations") {
        await writeFile(args[4]!, JSON.stringify(left));
        await writeFile(args[6]!, JSON.stringify(right));
        const result = spawnSync(process.execPath, args, { encoding: "utf8" });
        if (result.status === 0 || result.stdout.includes("Decision") || !result.stderr.includes("Comparison refused:"))
          throw new Error("Round 2 missing observations CLI reproduction passed");
      }
    }
    for (const status of ["pass", "fail", "error"] as const)
      for (const [kind, mutate] of [
        [
          "timeout",
          (t: TrialResult) => {
            t.codex!.timedOut = true;
          },
        ],
        [
          "interruption",
          (t: TrialResult) => {
            t.codex!.aborted = true;
          },
        ],
        [
          "runnerExit",
          (t: TrialResult) => {
            t.codex!.exitCode = 1;
          },
        ],
        [
          "runnerExit",
          (t: TrialResult) => {
            t.codex!.exitCode = null;
          },
        ],
        [
          "error",
          (t: TrialResult) => {
            t.error = "runner error";
          },
        ],
        [
          "error",
          (t: TrialResult) => {
            t.codex!.resultSubtypes = ["error_during_execution"];
          },
        ],
        [
          "error",
          (t: TrialResult) => {
            t.saved!.trace.transcript.find((e) => e.kind === "turn_end")!.isError = true;
          },
        ],
      ] as const) {
        const left = comparisonFixture("six", 2),
          right = comparisonFixture("code", 2);
        const trial = right.trials.find((t) => t.task === "p5-known-read-routing")!;
        trial.status = status;
        mutate(trial);
        const report = compare(left, right);
        if (
          !report.includes("code 35/38") ||
          !report.includes(`${kind} 1`) ||
          !report.includes("Decision FAIL") ||
          !report.includes("infrastructure errors")
        )
          throw new Error(`Round 2 ${status}/${kind} lost denominator or veto: ${report}`);
        if (status === "fail" && kind === "timeout") {
          await writeFile(args[4]!, JSON.stringify(left));
          await writeFile(args[6]!, JSON.stringify(right));
          const result = spawnSync(process.execPath, args, { encoding: "utf8" });
          if (
            result.status !== 0 ||
            !result.stdout.includes("Decision FAIL") ||
            result.stdout.includes("Decision PASS")
          )
            throw new Error("Round 2 timeout CLI reproduction passed");
        }
      }
    console.log(
      `ok   round 2: ${controls.length} strict trial controls and 21 flagged-outcome controls, including CLI reproductions`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Synthetic paired measurements above use saved baseline facts solely to test
// the rule. Real historical files remain unmodified and must be refused.
{
  const controls: [string, (file: AgentResultFile) => void][] = [
    [
      "source commit",
      (f) => {
        f.meta.git.commit = "abcdef012345";
      },
    ],
    [
      "source srcTree",
      (f) => {
        f.meta.git.srcTree = "abcdef012345";
      },
    ],
    [
      "dirty",
      (f) => {
        f.meta.git.dirty = true;
      },
    ],
    [
      "srcDirty",
      (f) => {
        f.meta.git.srcDirty = true;
      },
    ],
    [
      "known source commit",
      (f) => {
        f.meta.git.commit = "unknown";
      },
    ],
    [
      "known source srcTree",
      (f) => {
        f.meta.git.srcTree = "unknown";
      },
    ],
    [
      "taskDefinitionsHash",
      (f) => {
        f.protocol!.taskDefinitionsHash = "changed prompts";
      },
    ],
    [
      "harnessHash",
      (f) => {
        f.protocol!.harnessHash = "changed fakes";
      },
    ],
    [
      "protocol version",
      (f) => {
        delete f.protocol;
      },
    ],
    [
      "pairId",
      (f) => {
        f.protocol!.pairId = "another-batch";
      },
    ],
    [
      "paired batch ID",
      (f) => {
        delete f.protocol!.pairId;
      },
    ],
    [
      "grading",
      (f) => {
        f.config.grading = "route";
      },
    ],
    [
      "grading",
      (f) => {
        delete f.config.grading;
      },
    ],
    [
      "runner",
      (f) => {
        f.config.runner = "claude";
        f.claudeVersion = "control";
      },
    ],
    [
      "runner",
      (f) => {
        delete f.config.runner;
      },
    ],
    [
      "CLI version",
      (f) => {
        f.codexVersion = "different CLI";
      },
    ],
    [
      "CLI version",
      (f) => {
        delete f.codexVersion;
      },
    ],
    [
      "model set",
      (f) => {
        f.config.models = ["other-model"];
        f.trials.forEach((t) => {
          t.model = "other-model";
        });
      },
    ],
    [
      "served model",
      (f) => {
        f.trials[0]!.codex!.servedModel = "other-model";
      },
    ],
    [
      "requested model",
      (f) => {
        f.trials[0]!.codex!.requestedModel = "other-model";
      },
    ],
    [
      "CLI version contradicts",
      (f) => {
        f.trials[0]!.codex!.version = "different CLI";
      },
    ],
    [
      "task set",
      (f) => {
        f.config.tasks.pop();
        f.trials = f.trials.filter((t) => f.config.tasks.includes(t.task));
      },
    ],
    [
      "repeats",
      (f) => {
        f.config.repeats++;
      },
    ],
    [
      "timeoutMs",
      (f) => {
        f.config.timeoutMs++;
      },
    ],
    [
      "concurrency",
      (f) => {
        f.config.concurrency++;
      },
    ],
    [
      "valid concurrency",
      (f) => {
        f.config.concurrency = 0;
      },
    ],
    [
      "effort",
      (f) => {
        f.config.effort = "xhigh";
      },
    ],
    [
      "maxBudgetUsd",
      (f) => {
        f.config.maxBudgetUsd = 2;
      },
    ],
    [
      "MCP output limit",
      (f) => {
        f.config.mcpOutputTokens = 123;
      },
    ],
    [
      "arm label",
      (f) => {
        delete f.config.surface;
      },
    ],
    [
      "arm label",
      (f) => {
        f.config.surface = "six";
      },
    ],
    [
      "trial",
      (f) => {
        delete f.trials[0]!.surface;
      },
    ],
    [
      "trial",
      (f) => {
        f.trials[0]!.surface = "six";
      },
    ],
    [
      "trial",
      (f) => {
        f.trials[0]!.grading = "route";
      },
    ],
    [
      "trial",
      (f) => {
        f.trials[0]!.runner = "claude";
      },
    ],
    [
      "packageVersion",
      (f) => {
        f.meta.packageVersion = "old";
      },
    ],
    [
      "node",
      (f) => {
        f.meta.node = "old";
      },
    ],
    [
      "platform",
      (f) => {
        f.meta.platform = "other";
      },
    ],
    [
      "offline regrade",
      (f) => {
        f.regrade = { source: "historical.json", meta: f.meta };
      },
    ],
  ];
  for (const [reason, mutate] of controls) {
    const left = comparisonFixture("six", 1),
      right = comparisonFixture("code", 1);
    mutate(right);
    let message = "";
    try {
      compare(left, right);
    } catch (error) {
      message = String(error);
    }
    if (!message.includes("Comparison refused:") || !message.includes(reason) || message.includes("Decision"))
      throw new Error(`Missing provenance refusal for ${reason}: ${message}`);
  }
  expectRefusal(() => compare(frozen, comparisonFixture("code", 2)), "Historical baseline established a decision");
  const left = comparisonFixture("six", 1),
    right = comparisonFixture("code", 1);
  right.meta.git.commit = "abcdef012345";
  right.protocol!.taskDefinitionsHash = "different prompts";
  const report = compare(left, right, { allowMismatch: true });
  if (
    !report.includes("Decision NON-COMPARABLE PASS") ||
    report.includes("Decision PASS") ||
    !report.includes("source commit") ||
    !report.includes("taskDefinitionsHash")
  )
    throw new Error("Explicit mismatch diagnostics printed an unqualified decision");
  // Matching stale protocols are still incompatible with the current grader.
  left.protocol!.harnessHash = right.protocol!.harnessHash = "stale fakes";
  expectRefusal(() => compare(left, right), "Equally stale protocols established a decision");
  const cliArgs = [
    "--import",
    "tsx",
    new URL("./compare.ts", import.meta.url).pathname,
    "--a",
    new URL("./baselines/gpt-6-luna-0.29.json", import.meta.url).pathname,
    "--b",
    new URL("./baselines/gpt-6-luna-0.29.json", import.meta.url).pathname,
  ];
  const refused = spawnSync(process.execPath, cliArgs, { encoding: "utf8" });
  if (refused.status === 0 || refused.stdout.includes("Decision") || !refused.stderr.includes("Comparison refused:"))
    throw new Error("CLI provenance mismatch did not exit nonzero without a decision");
  const allowed = spawnSync(process.execPath, [...cliArgs, "--allow-mismatch"], { encoding: "utf8" });
  if (
    allowed.status !== 0 ||
    !allowed.stdout.includes("Decision NON-COMPARABLE") ||
    allowed.stdout.includes("Decision PASS")
  )
    throw new Error(`CLI mismatch override did not mark its decision: ${allowed.stderr}`);
  console.log(
    `ok   comparison provenance: ${controls.length} specific refusals, historical baseline, stale protocol and NON-COMPARABLE override`,
  );
}
{
  const left = comparisonFixture("six", 1),
    right = comparisonFixture("code", 1);
  for (const file of [left, right]) {
    file.config.runner = "claude";
    file.claudeVersion = "control CLI";
    for (const trial of file.trials) {
      trial.runner = "claude";
      delete trial.codex;
      trial.claude = {
        requestedModel: trial.model,
        servedModel: trial.model,
        version: "control CLI",
        exitCode: 0,
        timedOut: false,
        aborted: false,
        resultSubtypes: ["success"],
      };
      const skip = ACTIVE_TASKS.find((t) => t.id === trial.task)!.runnerSkips?.claude;
      if (skip) {
        trial.status = "skipped";
        trial.skip = skip;
        trial.metrics.conversationTurns = 0;
        trial.checks = [];
        trial.transcript = [];
        trial.saved!.trace.transcript = [];
        trial.saved!.trace.resultSubtypes = [];
        trial.saved!.trace.toolUses = [];
        delete trial.claude;
      }
    }
  }
  const saved = right.trials.find((t) => t.task === "p5-direct-rich-output")!.saved!;
  const write = right.trials
    .find((t) => t.task === "p5-trusted-program-write")!
    .saved!.world.calls.find((c) => c.kind === "write")!;
  saved.world.calls.push({ ...write }, { ...write });
  const report = compare(left, right);
  if (!report.includes("Decision FAIL") || !report.includes("1 code duplicate write"))
    throw new Error("A permitted N/A erased an observed duplicate write");
  const trial = right.trials.find((t) => t.task === "p5-direct-rich-output")!;
  delete trial.saved;
  const rawWrite = right.trials
    .find((t) => t.task === "p5-trusted-program-write")!
    .ledger.find((c) => c.kind === "write")!;
  trial.ledger.push({ ...rawWrite }, { ...rawWrite });
  const rawReport = compare(left, right);
  if (!rawReport.includes("Decision FAIL") || !rawReport.includes("1 code duplicate write"))
    throw new Error("A snapshot-less N/A trusted cached zero duplicate writes");
  trial.ledger.at(-1)!.args = "clipped arguments…";
  expectRefusal(() => compare(left, right), "Incomplete N/A write arguments hid safety evidence");
}
console.log(
  "ok   comparison: full scope, paired rates, exact decision boundary, task drops, all-row safety, settings, skips and missing pairs",
);
