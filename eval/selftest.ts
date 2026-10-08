/**
 * `npm run eval:selftest` — the harness checking itself, with no LLM.
 *
 * For every active task, a scripted MCP client plays the ideal route against a
 * fresh world and deployment, and the grader must pass it; an agent that does
 * nothing must fail it. A grader that passes a no-op or fails the reference is
 * a broken yardstick, and every later phase would be measured with it.
 */
import { World } from "./fakes/world.js";
import { startNodeDeployment } from "./deploy/node.js";
import { connectMcp } from "./support/mcp.js";
import type { AgentTrace, ToolUse, TranscriptEntry } from "./agent/trace.js";
import { counterexamples, positiveVariants } from "./tasks/counterexamples.js";
import { ACTIVE_TASKS } from "./tasks/index.js";
import { startAuthHost } from "./agent/auth-host.js";
import { parseTrace, type StreamEvent } from "./agent/trace.js";
import { flags } from "./support/meta.js";
import type { ActiveTask, Check } from "./tasks/types.js";
import { readFile } from "node:fs/promises";
import { saveGradeInputs } from "./agent/saved.js";
import { regradeTrial } from "./agent/regrade.js";
import { summarize } from "./report/summary.js";
import type { TrialResult } from "./agent/run.js";
import { BADGE_PNG, LEGACY_BADGE_PNG } from "./fakes/prerequisites.js";
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
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end)) return false;
    if (bytes.subarray(offset + 4, offset + 8).toString() === "IDAT") imageData.push(bytes.subarray(offset + 8, end));
    offset = end + 4;
  }
  return inflateSync(Buffer.concat(imageData)).length === 32 * (1 + 32 * 3);
}
if (!validPng(BADGE_PNG) || validPng(LEGACY_BADGE_PNG)) throw new Error("Badge PNG integrity controls failed");

interface TrialControl {
  task: string; runner: string; repeat: number; checks: string[];
  finalAnswer: string; channel?: string; artifactId?: string;
  program?: string; programResult?: string;
}
const trialControls = JSON.parse(await readFile(new URL("./tasks/fixtures/baseline-909b-controls.json", import.meta.url), "utf8")) as TrialControl[];

function emptyTrace(toolUses: ToolUse[], finalAnswer = "", transcript: TranscriptEntry[] = []): AgentTrace {
  return {
    finalAnswer, transcript,
    toolUses,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    costUsd: undefined,
    apiMs: 0,
    modelTurns: 0,
    permissionDenials: [],
    resultSubtypes: [],
    model: undefined,
    claudeCodeVersion: undefined,
    loadedTools: [],
    rateLimit: undefined,
  };
}

async function play(task: ActiveTask, mode: "reference" | "noop"): Promise<{ correct: Check[]; wrongDestination: Check[]; missingEvidence: Check[]; regressions: ReturnType<typeof counterexamples>; positives: ReturnType<typeof positiveVariants> }> {
  const world = new World(task.world);
  await world.start();
  for (const { service, fault } of task.faults ?? []) world.service(service).faults.push(fault);
  const deployment = await startNodeDeployment(world.connectorSpecs(), task.deployment, task.world?.oauth ? world.oauth : undefined);
  const hostEvents: StreamEvent[] = [];
  const host = task.host ? await startAuthHost(deployment, task.host.urlElicitation === "capable", e => hostEvents.push(e)) : undefined;
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
    if (mode === "reference") {
      // A schema rejection must not shift the observer-to-tool correlation.
      if (task.id === "p5-fanout-over-budget") {
        const rejected = await session.call("execute_code", {});
        if (!rejected.isError) throw new Error("Expected malformed execute_code to be rejected");
        toolUses.push({ id: "ref-invalid", turn, tool: "execute_code", input: {}, isError: true, resultText: rejected.text, resultBlocks: rejected.content });
      }
      await task.reference({
        world,
        answer: text => { finalAnswer = text; transcript.push({ kind: "assistant", turn, text }); },
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
          transcript.push({ kind: "tool_result", turn, id: toolUses.at(-1)!.id,
            isError: result.isError, text: result.text, chars: result.text.length });
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
    const regressions = mode === "reference" ? counterexamples(task, world, trace) : [];
    const positives = mode === "reference" ? positiveVariants(task, world, trace) : [];
    if (mode === "reference") {
      for (const control of trialControls.filter(c => c.task === task.id)) {
        const saved = structuredClone(saveGradeInputs(world, trace));
        saved.trace.finalAnswer = control.finalAnswer;
        if (control.channel) for (const call of saved.world.calls) {
          if (call.service === "chat" && call.tool === "post_message") call.args.channel = control.channel;
        }
        if (control.artifactId) {
          for (const artifact of saved.world.artifacts?.artifacts ?? []) artifact.id = control.artifactId;
          for (const message of saved.world.chat.messages) message.text = message.text.replaceAll("/artifacts/open-bugs", `/artifacts/${control.artifactId}`);
        }
        if (control.program) {
          // Same observed refused target, but the actual trial caught the
          // rejection and successfully returned its error code to the host.
          const use = saved.trace.toolUses.find(u => u.tool === "execute_code")!;
          use.input.code = control.program;
          use.isError = false;
          use.resultText = control.programResult;
        }
        const trial: TrialResult = { task: task.id, model: "control", repeat: 1, status: "fail", saved,
          checks: [], metrics: { wallMs: 0, apiMs: 0, modelTurns: 0, conversationTurns: 1,
            tokens: trace.tokens, costUsd: undefined, metaTools: {}, otherTools: {}, toolErrors: 0,
            confirmationNudges: 0, downstream: { reads: 0, writes: 0, duplicateReads: 0, duplicateWrites: 0, errors: 0, unauthorizedRequests: 0, byTool: {} } },
          approvals: { allowed: [], denied: [], gated: [], exercised: [], permissionDenials: [] },
          transcript: saved.trace.transcript, ledger: [], startedAt: "control" };
        // Grade without the runner skip to exercise corrected evidence even
        // when the live CLI cannot deliver the task's rich output.
        const graded = regradeTrial({ ...task, runnerSkips: {} }, trial, "codex");
        positives.push({ name: `saved ${control.runner} #${control.repeat}: ${control.checks.join(", ")}`,
          passed: control.checks.every(id => graded.checks.some(c => c.id === id && c.pass)) && !graded.regrade?.unavailable.length });
        const missing = regradeTrial({ ...task, runnerSkips: {} }, { ...trial,
          saved: { ...saved, trace: { ...saved.trace, finalAnswer: "Completed." } } }, "codex");
        regressions.push({ name: `saved ${control.runner} #${control.repeat} without evidence`,
          rejected: missing.checks.some(c => c.id === "answer-evidence" && !c.pass) });
        const wrong = structuredClone(saved);
        for (const call of wrong.world.calls) call.service = "wrong_destination";
        for (const program of wrong.world.programs) for (const call of program.calls) {
          call.args[0] = "wrong_destination";
          if (call.name === "connecta.search") call.result = { absence: { service: "wrong_destination" } };
        }
        for (const use of wrong.trace.toolUses) {
          if (use.tool === "search_tools") { use.input.query = "wrong_destination"; use.input.connector = "wrong_destination"; }
        }
        const bad = regradeTrial({ ...task, runnerSkips: {} }, { ...trial, saved: wrong }, "codex");
        regressions.push({ name: `saved ${control.runner} #${control.repeat} wrong destination`,
          rejected: bad.checks.some(c => c.id === "correct-destination" && !c.pass) });
        if (task.runnerSkips?.claude) {
          const skipped = regradeTrial(task, trial, "claude");
          const summary = summarize([skipped])[0]!;
          positives.push({ name: "typed runner skip excluded from pass rate",
            passed: skipped.status === "skipped" && skipped.skip?.code === "runner-limitation" && summary.passRate === undefined && summary.skipped === 1 });
        }
      }
    }
    if (mode === "reference" && task.id === "p5-absent-github") {
      for (const route of ["search_tools", "execute_code"]) {
        const programs = world.programs;
        if (route === "search_tools") world.programs = [];
        const controls = task.grade({ world, trace: { ...trace, toolUses: trace.toolUses.filter(u => u.tool === route) } });
        world.programs = programs;
        if (controls.some(c => !c.advisory && !c.pass)) throw new Error(`Valid ${route} absence discovery failed`);
      }
    }
    const missingEvidence = task.grade({ world, trace: { ...trace, finalAnswer: "Completed." } });
    // Keep the successful state and answer, but attribute every source call
    // to another destination. This isolates source enforcement from evidence.
    for (const call of world.ledger.calls) call.service = "wrong_destination";
    for (const p of world.programs) for (const c of p.calls) {
      if (typeof c.args[0] === "string") c.args[0] = c.args[0].replace(/^[^.]+/, "wrong_destination");
      if (c.name === "connecta.search") c.result = { absence: { service: "wrong_destination" } };
    }
    const wrongUses = toolUses.map(use => ({ ...use, input: {
      ...use.input,
      ...(typeof use.input.address === "string" ? { address: use.input.address.replace(/^[^.]+/, "wrong_destination") } : {}),
      ...(typeof use.input.connector === "string" ? { connector: "wrong_destination" } : {}),
      ...(typeof use.input.query === "string" ? { query: "wrong_destination" } : {}),
      ...(typeof use.input.code === "string" ? { code: use.input.code.replace(/tracker|ci|assets|oauth|mixpanel|supabase|revenuecat|github/gi, "wrong_destination") } : {}),
    } }));
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
  const caught = trialControls.find(c => c.task === task.id && c.program);
  if (caught) {
    const actual = await play({ ...task, reference: async ctx => {
      await ctx.call("execute_code", { code: caught.program! });
      ctx.answer(caught.finalAnswer);
    } }, "reference");
    if (required(actual.correct).some(c => !c.pass)) {
      failures += 1;
      console.log(`FAIL ${task.id}: replay of the real caught-refusal program against fresh fakes`);
    } else console.log(`ok   ${task.id}: real caught-refusal program against fresh fakes`);
  }
  const reference = played.correct;
  const refFailed = required(reference).filter((item) => !item.pass);
  const noop = (await play(task, "noop")).correct;
  const noopPassed = required(noop).every((item) => item.pass);
  const destinationRejected = played.wrongDestination.some(c => c.id === "correct-destination" && !c.pass) &&
    played.wrongDestination.some(c => c.id === "answer-evidence" && c.pass);
  const evidenceRejected = played.missingEvidence.some(c => c.id === "answer-evidence" && !c.pass) &&
    played.missingEvidence.some(c => c.id === "correct-destination" && c.pass);
  const ok = refFailed.length === 0 && !noopPassed && destinationRejected && evidenceRejected && played.regressions.every(c => c.rejected) && played.positives.every(c => c.passed);
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
  if (!destinationRejected) console.log("       wrong-destination answer did not fail the destination check independently");
  if (!evidenceRejected) console.log("       right-destination answer without facts did not fail evidence independently");
  if (noopPassed) console.log("       a no-op agent passed the grader");
}
if (failures) {
  console.error(`${failures} task(s) have a broken grader or reference.`);
  process.exitCode = 1;
}
