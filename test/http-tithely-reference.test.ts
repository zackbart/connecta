// B.4 reference expressibility: the entire live Tithe.ly surface on the
// HTTP kit, without wiring the prototype into the maintained provider.
import { configureGuardedTransport } from "../src/guarded-transport.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachCallClassification } from "../src/call-classification.js";
import { apiConnector } from "../src/connectors/api-connector.js";
import { ConnectorCallError, resendAdviceOf } from "../src/errors.js";
import goldenSpec from "./goldens/tithely/spec.js";
import goldenCatalog from "./goldens/tithely/catalog.json";
import goldenCalls from "./goldens/tithely/calls.json";
import { manifest } from "../src/http/vendor.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import { memoryStorage } from "../src/storage/memory.js";
import { silentLogger } from "./helpers.js";
import type { Connector, ConnectorContext } from "../src/types.js";
import { TITHELY_API_BASE_URLS, tithely } from "../src/providers/tithely/index.js";
import { kitTools, TITHELY_KIT_FACTS, TithelyApi } from "../src/providers/tithely/kit-prototype.js";

interface Stub {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Reject the fetch instead of answering. */
  reject?: unknown;
  /** Stream this many bytes of "x" instead of `text`/`body`. */
  stream?: number;
}

interface Sent {
  method: string;
  url: string;
  headers: [string, string][];
  body: string | undefined;
  redirect: RequestInit["redirect"];
}

let stubs: Stub[] = [];
let sent: Sent[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  configureGuardedTransport({ send: (url, init) => globalThis.fetch(url, init) });
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    sent.push({
      method: init.method ?? "GET",
      url: String(input),
      headers: [...new Headers(init.headers).entries()],
      body: typeof init.body === "string" ? init.body : undefined,
      redirect: init.redirect,
    });
    const next = stubs.shift() ?? {};
    if (next.reject !== undefined) throw next.reject;
    const status = next.status ?? 200;
    if (next.stream !== undefined) {
      const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
      let left = next.stream;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (left <= 0) return controller.close();
          const piece = chunk.subarray(0, Math.min(left, chunk.byteLength));
          left -= piece.byteLength;
          controller.enqueue(piece);
        },
      });
      return new Response(body, { status, ...(next.headers ? { headers: next.headers } : {}) });
    }
    const text = next.text ?? JSON.stringify(next.body ?? { status: "success" });
    return new Response(text, { status, ...(next.headers ? { headers: next.headers } : {}) });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  configureGuardedTransport(undefined);
  globalThis.fetch = realFetch;
});

const KEYS = { publicKey: "pub_abc123", privateKey: "pri_def456" };
const BASIC = `Basic ${btoa(`${KEYS.publicKey}:${KEYS.privateKey}`)}`;

function context(values: Record<string, string> | null = KEYS, signal?: AbortSignal): ConnectorContext {
  return {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    requestScope: {},
    ...(signal ? { signal } : {}),
    credential: {
      get: async (field?: string) => (field ? (values?.[field] ?? null) : null),
      getAll: async () => values,
    },
  };
}

const current = (
  sensitiveFields: "drop" | "return" = "drop",
  defaultPageSize = 25,
  environment: "live" | "test" = "live",
): Connector => tithely("giving", { purpose: "Weekly giving reports", environment, sensitiveFields, defaultPageSize });
// Both drop A.2's sensitive fields by default. Every kit request enters the
// core ledger, so the connector declares it as index.ts does.
const kit = (
  sensitiveFields: "drop" | "return" = "drop",
  defaultPageSize = 25,
  environment: "live" | "test" = "live",
): Connector =>
  tracksEveryRequest(
    apiConnector("giving", { tools: kitTools(TITHELY_API_BASE_URLS[environment], defaultPageSize, sensitiveFields) }),
  );

/** Everything an agent or an operator record could observe about one call. */
function observed(outcome: { value: unknown } | { error: unknown }): unknown {
  if ("value" in outcome) return { value: outcome.value };
  const error = outcome.error;
  if (!(error instanceof ConnectorCallError)) return { thrown: String(error), name: (error as Error)?.name };
  return {
    name: error.name,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
    details: error.details,
    writeOutcome: error.writeOutcome,
    // Advice to send it again, a segment of its own that output composes only where the outcome allows.
    advice: resendAdviceOf(error),
  };
}

async function run(
  connector: Connector,
  tool: string,
  args: Record<string, unknown>,
  responses: Stub[],
  ctx: ConnectorContext,
): Promise<{ result: unknown; sent: Sent[] }> {
  stubs = responses.map((stub) => ({ ...stub }));
  sent = [];
  const outcome = await connector.callTool(tool, args, ctx).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  return { result: observed(outcome), sent };
}

/** Run the same call through both implementations and return both observations. */
async function both(tool: string, args: Record<string, unknown>, responses: Stub[], ctx = () => context()) {
  const before = await run(current(), tool, args, responses, ctx());
  const after = await run(kit(), tool, args, responses, ctx());
  return { before, after };
}

const FULL_CHARGE = {
  charge_status: "charged",
  amount: "2500",
  net_amount: "2397",
  fees: "103",
  currency: "USD",
  giving_type: "Tithe",
  charge_date: "1497638090",
  deposit_date: "pending",
  recurring_transaction: false,
  fees_covered: true,
  organization: {
    organization_id: "org_1",
    name: "Grace Church",
    bank: { account_number_last4: "6789", name: "TEST BANK", currency: "USD" },
    legal: { first_name: "Mike", date_of_birth: "5/23/1985" },
  },
  donor_account: { account_id: "user_jane", email: "jane@example.com", first_name: "Jane", last_name: "Doe" },
  payment_method: { pm_id: "pm_9", last_4_digits: "4242", brand: "Visa", pm_type: "card", account_id: "user_jane" },
};

const ORGANIZATION = {
  ...FULL_CHARGE.organization,
  account_id: "user_owner",
  website: "https://church.example",
  phone_number: "5551231234",
  created_date: "1493928837",
  address: { street_address: "1 Main St", city: "Nashville", state: "TN", postal: "37209", country: "US" },
  giving_types: ["Tithe"],
  giving_types_full: [
    { id: "10", name: "Tithe", status: "1" },
    { id: "11", name: "Missions", status: "2" },
    { id: "12", name: "Building", status: "0" },
  ],
};
const ACCOUNT = {
  ...FULL_CHARGE.donor_account,
  created_date: "1487792831",
  phone_number: "5555551234",
  address: ORGANIZATION.address,
};
const PAYMENT_METHOD = FULL_CHARGE.payment_method;
const RECURRING = {
  recurring_id: "rc_1",
  amount: "1000",
  currency: "USD",
  giving_type: "Missions",
  term: "monthly",
  start_date: "1497632472",
  organization: ORGANIZATION,
  donor_account: ACCOUNT,
  payment_method: PAYMENT_METHOD,
};

const MUTATE = { method: "POST", path: "/charges", form: [{ name: "account_id", value: "user_jane" }] };

const ROWS = [1, 2, 3].map((n) => ({
  charge_id: `ch_${n}`,
  charge_status: "charged",
  amount: "2700",
  net_amount: "2591",
  fees: 109,
  charge_date: "1498665995",
  payment_method: "pm_1",
  organization: "org_1",
  donor_account: "user_1",
}));

describe("Tithe.ly on the provider kit (decision 0010)", () => {
  it("INV-1: preserves all eleven catalog entries byte for byte, including order and legacy hatch names", async () => {
    for (const pageSize of [1, 25, 99]) {
      const before = await current("drop", pageSize).listTools(context());
      const after = await kit("drop", pageSize).listTools(context());
      expect(after).toHaveLength(11);
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
      if (pageSize === 25) expect(JSON.stringify(after)).toBe(JSON.stringify(goldenCatalog.tools));
    }
  });

  const cases: Array<{ name: string; tool: string; args: Record<string, unknown>; responses: Stub[] }> = [
    {
      name: "a charge envelope",
      tool: "get_charge",
      args: { chargeId: "ch_7" },
      responses: [{ body: { status: "success", charge_id: "ch_7", type: "Charge", object: FULL_CHARGE } }],
    },
    { name: "a bare charge", tool: "get_charge", args: { chargeId: "ch 7/../x" }, responses: [{ body: FULL_CHARGE }] },
    {
      name: "a raw charge",
      tool: "get_charge",
      args: { chargeId: "ch_7", raw: true },
      responses: [{ body: { status: "success", object: FULL_CHARGE } }],
    },
    { name: "an empty 200", tool: "get_charge", args: { chargeId: "ch_7" }, responses: [{ text: "" }] },
    {
      name: "a first page with more",
      tool: "list_charges",
      args: { organizationId: "org_1", limit: 2 },
      responses: [{ body: { status: "success", type: "List", data: ROWS } }],
    },
    {
      name: "a last page, ascending, from a cursor, with dates",
      tool: "list_charges",
      args: {
        accountId: "user_1",
        organizationId: "org_1",
        cursor: "ch_2",
        order: "asc",
        createdAfter: "2026-01-01T00:00:00",
        createdBefore: 1798761600,
      },
      responses: [{ body: { status: "success", type: "List", data: ROWS.slice(2) } }],
    },
    {
      name: "raw rows",
      tool: "list_charges",
      args: { organizationId: "org_1", raw: true },
      responses: [{ body: { data: ROWS } }],
    },
    { name: "a list without data", tool: "list_charges", args: { accountId: "u" }, responses: [{ body: {} }] },
    {
      name: "a list whose data is not an array",
      tool: "list_charges",
      args: { accountId: "u" },
      responses: [{ body: { data: { charge_id: "ch_1" } } }],
    },
    {
      name: "a full page whose last row has no id",
      tool: "list_charges",
      args: { accountId: "u", limit: 1 },
      responses: [{ body: { data: [{ amount: "1" }, { amount: "2" }] } }],
    },
    { name: "neither scope", tool: "list_charges", args: {}, responses: [] },
    { name: "a bad date", tool: "list_charges", args: { accountId: "u", createdAfter: "not a date" }, responses: [] },
    {
      name: "a reversed range",
      tool: "list_charges",
      args: { accountId: "u", createdAfter: 2, createdBefore: 1 },
      responses: [],
    },
    { name: "an over-limit page", tool: "list_charges", args: { accountId: "u", limit: 100 }, responses: [] },
    { name: "an unknown argument", tool: "get_charge", args: { chargeId: "c", extra: 1 }, responses: [] },
    {
      name: "401",
      tool: "get_charge",
      args: { chargeId: "ch_1" },
      responses: [{ status: 401, body: { status: "fail", reason: "Bad keys" } }],
    },
    { name: "403", tool: "get_charge", args: { chargeId: "ch_1" }, responses: [{ status: 403, body: {} }] },
    {
      name: "404 text",
      tool: "get_charge",
      args: { chargeId: "ch_1" },
      responses: [{ status: 404, text: "Not Found" }],
    },
    {
      name: "400",
      tool: "list_charges",
      args: { accountId: "u" },
      responses: [{ status: 400, body: { status: "fail", reason: "amount is required" } }],
    },
    {
      name: "409",
      tool: "get_charge",
      args: { chargeId: "ch_1" },
      responses: [{ status: 409, body: { status: "fail", reason: "Busy" } }],
    },
    {
      name: "422",
      tool: "get_charge",
      args: { chargeId: "ch_1" },
      responses: [{ status: 422, body: { message: " m " } }],
    },
    {
      name: "429 with Retry-After",
      tool: "get_charge",
      args: { chargeId: "ch_1" },
      responses: [{ status: 429, body: {}, headers: { "Retry-After": "7" } }],
    },
    {
      name: "503 with Retry-After",
      tool: "list_charges",
      args: { accountId: "u" },
      responses: [{ status: 503, text: "<html>down</html>", headers: { "Retry-After": "3" } }],
    },
    {
      name: "418",
      tool: "get_charge",
      args: { chargeId: "ch_1" },
      responses: [{ status: 418, body: { error: { message: "teapot" } } }],
    },
    {
      name: "an in-band refusal",
      tool: "get_charge",
      args: { chargeId: "ch_1" },
      responses: [{ body: { status: "fail", reason: "There was a problem using that payment method." } }],
    },
    {
      name: "a non-JSON success",
      tool: "get_charge",
      args: { chargeId: "ch_1" },
      responses: [{ text: "<html>login</html>" }],
    },
    {
      name: "a redirect",
      tool: "get_charge",
      args: { chargeId: "ch_1" },
      responses: [{ status: 302, text: "", headers: { Location: "https://elsewhere.example/" } }],
    },
    {
      name: "a declared oversized body",
      tool: "get_charge",
      args: { chargeId: "ch_1" },
      responses: [{ text: "{}", headers: { "Content-Length": String(8 * 1024 * 1024) } }],
    },
    {
      name: "a streamed oversized body",
      tool: "get_charge",
      args: { chargeId: "ch_1" },
      responses: [{ stream: 5 * 1024 * 1024 }],
    },
    {
      name: "a refused connection",
      tool: "get_charge",
      args: { chargeId: "ch_1" },
      responses: [{ reject: Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }) }],
    },
    {
      name: "a reply quoting the credential",
      tool: "get_charge",
      args: { chargeId: "ch_1" },
      responses: [{ status: 400, body: { reason: `header was ${BASIC}` } }],
    },
    {
      // Past 2^53: the catalog and today's handler accept it, so the kit's decoder must too.
      name: "an integer past the safe range",
      tool: "list_charges",
      args: { accountId: "u", createdAfter: 9007199254740992 },
      responses: [{ body: { data: [] } }],
    },
    {
      // 301 code points, 601 UTF-16 units: the catalog and today's handler accept it, so the kit's decoder must too.
      name: "a path of astral characters",
      tool: "tithely_api_mutate",
      args: { method: "POST", path: "/" + "😀".repeat(300) },
      responses: [{ body: { status: "success" } }],
    },
    { name: "a form write", tool: "tithely_api_mutate", args: MUTATE, responses: [{ body: { status: "success" } }] },
    {
      name: "a write with a query and no form",
      tool: "tithely_api_mutate",
      args: { method: "DELETE", path: "/payment-methods/pm_1", query: [{ name: "account_id", value: "user_1" }] },
      responses: [{ text: "" }],
    },
    ...[400, 403, 404, 409, 422].map((code) => ({
      name: `a write answered ${code}`,
      tool: "tithely_api_mutate",
      args: MUTATE,
      responses: [{ status: code, body: { status: "fail", reason: `Golden ${code} failure` } }],
    })),
    {
      name: "a write answered 429",
      tool: "tithely_api_mutate",
      args: MUTATE,
      responses: [{ status: 429, body: {}, headers: { "Retry-After": "2" } }],
    },
    {
      name: "a write refused in-band",
      tool: "tithely_api_mutate",
      args: MUTATE,
      responses: [{ body: { status: "fail", reason: "There was a problem using that payment method." } }],
    },
    {
      // No rejection proves a write unsent (#902 round 8): unknown on both sides.
      name: "a write whose connection was refused",
      tool: "tithely_api_mutate",
      args: MUTATE,
      responses: [{ reject: Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }) }],
    },
    {
      name: "a write path escaping the base",
      tool: "tithely_api_mutate",
      args: { method: "POST", path: "/../v2/charges" },
      responses: [],
    },
  ];

  it("INV-5 INV-6 INV-9: preserves all tools' request and output bytes, raw modes, paging and failures", async () => {
    const fixtureCases = goldenSpec.calls.map((call) => ({
      name: call.label ?? call.tool,
      tool: call.tool,
      args: call.args ?? {},
      responses: Array.isArray(call.replies) ? [...call.replies] : [],
    }));
    expect(new Set(fixtureCases.map(({ tool }) => tool)).size).toBe(11);
    const getters = [
      ["get_organization", "organizationId", "organization_id", ORGANIZATION],
      ["get_account", "accountId", "account_id", ACCOUNT],
      ["get_charge", "chargeId", "charge_id", FULL_CHARGE],
      ["get_recurring_charge", "recurringId", "recurring_id", RECURRING],
    ] as const;
    const lists = [
      ["list_organizations", "organization_id", {}, ORGANIZATION],
      ["list_accounts", "account_id", {}, ACCOUNT],
      ["list_charges", "charge_id", { organizationId: "org_1", accountId: "user_1" }, FULL_CHARGE],
      ["list_recurring_charges", "recurring_id", { organizationId: "org_1", accountId: "user_1" }, RECURRING],
    ] as const;
    const additional: typeof cases = [];
    for (const [tool, arg, id, record] of getters) {
      for (const raw of [false, true]) {
        for (const body of [
          record,
          { [id]: "outer_id", object: record },
          { [id]: "outer_id", data: record },
          { [id]: "outer_id", object: {} },
        ]) {
          additional.push({
            name: `${tool} raw=${raw} envelope=${JSON.stringify(body)}`,
            tool,
            args: { [arg]: "an id/with spaces?", raw },
            responses: [{ body }],
          });
        }
      }
      additional.push({ name: `${tool} empty id`, tool, args: { [arg]: "" }, responses: [] });
    }
    for (const [tool, id, scope, record] of lists) {
      for (const raw of [false, true]) {
        for (const data of [
          [],
          [record],
          [1, 2, 3].map((n) => ({ ...record, [id]: `id_${n}` })),
          [null, {}],
          { unexpected: true },
        ]) {
          additional.push({
            name: `${tool} raw=${raw} data=${JSON.stringify(data)}`,
            tool,
            args: { ...scope, raw, limit: 1, cursor: "last &/id", order: "asc" },
            responses: [{ body: { data } }],
          });
        }
      }
      additional.push({ name: `${tool} absent data`, tool, args: { ...scope }, responses: [{ body: {} }] });
    }
    const echoed = goldenSpec.echo.replies(`${KEYS.publicKey} ${KEYS.privateKey} ${BASIC}`);
    additional.push({
      name: "hatch echoes sent credentials",
      tool: goldenSpec.echo.tool,
      args: goldenSpec.echo.args ?? {},
      responses: Array.isArray(echoed) ? [...echoed] : [],
    });
    additional.push(
      {
        name: "API-created accounts",
        tool: "list_accounts",
        args: { scope: "api", cursor: "user_1", order: "asc" },
        responses: [{ body: { data: [ACCOUNT] } }],
      },
      {
        name: "all accounts explicit",
        tool: "list_accounts",
        args: { scope: "all" },
        responses: [{ body: { data: [ACCOUNT] } }],
      },
      { name: "recurring gifts without a scope", tool: "list_recurring_charges", args: {}, responses: [] },
      {
        name: "organization legacy funds",
        tool: "get_organization",
        args: { organizationId: "org_1" },
        responses: [{ body: { giving_types: ["Tithe", 4, "Missions"] } }],
      },
      {
        name: "organization future fund status",
        tool: "get_organization",
        args: { organizationId: "org_1" },
        responses: [
          {
            body: {
              giving_types_full: [
                { id: 2, status: 9 },
                { name: "Tithe", status: 1 },
              ],
            },
          },
        ],
      },
    );
    for (const data of [undefined, {}, null, [PAYMENT_METHOD]]) {
      for (const raw of [false, true])
        additional.push({
          name: `unpaged payment methods raw=${raw} data=${JSON.stringify(data)}`,
          tool: "list_payment_methods",
          args: { accountId: "user_1", raw },
          responses: [{ body: { data } }],
        });
    }
    const legacy = current();
    const reference = kit();
    for (const scenario of [...fixtureCases, ...cases, ...additional]) {
      const before = await run(legacy, scenario.tool, scenario.args, scenario.responses, context());
      const after = await run(reference, scenario.tool, scenario.args, scenario.responses, context());
      expect(after.sent, scenario.name).toEqual(before.sent);
      expect(after.result, scenario.name).toEqual(before.result);
      expect(JSON.stringify(after), scenario.name).toBe(JSON.stringify(before));
      const golden = goldenCalls.find(({ label }) => label === scenario.name);
      if (golden)
        expect(JSON.stringify(after.result), scenario.name).toBe(JSON.stringify({ value: golden.result.value }));
    }
    // Deployment choices cannot silently change ordering, raw policy or the
    // projected payout currency. Exercise the complete fixture surface again.
    for (const choice of ["drop", "return"] as const) {
      for (const environment of ["live", "test"] as const) {
        const legacy = current(choice, 1, environment);
        const reference = kit(choice, 1, environment);
        for (const scenario of fixtureCases) {
          for (const raw of [false, true]) {
            const args = scenario.tool.startsWith("tithely_") ? scenario.args : { ...scenario.args, raw };
            const before = await run(legacy, scenario.tool, args, scenario.responses, context());
            const after = await run(reference, scenario.tool, args, scenario.responses, context());
            expect(JSON.stringify(after), `${scenario.name} ${choice} ${environment} raw=${raw}`).toBe(
              JSON.stringify(before),
            );
          }
        }
      }
    }
  }, 30_000);

  it("INV-5: refuses missing or swapped keys before any request, in the same words", async () => {
    for (const keys of [null, { publicKey: "pri_x", privateKey: "pub_y" }]) {
      const { before, after } = await both("get_charge", { chargeId: "ch_1" }, [], () => context(keys));
      expect(after.sent).toEqual([]);
      expect(after.result).toEqual(before.result);
    }
  });

  it("INV-5: sends the key pair as HTTP Basic, never follows a redirect, and adds no trace header", async () => {
    const { after } = await both("get_charge", { chargeId: "ch_1" }, [{ body: FULL_CHARGE }]);
    const headers = Object.fromEntries(after.sent[0]!.headers);
    expect(headers["authorization"]).toBe(BASIC);
    expect(after.sent[0]!.redirect).toBe("manual");
    expect(Object.keys(headers).sort()).toEqual(["accept", "authorization"]);
  });

  it("INV-7: a caller's abort ends both implementations, and invocation reads it as the caller's", async () => {
    for (const connector of [current(), kit()]) {
      const reason = new Error("caller left");
      const controller = new AbortController();
      let reached!: () => void;
      const dispatched = new Promise<void>((resolve) => (reached = resolve));
      globalThis.fetch = vi.fn((_input: unknown, init: RequestInit = {}) => {
        reached();
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }) as unknown as typeof fetch;
      const pending = connector.callTool("get_charge", { chargeId: "ch_1" }, context(KEYS, controller.signal));
      await dispatched;
      controller.abort(reason);
      const error = await pending.then(
        () => undefined,
        (caught: unknown) => caught,
      );
      // Both Promise edges preserve the caller's exact reason. A wrapped
      // network failure would lose its identity before invocation sees it.
      expect(controller.signal.aborted).toBe(true);
      expect(error).toBe(reason);
    }
  });

  it("INV-9: a write answered 401 (Q8), a 5xx and a broken connection match the core", async () => {
    // Q8: Tithe.ly documents no check of its keys before acting, so the code
    // and its authorize_connector handoff stay and the outcome is unknown, on
    // index.ts and on the kit alike.
    const { before, after } = await both("tithely_api_mutate", MUTATE, [
      { status: 401, body: { status: "fail", reason: "Bad keys" } },
    ]);
    expect(after.sent).toEqual(before.sent);
    expect(after.result).toEqual(before.result);
    expect(after.result).toEqual({
      name: "ConnectorCallError",
      code: "auth_required",
      message:
        "Tithe.ly: Bad keys Tithe.ly rejected the key pair. It may be revoked, mistyped, or issued for the other environment — test keys work only on tithelydev.com, live keys only on tithe.ly. An operator must fix the keys on this connection. The write was sent before Tithe.ly rejected its credential, so whether it took effect is unknown: check the target before repeating it.",
      retryable: false,
      retryAfterMs: undefined,
      details: undefined,
      writeOutcome: "unknown",
      advice: undefined,
    });
    // Everything else after dispatch is the core's verdict on both sides.
    for (const responses of [
      [{ status: 500, body: { reason: "Boom" } }],
      [{ reject: Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }) }],
    ] satisfies Stub[][]) {
      const { before, after } = await both("tithely_api_mutate", MUTATE, responses);
      expect(after.sent).toHaveLength(1);
      expect(after.result).toEqual(before.result);
      expect(after.result).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
    }
  });

  it("INV-5: drops the sensitive fields from raw reads and hatch replies unless deployment code returns them (A.2)", async () => {
    const reply = { status: "success", object: FULL_CHARGE };
    for (const [tool, args] of [
      ["get_charge", { chargeId: "ch_7", raw: true }],
      ["tithely_api_mutate", MUTATE],
    ] as const) {
      const dropped = await run(kit("drop"), tool, args, [{ body: reply }], context());
      expect(JSON.stringify(dropped.result), tool).not.toMatch(/TEST BANK|5\/23\/1985/);
      expect(JSON.stringify(dropped.result), tool).toContain("Grace Church");
      const returned = await run(kit("return"), tool, args, [{ body: reply }], context());
      expect(JSON.stringify(returned.result), tool).toMatch(/TEST BANK/);
    }
  });

  it("INV-1 INV-9: obeys the classification the deployment serves, not the builder's", async () => {
    // get_charge is built as a read; served as a write, its 5xx is an unknown outcome.
    const asWrite = context();
    attachCallClassification(asWrite, "write");
    const read = await run(kit(), "get_charge", { chargeId: "ch_1" }, [{ status: 503, body: {} }], asWrite);
    expect(read.result).toMatchObject({ code: "connector_call_failed", retryable: false });
    // tithely_api_mutate is built as a write; served as a read, its 5xx stays retryable.
    const asRead = context();
    attachCallClassification(asRead, "read");
    const write = await run(kit(), "tithely_api_mutate", MUTATE, [{ status: 503, body: {} }], asRead);
    expect(write.result).toMatchObject({ code: "unavailable", retryable: true });
  });

  it("INV-7 INV-9: a caller who leaves while a write's 401 is still being read gets its auth code and unknown outcome", async () => {
    const controller = new AbortController();
    let reading!: () => void;
    const reached = new Promise<void>((resolve) => (reading = resolve));
    globalThis.fetch = vi.fn(
      async () =>
        // The status is in; the body is pulled only once read, and never finishes.
        new Response(
          new ReadableStream(
            {
              pull: () => {
                reading();
                return new Promise(() => {});
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 401 },
        ),
    ) as unknown as typeof fetch;
    const pending = kit().callTool("tithely_api_mutate", MUTATE, context(KEYS, controller.signal));
    await reached;
    controller.abort(new Error("caller left"));
    const error = await pending.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "auth_required", retryable: false, writeOutcome: "unknown" });
    expect((error as Error).message).toContain("whether it took effect is unknown");
  });

  it("INV-9: a write's recorded 401 survives declared and streamed oversized bodies", async () => {
    for (const kind of ["declared", "streamed"]) {
      const result = await run(
        kit(),
        "tithely_api_mutate",
        MUTATE,
        [
          {
            status: 401,
            ...(kind === "declared"
              ? { text: "{}", headers: { "Content-Length": String(8 * 1024 * 1024) } }
              : { stream: 5 * 1024 * 1024 }),
          },
        ],
        context(),
      );
      expect(result.sent).toHaveLength(1);
      expect(result.result).toMatchObject({ code: "auth_required", retryable: false, writeOutcome: "unknown" });
      expect((result.result as { message: string }).message).toContain("Tithe.ly rejected the key pair.");
    }
  });

  it("declares decision 0011's ProviderKitFacts from the same vendor and the catalog's page size", async () => {
    // drift.json v2's generated.operations: "METHOD /path", sorted, from manifest(vendor).
    expect(TITHELY_KIT_FACTS.operations).toEqual([
      "GET /accounts-list",
      "GET /accounts-list-all",
      "GET /accounts/{accountId}",
      "GET /charges-list",
      "GET /charges/{chargeId}",
      "GET /organizations-list",
      "GET /organizations/{organizationId}",
      "GET /payment-methods-list",
      "GET /recurring-list",
      "GET /recurring/{recurringId}",
    ]);
    for (const operation of TITHELY_KIT_FACTS.operations) {
      expect(operation).toMatch(/^(GET|HEAD|POST|PUT|PATCH|DELETE) \/\S*$/);
    }
    // The Conventions' page size is the one the catalog advertises.
    const limit = (await kit().listTools(context())).find((tool) => tool.name === "list_charges")!.inputSchema![
      "properties"
    ] as Record<string, { maximum?: number; description?: string }>;
    expect(TITHELY_KIT_FACTS.pageSize).toEqual({ default: 25, max: limit["limit"]!.maximum });
    expect(limit["limit"]!.description).toContain("Defaults to 25.");
    // Step 1 keeps the old hatch names, so no standard hatch is declared yet.
    expect(TITHELY_KIT_FACTS.hatch).toBeUndefined();
  });

  it("derives the endpoint manifest drift checks read from the same declaration", () => {
    const spec = manifest(TithelyApi);
    expect(Object.keys(spec.paths).sort()).toEqual(TITHELY_KIT_FACTS.operations.map((operation) => operation.slice(4)));
    const paging = ["limit", "order_by", "starting_after"];
    for (const [path, names] of [
      ["/organizations-list", paging],
      ["/organizations/{organizationId}", ["organizationId"]],
      ["/accounts-list", paging],
      ["/accounts-list-all", paging],
      ["/accounts/{accountId}", ["accountId"]],
      ["/charges-list", ["organization_id", "account_id", "created_after", "created_before", ...paging]],
      ["/charges/{chargeId}", ["chargeId"]],
      ["/recurring-list", ["organization_id", "account_id", ...paging]],
      ["/recurring/{recurringId}", ["recurringId"]],
      ["/payment-methods-list", ["account_id"]],
    ] as const) {
      expect(
        spec.paths[path]!.get!.parameters.map((parameter: { name: string }) => parameter.name),
        path,
      ).toEqual(names);
    }
  });
});
