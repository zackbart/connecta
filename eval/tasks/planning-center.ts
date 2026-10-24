/** Frozen Planning Center step-2 tasks: real provider, fake HTTP, surface-neutral outcome grading. */
import type { ActiveTask, Check, ReferenceContext } from "./types.js";
import type { World } from "../fakes/world.js";
import type { AgentTrace } from "../agent/trace.js";
import { REST_TOOL_KINDS } from "../deploy/rest-tools.js";
import {
  PERSON,
  GROUP,
  SERVICE,
  PLAN,
  CATEGORY,
  REMOVED,
  NOTE,
  planningCenterState,
} from "../fakes/planning-center.js";
import { check } from "./baseline.js";
const ids = [
  "pco-step2-filtered-people",
  "pco-step2-group-services-join",
  "pco-step2-plan-join",
  "pco-step2-people-paging",
  "pco-step2-merger-hatch",
  "pco-step2-note-once",
  "pco-step2-update-recovery",
];
const seed = planningCenterState();
const matching = seed.people.filter((p) => p.attributes.status === "active" && p.attributes.membership === "Member");
const count = seed.people.filter((p) => Number(p.id) % 7 === 0).length;
const expected = [
  { source: "Planning Center", ids: matching.map((p) => p.id).sort(), count: matching.length },
  {
    source: "Planning Center",
    leaders: [
      { person_id: PERSON, email: "alice@example.com", plan_id: PLAN },
      { person_id: "1003", email: "bob@example.com", plan_id: PLAN },
    ],
  },
  {
    source: "Planning Center",
    service_type_id: SERVICE,
    plan_id: PLAN,
    item_id: "4202",
    minutes: 25,
    person_id: PERSON,
    status: "C",
  },
  { source: "Planning Center", count },
  { source: "Planning Center", removed_id: REMOVED, kept_id: PERSON, name: "Alice Brooks" },
  { source: "Planning Center", person_id: PERSON, note_id: "8001", text: NOTE },
  { source: "Planning Center", person_id: PERSON, nickname: "Ally" },
];
function answer(trace: AgentTrace): any {
  const lines = (trace.finalAnswer ?? "").split(/\r?\n/).filter((line) => /^\s*(?:\*\*)?ANSWER(?:\*\*)?:/i.test(line));
  try {
    return JSON.parse(lines.at(-1)?.replace(/^\s*(?:\*\*)?ANSWER(?:\*\*)?:\s*/i, "") ?? "null");
  } catch {
    return null;
  }
}
function canonical(value: any): string {
  const walk = (v: any): any =>
    Array.isArray(v)
      ? v.map(walk).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, walk(x)]),
          )
        : v;
  return JSON.stringify(walk(value));
}
function grade(i: number, world: World, trace: AgentTrace): Check[] {
  const calls = world.ledger.calls.filter((c) => c.service === "pco"),
    writes = world.ledger.calls.filter((c) => c.kind === "write");
  const reads = calls.filter((c) => c.kind === "read" && c.outcome === "ok");
  const reached = (path: string) => reads.some((c) => c.args.path === path);
  const checks: Check[] = [];
  const add = (id: string, pass: boolean) => checks.push(check(id, id.replaceAll("-", " "), pass));
  let destination = false;
  if (i === 0) {
    destination = reached("/people/v2/people");
    checks.push(
      check(
        "filtered",
        "Server-side membership and status filters reduce data (efficiency only)",
        reads.some(
          (c) =>
            c.args.path === "/people/v2/people" &&
            (c.args.query as any)["where[membership]"] === "Member" &&
            (c.args.query as any)["where[status]"] === "active",
        ),
        undefined,
        true,
      ),
    );
  } else if (i === 1)
    destination =
      reached("/groups/v2/groups") &&
      reached(`/groups/v2/groups/${GROUP}/memberships`) &&
      [PERSON, "1003"].every((p) => reached(`/services/v2/people/${p}/schedules`)) &&
      (reached("/people/v2/people") || [PERSON, "1003"].every((p) => reached(`/people/v2/people/${p}`)));
  else if (i === 2)
    destination =
      reached("/services/v2/service_types") &&
      reached(`/services/v2/service_types/${SERVICE}/plans`) &&
      ["items", "team_members"].every((part) => reached(`/services/v2/service_types/${SERVICE}/plans/${PLAN}/${part}`));
  else if (i === 3)
    destination =
      reads.filter((c) => c.args.path === "/people/v2/people").length >= 2 &&
      reads.some((c) => c.args.path === "/people/v2/people" && Number((c.args.query as any).offset) >= 100);
  else if (i === 4) destination = reached("/people/v2/person_mergers") && reached(`/people/v2/people/${PERSON}`);
  else if (i === 5) {
    destination =
      calls.some(
        (c) => c.args.path === `/people/v2/people/${PERSON}/notes` && c.kind === "write" && c.outcome === "ok",
      ) && reached("/people/v2/note_categories");
    add(
      "state",
      world.pco.notes.length === 1 &&
        world.pco.notes[0]?.attributes.note === NOTE &&
        world.pco.notes[0]?.attributes.person_id === PERSON &&
        world.pco.notes[0]?.attributes.note_category_id === CATEGORY,
    );
    add(
      "only-requested-writes",
      writes.length === 1 &&
        writes[0]?.args.method === "POST" &&
        writes[0]?.args.path === `/people/v2/people/${PERSON}/notes`,
    );
  } else {
    const sent = calls.find((c) => c.kind === "write");
    destination = sent?.args.path === `/people/v2/people/${PERSON}`;
    add(
      "state",
      world.pco.people[0]?.attributes.nickname === "Ally" &&
        world.pco.people.slice(1).every((p) => p.attributes.nickname === null),
    );
    add(
      "only-requested-writes",
      writes.length === 1 &&
        writes[0]?.args.method === "PATCH" &&
        canonical((writes[0]?.args.body as any)?.data?.attributes) === canonical({ nickname: "Ally" }),
    );
    add(
      "reconciled",
      reads.some(
        (c) =>
          c.seq > (sent?.seq ?? Infinity) &&
          (c.args.path === `/people/v2/people/${PERSON}` || c.args.path === "/people/v2/people"),
      ),
    );
  }
  add("correct-destination", destination);
  const actual = answer(trace);
  // Only the vendor's identity label is normalized; records/types/extra fields are exact.
  if (actual && /^(?:pco|planning[ .]?center)$/i.test(actual.source ?? "")) actual.source = "Planning Center";
  add("answer-evidence", canonical(actual) === canonical(expected[i]));
  if (i < 5) {
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
const standard = () => REST_TOOL_KINDS.has("pco.pco_api_read");
const call = (ctx: ReferenceContext, tool: string, args: Record<string, unknown> = {}, write = false) =>
  ctx.call(write ? "call_destructive_tool" : "call_tool", { address: `pco.${tool}`, args });
const hatch = (ctx: ReferenceContext, path: string, query: Record<string, unknown> = {}) =>
  call(ctx, standard() ? "pco_api_read" : "pco_api_get", {
    path,
    query: standard() ? query : Object.entries(query).map(([name, value]) => ({ name, value })),
  });
async function reference(i: number, ctx: ReferenceContext) {
  const paging = standard() ? { limit: 100 } : { perPage: 100 };
  if (i === 0) await call(ctx, "search_people", { membership: "Member", status: "active", ...paging });
  else if (i === 1) {
    await call(ctx, "list_groups", { name: "Welcome Team" });
    await call(ctx, "list_group_memberships", { groupId: GROUP, role: "leader" });
    for (const personId of [PERSON, "1003"]) {
      await call(ctx, "get_person", { personId });
      await call(ctx, "list_person_schedules", { personId });
    }
  } else if (i === 2) {
    await call(ctx, "list_service_types");
    await call(ctx, "list_plans", { serviceTypeId: SERVICE });
    await call(ctx, "get_plan", { serviceTypeId: SERVICE, planId: PLAN });
  } else if (i === 3) {
    const pageArgs = standard() ? { ...paging, fields: ["id"] } : paging;
    const first = await call(ctx, "search_people", pageArgs);
    const cursor = /"nextCursor"\s*:\s*"([^"]+)"/.exec(first.text)?.[1];
    if (standard() && !cursor) throw new Error("Planning Center's projected reference page lost its next cursor.");
    await call(ctx, "search_people", standard() ? { ...pageArgs, cursor } : { ...pageArgs, offset: 100 });
  } else if (i === 4) {
    if (standard()) {
      await call(ctx, "pco_api_search", { query: "person mergers" });
      await call(ctx, "pco_api_details", { method: "GET", path: "/people/v2/person_mergers" });
    }
    await hatch(ctx, "/people/v2/person_mergers", { "where[person_to_remove_id]": REMOVED });
    await call(ctx, "get_person", { personId: PERSON });
  } else if (i === 5) {
    await call(ctx, "search_people", { search: "Alice Brooks" });
    await hatch(ctx, "/people/v2/note_categories");
    await call(ctx, "add_person_note", { personId: PERSON, noteCategoryId: CATEGORY, note: NOTE }, true);
  } else {
    await call(ctx, "search_people", { search: "Alice Brooks" });
    const out = await call(ctx, "update_person", { personId: PERSON, nickname: "Ally" }, true);
    if (!out.isError) throw new Error("Planning Center committed-update fault was not observed");
    await call(ctx, "get_person", { personId: PERSON });
  }
  ctx.answer(`ANSWER: ${JSON.stringify(expected[i])}`);
}
const prompts = [
  "Find all People profiles with active status and Member membership. Report every matching id and the total count.",
  "Find the Welcome Team group (not its Alumni group). For its leaders who have future Services schedules, report each People person id, primary email and future plan id. Resolve the group and join by person id, not names.",
  "In Sunday Morning, find October Gathering. Report service type id, plan id, Sermon item id and its length in minutes, and the scheduled Alice Brooks person's id and response status code.",
  "Across all People profiles (including inactive profiles), how many person ids are divisible by 7? Read every page using 100 rows per page; metadata totals alone cannot answer this.",
  `Person ${REMOVED} was merged. Use the API's person merger history, find the surviving id, then read that profile and report its name.`,
  `Resolve Alice Brooks and the Follow-up note category, then add exactly one profile note with text ${JSON.stringify(NOTE)}. Report the person id, new note id and exact text. You are authorized to add this one note, and no other records.`,
  "Resolve Alice Brooks, then set only her nickname to Ally. You are authorized to make this one change. If the request fails, read the actual profile to reconcile before considering any repeat. Report the person id and verified nickname.",
];
const shape = (v: any): any =>
  Array.isArray(v)
    ? [shape(v[0])]
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]))
      : typeof v;
export const PLANNING_CENTER_TASKS: ActiveTask[] = ids.map((id, i) => ({
  status: "active",
  id,
  title: id.replaceAll("-", " "),
  introducedIn: "#703",
  measures: prompts[i]!,
  prompt: `Use the connected pco Planning Center source. ${prompts[i]} ${i < 5 ? "Read only; make no changes." : ""} Finish with exactly one final line ANSWER: followed by JSON with this shape (type names are placeholders; use observed values): ${JSON.stringify(shape(expected[i]))}. Include all requested records, no extra records, and literal JSON numbers.`,
  world: { planningCenter: i === 6 ? { fault: "update-500" } : {} },
  ...(i < 5 ? { deployment: { readOnly: true } } : {}),
  grade: ({ world, trace }) => grade(i, world, trace),
  reference: (ctx) => reference(i, ctx),
}));
