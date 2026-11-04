/** No paid model: actual Worker surface, state, paging and grader controls. */
import { playReference } from "./agent/reference.js";
import assert from "node:assert/strict";
import { World } from "./fakes/world.js";
import { startDeployment } from "./deploy/targets.js";
import { connectMcp } from "./support/mcp.js";
import { assertSurface, parseSurface, type Surface } from "./agent/surface.js";
import { ACTIVE_TASKS } from "./tasks/index.js";
import { gradeTask, passes } from "./tasks/grading.js";
import { parseTrace } from "./agent/trace.js";
import { taskForSurface } from "./tasks/surface.js";

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
        arm === "six" ? "call_destructive_tool" : "tracker__close_issue",
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
        const padding = tools.filter((tool) => ids.has(tool.address?.split(".")[0] ?? ""));
        assert.equal(padding.length, 132);
        const before = world.ledger.calls.length;
        assert.equal((await mcp.call(padding[0]!.name, {})).isError, false);
        assert.equal(world.ledger.calls.length, before);
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
      }
      console.log(`ok ${target} ${arm}: padded catalog, private ledger and surface refusal/text`);
    } finally {
      await mcp?.close();
      await deployment?.close();
      await world.stop();
    }
  }
}
