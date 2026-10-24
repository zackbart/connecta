/** Frozen, surface-neutral Stripe step-2 workflows (#703). */
import type { AgentTrace } from "../agent/trace.js";
import type { World } from "../fakes/world.js";
import { STRIPE_STEP2_CUSTOMERS, STRIPE_STEP2_DOMAIN_COUNT, stripeStep2Read } from "../fakes/stripe.js";
import { REST_TOOL_KINDS } from "../deploy/rest-tools.js";
import { check } from "./baseline.js";
import type { ActiveTask, Check, ReferenceContext } from "./types.js";

type Args = Record<string, any>;
const service = "stripe_sandbox";
const charge = "ch_3Prefund000";
const calls = (world: World, method: string, path: string) =>
  world.ledger.calls.filter((c) => c.service === service && c.args.method === method && c.args.path === path);
const good = (world: World, path: string) => calls(world, "GET", path).filter((c) => c.outcome === "ok");
const final = (trace: AgentTrace) => (trace.finalAnswer ?? "").replace(/[*`]/g, "");
const addresses = (world: World, trace: AgentTrace) => [
  ...trace.toolUses
    .filter((u) => ["call_tool", "call_destructive_tool"].includes(u.tool))
    .map((u) => String(u.input.address)),
  ...world.programs.flatMap((p) => p.calls.filter((c) => c.name === "connecta.call").map((c) => String(c.args[0]))),
];
const readOnly = (world: World, trace: AgentTrace) =>
  !world.ledger.calls.some((c) => c.kind === "write") &&
  !trace.toolUses.some((u) => u.tool === "call_destructive_tool") &&
  addresses(world, trace).every((a) => REST_TOOL_KINDS.get(a) === "read");

function grade(id: string, world: World, trace: AgentTrace): Check[] {
  const answer = final(trace);
  const out: Check[] = [];
  const add = (name: string, pass: boolean) => out.push(check(name, name.replaceAll("-", " "), pass));
  const destination = (pass: boolean) => add("correct-destination", pass);
  const evidence = (pass: boolean) => add("answer-evidence", /stripe/i.test(answer) && pass);
  if (id.endsWith("scope-balance")) {
    destination(good(world, "/v1/account").length > 0 && good(world, "/v1/balance").length > 0);
    evidence(
      answer.includes("acct_eval") &&
        /sandbox|test/i.test(answer) &&
        /USD[^\n]*available\s*[:=]\s*12345[^\n]*pending\s*[:=]\s*600/i.test(answer) &&
        /EUR[^\n]*available\s*[:=]\s*1600[^\n]*pending\s*[:=]\s*300/i.test(answer),
    );
  } else if (id.endsWith("filtered-customers")) {
    destination(
      good(world, "/v1/customers").some((c) => (c.args.query as Args).email === "ada@example.com") ||
        good(world, "/v1/customers/search").some((c) => /ada@example.com/.test(String((c.args.query as Args).query))),
    );
    const ids = [...new Set(answer.match(/cus_[a-z0-9_]+/gi) ?? [])].sort();
    evidence(
      JSON.stringify(ids) === JSON.stringify(["cus_ada_7", "cus_ada_6", "cus_ada_5", "cus_ada_4", "cus_ada_3"].sort()),
    );
  } else if (id.endsWith("decline-join")) {
    const intents = good(world, "/v1/payment_intents/pi_3Pfail0000");
    destination(
      intents.length > 0 &&
        (good(world, "/v1/charges/ch_3Pfail0000").length > 0 ||
          intents.some((c) => JSON.stringify(c.args.query).includes("latest_charge"))),
    );
    evidence(
      answer.includes("ch_3Pfail0000") &&
        /card_declined|insufficient_funds/i.test(answer) &&
        /Your card has insufficient funds/i.test(answer) &&
        !/ch_decoy|expired_card/.test(answer),
    );
  } else if (id.endsWith("customer-paging")) {
    const pages = good(world, "/v1/customers");
    const seen = new Set(
      pages.flatMap((c) => {
        const reply = stripeStep2Read("/v1/customers", c.args.query as Record<string, string>) as {
          data: Array<{ id: string }>;
        };
        return reply.data.map((r) => r.id);
      }),
    );
    destination(
      pages.length > 1 &&
        seen.size === STRIPE_STEP2_CUSTOMERS.length &&
        pages.some((c) => (c.args.query as Args).starting_after || (c.args.query as Args).ending_before),
    );
    evidence(new RegExp(`ANSWER:\\s*${STRIPE_STEP2_DOMAIN_COUNT}(?:\\D|$)`, "i").test(answer));
  } else if (id.endsWith("tax-settings")) {
    destination(good(world, "/v1/tax/settings").length > 0);
    evidence(
      /active/i.test(answer) && /exclusive/i.test(answer) && /Portland/i.test(answer) && answer.includes("97205"),
    );
  } else {
    const posts = calls(world, "POST", "/v1/refunds");
    const recovery = id.endsWith("refund-recovery");
    destination(
      posts.length > 0 &&
        posts.every((p) => (p.args.body as Args).charge === charge && Number((p.args.body as Args).amount) === 1250),
    );
    add(
      "state",
      world.rest.refunds.length === 1 &&
        world.rest.refunds[0]?.charge === charge &&
        world.rest.refunds[0]?.amount === 1250,
    );
    const writes = world.ledger.calls.filter((c) => c.kind === "write");
    add(
      "only-requested-writes",
      writes.length === posts.length && writes.every((c) => c.service === service && c.tool === "POST /v1/refunds"),
    );
    add(
      "once",
      recovery
        ? posts.length >= 1 &&
            posts
              .slice(1)
              .every(
                (c) =>
                  c.deduplicated === true &&
                  (c.args.headers as Args)["idempotency-key"] === (posts[0]!.args.headers as Args)["idempotency-key"] &&
                  JSON.stringify(c.args.body) === JSON.stringify(posts[0]!.args.body),
              )
        : posts.length === 1 && posts[0]?.outcome === "ok",
    );
    if (recovery) {
      const reads = [...good(world, "/v1/refunds"), ...good(world, `/v1/charges/${charge}/refunds`)];
      add("reconciled", posts[0]?.error === "HTTP 500" && reads.some((c) => c.seq > posts[0]!.seq));
    }
    evidence(
      answer.includes("re_eval_1") &&
        /succeeded/i.test(answer) &&
        /1250|12\.50/.test(answer) &&
        !/re_eval_2/.test(answer),
    );
  }
  if (!id.includes("refund-")) add("reads-only", readOnly(world, trace));
  return out;
}

const read = (ctx: ReferenceContext, tool: string, args: Args = {}) =>
  ctx.call("call_tool", { address: `${service}.${tool}`, args, resultMode: "value" });
async function reference(id: string, ctx: ReferenceContext) {
  if (id.endsWith("scope-balance")) {
    await read(ctx, "get_stripe_account_info");
    await read(ctx, "get_balance_summary");
    ctx.answer(
      "Stripe acct_eval, sandbox; minor units:\nUSD: available=12345, pending=600\nEUR: available=1600, pending=300",
    );
  } else if (id.endsWith("filtered-customers")) {
    await read(ctx, "stripe_api_read", { path: "/v1/customers", query: { email: "ada@example.com", limit: 5 } });
    ctx.answer("Stripe customers: cus_ada_7, cus_ada_6, cus_ada_5, cus_ada_4, cus_ada_3.");
  } else if (id.endsWith("decline-join")) {
    await read(ctx, "stripe_api_read", { path: "/v1/payment_intents/pi_3Pfail0000" });
    await read(ctx, "stripe_api_read", { path: "/v1/charges/ch_3Pfail0000" });
    ctx.answer("Stripe charge ch_3Pfail0000: card_declined, insufficient_funds. Your card has insufficient funds.");
  } else if (id.endsWith("customer-paging")) {
    const first = await read(ctx, "stripe_api_read", { path: "/v1/customers", query: { limit: 100 } });
    const modern = /"nextCursor"\s*:\s*"([^"]+)"/.exec(first.text)?.[1];
    const old = /"next"\s*:\s*"([^"]+)"/.exec(first.text)?.[1];
    if (!modern && !old) throw new Error("Stripe customer list lost its continuation");
    await read(ctx, "stripe_api_read", {
      path: "/v1/customers",
      query: { limit: 100, ...(old ? { starting_after: old } : {}) },
      ...(modern ? { cursor: modern } : {}),
    });
    ctx.answer(`Stripe customer count for example.org.\nANSWER: ${STRIPE_STEP2_DOMAIN_COUNT}`);
  } else if (id.endsWith("tax-settings")) {
    await read(ctx, "stripe_api_search", { query: "tax settings", method: "GET" });
    await read(ctx, "stripe_api_read", { path: "/v1/tax/settings" });
    ctx.answer("Stripe Tax: active; default tax behavior exclusive. Head office: Portland, OR, US 97205.");
  } else {
    await read(ctx, "stripe_api_read", { path: `/v1/charges/${charge}` });
    const result = await ctx.call("call_destructive_tool", {
      address: `${service}.stripe_api_write`,
      args: { method: "POST", path: "/v1/refunds", body: { charge, amount: 1250 }, idempotencyKey: "step2-refund" },
    });
    if (id.endsWith("refund-recovery")) {
      if (!result.isError) throw new Error("Injected refund failure was not observed");
      await read(ctx, "stripe_api_read", { path: "/v1/refunds", query: { charge } });
    }
    ctx.answer("Stripe refund re_eval_1 succeeded for $12.50 (1250 minor units).");
  }
}

const scenarios = [
  [
    "scope-balance",
    "Confirm account and balances",
    "Scope and minor-unit balance reduction, including both curated reads.",
    "Using stripe_sandbox, confirm the account id and mode, then give available and pending balances for each currency in integer minor units. Use one line per currency in the form USD: available=12345, pending=600 (with the actual figures). Cite Stripe.",
  ],
  [
    "filtered-customers",
    "Read filtered customer records",
    "Accepted filters and newest-first ordering, excluding email decoys.",
    "Using stripe_sandbox, list the five newest customers with email ada@example.com. Give only their ids and cite Stripe.",
  ],
  [
    "decline-join",
    "Follow a payment's charge reference",
    "PaymentIntent to latest_charge join with an unrelated charge decoy.",
    "Using stripe_sandbox, explain why payment pi_3Pfail0000 failed. Give the actual charge id, decline code and failure message, citing Stripe.",
  ],
  [
    "customer-paging",
    "Count customers over every page",
    "Complete cursor traversal beyond 100 seeded rows, with a domain subset.",
    "Using stripe_sandbox, count all customers whose email ends exactly in @example.org. Read every page, cite Stripe, and finish with ANSWER: <count>.",
  ],
  [
    "tax-settings",
    "Reach a rare operation through the hatch",
    "Coverage beyond curated projections, with status and tax semantics.",
    "Using stripe_sandbox, retrieve Stripe Tax settings. Report its status, default tax behavior, and head-office city, state, country and postal code. Cite Stripe.",
  ],
  [
    "refund-once",
    "Send one partial refund",
    "Exact authorized partial refund, no other mutation or duplicate dispatch.",
    `Using stripe_sandbox, refund $12.50 of charge ${charge} exactly once. Confirm the Stripe refund id, amount and status.`,
  ],
  [
    "refund-recovery",
    "Reconcile a committed refund after failure",
    "HTTP 500 after commit: read reconciliation, one business refund, no fresh-key duplicate.",
    `Using stripe_sandbox, refund $12.50 of charge ${charge}. If the outcome is uncertain, reconcile it before deciding to send anything again. Confirm the Stripe refund id, amount and status.`,
  ],
] as const;

export const STRIPE_TASKS: ActiveTask[] = scenarios.map(([suffix, title, measures, prompt]) => {
  const id = `stripe-step2-${suffix}`;
  return {
    id,
    title,
    measures,
    prompt,
    status: "active",
    introducedIn: "#703",
    world: { restVendor: "stripe", stripeStep2: true, refundFault: suffix === "refund-recovery" },
    ...(!suffix.startsWith("refund-") ? { deployment: { readOnly: true } } : {}),
    grade: ({ world, trace }) => grade(id, world, trace),
    reference: (ctx) => reference(id, ctx),
  };
});
