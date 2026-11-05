/** Surface-neutral CCB step-2 tasks; state/HTTP/final-answer checks stay frozen across arms. */
import type { ActiveTask, Check, ReferenceContext } from "./types.js";
import type { World } from "../fakes/world.js";
import type { AgentTrace } from "../agent/trace.js";
import { REST_TOOL_KINDS } from "../deploy/rest-tools.js";
import { ccbState, CCB_TARGET, CCB_NEW_EMAIL } from "../fakes/ccb.js";
import { check } from "./baseline.js";
import { deliveredReducedCount, deliveredValues } from "./correctness.js";

const ids = [
  "ccb-filtered-individuals",
  "ccb-family-group-join",
  "ccb-individual-paging",
  "ccb-advanced-search",
  "ccb-campus-hatch",
  "ccb-update-once",
  "ccb-update-recovery",
];
const seed = ccbState();
const filtered = seed.people.filter((p) => p.active && p.campus_id === 1).length;
const inactive = seed.people.filter((p) => !p.active).length;
const standard = () => REST_TOOL_KINDS.has("ccb.ccb_api_read");
const isProfile = (value: unknown) => {
  if (!value || typeof value !== "object") return false;
  const facts = Object.values(value).map(String);
  return facts.includes(String(CCB_TARGET)) && facts.includes(CCB_NEW_EMAIL);
};
const carriesProfile = (value: unknown): boolean =>
  isProfile(value) ||
  (Boolean(value) && typeof value === "object" && Object.values(value as object).some(carriesProfile));
const isWrite = (address: unknown) => REST_TOOL_KINDS.get(String(address)) !== "read";
/**
 * A successful read delivered Alice's id with her updated email. That email exists
 * only after the write, so its order is implied, and a write's own reply is excluded.
 * A program also has to have read the profile, not just returned the write's reply.
 */
function readBackProfile(world: World, trace: AgentTrace): boolean {
  const direct = trace.toolUses.filter((u) => u.tool !== "execute_code" && !isWrite(u.input.address));
  if (deliveredValues({ ...trace, toolUses: direct }).some(isProfile)) return true;
  const programs = trace.toolUses.filter((u) => u.tool === "execute_code");
  return (
    deliveredValues({ ...trace, toolUses: programs }).some(isProfile) &&
    world.programs.some((p) =>
      p.calls.some(
        (c) => c.name === "connecta.call" && c.outcome === "ok" && !isWrite(c.args[0]) && carriesProfile(c.result),
      ),
    )
  );
}
function grade(i: number, world: World, trace: AgentTrace): Check[] {
  const calls = world.ledger.calls.filter((c) => c.service === "ccb");
  const writes = calls.filter((c) => c.kind === "write");
  const answer = (trace.finalAnswer ?? "").replace(/[*`]/g, "");
  const reached = (path: string) => calls.some((c) => c.args.path === path && c.outcome === "ok");
  const checks: Check[] = [];
  const add = (key: string, pass: boolean) => checks.push(check(key, key.replaceAll("-", " "), pass));
  let destination = false,
    evidence = /\bCCB\b|Church Community Builder/i.test(answer);
  if (i === 0) {
    destination = reached("/individuals");
    evidence &&= new RegExp(`ANSWER:\\s*${filtered}\\b`, "i").test(answer);
  }
  if (i === 1) {
    destination = reached("/families/9") && reached("/groups/5/members");
    evidence &&= /Alice Rowan/i.test(answer) && /1002/.test(answer) && /leader/i.test(answer);
  }
  if (i === 2) {
    destination = calls.some(
      (c) => c.args.path === "/individuals" && Number((c.args.query as Record<string, string>).page) >= 2,
    );
    evidence &&= /ANSWER:\s*137\b/i.test(answer);
  }
  if (i === 3) {
    destination = reached("/search/individuals/results");
    evidence &&= new RegExp(`ANSWER:\\s*${inactive}\\b`, "i").test(answer);
    const delivered = deliveredValues(trace);
    add(
      "delivered-data",
      seed.people.filter((p) => !p.active).every((p) => delivered.some((row) => row?.id === p.id)) ||
        deliveredReducedCount(trace, inactive),
    );
  }
  if (i === 4) {
    destination = reached("/campuses");
    evidence &&= /North/i.test(answer) && /America\/Chicago/.test(answer) && /Thank you, North\./i.test(answer);
  }
  if (i >= 5) {
    const write = writes.find(
      (c) =>
        c.args.method === "PUT" &&
        [`/individuals/${CCB_TARGET}`, `/individuals/${CCB_TARGET}/contact_info`].includes(String(c.args.path)),
    );
    destination = Boolean(write);
    add(
      "state",
      world.ccb.people.find((p) => p.id === CCB_TARGET)?.email === CCB_NEW_EMAIL && world.ccb.updated.length === 1,
    );
    add(
      "only-requested-writes",
      writes.length === 1 && Boolean(write) && Object.keys((write?.args.body ?? {}) as object).join() === "email",
    );
    add(
      "reconciled",
      calls.some(
        (c) =>
          c.seq > (write?.seq ?? Infinity) &&
          c.args.method === "GET" &&
          c.outcome === "ok" &&
          (c.args.path === `/individuals/${CCB_TARGET}` || c.args.path === "/individuals"),
      ) && readBackProfile(world, trace),
    );
    evidence &&= answer.includes(String(CCB_TARGET)) && answer.includes(CCB_NEW_EMAIL);
  } else {
    const addresses = [
      ...trace.toolUses
        .filter((u) => ["call_tool", "call_destructive_tool"].includes(u.tool))
        .map((u) => String(u.input.address)),
      ...world.programs.flatMap((p) => p.calls.filter((c) => c.name === "connecta.call").map((c) => String(c.args[0]))),
    ];
    add(
      "reads-only",
      writes.length === 0 &&
        !trace.toolUses.some((u) => u.tool === "call_destructive_tool") &&
        addresses.every((a) => REST_TOOL_KINDS.get(a) === "read"),
    );
  }
  add("correct-destination", destination);
  add("answer-evidence", evidence);
  return checks;
}
const call = (ctx: ReferenceContext, tool: string, args: Record<string, unknown> = {}, write = false) =>
  ctx.call(write ? "call_destructive_tool" : "call_tool", { address: `ccb.${tool}`, args });
async function reference(i: number, ctx: ReferenceContext) {
  if (i === 0 || i === 2) {
    let cursor: string | undefined;
    for (let page = 1; page <= 2; page++) {
      const r = await call(ctx, "list_individuals", {
        includeInactive: true,
        ...(standard()
          ? { limit: 100, fields: ["id", "active", "campusId"], ...(cursor ? { cursor } : {}) }
          : { perPage: 100, page }),
      });
      if (r.isError) throw new Error(r.text);
      cursor = /"nextCursor"\s*:\s*"([^"]+)"/.exec(r.text)?.[1];
      if (standard() && page === 1 && !cursor) throw new Error("Missing CCB next cursor.");
    }
    ctx.answer(`CCB. ANSWER: ${i === 0 ? filtered : 137}`);
  } else if (i === 1) {
    await call(ctx, "list_families", { lastName: "Rowan" });
    await call(ctx, "get_family", { familyId: 9 });
    await call(ctx, "list_groups", { name: "Choir" });
    await call(ctx, "list_group_members", { groupId: 5 });
    ctx.answer("CCB: Alice Rowan (1002) is the Rowan family member who is a Choir leader.");
  } else if (i === 3) {
    const body = { configuration: { filter_profile_type: ["inactive"] }, filters: {} };
    await call(ctx, standard() ? "search_records" : "ccb_api_search", {
      domain: "individuals",
      body,
      ...(standard() ? { limit: 100 } : { perPage: 100 }),
    });
    ctx.answer(`CCB inactive profiles. ANSWER: ${inactive}`);
  } else if (i === 4) {
    if (standard()) {
      await call(ctx, "ccb_api_search", { query: "campus" });
      await call(ctx, "ccb_api_details", { method: "GET", path: "/campuses" });
    }
    await call(ctx, standard() ? "ccb_api_read" : "ccb_api_get", { path: "/campuses" });
    ctx.answer("CCB North campus: timezone America/Chicago; public gift message: Thank you, North.");
  } else {
    await call(ctx, "list_individuals", { query: "Alice Rowan" });
    const r = await call(
      ctx,
      standard() ? "ccb_api_write" : "ccb_api_mutate",
      { method: "PUT", path: `/individuals/${CCB_TARGET}`, body: { email: CCB_NEW_EMAIL } },
      true,
    );
    if ((i === 6) !== r.isError) throw new Error("Unexpected CCB update outcome.");
    await call(ctx, "get_individual", { individualId: CCB_TARGET });
    ctx.answer(`CCB individual ${CCB_TARGET} now has email ${CCB_NEW_EMAIL}, verified by reading the record.`);
  }
}
const prompts = [
  "Using the ccb connector, count all active individuals at campus id 1 across every page. Include inactive people in the source list so you explicitly filter active status and campus. Cite CCB and finish with ANSWER: <number>.",
  "Using ccb, resolve the Rowan family and Choir group, then identify the Rowan family member who is a Choir leader. Join the family members with group members by individual id. Give the name, id and role and cite CCB.",
  "Using ccb, count all individuals, including inactive people, across every page. Use 100 rows per page. Cite CCB and finish with ANSWER: <number>.",
  'Using ccb, use its individuals advanced POST search with configuration.filter_profile_type set to ["inactive"] and an empty filters object. Count every matching profile. Cite CCB and finish with ANSWER: <number>.',
  "Using ccb, find the North campus and report its timezone and public gift message. Cite CCB; use the vendor API hatch if the named tools do not carry those fields.",
  `Using ccb, find Alice Rowan and update only her email to ${CCB_NEW_EMAIL}. Make the update exactly once, verify it by reading her profile, and report the individual id and verified email, citing CCB.`,
  `Using ccb, find Alice Rowan and update only her email to ${CCB_NEW_EMAIL}. If the update fails, read her actual profile before deciding whether any repeat is needed. Make at most one business update; report her id and verified email, citing CCB.`,
];
export const CCB_TASKS: ActiveTask[] = ids.map((id, i) => ({
  status: "active",
  id,
  title: id.replaceAll("-", " "),
  introducedIn: "#703",
  measures: prompts[i]!,
  prompt: prompts[i]!,
  world: { ccb: i === 6 ? { fault: "update-500" } : {} },
  ...(i < 5 ? { deployment: { readOnly: true } } : {}),
  grade: ({ world, trace }) => grade(i, world, trace),
  reference: (ctx) => reference(i, ctx),
}));
