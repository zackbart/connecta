import { configureGuardedTransport } from "../../guarded-transport.js";
// Decision 0010's proof on real code: Tithe.ly's get_charge, list_charges, and
// tithely_api_mutate rebuilt on the Effect provider kit must be
// indistinguishable from index.ts — the same catalog bytes, the same requests
// on the wire, and the same mapped results and failures, sent-secret
// redaction included — except where a recorded decision changes them: A.2's
// sensitive fields and decision 0010's 401 rule. Every other write verdict is
// the core's on both sides, decided at api()'s boundary from the same ledger.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachCallClassification } from "../../call-classification.js";
import { apiConnector } from "../../connectors/api-connector.js";
import { ConnectorCallError, resendAdviceOf } from "../../errors.js";
import { manifest } from "../../http/vendor.js";
import { tracksEveryRequest } from "../../provider-call.js";
import { memoryStorage } from "../../storage/memory.js";
import { silentLogger } from "../../../test/helpers.js";
import type { Connector, ConnectorContext } from "../../types.js";
import { TITHELY_API_BASE_URLS, tithely } from "./index.js";
import { kitTools, TITHELY_KIT_FACTS, TithelyApi } from "./kit-prototype.js";

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

const current = (): Connector => tithely("giving", { purpose: "Weekly giving reports", environment: "live" });
// Both drop A.2's sensitive fields by default. Every kit request enters the
// core ledger, so the connector declares it as index.ts does.
const kit = (sensitiveFields: "drop" | "return" = "drop"): Connector =>
  tracksEveryRequest(apiConnector("giving", { tools: kitTools(TITHELY_API_BASE_URLS.live, 25, sensitiveFields) }));

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
  it("INV-1: renders catalog entries identical after #902 privacy descriptions, classification included", async () => {
    const before = await current().listTools(context());
    const after = await kit().listTools(context());
    for (const name of ["list_charges", "get_charge", "tithely_api_mutate"]) {
      const old = structuredClone(before.find((tool) => tool.name === name)!);
      if (name === "tithely_api_mutate") {
        (old.outputSchema!["properties"] as Record<string, { description: string }>)["result"]!.description =
          "Tithe.ly's response body, less the sensitive fields this connection drops, or null when empty.";
      } else {
        (old.inputSchema!["properties"] as Record<string, { description: string }>)["raw"]!.description =
          "Return Tithe.ly's records instead of the lean projection. The guide says whether bank and legal details stay dropped.";
      }
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

  it.each(cases)("INV-6 INV-9: preserves requests and results for $name", async ({ tool, args, responses }) => {
    const { before, after } = await both(tool, args, responses);
    expect(after.sent).toEqual(before.sent);
    expect(after.result).toEqual(before.result);
  });

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

  it.each(["declared", "streamed"])("INV-9: a write's recorded 401 survives a %s oversized body", async (kind) => {
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
  });

  it("declares decision 0011's ProviderKitFacts from the same vendor and the catalog's page size", async () => {
    // drift.json v2's generated.operations: "METHOD /path", sorted, from manifest(vendor).
    expect(TITHELY_KIT_FACTS.operations).toEqual(["GET /charges-list", "GET /charges/{chargeId}"]);
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
