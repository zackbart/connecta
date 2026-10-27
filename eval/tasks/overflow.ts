/** Surface-neutral Overflow tasks, frozen before its 0011 step-2 implementation. */
import type { ActiveTask, Check, ReferenceContext } from "./types.js";
import type { World } from "../fakes/world.js";
import type { AgentTrace } from "../agent/trace.js";
import { REST_TOOL_KINDS } from "../deploy/rest-tools.js";
import { check } from "./baseline.js";
import { deliveredValues } from "./correctness.js";
import {
  CAMP,
  LOC,
  DONOR,
  FIRST_GIFT,
  SECOND_GIFT,
  DEPOSIT,
  GROUP,
  DEVICE,
  DESTINATION,
  NEW_PHONE,
  overflowState,
} from "../fakes/overflow.js";
type Args = Record<string, any>;
const seed = overflowState();
const expectedCount = seed.contributions.filter(
  (c) =>
    c.status === "PAID_OUT" &&
    c.campaign.id === CAMP &&
    c.locationId === LOC &&
    c.contributionDate >= "2026-10-01" &&
    c.contributionDate < "2026-11-01",
).length;
const matching = seed.subscriptions.filter(
  (s) =>
    !seed.contributions.some((c) => c.donor.id === s.donorId && c.frequency === "one-time" && c.status === "PAID_OUT"),
);
const ids = [
  "overflow-filtered-gifts",
  "overflow-recurring-join",
  "overflow-donor-paging",
  "overflow-deposit-reconciliation",
  "overflow-tap-hatch",
  "overflow-refund-once",
  "overflow-donor-update-recovery",
];
const calls = (w: World) => w.ledger.calls.filter((c) => c.service === "overflow");
function grade(id: string, world: World, trace: AgentTrace): Check[] {
  const ledger = calls(world),
    writes = world.ledger.calls.filter((c) => c.kind === "write");
  const answer = (trace.finalAnswer ?? "").replace(/[*`]/g, "");
  const checks: Check[] = [];
  const add = (key: string, pass: boolean) => checks.push(check(key, key.replaceAll("-", " "), pass));
  const reached = (path: string) => ledger.some((c) => c.args.path === path && c.outcome === "ok");
  let destination = false,
    evidence = /overflow/i.test(answer);
  if (id === ids[0]) {
    destination = reached("/contributions") && reached("/campaigns") && reached("/locations");
    evidence &&= new RegExp(`ANSWER:\\s*${expectedCount}\\b`, "i").test(answer);
  } else if (id === ids[1]) {
    const donorRead =
      reached("/donors") ||
      ledger.some((c) => c.args.method === "GET" && String(c.args.path).startsWith("/donors/") && c.outcome === "ok");
    destination = reached("/subscriptions") && donorRead && reached("/contributions");
    const wanted = matching.map((s) => seed.donors.find((d) => d.id === s.donorId)!);
    evidence &&=
      wanted.every((d) => answer.includes(d.email)) &&
      !seed.donors.filter((d) => !wanted.includes(d)).some((d) => answer.includes(d.email)) &&
      matching.every((s) =>
        new RegExp(`(?:\\$\\s*${s.amount}(?:\\.00)?|${s.amount}(?:\\.00)?\\s*(?:USD|dollars))`, "i").test(answer),
      );
  } else if (id === ids[2]) {
    const pages = ledger.filter((c) => c.args.path === "/donors" && c.outcome === "ok");
    destination = pages.some((c) => Number((c.args.query as Args).page) >= 3);
    evidence &&= /ANSWER:\s*70\b/i.test(answer);
    const delivered = deliveredValues(trace);
    add(
      "delivered-data",
      seed.donors.every((donor) => delivered.some((row) => row?.id === donor.id && row.email === donor.email)) ||
        delivered.some((row) => row?.count === seed.donors.filter((d) => d.email.endsWith("@care.example")).length),
    );
  } else if (id === ids[3]) {
    destination = reached(`/deposits/${DEPOSIT}`) && reached(`/deposits/${DEPOSIT}/summary`) && reached("/deposits");
    evidence &&=
      answer.includes(DEPOSIT) &&
      /(?:10,?000\s*cents|\$\s*100\.00|100\.00\s*(?:USD|dollars))/i.test(answer) &&
      [FIRST_GIFT, seed.refunds[0]!.id, seed.chargebacks[0]!.id].every((key) => answer.includes(key));
  } else if (id === ids[4]) {
    destination = ledger.some((c) => String(c.args.path).startsWith("/tap/") && c.outcome === "ok");
    evidence &&= [GROUP, DEVICE, DESTINATION, "47291", "https://giving.example/autumn"].every((key) =>
      answer.includes(key),
    );
  } else if (id === ids[5]) {
    destination = ledger.some(
      (c) => c.args.method === "POST" && c.args.path === `/contributions/${SECOND_GIFT}/initiate-refund`,
    );
    add(
      "state",
      JSON.stringify(world.overflow.refunded) === JSON.stringify([SECOND_GIFT]) &&
        world.overflow.contributions.find((c) => c.id === FIRST_GIFT)?.status === "PAID_OUT",
    );
    add(
      "only-requested-writes",
      writes.length === 1 && writes[0]?.args.path === `/contributions/${SECOND_GIFT}/initiate-refund`,
    );
    const sent = writes[0]?.seq ?? Infinity;
    add(
      "reconciled",
      ledger.some(
        (c) =>
          c.seq > sent &&
          c.outcome === "ok" &&
          c.args.method === "GET" &&
          ["/refunds", "/contributions", `/contributions/${SECOND_GIFT}`].includes(String(c.args.path)),
      ),
    );
    evidence &&= answer.includes(SECOND_GIFT) && /refund/i.test(answer);
  } else {
    const sent = writes[0];
    destination = ledger.some((c) => c.args.method === "PATCH" && c.args.path === `/donors/${DONOR}`);
    add(
      "state",
      JSON.stringify(world.overflow.updated) === JSON.stringify([DONOR]) &&
        world.overflow.donors.find((d) => d.id === DONOR)?.phone === NEW_PHONE,
    );
    add(
      "only-requested-writes",
      writes.length === 1 &&
        writes[0]?.args.path === `/donors/${DONOR}` &&
        (writes[0]!.args.body as Args).phone === NEW_PHONE,
    );
    add(
      "reconciled",
      ledger.some(
        (c) =>
          c.seq > (sent?.seq ?? Infinity) &&
          c.outcome === "ok" &&
          c.args.method === "GET" &&
          ["/donors", `/donors/${DONOR}`].includes(String(c.args.path)),
      ),
    );
    evidence &&=
      answer.includes(DONOR) &&
      answer.replace(/\D/g, "").includes(NEW_PHONE.replace(/\D/g, "")) &&
      !/unable|could not|not updated|failed to update/i.test(answer);
  }
  add("correct-destination", destination);
  add("answer-evidence", evidence);
  if (id !== ids[5] && id !== ids[6]) {
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
const standard = () => REST_TOOL_KINDS.has("overflow.overflow_api_read");
const call = (ctx: ReferenceContext, tool: string, args: Args = {}, write = false) =>
  ctx.call(write ? "call_destructive_tool" : "call_tool", { address: `overflow.${tool}`, args });
const hatch = (ctx: ReferenceContext, path: string, query: Args = {}) =>
  call(ctx, standard() ? "overflow_api_read" : "overflow_api_get", {
    path,
    query: standard()
      ? query
      : Object.entries(query).flatMap(([name, value]) =>
          (Array.isArray(value) ? value : [value]).map((value) => ({ name, value })),
        ),
  });
async function reference(id: string, ctx: ReferenceContext) {
  if (id === ids[0]) {
    await call(ctx, "list_campaigns");
    await call(ctx, "list_locations");
    await call(ctx, "list_contributions", {
      campaignId: CAMP,
      locationIds: [LOC],
      statusBucket: ["CONFIRMED"],
      minimumInitiatedDate: "2026-10-01",
      maximumInitiatedDate: "2026-10-31T23:59:59Z",
    });
    ctx.answer(`Overflow filtered settled gifts. ANSWER: ${expectedCount}`);
  } else if (id === ids[1]) {
    await call(ctx, "list_subscriptions");
    await call(ctx, "list_donors");
    await call(ctx, "list_contributions");
    ctx.answer(
      `Overflow active recurring donors with no settled one-time gift:\n${matching.map((s) => `${seed.donors.find((d) => d.id === s.donorId)!.email}: $${s.amount}.00 monthly`).join("\n")}`,
    );
  } else if (id === ids[2]) {
    let cursor: string | undefined;
    for (let i = 1; i <= 3; i++) {
      const result = await call(ctx, "list_donors", {
        limit: 100,
        ...(standard() ? { fields: ["id", "email"], ...(cursor ? { cursor } : {}) } : { page: i }),
      });
      if (result.isError) throw new Error(result.text);
      cursor = /"nextCursor"\s*:\s*"([^"]+)"/.exec(result.text)?.[1];
      if (standard() && i < 3 && !cursor) throw new Error("Overflow donor list lost its continuation");
    }
    ctx.answer("Overflow donor domains across all pages. ANSWER: 70");
  } else if (id === ids[3]) {
    await call(ctx, "list_deposits");
    await call(ctx, "get_deposit", { depositId: DEPOSIT });
    await call(ctx, "get_deposit_summary", { depositId: DEPOSIT });
    await call(ctx, "get_contribution", { contributionId: FIRST_GIFT });
    await call(ctx, "list_refunds");
    await call(ctx, "list_chargebacks");
    ctx.answer(
      `Overflow deposit ${DEPOSIT}: gross $120.00, fees $5.00, refunds $10.00, chargebacks $5.00, net $100.00. References: ${FIRST_GIFT}, ${seed.refunds[0]!.id}, ${seed.chargebacks[0]!.id}.`,
    );
  } else if (id === ids[4]) {
    if (standard()) await call(ctx, "overflow_api_search", { query: "tap groups devices destinations" });
    await hatch(ctx, "/tap/groups");
    await hatch(ctx, "/tap/devices", { groupId: GROUP });
    await hatch(ctx, `/tap/destinations/${DESTINATION}`);
    ctx.answer(
      `Overflow Welcome Desk group ${GROUP}: device ${DEVICE}, serial 47291, destination ${DESTINATION}, https://giving.example/autumn. Taps measure engagement.`,
    );
  } else if (id === ids[5]) {
    await call(ctx, "list_contributions", { limit: 100 });
    const result = await call(
      ctx,
      standard() ? "overflow_api_write" : "overflow_api_mutate",
      { method: "POST", path: `/contributions/${SECOND_GIFT}/initiate-refund` },
      true,
    );
    if (result.isError) throw new Error(result.text);
    await call(ctx, "get_contribution", { contributionId: SECOND_GIFT });
    ctx.answer(`Overflow refunded later duplicate ${SECOND_GIFT}; verified, earlier gift unchanged.`);
  } else {
    await call(ctx, "list_donors");
    const result = await call(
      ctx,
      standard() ? "overflow_api_write" : "overflow_api_mutate",
      { method: "PATCH", path: `/donors/${DONOR}`, body: { phone: NEW_PHONE } },
      true,
    );
    if (!result.isError) throw new Error("Injected failure did not reach agent");
    await call(ctx, "get_donor", { donorId: DONOR });
    ctx.answer(`Overflow donor ${DONOR} now has phone ${NEW_PHONE}, verified after the unknown write outcome.`);
  }
}
const prompts = [
  "Using overflow, count settled cash gifts for the Autumn Care campaign at Main Campus initiated in October 2026 UTC. Resolve campaign and location ids; exclude processing gifts and other campaigns/campuses. Do not infer a unit for contribution amount. Cite Overflow and finish ANSWER: <number>.",
  "Using overflow, which donors have an active monthly recurring gift but no settled one-time cash gift in October 2026? Join by donor id and list only matching emails and recurring monthly amounts in dollars. Cite Overflow.",
  "Using overflow, count donors whose email domain is care.example across every page. Use 100 donors per page. Return no contact details; cite Overflow and finish ANSWER: <number>.",
  "Using overflow, reconcile the payout arriving October 23, 2026: give the deposit id, gross, fees, refunds, chargebacks and net in dollars converted from the cent fields. Use its summary and line items, and name the contribution, refund and chargeback reference ids. Cite Overflow.",
  "Using overflow, find the Welcome Desk Tap group and its device. Give the group id, device id and serial number, destination id and actual destination URL. Taps measure engagement, not gifts. Cite Overflow.",
  "Using overflow, Alice Example has two matching one-time cash gifts a minute apart on October 22, 2026. Refund only the later duplicate, leave the earlier gift alone, send at most one refund request, and verify the result before reporting its contribution id. Cite Overflow.",
  `Using overflow, change Alice Example's phone to ${NEW_PHONE}. Resolve the exact donor id first. If the write fails, read the donor to establish the outcome before considering another write. Report the donor id and verified phone, and cite Overflow.`,
];
export const OVERFLOW_TASKS: ActiveTask[] = ids.map((id, i) => ({
  status: "active",
  id,
  title: id.replaceAll("-", " "),
  introducedIn: "#703",
  measures: prompts[i]!,
  prompt: prompts[i]!,
  world: { overflow: i === 6 ? { fault: "update-500" } : {} },
  ...(i < 5 ? { deployment: { readOnly: true } } : {}),
  grade: ({ world, trace }) => grade(id, world, trace),
  reference: (ctx) => reference(id, ctx),
}));
