/** No paid model: actual Worker surface, state, paging and grader controls. */
import { playReference } from "./agent/reference.js";
import assert from "node:assert/strict";
import { z } from "zod";
import { FakeService, Ledger, type FakeTool } from "./fakes/service.js";
import { NO_INJECTION } from "./fakes/injection.js";
import { World } from "./fakes/world.js";
import { startDeployment } from "./deploy/targets.js";
import { connectMcp } from "./support/mcp.js";
import { assertSurface, parseSurface, type Surface } from "./agent/surface.js";
import { ACTIVE_TASKS } from "./tasks/index.js";
import { gradeTask, passes } from "./tasks/grading.js";
import { downstreamMetrics, parseTrace } from "./agent/trace.js";
import { connectionLost } from "./agent/infra.js";
import { restoreGradeInputs, saveGradeInputs } from "./agent/saved.js";
import { deliveredValues } from "./tasks/correctness.js";
import type { ActiveTask } from "./tasks/types.js";
import { taskForSurface } from "./tasks/surface.js";

/** A distractor read is reported, a distractor write fails, and neither enters the task ledger. */
async function distractorControls(arm: Surface, task: ActiveTask, world: World, write: () => Promise<void>) {
  const grade = () => {
    const trace = parseTrace([], [], []);
    trace.finalAnswer = "CI run 4812 failed, commit 9f2c1ab.";
    return gradeTask(taskForSurface(task, arm), { world, trace }, arm, "outcome");
  };
  const check = () => grade().find((candidate) => candidate.id === "no-distractor-writes");
  assert.equal(world.injected.catalogCalls.length, 1);
  assert.equal(world.injected.catalogCalls[0]?.kind, "read");
  assert.equal(check()?.pass, true);
  const before = world.ledger.calls.length;
  await write();
  assert.equal(world.ledger.calls.length, before);
  assert.equal(downstreamMetrics(world.injected.catalogCalls, []).writes, 1);
  assert.equal(check()?.pass, false);
  assert.equal(passes(grade(), "outcome"), false);
  const restored = restoreGradeInputs(structuredClone(saveGradeInputs(world, parseTrace([], [], []))));
  assert.equal(restored.world.injected.catalogCalls.length, 2);
}

/** A read a host cached turns into a write: replays of its name write nothing, and the write's own name writes once. */
async function staleReadNameControl() {
  const ledger = new Ledger();
  const tool: FakeTool = {
    name: "set_status",
    description: "Set a record's status.",
    input: z.object({ id: z.string() }),
    annotations: { readOnlyHint: true, destructiveHint: false },
    run: () => ({ json: { ok: true } }),
  };
  const crm = new FakeService("crm", "Customer records.", [tool], ledger);
  await crm.start();
  const world = new World({}, NO_INJECTION);
  await world.start();
  const specs = world.connectorSpecs.bind(world);
  world.connectorSpecs = () => [
    ...specs(),
    { id: "crm", title: "crm", description: "Customer records.", url: crm.url },
  ];
  const deployment = await startDeployment("worker", world, { id: "stale-read-name" } as ActiveTask, "native");
  const physical = () => crm.calls.filter((call) => call.tool === "set_status").length;
  try {
    const before = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
    assert.equal(
      (await before.listTools()).find((listed) => listed.address === "crm.set_status")?.name,
      "crm__set_status",
    );
    await before.close();
    tool.annotations = { readOnlyHint: false, destructiveHint: true };
    assert.ok(deployment.restart);
    await deployment.restart(false);
    const after = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
    assert.equal(
      (await after.listTools()).find((listed) => listed.address === "crm.set_status")?.name,
      "crm__WRITE__set_status",
    );
    for (const id of ["A-1", "A-2", "A-1", "A-2"]) {
      const replay = await after.call("crm__set_status", { id });
      assert.equal(replay.isError, true);
      assert.match(replay.text, /destructive_tool_requires_approval/);
    }
    assert.equal(physical(), 0);
    assert.equal((await after.call("crm__WRITE__set_status", { id: "A-1" })).isError, false);
    assert.equal(physical(), 1);
    await after.close();
    console.log("ok native: replays of a stale read name wrote nothing, and the write's own name wrote once");
  } finally {
    await deployment.close();
    await world.stop();
    await crm.stop();
  }
}

async function nativeControls() {
  assert.throws(() => parseSurface("wrong"));
  for (const arm of ["six", "native", "native-no-code"] as const) {
    const task = ACTIVE_TASKS.find((task) => task.id === "p5-known-read-routing")!;
    const world = new World(task.world);
    await world.start();
    let deployment;
    let mcp;
    try {
      deployment = await startDeployment("worker", world, task, arm);
      mcp = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
      const tools = await mcp.listTools();
      const names = tools.map((tool) => tool.name);
      assertSurface(names, arm);
      for (const wrong of ["six", "code", "native", "native-no-code"] as Surface[]) {
        if (wrong !== arm) assert.throws(() => assertSurface(names, wrong));
      }
      assert.throws(() => assertSurface([...names, "call_tool_wrong"], arm));
      const trace = parseTrace([], [], []);
      trace.finalAnswer = "CI run 4812 failed, commit 9f2c1ab.";
      assert.equal(passes(gradeTask(taskForSurface(task, arm), { world, trace }, arm, "outcome"), "outcome"), false);
      const name = arm === "six" ? "call_tool" : tools.find((tool) => tool.address === "ci.get_run")!.name;
      const input = arm === "six" ? { address: "ci.get_run", args: { runId: 4812 } } : { runId: 4812 };
      const result = await mcp.call(name, input);
      assert.equal(result.isError, false);
      const listed = tools.find((tool) => tool.name === name)!;
      trace.toolUses.push({
        id: "read",
        turn: 0,
        tool: name,
        input,
        isError: false,
        resultText: result.text,
        resultBlocks: result.content,
        ...(listed.address ? { native: { address: listed.address, readOnly: listed.readOnly } } : {}),
      });
      assert.equal(passes(gradeTask(taskForSurface(task, arm), { world, trace }, arm, "outcome"), "outcome"), true);
      assert.equal(world.ledger.calls.filter((call) => call.kind === "write").length, 0);
      const logName = arm === "six" ? "call_tool" : tools.find((tool) => tool.address === "ci.get_run_log")!.name;
      const log = await mcp.call(
        logName,
        arm === "six" ? { address: "ci.get_run_log", args: { runId: 4812 } } : { runId: 4812 },
      );
      assert.equal(log.isError, false);
      if (arm === "native-no-code") {
        const notice = JSON.parse(log.text.split("\n")[0]!);
        assert.equal(notice.truncated, true);
        const page = await mcp.call("read_result", { ...notice.nextAction.arguments, offset: 0, maxBytes: 3500 });
        assert.equal(page.isError, false);
      }
      const writeName =
        arm === "six" ? "call_destructive_tool" : tools.find((tool) => tool.address === "chat.post_message")!.name;
      const write = await mcp.call(
        writeName,
        arm === "six"
          ? { address: "chat.post_message", args: { channel: "eng", text: "native control" } }
          : { channel: "eng", text: "native control" },
      );
      assert.equal(write.isError, false);
      assert.equal(world.ledger.calls.filter((call) => call.kind === "write").length, 1);
      assert.ok(deployment.restart);
      await deployment.restart(true);
      const before = world.ledger.calls.length;
      const refusal = await mcp.call(
        arm === "six" ? "call_destructive_tool" : "tracker__WRITE__close_issue",
        arm === "six" ? { address: "tracker.close_issue", args: { id: "WEB-105" } } : { id: "WEB-105" },
      );
      assert.equal(refusal.isError, true);
      assert.match(refusal.text, /read_only_endpoint/);
      assert.equal(world.ledger.calls.length, before);
      assert.equal(world.tracker.issues.find((issue) => issue.id === "WEB-105")?.status, "open");
      console.log(
        `ok ${arm}: exact arm guard, real Worker read, no-op rejected, known-read grader accepted native facts`,
      );
    } finally {
      await mcp?.close();
      await deployment?.close();
      await world.stop();
    }
  }
}
await nativeControls();
await staleReadNameControl();

// A real retained result: rows reach the agent only after every read_result page.
{
  const base = ACTIVE_TASKS.find((task) => task.id === "overflow-donor-paging")!;
  const task = { ...base, deployment: { ...base.deployment, calls: { maxResultBytes: 1024 } } };
  await playReference(
    task,
    {
      mode: "noop",
      target: "node",
      surface: "native-no-code",
      before: async ({ session, toolUses }) => {
        const listed = (await session.listTools()).find((tool) => tool.address === "overflow.list_donors")!;
        const first = await session.call(listed.name, {});
        toolUses.push({
          id: "first",
          turn: 1,
          tool: listed.name,
          input: {},
          native: { address: listed.address!, readOnly: true },
          isError: first.isError,
          resultText: first.text,
          resultBlocks: first.content,
        });
        let next = JSON.parse(first.text.split("\n")[0]!).nextAction.arguments;
        while (next) {
          const page = await session.call("read_result", next);
          toolUses.push({
            id: `page-${toolUses.length}`,
            turn: 1,
            tool: "read_result",
            input: next,
            isError: page.isError,
            resultText: page.text,
            resultBlocks: page.content,
          });
          const header = JSON.parse(page.text.split("\n")[0]!);
          next = header.hasMore ? { id: header.resultId, offset: header.nextOffset } : undefined;
        }
      },
    },
    ({ trace }) => {
      assert.ok(trace.toolUses.length > 2, "the fixture must actually page");
      const rows = (t: typeof trace) => deliveredValues(t).filter((row) => row?.id);
      assert.ok(rows(trace).length > 0, "complete pages must deliver rows");
      const partial = { ...trace, toolUses: trace.toolUses.slice(0, -1) };
      assert.equal(rows(partial).length, 0, "a partial read proves nothing");
    },
  );
  console.log("ok read_result: complete pages deliver rows, partial pages deliver none");
}

// The host's token is checked against the real deployment at trial end.
for (const target of ["node", "worker"] as const) {
  const task = ACTIVE_TASKS.find((task) => task.id === "p5-known-read-routing")!;
  const world = new World(task.world);
  await world.start();
  const deployment = await startDeployment(target, world, task, "six");
  try {
    assert.equal(await connectionLost(deployment.mcpUrl, deployment.token), undefined);
    assert.match(
      (await connectionLost(deployment.mcpUrl, "cta_revoked_by_a_reload")) ?? "",
      /rejected the agent's token .*HTTP 401/,
    );
    console.log(`ok ${target}: a rejected token at trial end is reported as lost`);
  } finally {
    await deployment.close();
    await world.stop();
  }
}

for (const surface of ["native", "native-no-code"] as const) {
  for (const id of ["pco-step2-filtered-people", "pco-step2-plan-join", "pco-step2-update-recovery"]) {
    const task = ACTIVE_TASKS.find((task) => task.id === id)!;
    await playReference(task, { mode: "reference", target: "worker", surface }, ({ world, trace }) => {
      const checks = gradeTask(task, { world, trace }, surface, "outcome");
      assert.equal(passes(checks, "outcome"), true, JSON.stringify(checks.filter((check) => !check.pass)));
      if (id === "pco-step2-plan-join") {
        const fabricated = {
          ...trace,
          toolUses: trace.toolUses.map((use) => ({ ...use, resultText: "{}", resultBlocks: [] })),
        };
        assert.equal(
          gradeTask(task, { world, trace: fabricated }, surface, "outcome").find(
            (check) => check.id === "delivered-data",
          )?.pass,
          false,
        );
      }
      if (id === "pco-step2-update-recovery") {
        const write = world.ledger.calls.find((call) => call.kind === "write")!;
        world.ledger.calls.push({ ...write });
        assert.equal(
          gradeTask(task, { world, trace }, surface, "outcome").find((check) => check.id === "no-duplicate-writes")
            ?.pass,
          false,
        );
      }
      console.log(`ok ${surface} ${id}: native state, evidence, recovery and physical-write controls`);
    });
  }
}

for (const target of ["node", "worker"] as const) {
  for (const arm of ["six", "five", "native", "native-no-code"] as const) {
    const task = ACTIVE_TASKS.find((task) => task.id === "p5-known-read-routing")!;
    const world = new World(task.world, {
      latencyMs: 0,
      d1LatencyMs: 0,
      hungConnector: false,
      unauthorizedConnector: false,
      catalogTools: 132,
    });
    await world.start();
    let deployment;
    let mcp;
    try {
      deployment = await startDeployment(target, world, task, arm);
      mcp = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
      const tools = await mcp.listTools();
      assertSurface(
        tools.map((tool) => tool.name),
        arm,
      );
      if (arm === "five") {
        assert.doesNotMatch(JSON.stringify([mcp.instructions, tools]), /search_tools/);
        const guide = await mcp.call("skills", { name: "usage" });
        assert.doesNotMatch(guide.text, /search_tools/);
        assert.doesNotMatch(JSON.stringify(await mcp.readResource("skill://connecta/usage")), /search_tools/);
        // The usage guide on this arm is the product's, not the code arm's.
        assert.doesNotMatch(JSON.stringify(await mcp.listResources()), /Use Connecta programs for discovery/);
        const before = world.ledger.calls.length;
        await assert.rejects(() => mcp!.call("search_tools", { query: "issues" }), /eval_unavailable_tool/);
        assert.equal(world.ledger.calls.length, before);
        const recovery = await mcp.call("call_tool", { address: "ci.nonexistent", args: {} });
        assert.doesNotMatch(recovery.text, /search_tools/);
        const guest = await mcp.call("execute_code", {
          code: 'async () => { try { await connecta.call("ci.nonexistent", {}); } catch (e) { return e; } }',
        });
        assert.doesNotMatch(guest.text, /search_tools/);
      }
      const ids = new Set(world.injected.ids());
      if (arm.startsWith("native")) {
        const beforeRefusal = world.ledger.calls.length;
        const refused = async (name: string, args: Record<string, unknown>) => {
          const outcome = await mcp!.call(name, args).then(
            (result: { isError: boolean; text: string }) => ({ refused: result.isError, text: result.text }),
            (error: unknown) => ({ refused: true, text: String(error) }),
          );
          assert.equal(outcome.refused, true);
          assert.match(outcome.text, /not found|unknown_tool|unavailable/);
        };
        await refused("search_tools", { query: "issues" });
        await refused("call_tool", { address: "ci.get_run", args: { runId: 4812 } });
        if (arm === "native-no-code") await refused("execute_code", { code: "async () => 1" });
        assert.equal(world.ledger.calls.length, beforeRefusal);
        const padding = tools.filter((tool) => ids.has(tool.address?.split(".")[0] ?? ""));
        assert.equal(padding.length, 132);
        const before = world.ledger.calls.length;
        const read = padding.find((tool) => tool.readOnly)!;
        assert.equal((await mcp.call(read.name, {})).isError, false);
        assert.equal(world.ledger.calls.length, before);
        await distractorControls(arm, task, world, async () => {
          const write = padding.find((tool) => !tool.readOnly)!;
          assert.equal((await mcp!.call(write.name, {})).isError, false);
        });
      } else {
        let found = 0;
        for (const connector of ids) {
          const code = `async () => await connecta.search({ connector: ${JSON.stringify(connector)}, query: "", limit: 100, includeSchemas: "compact" })`;
          const result = await mcp.call("execute_code", { code });
          assert.equal(result.isError, false);
          const data = JSON.parse(result.text);
          // execute_code's value envelope is intentionally not a downstream result.
          const wire = JSON.stringify(data);
          assert.match(wire, new RegExp(connector));
          assert.equal(data.result.tools.length, 22);
          found += data.result.tools.length;
        }
        assert.equal(found, 132);
        const before = world.ledger.calls.length;
        assert.equal((await mcp.call("call_tool", { address: "billing_ops.list_issues_1", args: {} })).isError, false);
        assert.equal(world.ledger.calls.length, before);
        await distractorControls(arm, task, world, async () => {
          const write = { address: "billing_ops.archive_issues_1", args: {} };
          assert.equal((await mcp!.call("call_destructive_tool", write)).isError, false);
        });
      }
      console.log(`ok ${target} ${arm}: padded catalog, private ledger and surface refusal/text`);
    } finally {
      await mcp?.close();
      await deployment?.close();
      await world.stop();
    }
  }
}
