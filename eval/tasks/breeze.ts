/** Frozen, surface-neutral Breeze step-2 tasks and outcome graders. */
import type { ActiveTask, ReferenceContext, Check } from "./types.js";
import type { World } from "../fakes/world.js";
import type { AgentTrace } from "../agent/trace.js";
import { REST_TOOL_KINDS } from "../deploy/rest-tools.js";
import { STATUS_FIELD, EMAIL_FIELD, TARGET, TAG, INSTANCE, CAMPAIGN, NEW_EMAIL, breezeState } from "../fakes/breeze.js";
import { check } from "./baseline.js";
const seed = breezeState();
const matching = seed.people.filter((p) => p.tags.includes(TAG) && p.details[STATUS_FIELD] === "901");
const ids = [
  "breeze-filtered-people",
  "breeze-attendance-join",
  "breeze-people-paging",
  "breeze-pledge-hatch",
  "breeze-create-once",
  "breeze-update-recovery",
  "breeze-giving-totals",
];
const query = (c: World["ledger"]["calls"][number]) => c.args.query as Record<string, string>;
function grade(id: string, world: World, trace: AgentTrace): Check[] {
  const calls = world.ledger.calls.filter((c) => c.service === "breeze"),
    writes = world.ledger.calls.filter((c) => c.kind === "write");
  const answer = (trace.finalAnswer ?? "").replace(/[*`]/g, "");
  const checks: Check[] = [];
  const add = (key: string, pass: boolean) => checks.push(check(key, key.replaceAll("-", " "), pass));
  const reached = (path: string) => calls.some((c) => c.args.path === path && c.outcome === "ok");
  let destination = false,
    evidence = /breeze/i.test(answer);
  if (id === ids[0]) {
    destination = reached("/people") && reached("/profile") && reached("/tags/list_tags");
    add(
      "filtered",
      calls.some(
        (c) =>
          c.args.path === "/people" &&
          query(c).filter_json &&
          JSON.parse(query(c).filter_json!)[STATUS_FIELD] === "901" &&
          JSON.parse(query(c).filter_json!).tag_contains === `y_${TAG}`,
      ),
    );
    evidence &&= /ANSWER:\s*34\b/i.test(answer) && matching.length === 34;
  } else if (id === ids[1]) {
    destination =
      reached("/events") &&
      calls.some((c) => c.args.path === "/events/attendance/list" && query(c).instance_id === INSTANCE);
    evidence &&=
      /Bob Smith/i.test(answer) &&
      /(?:not checked out|still checked in|no check.?out|checked.?out[^\n]*null)/i.test(answer);
  } else if (id === ids[2]) {
    const pages = calls.filter((c) => c.args.path === "/people" && c.outcome === "ok");
    destination = pages.length >= 3 && pages.some((c) => Number(query(c).offset) >= 200);
    evidence &&= /ANSWER:\s*200\b/i.test(answer);
  } else if (id === ids[3]) {
    destination =
      reached("/pledges/list_campaigns") &&
      calls.some((c) => c.args.path === "/pledges/list_pledges" && query(c).campaign_id === CAMPAIGN);
    evidence &&= answer.includes("125.50") && answer.includes(CAMPAIGN);
  } else if (id === ids[4]) {
    const p = world.breeze.people.find((p) => p.id === world.breeze.created[0]);
    destination = reached("/people/add");
    add(
      "state",
      world.breeze.created.length === 1 &&
        p?.first_name === "Alice" &&
        p?.last_name === "New" &&
        p?.details[EMAIL_FIELD] === NEW_EMAIL,
    );
    add("only-requested-writes", writes.length === 1 && writes[0]?.args.path === "/people/add");
    evidence &&= answer.includes(world.breeze.created[0] ?? "__missing__") && /creat|add/i.test(answer);
  } else if (id === ids[5]) {
    const sent = calls.find((c) => c.args.path === "/people/update");
    destination = Boolean(sent && query(sent).person_id === TARGET);
    add("state", world.breeze.people.find((p) => p.id === TARGET)?.details[STATUS_FIELD] === "902");
    add("only-requested-writes", writes.length === 1 && writes[0]?.args.path === "/people/update");
    add(
      "reconciled",
      calls.some(
        (c) =>
          c.seq > (sent?.seq ?? Infinity) &&
          c.outcome === "ok" &&
          (c.args.path === `/people/${TARGET}` || c.args.path === "/people"),
      ),
    );
    evidence &&=
      answer.includes(TARGET) &&
      /visitor/i.test(answer) &&
      !/unable|could not|not updated|failed to update/i.test(answer);
  } else {
    destination = reached("/giving/list") && reached("/funds/list") && reached("/account/summary");
    evidence &&= /General[^\n]*0\.30/i.test(answer) && /Missions[^\n]*12\.34/i.test(answer) && /USD/.test(answer);
  }
  add("correct-destination", destination);
  add("answer-evidence", evidence);
  if (id !== ids[4] && id !== ids[5]) {
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
        !addresses.some((a) => REST_TOOL_KINDS.get(a) === "write"),
    );
  }
  return checks;
}
const call = (ctx: ReferenceContext, tool: string, args: Record<string, unknown> = {}, write = false) =>
  ctx.call(write ? "call_destructive_tool" : "call_tool", { address: `breeze.${tool}`, args });
const standard = () => REST_TOOL_KINDS.has("breeze.breeze_api_read");
const hatch = (ctx: ReferenceContext, path: string, query: Record<string, unknown> = {}) =>
  call(ctx, standard() ? "breeze_api_read" : "breeze_api_get", {
    path,
    query: standard() ? query : Object.entries(query).map(([name, value]) => ({ name, value })),
  });
async function reference(id: string, ctx: ReferenceContext) {
  if (id === ids[0]) {
    await call(ctx, "list_profile_fields");
    await call(ctx, "list_tags");
    await call(ctx, "list_people", { tagId: TAG, filter: { [STATUS_FIELD]: "901" } });
    ctx.answer("Breeze Choir members with Member status. ANSWER: 34");
  } else if (id === ids[1]) {
    await call(ctx, "list_events", { start: "2026-10-18", end: "2026-10-18" });
    await call(ctx, "list_attendance", { instanceId: INSTANCE, includeNames: true });
    await call(ctx, "get_person", { personId: TARGET });
    ctx.answer("Breeze: Bob Smith is still checked in; not checked out.");
  } else if (id === ids[2]) {
    let cursor: string | undefined;
    for (let i = 0; i < 3; i++) {
      const r = await call(ctx, "list_people", { limit: 100, ...(cursor ? { cursor } : {}) });
      cursor = /"nextCursor"\s*:\s*"([^"]+)"/.exec(r.text)?.[1];
      if (i < 2 && !cursor) throw new Error("Missing Breeze next page");
    }
    ctx.answer("Breeze people total. ANSWER: 200");
  } else if (id === ids[3]) {
    if (standard()) {
      await call(ctx, "breeze_api_search", { query: "pledge campaigns" });
      await call(ctx, "breeze_api_details", { method: "GET", path: "/pledges/list_pledges" });
    }
    await hatch(ctx, "/pledges/list_campaigns");
    await hatch(ctx, "/pledges/list_pledges", { campaign_id: CAMPAIGN });
    ctx.answer(`Breeze Roof Renewal campaign ${CAMPAIGN}: pledge total 125.50.`);
  } else if (id === ids[4]) {
    await call(ctx, "list_people");
    await call(ctx, "list_profile_fields");
    await call(
      ctx,
      "add_person",
      {
        firstName: "Alice",
        lastName: "New",
        fields: [{ fieldId: EMAIL_FIELD, type: "email", details: { address: NEW_EMAIL } }],
      },
      true,
    );
    ctx.answer("Breeze created Alice New as person 5000.");
  } else if (id === ids[5]) {
    await call(ctx, "list_people");
    await call(ctx, "list_profile_fields");
    const r = await call(
      ctx,
      "update_person",
      { personId: TARGET, fields: [{ fieldId: STATUS_FIELD, type: "radio", response: "902" }] },
      true,
    );
    if (!r.isError) throw new Error("Injected Breeze failure lost");
    await call(ctx, "get_person", { personId: TARGET });
    ctx.answer(`Breeze person ${TARGET} now has Visitor status, verified after the failed request.`);
  } else {
    await call(ctx, "get_account_summary");
    await call(ctx, "list_funds");
    await call(ctx, "list_contributions", { start: "2026-10-01", end: "2026-10-31" });
    ctx.answer("Breeze October giving in USD:\nGeneral: 0.30\nMissions: 12.34");
  }
}
const prompts = [
  "Using the breeze church connector, how many people are in the Choir tag and have Member status? Resolve the profile field and option ids. Return only the count, with the final line ANSWER: <number>, and cite Breeze.",
  "Using breeze, who attended the Sunday Gathering occurrence on October 18, 2026, and has not checked out? Give their names and check-out state, and cite Breeze. Use occurrence ids rather than series ids.",
  "Using breeze, count every person across all pages, including any empty final page needed to establish the end. Use 100 people per page. Finish with ANSWER: <number> and cite Breeze.",
  "Using breeze, find the Roof Renewal pledge campaign, then total its pledges. Give the campaign id and amount and cite Breeze.",
  `Using breeze, create one person Alice New with email ${NEW_EMAIL}. First check for an existing exact match and resolve the Email profile field. Create at most once and report the new person id, citing Breeze.`,
  "Using breeze, change Bob Smith's Status profile field to Visitor. Resolve ids first. If a write fails, check the actual person before deciding whether it needs repeating. Report the person id and verified status, citing Breeze.",
  "Using breeze, total October 2026 giving by fund, with exact two-decimal amounts and the account's currency. Read the fund inventory and account currency; ignore September gifts. Cite Breeze.",
];
export const BREEZE_TASKS: ActiveTask[] = ids.map((id, i) => ({
  status: "active",
  id,
  title: id.replaceAll("-", " "),
  introducedIn: "#703",
  measures: prompts[i]!,
  prompt: prompts[i]!,
  world: { breeze: i === 5 ? { fault: "update-500" } : {} },
  ...(i === 4 || i === 5 ? {} : { deployment: { readOnly: true } }),
  grade: ({ world, trace }) => grade(id, world, trace),
  reference: (ctx) => reference(id, ctx),
}));
