/**
 * Tithe.ly giving tasks for decision 0011's first step 2 (#703). Graders read
 * only the fake's state, its HTTP ledger and the final answer, so one task file
 * grades the legacy surface (`tithely_api_get`/`_api_mutate`, `raw`) and the
 * standard one (`tithely_api_search`/`_details`/`_read`/`_write`, `fields`)
 * alike. References try the standard hatch first and fall back to the legacy
 * one, so the same frozen file drives both arms of the before/after run.
 */
import type { ActiveTask, Check, ReferenceContext } from "./types.js";
import type { AgentTrace } from "../agent/trace.js";
import type { World } from "../fakes/world.js";
import type { CallRecord } from "../fakes/service.js";
import { REST_TOOL_KINDS } from "../deploy/rest-tools.js";
import { check } from "./baseline.js";
import { deliveredValues } from "./correctness.js";
import {
  BOB,
  BOB_HOPE,
  BOB_WEEKLY,
  DOMAIN,
  DUP_FIRST,
  DUP_SECOND,
  GRACE,
  GRACE_WIDGET,
  NOV_START,
  OCT_START,
  SEPT_START,
  tithelyState,
  type TithelyFault,
} from "../fakes/tithely.js";

type Args = Record<string, any>;
const SERVICE = "tithely";
const calls = (world: World, method?: string, path?: string | RegExp) =>
  world.ledger.calls.filter(
    (c) =>
      c.service === SERVICE &&
      (!method || c.args.method === method) &&
      (!path || (typeof path === "string" ? c.args.path === path : path.test(String(c.args.path)))),
  );
const success = (c: CallRecord) => c.outcome === "ok";
const final = (trace: AgentTrace) => (trace.finalAnswer ?? "").replace(/[*`]/g, "");
const query = (c: CallRecord) => c.args.query as Args;

function completeRecurringList(value: Args | undefined, expected: string[]): boolean {
  return (
    Array.isArray(value?.items) &&
    value.page?.hasMore === false &&
    value.items.length === expected.length &&
    expected.every((id) => value.items.some((row: Args) => row?.recurringId === id))
  );
}

/** Every tool the agent named, top level or inside a program, caught refusals included. */
function addresses(world: World, trace: AgentTrace): string[] {
  return [
    ...trace.toolUses
      .filter((u) => ["call_tool", "call_destructive_tool"].includes(u.tool))
      .map((u) => String(u.input.address)),
    ...world.programs.flatMap((p) => p.calls.filter((c) => c.name === "connecta.call").map((c) => String(c.args[0]))),
  ];
}
const readsOnly = (world: World, trace: AgentTrace) =>
  !world.ledger.calls.some((c) => c.kind === "write") &&
  !trace.toolUses.some((u) => u.tool === "call_destructive_tool") &&
  // An address this deployment does not serve cannot write; a served write tool fails even when refused.
  !addresses(world, trace).some((address) => REST_TOOL_KINDS.get(address) === "write");

/** Dollars with or without grouping and a currency sign, or whole cents. */
function money(cents: number): RegExp {
  const dollars = Math.trunc(cents / 100);
  const grouped = dollars.toLocaleString("en-US").replace(/,/g, ",?");
  const fraction = String(cents % 100).padStart(2, "0");
  const short = fraction.endsWith("0") ? `${fraction[0]}0?` : fraction;
  return new RegExp(
    `(?:\\$\\s?${grouped}\\.${short}(?!\\d)|(?<![\\d.,])${grouped}\\.${short}(?!\\d)|(?<![\\d.,$])${cents}(?![\\d.,]))`,
  );
}

/** Expected answers, computed from a fresh seed. */
const seed = tithelyState();
const september = (() => {
  const totals = new Map<string, { gross: number; net: number }>();
  for (const c of seed.charges) {
    const at = Number(c.charge_date);
    if (c.organization.organization_id !== GRACE || at < SEPT_START || at >= OCT_START) continue;
    if (c.charge_status !== "charged") continue;
    const entry = totals.get(c.giving_type) ?? { gross: 0, net: 0 };
    entry.gross += Number(c.amount);
    entry.net += Number(c.net_amount);
    totals.set(c.giving_type, entry);
  }
  return totals;
})();
const lapsed = (() => {
  const monthly = seed.recurring.filter((r) => r.term === "monthly" && r.organization.organization_id === GRACE);
  const gave = new Set(
    seed.charges
      .filter(
        (c) =>
          c.organization.organization_id === GRACE &&
          c.recurring_transaction === false &&
          Number(c.charge_date) >= OCT_START &&
          Number(c.charge_date) < NOV_START,
      )
      .map((c) => c.donor_account.account_id),
  );
  const donors = monthly.map((r) => r.donor_account);
  return {
    matching: donors.filter((d) => !gave.has(d.account_id)),
    other: donors.filter((d) => gave.has(d.account_id)),
  };
})();
const bob = seed.accounts.find((a) => a.account_id === BOB)!;
const BOB_PHONE = String(bob.phone_number);
const BOB_STREET = String(bob.address.street_address);
const domainCount = seed.accounts.filter((a) => String(a.email).endsWith(`@${DOMAIN}`)).length;
const apiDomainCount = seed.accounts.filter((a) => a.api && String(a.email).endsWith(`@${DOMAIN}`)).length;
if (domainCount === apiDomainCount) throw new Error("The account-scope trap needs distinct counts");

function lastAnswer(answer: string): string | undefined {
  const lines = answer.split(/\r?\n/).filter((line) => /^\s*(?:\*\*)?ANSWER(?:\*\*)?\s*:/i.test(line));
  return lines
    .at(-1)
    ?.replace(/^\s*(?:\*\*)?ANSWER(?:\*\*)?\s*:\s*/i, "")
    .trim()
    .replace(/^["'`]|["'`.]+$/g, "")
    .toLowerCase();
}

function grade(id: string, world: World, trace: AgentTrace): Check[] {
  const answer = final(trace);
  const checks: Check[] = [];
  const outcome = (name: string, description: string, pass: boolean, detail?: string) =>
    checks.push(check(name, description, pass, detail));
  const destination = (pass: boolean) =>
    outcome("correct-destination", "the Tithe.ly connector reached the requested giving records", pass);
  const evidence = (pass: boolean) =>
    outcome("answer-evidence", "the final answer contains the requested ids and facts", pass);
  const advisory = (name: string, description: string, pass: boolean) =>
    checks.push(check(name, description, pass, undefined, true));
  const writes = world.ledger.calls.filter((c) => c.kind === "write");
  if (id === "tithely-fund-totals") {
    const lists = calls(world, "GET", "/charges-list").filter((c) => success(c) && query(c).organization_id === GRACE);
    destination(lists.length > 0);
    evidence(
      /tithe\.?ly/i.test(answer) &&
        [...september].every(
          ([fund, { gross, net }]) => answer.includes(fund) && money(gross).test(answer) && money(net).test(answer),
        ),
    );
    outcome("reads-only", "no write was attempted", readsOnly(world, trace));
    advisory(
      "date-filter",
      "the vendor filtered by created date instead of the agent scanning every charge",
      lists.some((c) => query(c).created_after !== undefined && query(c).created_before !== undefined),
    );
  } else if (id === "tithely-recurring-join") {
    destination(
      calls(world, "GET", "/recurring-list").some(
        (c) => success(c) && (query(c).organization_id === GRACE || query(c).account_id !== undefined),
      ) && calls(world, "GET", "/charges-list").some((c) => success(c)),
    );
    const text = answer.toLowerCase();
    const name = (d: Args) => `${d.first_name} ${d.last_name}`.toLowerCase();
    // Explaining who was left out is fine; listing them, or giving their emails, is not.
    const listed = text.split(/\r?\n/).filter((line) => /^\s*(?:[-*•]|\d+[.)]|\|)/.test(line));
    evidence(
      lapsed.matching.every((d) => text.includes(name(d)) && text.includes(String(d.email).toLowerCase())) &&
        !lapsed.other.some(
          (d) => text.includes(String(d.email).toLowerCase()) || listed.some((line) => line.includes(name(d))),
        ),
    );
    outcome("reads-only", "no write was attempted", readsOnly(world, trace));
  } else if (id === "tithely-account-paging") {
    const pages = calls(world, "GET", "/accounts-list-all").filter(success);
    destination(pages.length >= 2 && pages.some((c) => query(c).starting_after || query(c).ending_before));
    evidence(lastAnswer(answer) === String(domainCount));
    outcome("reads-only", "no write was attempted", readsOnly(world, trace));
  } else if (id === "tithely-widget-hatch") {
    destination(
      [...calls(world, "GET", `/organizations/${GRACE}`), ...calls(world, "GET", "/organizations-list")].some(success),
    );
    evidence(answer.includes(GRACE_WIDGET) && /grace/i.test(answer));
    outcome("reads-only", "no write was attempted", readsOnly(world, trace));
  } else if (id === "tithely-donor-contact") {
    // No named projection carries an account's phone or street address; only Tithe.ly's records do.
    destination(
      calls(world, "GET").some(
        (c) =>
          success(c) &&
          (c.args.path === `/accounts/${BOB}` ||
            String(c.args.path).startsWith("/accounts-list") ||
            ["/charges-list", "/recurring-list"].includes(String(c.args.path))),
      ),
    );
    evidence(answer.replace(/\D/g, "").includes(BOB_PHONE) && answer.includes(BOB_STREET));
    outcome("reads-only", "no write was attempted", readsOnly(world, trace));
  } else if (id === "tithely-refund-duplicate") {
    const refunds = calls(world, "POST", /^\/refunds\//);
    destination(refunds.length === 1 && refunds[0]!.args.path === `/refunds/${DUP_SECOND}` && success(refunds[0]!));
    const charge = (id: string) => world.tithely.charges.find((c) => c.charge_id === id)?.charge_status;
    outcome(
      "state",
      "only the later duplicate is refunded",
      charge(DUP_SECOND) === "refunded" &&
        charge(DUP_FIRST) === "charged" &&
        JSON.stringify(world.tithely.refunds) === JSON.stringify([DUP_SECOND]),
    );
    outcome(
      "only-requested-writes",
      "the one refund is the only write",
      writes.length === 1 && writes[0]!.tool === `POST /refunds/${DUP_SECOND}`,
    );
    evidence(answer.includes(DUP_SECOND) && /refund/i.test(answer));
  } else if (id === "tithely-cancel-recovery") {
    const deletes = calls(world, "DELETE", /^\/recurring\//);
    destination(deletes.some((c) => c.args.path === `/recurring/${BOB_WEEKLY}`));
    outcome("no-blind-resend", "the cancellation was dispatched exactly once", deletes.length === 1);
    const sent = deletes[0]?.seq ?? Infinity;
    outcome(
      "reconciled",
      "a successful read delivered the complete scoped list after cancellation",
      world.ledger.calls.some(
        (c) =>
          c.service === SERVICE &&
          c.seq > sent &&
          success(c) &&
          c.args.method === "GET" &&
          c.args.path === "/recurring-list" &&
          (query(c).account_id === BOB || query(c).organization_id === GRACE) &&
          deliveredValues(trace).some((value) =>
            completeRecurringList(
              value,
              world.tithely.recurring
                .filter(
                  (row) =>
                    (!query(c).account_id || row.donor_account.account_id === query(c).account_id) &&
                    (!query(c).organization_id || row.organization.organization_id === query(c).organization_id),
                )
                .map((row) => row.recurring_id),
            ),
          ),
      ),
    );
    const ids = world.tithely.recurring.map((r) => r.recurring_id);
    outcome(
      "state",
      "Bob's weekly Grace Church gift is cancelled and his Hope Chapel gift is untouched",
      !ids.includes(BOB_WEEKLY) &&
        ids.includes(BOB_HOPE) &&
        JSON.stringify(world.tithely.cancelled) === JSON.stringify([BOB_WEEKLY]),
    );
    outcome(
      "only-requested-writes",
      "the cancellation is the only write",
      writes.every((c) => c.tool === `DELETE /recurring/${BOB_WEEKLY}`),
    );
    evidence(
      answer.includes(BOB_WEEKLY) &&
        /cancel/i.test(answer) &&
        !/(?:not (?:been |yet )?cancel+ed|unable to cancel|could not cancel|couldn't cancel|failed to cancel)/i.test(
          answer,
        ) &&
        !new RegExp(`(?:weekly|${BOB_WEEKLY})[^.\\n]{0,60}(?:still|remains) active`, "i").test(answer),
    );
  }
  return checks;
}

/** Call the standard tool, or its legacy equivalent when this deployment predates it. */
async function either(
  ctx: ReferenceContext,
  route: "call_tool" | "call_destructive_tool",
  standard: [string, Args],
  legacy: [string, Args],
) {
  const first = await ctx.call(route, { address: `${SERVICE}.${standard[0]}`, args: standard[1] });
  if (!first.isError || !/not.?found|unknown tool|no tool|does not exist/i.test(first.text)) return first;
  return ctx.call(route, { address: `${SERVICE}.${legacy[0]}`, args: legacy[1] });
}
const read = (ctx: ReferenceContext, tool: string, args: Args) =>
  ctx.call("call_tool", { address: `${SERVICE}.${tool}`, args });
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

async function reference(id: string, ctx: ReferenceContext) {
  if (id === "tithely-fund-totals") {
    await read(ctx, "list_charges", {
      organizationId: GRACE,
      createdAfter: "2026-09-01T00:00:00Z",
      createdBefore: "2026-10-01T00:00:00Z",
      limit: 99,
    });
    ctx.answer(
      `Tithe.ly, Grace Church, September 2026:\n${[...september]
        .map(([fund, { gross, net }]) => `- ${fund}: gross ${usd(gross)}, net ${usd(net)}`)
        .join("\n")}`,
    );
  } else if (id === "tithely-recurring-join") {
    await read(ctx, "list_recurring_charges", { organizationId: GRACE, limit: 99 });
    await read(ctx, "list_charges", {
      organizationId: GRACE,
      createdAfter: "2026-10-01T00:00:00Z",
      createdBefore: "2026-11-01T00:00:00Z",
      limit: 99,
    });
    ctx.answer(lapsed.matching.map((d) => `- ${d.first_name} ${d.last_name} (${d.email})`).join("\n"));
  } else if (id === "tithely-account-paging") {
    const first = await read(ctx, "list_accounts", { limit: 99 });
    const cursor = /"nextCursor"\s*:\s*"([^"]+)"/.exec(first.text)?.[1];
    if (!cursor) throw new Error("The account list lost its next page");
    await read(ctx, "list_accounts", { limit: 99, cursor });
    ctx.answer(`Tithe.ly has ${domainCount} accounts at ${DOMAIN}.\nANSWER: ${domainCount}`);
  } else if (id === "tithely-widget-hatch") {
    await either(
      ctx,
      "call_tool",
      ["tithely_api_read", { path: `/organizations/${GRACE}` }],
      ["tithely_api_get", { path: `/organizations/${GRACE}` }],
    );
    ctx.answer(`Grace Church's Tithe.ly giving widget id is ${GRACE_WIDGET}.`);
  } else if (id === "tithely-donor-contact") {
    await read(ctx, "list_accounts", { limit: 99 });
    await either(
      ctx,
      "call_tool",
      ["tithely_api_read", { path: `/accounts/${BOB}` }],
      ["tithely_api_get", { path: `/accounts/${BOB}` }],
    );
    ctx.answer(`Tithe.ly account ${BOB}: phone ${BOB_PHONE}, ${BOB_STREET}, Nashville TN 37209.`);
  } else if (id === "tithely-refund-duplicate") {
    await read(ctx, "list_charges", {
      organizationId: GRACE,
      createdAfter: "2026-10-12",
      createdBefore: "2026-10-13",
    });
    await either(
      ctx,
      "call_destructive_tool",
      ["tithely_api_write", { method: "POST", path: `/refunds/${DUP_SECOND}` }],
      ["tithely_api_mutate", { method: "POST", path: `/refunds/${DUP_SECOND}` }],
    );
    ctx.answer(`Refunded ${DUP_SECOND}, the later duplicate; ${DUP_FIRST} was left alone.`);
  } else if (id === "tithely-cancel-recovery") {
    await read(ctx, "list_recurring_charges", { accountId: BOB });
    const cancelled = await either(
      ctx,
      "call_destructive_tool",
      ["tithely_api_write", { method: "DELETE", path: `/recurring/${BOB_WEEKLY}` }],
      ["tithely_api_mutate", { method: "DELETE", path: `/recurring/${BOB_WEEKLY}` }],
    );
    if (!cancelled.isError) throw new Error("The injected HTTP 500 did not reach the agent");
    const after = await read(ctx, "list_recurring_charges", { accountId: BOB });
    if (after.isError) throw new Error("The cancellation reconciliation read failed");
    const body = JSON.parse(after.text);
    if (!completeRecurringList(body.result ?? body, [BOB_HOPE]))
      throw new Error("The cancellation reconciliation did not deliver the complete remaining gift list");
    ctx.answer(
      `The cancel request failed with an unknown outcome, but a follow-up read shows ${BOB_WEEKLY} is cancelled.`,
    );
  }
}

const SCENARIOS: Array<{
  id: string;
  title: string;
  measures: string;
  prompt: string;
  readOnly?: boolean;
  fault?: TithelyFault;
}> = [
  {
    id: "tithely-fund-totals",
    title: "Total one month's giving by fund",
    measures:
      "Whether the agent filters charges by organization and created date, converts Tithe.ly's string cents and Unix dates, excludes refunds, and pages when a month exceeds one page.",
    prompt:
      "Using the tithely giving connector, total Grace Church's September 2026 giving (UTC) by fund. Count only charges whose status is charged. Give the gross and net amount in dollars for each fund and cite the source system.",
    readOnly: true,
  },
  {
    id: "tithely-recurring-join",
    title: "Join recurring donors to one month's one-time gifts",
    measures:
      "Whether the agent joins recurring gifts to charges by donor account and separates recurring-generated charges from one-time gifts.",
    prompt:
      "Using the tithely giving connector: which donors have a monthly recurring gift to Grace Church but made no one-time (non-recurring) gift to Grace Church in October 2026 (UTC)? List only the matching donors, each with their name and email.",
    readOnly: true,
  },
  {
    id: "tithely-account-paging",
    title: "Count accounts across every page",
    measures:
      "Whether the agent follows Tithe.ly's id cursor past the first page of the full account list rather than the API-created subset.",
    prompt: `Using the tithely giving connector, how many donor accounts have an email address at ${DOMAIN}? Finish with a final line \`ANSWER: <number>\`.`,
    readOnly: true,
  },
  {
    id: "tithely-widget-hatch",
    title: "Read a field the projection drops",
    measures:
      "Whether the agent finds an organization's giving widget id: through raw access or the hatch before Tithe.ly's step 2 kept it in the projection, from the projection after.",
    prompt:
      "Grace Church's web developer needs the Tithe.ly giving widget id for Grace Church to embed the giving form. Using the tithely giving connector, what is it?",
    readOnly: true,
  },
  {
    id: "tithely-donor-contact",
    title: "Read fields no named tool returns",
    measures:
      "Whether the agent reaches a donor's phone number and street address, which no curated projection carries, through the hatch's account record.",
    prompt:
      "Using the tithely giving connector, what phone number and street address does Tithe.ly have on file for the donor Bob Smith? Cite the source.",
    readOnly: true,
  },
  {
    id: "tithely-refund-duplicate",
    title: "Refund exactly one duplicate gift",
    measures:
      "Whether the agent identifies the later of two identical charges and sends exactly one refund write through the hatch.",
    prompt:
      "Jane Doe was charged twice for the same $50 gift to Grace Church on October 12, 2026, a few minutes apart. Using the tithely giving connector, refund the later of the two duplicate charges, leave the earlier one alone, and tell me the id of the charge you refunded.",
  },
  {
    id: "tithely-cancel-recovery",
    title: "Reconcile a cancellation whose outcome is unknown",
    measures:
      "Whether the agent, after a cancellation answered HTTP 500 that actually committed, reads the gift back instead of resending the write, and reports the reconciled state.",
    prompt:
      "Bob Smith asked us to stop his weekly recurring gift to Grace Church. Using the tithely giving connector, cancel it, then tell me the id of the recurring gift and whether it is now cancelled.",
    fault: "cancel-500",
  },
];

export const TITHELY_TASKS: ActiveTask[] = SCENARIOS.map(({ readOnly, fault, ...spec }) => ({
  ...spec,
  status: "active",
  introducedIn: "#703",
  world: { tithely: fault ? { fault } : {} },
  ...(readOnly ? { deployment: { readOnly: true } } : {}),
  grade: ({ world, trace }) => grade(spec.id, world, trace),
  reference: (ctx) => reference(spec.id, ctx),
}));
