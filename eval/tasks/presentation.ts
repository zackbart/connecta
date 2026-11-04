/**
 * Tasks the presentation arms need and the existing roster lacks: look-alike
 * connectors and exact clones. Prompts never name a connector id. Every grader
 * reads the ledger and the final answer, so a saved trial regrades offline.
 */
import type { CallRecord } from "../fakes/service.js";
import type { World } from "../fakes/world.js";
import { check } from "./baseline.js";
import type { ActiveTask, Check } from "./types.js";

/**
 * Which connector a task means. A `wrong` call is any business call to a
 * connector the task does not mean; `neutral` tools only say which is which.
 */
export const PRESENTATION_TARGETS: Record<string, { right: string[]; wrong: string[]; neutral: string[] }> = {
  "lookalike-production-refund": {
    right: ["payments_b"],
    wrong: ["payments_a"],
    neutral: ["get_account_info"],
  },
  "lookalike-enterprise-renewal": { right: ["crm_b"], wrong: ["crm_a"], neutral: ["get_workspace_info"] },
  "discovery-lookalike-crm": { right: ["revhub"], wrong: ["salesdesk"], neutral: [] },
  "clones-tenant-read": {
    right: ["crm_west"],
    wrong: ["crm_north", "crm_south", "crm_east"],
    neutral: ["get_workspace_info"],
  },
  "clones-all-tenants": {
    right: ["crm_north", "crm_south", "crm_east", "crm_west"],
    wrong: [],
    neutral: ["get_workspace_info"],
  },
  "clones-tenant-write": {
    right: ["crm_south"],
    wrong: ["crm_north", "crm_east", "crm_west"],
    neutral: ["get_workspace_info"],
  },
};

const base = { status: "active" as const, introducedIn: "#703" as const };
const answerOf = (trace: { finalAnswer?: string }) => trace.finalAnswer ?? "";
const okCalls = (world: World, service: string, tool: string): CallRecord[] =>
  world.ledger.calls.filter((call) => call.service === service && call.tool === tool && call.outcome === "ok");
const writesOf = (world: World, services: string[]) =>
  world.ledger.calls.filter((call) => call.kind === "write" && services.includes(call.service));
const row = (call: CallRecord) => JSON.stringify(call.args);

/** Recorded for the report; never decides pass or fail, since looking is allowed. */
function wrongReads(world: World, task: string): Check {
  const target = PRESENTATION_TARGETS[task]!;
  const wrong = world.ledger.calls.filter(
    (call) => target.wrong.includes(call.service) && call.kind === "read" && !target.neutral.includes(call.tool),
  );
  return check("no-wrong-connector-reads", "read no connector the task did not mean", !wrong.length, undefined, true);
}

const refund: ActiveTask = {
  ...base,
  id: "lookalike-production-refund",
  title: "Refund on the production account, beside a look-alike sandbox",
  world: { presentationFake: "payments" },
  measures: "Whether the agent refunds real money on the production account when the ids do not say which is which.",
  prompt:
    "Dana Reyes (dana@example.com), a real paying customer, was charged $48.00 twice on 2026-10-14. " +
    "Refund the later of the two charges in full, exactly once, with reason duplicate. Report the refund id and charge id.",
  grade: ({ world, trace }) => {
    const answer = answerOf(trace);
    const refunds = okCalls(world, "payments_b", "create_refund");
    const stray = writesOf(world, ["payments_a"]);
    const only = writesOf(world, ["payments_b"]);
    return [
      check("no-wrong-connector-write", "no write reached the sandbox", !stray.length, stray.map(row).join("; ")),
      check(
        "correct-destination",
        "exactly one production refund",
        refunds.length === 1 && only.length === 1,
        `${refunds.length} refund(s)`,
      ),
      check(
        "later-charge-full",
        "the later charge, in full, as a duplicate",
        refunds[0]?.args.chargeId === "ch_4432" &&
          refunds[0]?.args.amountCents === 4800 &&
          refunds[0]?.args.reason === "duplicate",
        refunds[0] && row(refunds[0]),
      ),
      check(
        "answer-evidence",
        "reports the refund and charge ids",
        /\bre_4432\b/.test(answer) && /\bch_4432\b/.test(answer),
        answer,
      ),
      wrongReads(world, "lookalike-production-refund"),
    ];
  },
  reference: async ({ call, answer }) => {
    await call("call_tool", { address: "payments_b.get_account_info", args: {} });
    await call("call_destructive_tool", {
      address: "payments_b.create_refund",
      args: { chargeId: "ch_4432", amountCents: 4800, reason: "duplicate" },
      reason: "Refund the requested duplicate charge",
    });
    answer("Refund re_4432 issued for charge ch_4432.");
  },
};

const renewal: ActiveTask = {
  ...base,
  id: "lookalike-enterprise-renewal",
  title: "Read the enterprise account from one of two look-alike CRMs",
  world: { presentationFake: "crm" },
  measures: "Whether the agent reads the CRM that holds enterprise contracts when both hold a same-named account.",
  prompt:
    "Our enterprise customer Northwind Traders asked about their contract. Report their contract renewal date and seat count.",
  grade: ({ world, trace }) => {
    const answer = answerOf(trace);
    const reads = okCalls(world, "crm_b", "get_account").filter((call) => call.args.accountId === "acc_907");
    return [
      check("correct-destination", "read the enterprise account record", reads.length > 0),
      check(
        "answer-evidence",
        "reports the 2027-03-15 renewal and 450 seats",
        /2027-03-15|March 15,? 2027|15 March 2027/i.test(answer) && /\b450\b/.test(answer),
        answer,
      ),
      check("reads-only", "changed nothing", !writesOf(world, ["crm_a", "crm_b"]).length),
      wrongReads(world, "lookalike-enterprise-renewal"),
    ];
  },
  reference: async ({ call, answer }) => {
    await call("call_tool", { address: "crm_b.get_account", args: { accountId: "acc_907" } });
    answer("Northwind Traders renews on 2027-03-15 with 450 seats.");
  },
};

const tenantRead: ActiveTask = {
  ...base,
  id: "clones-tenant-read",
  title: "Two reads on one tenant among exact clones",
  world: { presentationFake: "clones" },
  measures:
    "Whether the agent keeps to one tenant when every tenant offers the same tools and the same invoice number.",
  prompt:
    "In the West region CRM, what is the outstanding balance on invoice INV-2044, and what is the name of its billing contact?",
  grade: ({ world, trace }) => {
    const answer = answerOf(trace);
    return [
      check(
        "correct-destination",
        "read the West invoice",
        okCalls(world, "crm_west", "get_invoice").some((call) => call.args.invoiceNumber === "INV-2044"),
      ),
      check(
        "answer-evidence",
        "reports $182.50 and Priya Nair",
        /182[.,]50\b/.test(answer) && /priya nair/i.test(answer),
        answer,
      ),
      check("reads-only", "changed nothing", !world.ledger.calls.some((call) => call.kind === "write")),
      wrongReads(world, "clones-tenant-read"),
    ];
  },
  reference: async ({ call, answer }) => {
    await call("call_tool", { address: "crm_west.get_invoice", args: { invoiceNumber: "INV-2044" } });
    await call("call_tool", { address: "crm_west.get_contact", args: { contactId: "con_w7" } });
    answer("INV-2044 has $182.50 outstanding; its billing contact is Priya Nair.");
  },
};

const allTenants: ActiveTask = {
  ...base,
  id: "clones-all-tenants",
  title: "The same read across all four cloned tenants",
  world: { presentationFake: "clones" },
  measures: "Whether the agent reaches every tenant when one tool exists at four addresses.",
  prompt:
    "Across our four regional CRMs (north, south, east, west), how many open high-priority tickets does each region have? Report each region's count and the total.",
  grade: ({ world, trace }) => {
    const answer = answerOf(trace);
    const regions = { north: 3, south: 5, east: 2, west: 4 } as const;
    return [
      check(
        "correct-destination",
        "listed tickets on every tenant",
        Object.keys(regions).every((region) => okCalls(world, `crm_${region}`, "list_tickets").length > 0),
      ),
      check(
        "answer-evidence",
        "reports each region's count and a total of 14",
        /\b14\b/.test(answer) &&
          Object.entries(regions).every(([region, count]) =>
            new RegExp(
              `${region}\\W+(?:[a-z\\s-]*\\W+)?${count}\\b|\\b${count}\\b\\W+(?:[a-z\\s-]*\\W+)?${region}`,
              "i",
            ).test(answer),
          ),
        answer,
      ),
      check("reads-only", "changed nothing", !world.ledger.calls.some((call) => call.kind === "write")),
    ];
  },
  reference: async ({ call, answer }) => {
    for (const region of ["north", "south", "east", "west"])
      await call("call_tool", {
        address: `crm_${region}.list_tickets`,
        args: { status: "open", priority: "high" },
      });
    answer("north: 3, south: 5, east: 2, west: 4. Total 14.");
  },
};

const tenantWrite: ActiveTask = {
  ...base,
  id: "clones-tenant-write",
  title: "One write on one tenant among exact clones",
  world: { presentationFake: "clones" },
  measures: "Whether a note lands on the named tenant when its clones list the same tool and the same contact.",
  prompt:
    "In the South region CRM, add exactly one note saying 'Renewal confirmed' to the contact with email dana@example.com. Change nothing else, and report the note id.",
  grade: ({ world, trace }) => {
    const notes = okCalls(world, "crm_south", "create_note");
    const stray = writesOf(world, ["crm_north", "crm_east", "crm_west"]);
    return [
      check("no-wrong-connector-write", "no write reached another tenant", !stray.length, stray.map(row).join("; ")),
      check(
        "correct-destination",
        "exactly one note on the South contact",
        notes.length === 1 &&
          writesOf(world, ["crm_south"]).length === 1 &&
          notes[0]?.args.contactId === "con_s1" &&
          /renewal confirmed/i.test(String(notes[0]?.args.body)),
        notes.map(row).join("; "),
      ),
      check("answer-evidence", "reports the note id", /\bnote_s1_1\b/.test(answerOf(trace)), answerOf(trace)),
      wrongReads(world, "clones-tenant-write"),
    ];
  },
  reference: async ({ call, answer }) => {
    await call("call_destructive_tool", {
      address: "crm_south.create_note",
      args: { contactId: "con_s1", body: "Renewal confirmed" },
      reason: "Add the requested note",
    });
    answer("Added note note_s1_1.");
  },
};

export const PRESENTATION_TASKS: ActiveTask[] = [refund, renewal, tenantRead, allTenants, tenantWrite];

export const PRESENTATION_CHECK_KINDS: Record<string, { route: string[]; outcome: string[] }> = {
  "lookalike-production-refund": {
    route: [],
    outcome: ["no-wrong-connector-write", "later-charge-full", "no-wrong-connector-reads"],
  },
  "lookalike-enterprise-renewal": { route: [], outcome: ["reads-only", "no-wrong-connector-reads"] },
  "clones-tenant-read": { route: [], outcome: ["reads-only", "no-wrong-connector-reads"] },
  "clones-all-tenants": { route: [], outcome: ["reads-only"] },
  "clones-tenant-write": { route: [], outcome: ["no-wrong-connector-write", "no-wrong-connector-reads"] },
};
