// Decision 0010's proof on real code: Tithe.ly's get_charge and list_charges
// rebuilt on the Effect provider kit must be indistinguishable from index.ts —
// the same catalog bytes, the same requests on the wire, and the same mapped
// results and failures, sent-secret redaction included.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiConnector } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { manifest } from "../../http/vendor.js";
import { memoryStorage } from "../../storage/memory.js";
import { silentLogger } from "../../../test/helpers.js";
import type { Connector, ConnectorContext } from "../../types.js";
import { TITHELY_API_BASE_URLS, tithely } from "./index.js";
import { kitTools, TithelyApi } from "./kit-prototype.js";

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

const current = (): Connector => tithely("giving", { purpose: "Weekly giving reports", environment: "live" });
const kit = (): Connector => apiConnector("giving", { tools: kitTools(TITHELY_API_BASE_URLS.live, 25) });

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
  it("INV-1: renders byte-identical catalog entries, classification included", async () => {
    const before = await current().listTools(context());
    const after = await kit().listTools(context());
    for (const name of ["list_charges", "get_charge"]) {
      const old = before.find((tool) => tool.name === name);
      const now = after.find((tool) => tool.name === name);
      expect(JSON.stringify(now), name).toBe(JSON.stringify(old));
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
  ];

  it.each(cases)(
    "INV-6 INV-9: sends the same requests and maps $name the same way",
    async ({ tool, args, responses }) => {
      const { before, after } = await both(tool, args, responses);
      expect(after.sent).toEqual(before.sent);
      expect(after.result).toEqual(before.result);
    },
  );

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
    const outcomes: unknown[] = [];
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
      // Invocation classifies any failure after its signal aborts as the
      // caller's cancellation, so both are the same outcome on the wire.
      expect(controller.signal.aborted).toBe(true);
      outcomes.push(error === reason ? "reason" : error instanceof ConnectorCallError ? error.cause === reason : error);
    }
    // Today's transport wraps the reason as an `unavailable` cause; the kit
    // rethrows the reason itself, as runEdge does at every other edge.
    expect(outcomes).toEqual([true, "reason"]);
  });

  it("derives the endpoint manifest drift checks read from the same declaration", () => {
    const spec = manifest(TithelyApi);
    expect(Object.keys(spec.paths).sort()).toEqual(["/charges-list", "/charges/{chargeId}"]);
    const list = spec.paths["/charges-list"]!.get!;
    expect(list.parameters.map((parameter: { name: string }) => parameter.name)).toEqual([
      "organization_id",
      "account_id",
      "created_after",
      "created_before",
      "limit",
      "order_by",
      "starting_after",
    ]);
  });
});
