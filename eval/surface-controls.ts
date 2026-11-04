/**
 * No paid model: the prototype arms against a real Worker deployment, and the
 * approval modes against real host processes with a scripted model. CI runs the
 * deployment half; the approval half needs both CLIs installed.
 *
 *   pnpm run build && pnpm exec tsx eval/surface-controls.ts [--only read,bound,hints,pinned,approval]
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude } from "./agent/claude.js";
import { runCodex, type ApprovalMode } from "./agent/codex.js";
import { assertSurface, type Surface } from "./agent/surface.js";
import { startDeployment } from "./deploy/targets.js";
import { READ_ROUTE_REFUSAL, READ_TOOL, PINNED_TOOLS } from "./deploy/surface-arms.js";
import { NO_INJECTION } from "./fakes/injection.js";
import { World } from "./fakes/world.js";
import { flags } from "./support/meta.js";
import { connectMcp } from "./support/mcp.js";
import { claudeWrapper, codexWrapper, scriptedClaudeModel, scriptedCodexModel } from "./support/scripted-model.js";
import { ACTIVE_TASKS } from "./tasks/index.js";
import type { ActiveTask } from "./tasks/types.js";

const TASK = ACTIVE_TASKS.find((task) => task.id === "p5-known-read-routing") as ActiveTask;

async function withArm<T>(
  surface: Surface,
  catalogTools: number,
  run: (world: World, session: Awaited<ReturnType<typeof connectMcp>>, url: string, token: string) => Promise<T>,
): Promise<T> {
  const world = new World({}, { ...NO_INJECTION, catalogTools });
  await world.start();
  const deployment = await startDeployment("worker", world, TASK, surface);
  const session = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
  try {
    return await run(world, session, deployment.mcpUrl, deployment.token);
  } finally {
    await session.close();
    await Promise.allSettled([deployment.close(), world.stop()]);
  }
}

const writes = (world: World) => world.ledger.calls.filter((call) => call.kind === "write");

/** INV-1, INV-2, INV-3: a read program cannot write by any path a guest can reach. */
async function readRouteControls(surface: "read-six" | "read-five") {
  await withArm(surface, 12, async (world, session) => {
    const tools = await session.listTools();
    assertSurface(
      tools.map((tool) => tool.name),
      surface,
    );
    const readTool = tools.find((tool) => tool.name === READ_TOOL)!;
    assert.doesNotMatch(
      readTool.description ?? "",
      /Everything else: execute_code/,
      "the read route keeps reads on it",
    );
    assert.match(session.instructions ?? "", /execute_read_code programs need no write approval/);
    assert.equal(readTool.readOnly, true, "the read route is annotated read-only");
    assert.equal(tools.find((tool) => tool.name === "execute_code")!.readOnly, false, "execute_code stays a write");
    if (surface === "read-five") assert.ok(!tools.some((tool) => tool.name === "search_tools"));
    else assert.ok(tools.some((tool) => tool.name === "search_tools"));

    // Discovery and reads work, and discovery omits writes.
    const found = await session.call(READ_TOOL, {
      code: `async () => { const hits = await connecta.search({ query: "close issue" }); const run = await connecta.call("ci.get_run", { runId: 4812 }); return { names: hits.tools.map((t) => t.address ?? t.name), run: run.data }; }`,
    });
    assert.equal(found.isError, false, found.text);
    assert.match(found.text, /9f2c1ab/);
    assert.doesNotMatch(found.text, /tracker\.close_issue/, "read-program search omits writes");

    // The composition: read data, then hand it to a write, in every form a guest can try.
    for (const [label, code] of Object.entries({
      "read then write": `async () => { const issue = (await connecta.call("tracker.get_issue", { id: "WEB-105" })).data; return (await connecta.call("tracker.close_issue", { id: issue.id ?? "WEB-105" })).data; }`,
      "swallowed refusal": `async () => { try { await connecta.call("tracker.close_issue", { id: "WEB-105" }); return "wrote"; } catch (error) { return { code: error.code, message: error.message }; } }`,
      allSettled: `async () => { const r = await Promise.allSettled([connecta.call("chat.post_message", { channel: "eng", text: "x" }), connecta.call("tracker.close_issue", { id: "WEB-105" })]); return r.map((x) => x.status + ":" + (x.reason?.code ?? "")); }`,
      "fifty attempts": `async () => { const out = []; for (let i = 0; i < 50; i++) { try { await connecta.call("chat.post_message", { channel: "eng", text: String(i) }); out.push("wrote"); } catch (error) { out.push(error.code); if (error.code === "budget_exceeded") break; } } return out; }`,
    })) {
      const result = await session.call(READ_TOOL, { code });
      assert.equal(writes(world).length, 0, `${surface}/${label} physically wrote: ${result.text}`);
      assert.doesNotMatch(result.text, /"wrote"/, `${surface}/${label} reported a write`);
    }
    const refusal = await session.call(READ_TOOL, {
      code: `async () => { try { await connecta.call("tracker.close_issue", { id: "WEB-105" }); } catch (error) { return { code: error.code, message: error.message }; } }`,
    });
    assert.match(refusal.text, /read_only_endpoint/);
    assert.ok(refusal.text.includes(READ_ROUTE_REFUSAL), refusal.text);
    assert.equal(world.tracker.issues.find((issue) => issue.id === "WEB-105")!.status, "open");

    // A call the host sends directly under the wrong name cannot reach a write either.
    const direct = await session.call("call_tool", { address: "tracker.close_issue", args: { id: "WEB-105" } });
    assert.equal(direct.isError, true);
    assert.equal(writes(world).length, 0);

    // Handles minted by the writable pool's direct read page on the read route.
    const log = await session.call("call_tool", { address: "ci.get_run_log", args: { runId: 4812 } });
    const notice = JSON.parse(log.text.split("\n")[0]!) as {
      resultId?: string;
      nextAction?: { arguments?: { id?: string } };
    };
    const id = notice.resultId ?? notice.nextAction?.arguments?.id;
    assert.ok(id, log.text.slice(0, 300));
    assert.doesNotMatch(log.text, /"tool":"execute_code"/, "a truncated read pages on the read route");
    const page = await session.call(READ_TOOL, {
      code: `async () => { const page = await connecta.result(${JSON.stringify(id)}, { offset: 0, maxBytes: 200 }); return { bytes: page.text?.length ?? 0 }; }`,
    });
    assert.equal(page.isError, false, page.text);
    assert.doesNotMatch(page.text, /not_found/);

    // Positive control: the same write through execute_code does land, exactly once.
    const allowed = await session.call("execute_code", {
      code: `async () => (await connecta.call("tracker.close_issue", { id: "WEB-105" })).data`,
    });
    assert.equal(allowed.isError, false, allowed.text);
    assert.equal(writes(world).length, 1);
  });
  console.log(`ok ${surface}: annotation, discovery, read, composition refusal and positive write control`);
}

async function hintControls() {
  await withArm("native-hints", 12, async (world, session) => {
    void world;
    const tools = await session.listTools();
    assertSurface(
      tools.map((tool) => tool.name),
      "native-hints",
    );
    const close = tools.find((tool) => tool.name === "tracker__close_issue")!;
    assert.match(close.description ?? "", /^[a-z]/, "the description leads with synonyms");
    assert.ok(/done/.test(close.description ?? ""));
  });
  console.log("ok native-hints: inventory and synonym-leading descriptions");
}

async function pinnedControls() {
  await withArm("pinned", 60, async (world, session) => {
    const tools = await session.listTools();
    assertSurface(
      tools.map((tool) => tool.name),
      "pinned",
    );
    const pinned = tools.filter((tool) => tool.name.includes("__"));
    assert.equal(pinned.length, PINNED_TOOLS);
    const read = await session.call("ci__get_run", { runId: 4812 });
    assert.equal(read.isError, false, read.text);
    assert.match(read.text, /9f2c1ab/);
    assert.equal(tools.find((tool) => tool.name === "chat__post_message")?.readOnly, false);
    const write = await session.call("chat__post_message", { channel: "eng", text: "pinned control" });
    assert.equal(write.isError, false, write.text);
    assert.equal(writes(world).length, 1);
  });
  console.log("ok pinned: inventory, pinned read and annotated pinned write");
}

/** Real hosts, scripted model: which tools prompt, and what each answer does. */
async function approvalControls() {
  const cases: { approval: ApprovalMode; expected: number }[] = [
    { approval: "prompt-allow", expected: 1 },
    { approval: "prompt-deny", expected: 0 },
  ];
  for (const { approval, expected } of cases) {
    await withArm("read-six", 0, async (world, session, url, token) => {
      const tools = await session.listTools();
      const gated = tools.filter((tool) => !tool.readOnly).map((tool) => tool.name);
      const root = await mkdtemp(join(tmpdir(), "connecta-approval-"));
      const write = `async () => (await connecta.call("chat.post_message", { channel: "eng", text: "control" })).data`;
      const read = `async () => (await connecta.call("ci.get_run", { runId: 4812 })).data`;
      const model = await scriptedClaudeModel([
        [{ tool: `mcp__connecta__${READ_TOOL}`, input: { code: read } }],
        [{ tool: "mcp__connecta__call_tool", input: { address: "ci.get_run", args: { runId: 4811 } } }],
        [{ tool: "mcp__connecta__execute_code", input: { code: write } }],
      ]);
      const run = await runClaude({
        model: "claude-sonnet-5-5",
        approval,
        surface: "read-six",
        mcpUrl: url,
        token,
        allowedTools: tools.filter((tool) => tool.readOnly).map((tool) => tool.name),
        deniedTools: [],
        promptedTools: gated,
        toolSearch: false,
        timeoutMs: 180_000,
        firstPrompt: "Run the script.",
        nextTurn: async () => undefined,
        testHost: { executable: await claudeWrapper(root, model.url), args: [] },
      });
      await model.close();
      await rm(root, { recursive: true, force: true });
      const prompts = run.events.filter((event) => event.type === "approval_prompt");
      assert.deepEqual(
        prompts.map((event) => event.tool),
        ["execute_code"],
        `Claude ${approval} prompts: ${JSON.stringify(prompts)} stderr: ${run.stderrTail}`,
      );
      assert.equal(prompts[0]!.decision, approval === "prompt-allow" ? "allow" : "deny");
      assert.equal(writes(world).length, expected, `Claude ${approval} writes`);
      assert.equal(world.ledger.calls.filter((call) => call.tool === "get_run").length, 2);
    });
    console.log(`ok claude ${approval}: only execute_code prompted; read route and call_tool ran unprompted`);
    await withArm("read-six", 0, async (world, session, url, token) => {
      const tools = await session.listTools();
      const gated = tools.filter((tool) => !tool.readOnly).map((tool) => tool.name);
      const root = await mkdtemp(join(tmpdir(), "connecta-approval-"));
      const nested = (name: string, args: unknown) =>
        `const t = ALL_TOOLS.find((tool) => tool.name.endsWith(${JSON.stringify(name)}));text(JSON.stringify(await tools[t.name](${JSON.stringify(args)})));`;
      const model = await scriptedCodexModel([
        nested(READ_TOOL, {
          code: `async () => (await connecta.call("ci.get_run", { runId: 4812 })).data`,
        }),
        nested("execute_code", {
          code: `async () => (await connecta.call("chat.post_message", { channel: "eng", text: "control" })).data`,
        }),
      ]);
      const { executable, authFile } = await codexWrapper(root, model.url);
      const run = await runCodex({
        model: "gpt-6.1-sol",
        approval,
        surface: "read-six",
        mcpUrl: url,
        token,
        allowedTools: tools.filter((tool) => tool.readOnly).map((tool) => tool.name),
        deniedTools: [],
        promptedTools: gated,
        timeoutMs: 120_000,
        firstPrompt: "Run the script.",
        nextTurn: async () => undefined,
        testHost: { executable, args: [], authFile, version: "codex-cli scripted" },
      });
      await model.close();
      await rm(root, { recursive: true, force: true });
      const prompts = run.events.filter((event) => event.type === "approval_prompt");
      assert.equal(prompts.length, 1, `Codex ${approval} prompts: ${JSON.stringify(prompts)} ${run.stderrTail}`);
      assert.equal(writes(world).length, expected, `Codex ${approval} writes`);
      assert.equal(world.ledger.calls.filter((call) => call.tool === "get_run").length, 1);
    });
    console.log(`ok codex ${approval}: one prompt for execute_code inside exec; the read route ran unprompted`);
  }
}

/** The stale-flip mitigation must not cost the write itself: the new name still works, once. */
async function boundNameControls() {
  await withArm("native-bound", 0, async (world, session) => {
    const names = (await session.listTools()).map((tool) => tool.name);
    assert.ok(names.includes("chat__post_message_w") && !names.includes("chat__post_message"));
    assert.ok(names.includes("ci__get_run"), "a read keeps its name");
    const stale = await session.call("chat__post_message", { channel: "eng", text: "stale" });
    assert.equal(stale.isError, true);
    assert.equal(writes(world).length, 0);
    const write = await session.call("chat__post_message_w", { channel: "eng", text: "bound" });
    assert.equal(write.isError, false, write.text);
    assert.equal(writes(world).length, 1);
    const read = await session.call("ci__get_run", { runId: 4812 });
    assert.equal(read.isError, false, read.text);
  });
  console.log("ok native-bound: stale plain name refused, write reachable by its bound name, reads unchanged");
}

/** Real deployment, no host and no model: these run in CI through `eval:selftest --native-only`. */
export async function deploymentControls(wanted: (name: string) => boolean = () => true) {
  if (wanted("read")) {
    await readRouteControls("read-six");
    await readRouteControls("read-five");
  }
  if (wanted("bound")) await boundNameControls();
  if (wanted("hints")) await hintControls();
  if (wanted("pinned")) await pinnedControls();
}

if (process.argv[1]?.endsWith("surface-controls.ts")) {
  const only = flags(process.argv.slice(2)).get("only")?.split(",");
  const wanted = (name: string) => !only || only.includes(name);
  await deploymentControls(wanted);
  if (wanted("approval")) await approvalControls();
  process.exit(0);
}
