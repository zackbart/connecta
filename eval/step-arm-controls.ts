/**
 * No paid model: each step-reduction arm against real deployments, through real
 * MCP and real programs. An arm must keep every grader's reference passing and
 * must leave refusals, read/write routing, value safety and required guides as
 * they were. `pnpm run eval:selftest --step-arms-only [--target node|worker]`.
 */
import assert from "node:assert/strict";
import { playReference } from "./agent/reference.js";
import { gradeTask, passes } from "./tasks/grading.js";
import { ACTIVE_TASKS } from "./tasks/index.js";
import { startDeployment, type Target } from "./deploy/targets.js";
import { World } from "./fakes/world.js";
import { connectMcp, type McpSession } from "./support/mcp.js";
import { flags } from "./support/meta.js";
import { hinted, mergedCatalog, parseStepArm, stepArmRefusal, type StepArm } from "./deploy/step-arms.js";
import { STEP_CONTROL_TASKS, STEP_EXPERIMENTS, STEP_TRIAL_COUNT, STEP_BATCH } from "./step-reduction-plan.js";
import { REST_TOOL_KINDS } from "./deploy/rest-tools.js";
import { vercel } from "@zackbart/connecta/providers/vercel";

const target = (flags(process.argv.slice(2)).get("target") ?? "node") as Target;
const taskOf = (id: string) => {
  const task = ACTIVE_TASKS.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Unknown plan task ${id}`);
  return task;
};

assert.throws(() => parseStepArm("wrong"));
assert.equal(parseStepArm(undefined), undefined);
assert.ok(stepArmRefusal("ready-rows", "code"));
assert.equal(stepArmRefusal("ready-rows", "six"), undefined);
assert.ok(STEP_TRIAL_COUNT <= STEP_BATCH.trialCap, `Plan spends ${STEP_TRIAL_COUNT} trials`);
for (const id of STEP_CONTROL_TASKS) taskOf(id);
for (const name of ["upsert_project_env_var", "update_project_env_var", "get_runtime_logs"])
  assert.ok(REST_TOOL_KINDS.has(`vercel_rest.${name}`), `Merge names a real tool: ${name}`);

async function session<T>(
  id: string,
  arm: StepArm | undefined,
  use: (mcp: McpSession, world: World) => Promise<T>,
): Promise<T> {
  const task = taskOf(id);
  const world = new World(task.world);
  await world.start();
  let deployment: Awaited<ReturnType<typeof startDeployment>> | undefined;
  let mcp: McpSession | undefined;
  try {
    deployment = await startDeployment(target, world, task, "six", arm);
    mcp = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
    return await use(mcp, world);
  } finally {
    await mcp?.close().catch(() => {});
    await deployment?.close().catch(() => {});
    await world.stop().catch(() => {});
  }
}

const parse = (text: string) => JSON.parse(text) as Record<string, any>;
const program = async (mcp: McpSession, code: string) => parse((await mcp.call("execute_code", { code })).text).result;

async function teachControls() {
  await session("ccb-advanced-search", "teach-errors", async (mcp) => {
    const secret = "submitted-secret-value-7f3a";
    // A wrong argument teaches the schema and never echoes what was sent.
    const wrong = await mcp.call("call_tool", { address: "ccb.list_individuals", args: { [secret]: secret } });
    assert.equal(wrong.isError, true);
    assert.ok(!wrong.text.includes(secret), "teach echoes a submitted value");
    const taught = parse(wrong.text).error;
    assert.equal(taught.code, "invalid_args");
    assert.match(taught.teach.candidates[0].inputSchema, /includeInactive/);
    assert.equal(taught.teach.candidates[0].guideRequired, true, "a required guide must travel with the schema");
    assert.equal(taught.retryable, false);
    assert.ok(taught.nextAction, "the shipped recovery action stays");
    // An unknown tool teaches nearby addresses.
    const unknown = parse((await mcp.call("call_tool", { address: "ccb.get_person", args: { id: 1 } })).text).error;
    assert.equal(unknown.code, "unknown_tool");
    assert.ok(unknown.teach.candidates.every((row: any) => row.address.startsWith("ccb.")));
    // A hatch argument error teaches that operation's contract.
    const hatch = parse(
      (
        await mcp.call("call_tool", {
          address: "ccb.ccb_api_read",
          args: { path: "/search/individuals/results", method: "POST", body: { nope: 1 } },
        })
      ).text,
    ).error;
    assert.equal(hatch.teach.operation, "POST /search/individuals/results");
    assert.ok(hatch.teach.accepts.body.fields["configuration?"]);
    // A wrong hatch path teaches indexed operations only.
    const path = parse(
      (await mcp.call("call_tool", { address: "ccb.ccb_api_read", args: { path: "/campus" } })).text,
    ).error;
    assert.ok(path.teach.candidates.some((row: any) => row.path === "/campuses"));
    // The same teaching reaches a program that catches the error.
    const guest = await program(
      mcp,
      `async () => { try { await connecta.call("ccb.list_individuals", { bogus: 1 }) } catch (e) { return e.details } }`,
    );
    assert.equal(guest.code, "invalid_args");
    assert.match(guest.teach.candidates[0].inputSchema, /includeInactive/);
    // Required guides stay on every row that requires them.
    const page = parse((await mcp.call("search_tools", { query: "individuals", connector: "ccb" })).text);
    assert.ok(page.tools.every((row: any) => row.guideRequired === true));
    assert.equal(page.connectors.ccb.guide, "connector:ccb");
    const guide = await mcp.call("skills", { name: "connector:ccb" });
    assert.equal(guide.isError, false, "guides stay reachable by name");
  });
  // Only a remote connector's unrequired guide gets quieter; every maintained provider requires its guide.
  await session("p5-revenuecat-text", "teach-errors", async (mcp) => {
    const page = parse((await mcp.call("search_tools", { query: "subscriptions" })).text);
    assert.ok(page.tools.every((row: any) => row.guideRequired !== true));
    assert.equal(page.connectors.revenuecat.guide, undefined);
    assert.equal(page.connectors.revenuecat.guideSummary, undefined);
    assert.equal((await mcp.call("skills", { name: "connector:revenuecat" })).isError, false);
  });
  await session("vercel-step2-bounded-logs", "teach-errors", async (mcp) => {
    const page = parse((await mcp.call("search_tools", { query: "build logs", connector: "vercel_rest" })).text);
    assert.ok(page.tools.every((row: any) => row.guideRequired === true));
    assert.equal(page.connectors.vercel_rest.guide, "connector:vercel_rest");
  });
  // An unknown write outcome is never rewritten into teaching.
  await session("801-stripe-idempotent-refund", "teach-errors", async (mcp, world) => {
    const refused = await mcp.call("call_destructive_tool", {
      address: "stripe_sandbox.stripe_api_write",
      args: { method: "POST", path: "/v1/refunds", body: { nope: 1 } },
    });
    assert.equal(refused.isError, true);
    assert.equal(world.ledger.calls.filter((call) => call.kind === "write" && call.outcome === "ok").length, 0);
  });
}

async function readyControls() {
  await session("801-cloudflare-pin-refusal", "ready-rows", async (mcp, world) => {
    const page = parse(
      (
        await mcp.call("call_tool", {
          address: "cloudflare_legacy.cloudflare_api_search",
          args: { query: "purge cache" },
        })
      ).text,
    );
    for (const row of page.operations) if (row.refusal) assert.ok(!row.call && !row.accepts, "a refusal gains a call");
    const writes = world.ledger.calls.filter((call) => call.kind === "write");
    assert.equal(writes.length, 0);
  });
  await session("ccb-campus-hatch", "ready-rows", async (mcp, world) => {
    const page = parse(
      (await mcp.call("call_tool", { address: "ccb.ccb_api_search", args: { query: "campus" } })).text,
    );
    const read = page.operations.find((row: any) => row.path === "/campuses" && row.method === "GET");
    const write = page.operations.find((row: any) => row.method !== "GET" && row.tool === "ccb_api_write");
    assert.deepEqual(read.call, { address: "ccb.ccb_api_read", args: { path: "/campuses" } });
    assert.equal(write.call.address, "ccb.ccb_api_write", "a write stays on the write route");
    assert.ok(new TextEncoder().encode(JSON.stringify(page)).length <= 16 * 1024);
    // The read row's call is exact: no details call needed.
    const direct = await mcp.call("call_tool", read.call);
    assert.equal(direct.isError, false);
    // A hostile query is not reflected into any example.
    const hostile = "drop-table-marker-92";
    const reflected = await mcp.call("call_tool", {
      address: "ccb.ccb_api_search",
      args: { query: `campus ${hostile}` },
    });
    assert.ok(!reflected.text.includes(hostile));
    // A write through a row keeps the write route's refusal on call_tool.
    const refused = await mcp.call("call_tool", {
      address: write.call.address,
      args: { method: write.method, path: write.path, body: {} },
    });
    assert.equal(refused.isError, true);
    assert.equal(world.ledger.calls.filter((call) => call.kind === "write").length, 0);
    // Programs see the same rows.
    const guest = await program(
      mcp,
      `async () => (await connecta.call("ccb.ccb_api_search", { query: "campus" })).data`,
    );
    assert.deepEqual(guest.operations.find((row: any) => row.path === "/campuses").call, read.call);
  });
  // Value safety sits behind the example: a copied withheld value still refuses before sending.
  await session("stripe-step2-refund-once", "ready-rows", async (mcp, world) => {
    const refused = await mcp.call("call_destructive_tool", {
      address: "stripe_sandbox.stripe_api_write",
      args: { method: "POST", path: "/v1/refunds", body: { charge: "[redacted]" } },
    });
    assert.equal(refused.isError, true);
    assert.equal(world.ledger.calls.filter((call) => call.kind === "write").length, 0);
  });
}

async function hintControls() {
  await session("ccb-family-group-join", "next-hints", async (mcp) => {
    const list = parse(
      (await mcp.call("call_tool", { address: "ccb.list_families", args: { lastName: "Rowan" } })).text,
    );
    assert.equal(list.nextStep.tool, "ccb.get_family");
    assert.equal(list.nextStep.passAs, "familyId");
    const followed = await mcp.call("call_tool", { address: list.nextStep.tool, args: list.nextStep.args });
    assert.equal(followed.isError, false, "the hinted call must be a correct call");
    assert.deepEqual(hinted("ccb.list_families", { items: [] }), { items: [] }, "no rows, no hint");
    assert.equal((hinted("ccb.list_families", { items: [{ id: "[redacted]" }] }) as any).nextStep, undefined);
    assert.equal((hinted("ccb.get_family", { items: [{ id: 9 }] }) as any).nextStep, undefined, "only reviewed lists");
    const projected = parse(
      (await mcp.call("call_tool", { address: "ccb.list_families", args: { lastName: "Rowan", fields: ["name"] } }))
        .text,
    );
    assert.equal(projected.nextStep, undefined, "a selected-away id leaves no hint");
    const guest = await program(
      mcp,
      `async () => (await connecta.call("ccb.list_families", { lastName: "Rowan" })).data`,
    );
    assert.equal(guest.nextStep.tool, "ccb.get_family");
  });
  await session("cloudflare-step2-account-zone-join", "next-hints", async (mcp) => {
    const list = parse((await mcp.call("call_tool", { address: "cloudflare_prod.list_accounts", args: {} })).text);
    assert.equal(list.nextStep.tool, "cloudflare_prod.list_zones");
    const followed = await mcp.call("call_tool", { address: list.nextStep.tool, args: list.nextStep.args });
    assert.equal(followed.isError, false);
    const zones = parse(followed.text);
    assert.equal(zones.nextStep.tool, "cloudflare_prod.cloudflare_api_read");
  });
  await session("breeze-update-recovery", "next-hints", async (mcp) => {
    const people = parse((await mcp.call("call_tool", { address: "breeze.list_people", args: {} })).text);
    assert.equal(people.nextStep.tool, "breeze.get_person");
    assert.equal(
      (await mcp.call("call_tool", { address: people.nextStep.tool, args: people.nextStep.args })).isError,
      false,
    );
  });
  await session("pco-step2-note-once", "next-hints", async (mcp) => {
    const people = parse(
      (await mcp.call("call_tool", { address: "pco.search_people", args: { search: "Alice" } })).text,
    );
    assert.equal(people.nextStep.tool, "pco.get_person");
    assert.equal(
      (await mcp.call("call_tool", { address: people.nextStep.tool, args: people.nextStep.args })).isError,
      false,
    );
  });
}

async function mergedControls() {
  const catalog = mergedCatalog(
    vercel("vercel_rest", { purpose: "catalog", auth: { type: "token" }, teamId: "team_fake" }).staticTools ?? [],
  );
  assert.ok(catalog.after < catalog.before, "the merge must shrink the catalog");
  console.log(`merged-tools catalog bytes: ${catalog.before} before, ${catalog.after} after`);
  await session("vercel-step2-env-once", "merged-tools", async (mcp, world) => {
    const page = parse(
      (
        await mcp.call("search_tools", {
          query: "environment variable",
          connector: "vercel_rest",
          includeSchemas: "compact",
        })
      ).text,
    );
    const names = page.tools.map((row: any) => row.name);
    assert.ok(names.includes("upsert_project_env"));
    assert.ok(!names.includes("upsert_project_env_var") && !names.includes("update_project_env_var"));
    const row = page.tools.find((candidate: any) => candidate.name === "upsert_project_env");
    assert.notEqual(row.classification, "read", "the merged write stays a write");
    assert.equal(row.guideRequired, true);
    // The write route is required: call_tool refuses the merged write before dispatch.
    const direct = await mcp.call("call_tool", {
      address: "vercel_rest.upsert_project_env",
      args: { projectId: "prj_web", key: "A", value: "b", type: "plain", targets: ["production"] },
    });
    assert.equal(direct.isError, true);
    assert.equal(world.ledger.calls.filter((call) => call.kind === "write").length, 0);
    // An original is absent, and its error names only what the arm serves.
    const hidden = parse(
      (await mcp.call("call_tool", { address: "vercel_rest.get_runtime_logs", args: { projectId: "prj_web" } })).text,
    ).error;
    assert.equal(hidden.code, "unknown_tool");
    // One merged write is exactly one physical write.
    const write = await mcp.call("call_destructive_tool", {
      address: "vercel_rest.upsert_project_env",
      args: {
        projectId: "prj_web",
        key: "FEATURE_FLAG",
        value: "enabled",
        type: "plain",
        targets: ["production"],
        upsert: false,
      },
    });
    assert.equal(write.isError, false, write.text);
    assert.ok(!write.text.includes("upsert_project_env_var"));
    assert.equal(world.ledger.calls.filter((call) => call.kind === "write").length, 1);
    // A program dispatches the same way, and a wrong argument names the merged tool.
    const guest = await program(
      mcp,
      `async () => { try { await connecta.call("vercel_rest.get_logs", { kind: "runtime", deploymentId: "dpl_release000", bogus: 1 }) } catch (e) { return { code: e.code, details: e.details } } }`,
    );
    assert.equal(guest.code, "invalid_args");
    assert.ok(!JSON.stringify(guest).includes("get_runtime_logs"));
    // A missing kind is refused by the real validator, without a vendor call.
    const before = world.ledger.calls.length;
    const missing = await mcp.call("call_tool", {
      address: "vercel_rest.get_logs",
      args: { deploymentId: "dpl_release002" },
    });
    assert.equal(missing.isError, true);
    assert.equal(world.ledger.calls.length, before);
  });
}

await teachControls();
console.log("teach-errors controls passed");
await readyControls();
console.log("ready-rows controls passed");
await hintControls();
console.log("next-hints controls passed");
await mergedControls();
console.log("merged-tools controls passed");

// Each grader's scripted reference still passes on every arm that runs it, and doing nothing still fails.
for (const [arm, tasks] of Object.entries(STEP_EXPERIMENTS) as [StepArm, readonly string[]][]) {
  for (const id of tasks) {
    const task = taskOf(id);
    const checks = await playReference(task, { mode: "reference", target, stepArm: arm }, ({ world, trace }) =>
      gradeTask(task, { world, trace }, "six", "outcome"),
    );
    assert.equal(
      passes(checks, "outcome"),
      true,
      `${arm} ${id} reference: ${checks.filter((check) => !check.pass && !check.advisory).map((check) => check.id)}`,
    );
    const noop = await playReference(task, { mode: "noop", target, stepArm: arm }, ({ world, trace }) =>
      gradeTask(task, { world, trace }, "six", "outcome"),
    );
    assert.equal(passes(noop, "outcome"), false, `${arm} ${id} no-op must fail`);
    console.log(`${arm} ${id}: reference passes, no-op fails`);
  }
}
console.log(`Step-arm controls passed on ${target}: ${STEP_TRIAL_COUNT} planned trials`);
