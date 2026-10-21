// Decision 0010's shared case table: the provider kit prototype and today's
// api() core run the same cases, served by the invocation and called
// directly, and must reach the same verdict on every row: the write's outcome
// (`classifyWriteOutcome`), `retryable`, `code`, and whether advice to send
// the call again reaches the agent. The kit records provenance in the core
// ledger and the api() boundary decides, so there is one verdict table: the
// core's (src/write-outcome.ts).
//
// Rows marked Q8 are the one deliberate difference, a write answered 401. The
// kit already reports it unknown, keeping its auth code and handoff, unless
// the vendor declares `authBeforeExecution`. Today's providers still count it
// a served refusal; the separate 401 back-port gives them the kit's verdict,
// and these rows then assert the same verdict on both sides.
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogService } from "../src/catalog-service.js";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { CredentialVault } from "../src/credentials.js";
import { classifyCallError, ConnectorCallError, resendAdviceOf } from "../src/errors.js";
import { guardedClient } from "../src/http/client.js";
import { Refusal, type VendorErrors } from "../src/http/errors.js";
import { resultSafety } from "../src/http/safety.js";
import { Credentials } from "../src/http/services.js";
import { write } from "../src/http/tools.js";
import { connect, get, vendor } from "../src/http/vendor.js";
import { InvocationService, type InvocationOutcome } from "../src/invocation.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import { stripeErrors } from "../src/providers/stripe/kit-prototype.js";
import { stripe } from "../src/providers/stripe/index.js";
import { TITHELY_API_BASE_URLS, tithely } from "../src/providers/tithely/index.js";
import { kitTools } from "../src/providers/tithely/kit-prototype.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { classifyWriteOutcome } from "../src/write-outcome.js";
import { silentLogger } from "./helpers.js";

const BASE = "https://connecta.example";
const SEAL_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- The two sides of each family ------------------------------------------------

interface Family {
  /** Today's api() core. */
  readonly core: () => Connector;
  /** The same tool names on the kit prototype, inside a tracked api() boundary. */
  readonly kit: () => Connector;
  readonly credential?: Record<string, string>;
}

const tithelyCore = () => tithely("giving", { purpose: "Weekly giving reports", environment: "live" });

/** Stripe's failure mapper on the kit (stripeErrors), sending one form write as the REST hatch does. */
function stripeKit(): Connector {
  const keyed = connect(
    vendor("Stripe", get("getCustomer", "/v1/customers/:id", { params: { id: Schema.String } })),
    guardedClient({
      provider: "Stripe",
      baseUrl: "https://api.stripe.com",
      maxResponseBytes: 1024 * 1024,
      authenticate: Credentials.use((credentials) => credentials.values).pipe(
        Effect.map((values) => ({ Authorization: `Bearer ${values?.["value"]}` })),
        Effect.mapError((error) => new Refusal({ error })),
      ),
    }),
    {
      errors: stripeErrors,
      safety: resultSafety({
        review: "A case-table write whose replies carry no secret.",
        sensitiveFields: { names: [], choice: "drop" },
      }),
    },
  );
  const core = stripe("billing", { purpose: "Billing", auth: { type: "apiKey" }, mode: "sandbox" });
  return tracksEveryRequest(
    api("billing", {
      title: "Stripe",
      ...(core.credential ? { credential: core.credential } : {}),
      tools: [
        write(keyed, {
          name: "stripe_api_write",
          description: "Send one Stripe write.",
          destructive: true,
          input: Schema.Struct({
            method: Schema.Literals(["POST", "DELETE"]),
            path: Schema.String,
            body: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
            idempotencyKey: Schema.optionalKey(Schema.String),
          }),
          output: Schema.Unknown,
          idempotency: { header: "Idempotency-Key", key: (args) => args.idempotencyKey },
          run: (args) =>
            keyed
              .sendPath({ method: args.method, path: args.path, template: args.path, form: args.body ?? {} })
              .pipe(Effect.map(({ data }) => data)),
        }),
      ],
    }),
  );
}

// "Acme": one tool that writes twice, hand-written on the guarded transport
// today and declared as two write steps on the kit.
const ACME_BASE = "https://api.acme.example";
function acmeFailure(status: number): ConnectorCallError {
  const message = `Acme returned HTTP ${status}.`;
  if (status === 400 || status === 422) return new ConnectorCallError("invalid_args", message);
  if (status === 401) return new ConnectorCallError("auth_required", message);
  if (status === 403) return new ConnectorCallError("provider_permission_denied", message, { retryable: false });
  if (status === 404) return new ConnectorCallError("not_found", message);
  if (status === 429) return new ConnectorCallError("rate_limited", message);
  if (status >= 500) return new ConnectorCallError("unavailable", message);
  return new ConnectorCallError("connector_call_failed", message, { retryable: false });
}
const ACME_ERRORS: VendorErrors = {
  provider: "Acme",
  facts: () => ({}),
  detail: ({ status }) => `Acme returned HTTP ${status}.`,
  unreadable: "Acme returned a successful response that is not JSON.",
  statuses: {
    401: () => ({ code: "auth_required" }),
    403: () => ({ code: "provider_permission_denied", retryable: false }),
    404: () => ({ code: "not_found" }),
  },
};

function acmeCore(): Connector {
  const send = guardedFetch({ provider: "Acme", baseUrl: ACME_BASE, authenticate: () => ({}), maxResponseBytes: 4096 });
  const post = (path: string, ctx: Parameters<typeof send>[1]) =>
    send({ method: "POST", path }, ctx, async (response) => {
      const parsed = await response.jsonResult();
      if (!response.ok) throw acmeFailure(response.status);
      return "value" in parsed ? parsed.value : undefined;
    });
  return tracksEveryRequest(
    api("acme", {
      title: "Acme",
      tools: [
        {
          name: "sync_items",
          description: "Create an item and its child.",
          annotations: { readOnlyHint: false },
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          handler: async (_args, ctx) => ({ first: await post("/items", ctx), second: await post("/items/2", ctx) }),
        },
      ],
    }),
  );
}

function acmeKit(): Connector {
  const connection = connect(
    vendor("Acme", get("getItem", "/items/:id", { params: { id: Schema.String } })),
    guardedClient({
      provider: "Acme",
      baseUrl: ACME_BASE,
      maxResponseBytes: 4096,
      authenticate: Effect.succeed({}),
    }),
    {
      errors: ACME_ERRORS,
      safety: resultSafety({
        review: "A test vendor that returns no secrets.",
        sensitiveFields: { names: [], choice: "drop" },
      }),
    },
  );
  const step = (path: string, name: string) =>
    connection.sendPath({ method: "POST", path, template: path }, { step: name }).pipe(Effect.map(({ data }) => data));
  return tracksEveryRequest(
    api("acme", {
      title: "Acme",
      tools: [
        write(connection, {
          name: "sync_items",
          description: "Create an item and its child.",
          destructive: false,
          writeSteps: { first: "once", second: "once" },
          input: Schema.Struct({}),
          output: Schema.Unknown,
          run: () =>
            Effect.gen(function* () {
              return { first: yield* step("/items", "first"), second: yield* step("/items/2", "second") };
            }),
        }),
      ],
    }),
  );
}

const FAMILIES = {
  tithely: {
    core: tithelyCore,
    kit: () => {
      const core = tithelyCore();
      return tracksEveryRequest(
        api("giving", {
          title: "Tithe.ly Giving",
          ...(core.credential ? { credential: core.credential } : {}),
          tools: kitTools(TITHELY_API_BASE_URLS.live, 25, "drop"),
        }),
      );
    },
    credential: { publicKey: "pub_case_table", privateKey: "pri_case_table" },
  },
  stripe: {
    core: () => stripe("billing", { purpose: "Billing", auth: { type: "apiKey" }, mode: "sandbox" }),
    kit: stripeKit,
    credential: { value: "sk_test_caseTable0123456789" },
  },
  acme: { core: acmeCore, kit: acmeKit },
} satisfies Record<string, Family>;

// --- The fake network --------------------------------------------------------------

type Reply =
  | {
      readonly status?: number;
      readonly body?: unknown;
      readonly text?: string;
      readonly headers?: Record<string, string>;
    }
  | "network"
  | "timeout"
  | "hang";

function network(replies: readonly Reply[]): { sent: string[]; reached: Promise<void> } {
  const queue = [...replies];
  const sent: string[] = [];
  let reached!: () => void;
  const seen = new Promise<void>((resolve) => (reached = resolve));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const key = new Headers(init.headers).get("idempotency-key");
      sent.push(`${init.method ?? "GET"} ${new URL(String(input)).pathname}${key === null ? "" : ` key=${key}`}`);
      const reply = queue.shift() ?? {};
      reached();
      if (reply === "network")
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        });
      if (reply === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (reply === "hang")
        return new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
        );
      const text = reply.text ?? JSON.stringify(reply.body ?? {});
      return new Response(text, {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json", ...reply.headers },
      });
    }),
  );
  return { sent, reached: seen };
}

async function registryFor(connector: Connector, credential?: Record<string, string>): Promise<Registry> {
  const storage = memoryStorage();
  const credentialVault = new CredentialVault(storage, SEAL_KEY);
  if (credential) await credentialVault.setAll(connector.id, credential, "case-table");
  return new Registry([connector], { storage, logger: silentLogger, credentialVault });
}

// --- One row, one side ---------------------------------------------------------------

/** What the agent and a program's accounting see, reduced to the verdict. */
interface Verdict {
  /** `classifyWriteOutcome` for a write; for a read, whether the error says its outcome is unknown. */
  readonly outcome: string;
  readonly code: string | undefined;
  readonly retryable: boolean | undefined;
  /** The connector's advice to send the call again reached the agent's message. */
  readonly advice: boolean;
  /** The invocation's own retry guidance (`retry`) and reconciliation facts (`uncertainCall`). */
  readonly retry?: boolean;
  readonly recovery?: boolean;
}

interface Row {
  readonly name: string;
  readonly family: keyof typeof FAMILIES;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly write: boolean;
  readonly replies: readonly Reply[];
  /** The served verdict both sides reach (for a Q8 row, the kit's and the 401 back-port's). */
  readonly served: Pick<Verdict, "outcome" | "code" | "retryable" | "advice">;
  /** The direct verdict, where it differs from the served one. */
  readonly direct?: Pick<Verdict, "outcome" | "code" | "retryable" | "advice">;
  /** Q8: today's core verdict until the 401 back-port lands. */
  readonly q8?: { readonly served: Pick<Verdict, "outcome" | "code" | "retryable"> };
  /** The served failure carries the call's reconciliation facts (`uncertainCall`). */
  readonly recovery?: true;
  /** Direct only: the caller's own signal aborts while the request is in flight. */
  readonly abort?: true;
  /** No credential is stored. */
  readonly uncredentialed?: true;
}

async function direct(row: Row, connector: Connector): Promise<{ verdict: Verdict; advice?: string; sent: string[] }> {
  const family: Family = FAMILIES[row.family];
  const registry = await registryFor(connector, row.uncredentialed ? undefined : family.credential);
  const { sent, reached } = network(row.replies);
  const controller = new AbortController();
  const ctx = { ...registry.contextFor(connector.id, BASE), ...(row.abort ? { signal: controller.signal } : {}) };
  const pending = connector.callTool(row.tool, row.args, ctx).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (row.abort) {
    await reached;
    controller.abort(new Error("caller left"));
  }
  const error = await pending;
  registry.closeCallAdmission();
  if (error === undefined) {
    return { verdict: { outcome: "ok", code: undefined, retryable: undefined, advice: false }, sent };
  }
  const advice = resendAdviceOf(error);
  const details = classifyCallError(error);
  return {
    verdict: {
      outcome: row.write
        ? classifyWriteOutcome({ ok: false, dispatched: true, error: error as never })
        : (details.writeOutcome ?? "-"),
      code: details.code,
      retryable: details.retryable,
      advice: advice !== undefined && details.message.includes(advice),
    },
    ...(advice === undefined ? {} : { advice }),
    sent,
  };
}

async function served(row: Row, connector: Connector, advice: string | undefined): Promise<Verdict> {
  const family: Family = FAMILIES[row.family];
  const registry = await registryFor(connector, row.uncredentialed ? undefined : family.credential);
  network(row.replies);
  const outcome: InvocationOutcome<unknown> = await new InvocationService(
    registry,
    new CatalogService(registry, BASE),
  ).invoke(`${connector.id}.${row.tool}`, row.args, {
    source: row.write ? "call_destructive_tool" : "call_tool",
    readOnly: false,
  });
  registry.closeCallAdmission();
  if (outcome.ok) return { outcome: "ok", code: undefined, retryable: undefined, advice: false };
  return {
    outcome: row.write ? classifyWriteOutcome(outcome) : (outcome.error.writeOutcome ?? "-"),
    code: outcome.error.code,
    retryable: outcome.error.retryable,
    advice: advice !== undefined && outcome.error.message.includes(advice),
    retry: outcome.error.retry !== undefined,
    recovery: outcome.error.uncertainCall !== undefined,
  };
}

// --- The table -------------------------------------------------------------------

const MUTATE = { method: "POST", path: "/charges", form: [{ name: "account_id", value: "user_jane" }] };
const fail = (status: number, extra: Record<string, unknown> = {}): Reply => ({
  status,
  body: { status: "fail", reason: `Case ${status} failure` },
  ...extra,
});
const known = (code: string, retryable: boolean, advice = false) => ({ outcome: "failed", code, retryable, advice });
const unknown = (code: string) => ({ outcome: "unknown", code, retryable: false, advice: false });
const tithelyWrite = (name: string, replies: Reply[], verdict: Row["served"], extra: Partial<Row> = {}): Row => ({
  name: `Tithe.ly write: ${name}`,
  family: "tithely",
  tool: "tithely_api_mutate",
  args: MUTATE,
  write: true,
  replies,
  served: verdict,
  ...extra,
});
const tithelyRead = (name: string, replies: Reply[], verdict: Row["served"]): Row => ({
  name: `Tithe.ly read: ${name}`,
  family: "tithely",
  tool: "get_charge",
  args: { chargeId: "ch_1" },
  write: false,
  replies,
  served: verdict,
});
const read = (code: string, retryable: boolean, advice = false) => ({ outcome: "-", code, retryable, advice });

const ROWS: readonly Row[] = [
  // A served 2xx whose reply then fails a check: the write may have applied.
  tithelyWrite("2xx, then a body that is not JSON", [{ text: "<html>ok</html>" }], unknown("connector_call_failed")),
  // Tithe.ly's in-band refusal carries advice to read the reason and retry; an unknown write never shows it.
  tithelyWrite(
    "2xx, then an in-band refusal",
    [{ body: { status: "fail", reason: "Card declined." } }],
    unknown("connector_call_failed"),
  ),
  // A served 4xx other than 408 on the call's one request: provenance (b).
  tithelyWrite("400", [fail(400)], known("invalid_args", false)),
  tithelyWrite("401 (Q8)", [fail(401)], unknown("auth_required"), {
    // Today's core on main: a served refusal. The 401 back-port makes it the kit's verdict.
    q8: { served: { outcome: "failed", code: "auth_required", retryable: false } },
  }),
  tithelyWrite("403", [fail(403)], known("provider_permission_denied", false)),
  // Tithe.ly cannot tell absence from reach, so its code is connector_call_failed; the refusal is the status's.
  tithelyWrite("404", [fail(404)], known("connector_call_failed", false)),
  // A 408 is a timeout, never refusal provenance.
  tithelyWrite("408", [fail(408)], unknown("connector_call_failed")),
  tithelyWrite("409", [fail(409)], known("connector_call_failed", false)),
  tithelyWrite("422", [fail(422)], known("invalid_args", false)),
  tithelyWrite("429", [fail(429, { headers: { "Retry-After": "2" } })], known("rate_limited", true, true)),
  // A 5xx never proves a write unapplied.
  tithelyWrite("500", [fail(500)], unknown("connector_call_failed")),
  tithelyWrite("503", [fail(503)], unknown("connector_call_failed")),
  // No rejection proves a write unsent: one fetch can hide several attempts.
  tithelyWrite("network error", ["network"], unknown("connector_call_failed")),
  // A request whose own deadline fired after it left. Served, the invocation
  // promotes it to write_outcome_unknown; called directly, the core keeps the
  // transport's code as a diagnostic.
  tithelyWrite("timeout", ["timeout"], unknown("write_outcome_unknown"), {
    direct: unknown("unavailable"),
  }),
  tithelyWrite("caller abort", ["hang"], unknown("connector_call_failed"), { abort: true }),
  // Refused before anything left: provenance (a).
  tithelyWrite("path escaping the base, refused before dispatch", [], known("invalid_args", false), {
    args: { method: "POST", path: "/../v2/charges" },
  }),
  tithelyWrite("no stored keys, refused before dispatch", [], known("auth_required", false), {
    uncredentialed: true,
  }),

  // Reads keep the vendor's verdict and its advice; nothing is unknown.
  tithelyRead("2xx, then a body that is not JSON", [{ text: "<html>ok</html>" }], read("connector_call_failed", false)),
  tithelyRead("400", [fail(400)], read("invalid_args", false)),
  tithelyRead("401", [fail(401)], read("auth_required", false)),
  tithelyRead("404", [fail(404)], read("connector_call_failed", false)),
  tithelyRead("408", [fail(408)], read("connector_call_failed", false)),
  tithelyRead("409", [fail(409)], read("connector_call_failed", false)),
  tithelyRead("429", [fail(429, { headers: { "Retry-After": "2" } })], read("rate_limited", true, true)),
  tithelyRead("500", [fail(500)], read("unavailable", true)),
  tithelyRead("network error", ["network"], read("unavailable", true)),
  tithelyRead("timeout", ["timeout"], read("unavailable", true)),

  // Stripe answers 424 when an external dependency failed; its mapper reads it
  // as unavailable, which the core takes as no refusal.
  {
    name: "Stripe write: 424 mapped to unavailable",
    family: "stripe",
    tool: "stripe_api_write",
    args: { method: "DELETE", path: "/v1/customers/cus_1" },
    write: true,
    replies: [{ status: 424, body: { error: { type: "api_error", message: "Dependency failed." } } }],
    served: unknown("connector_call_failed"),
  },
  // Stripe's lock timeout: a served 429 on the one request, so a refusal with its wait and advice.
  {
    name: "Stripe write: 429 lock_timeout",
    family: "stripe",
    tool: "stripe_api_write",
    args: { method: "DELETE", path: "/v1/customers/cus_1" },
    write: true,
    replies: [{ status: 429, body: { error: { type: "invalid_request_error", code: "lock_timeout" } } }],
    served: known("conflict", true, true),
  },
  // A genuine key the vendor receives protects the whole logical call: a direct
  // caller may repeat it; a served write is reconciled, never retried.
  {
    name: "Stripe write: keyed single write answered 500",
    family: "stripe",
    tool: "stripe_api_write",
    args: { method: "POST", path: "/v1/customers", body: { email: "bob@example.com" }, idempotencyKey: "case-key-1" },
    write: true,
    replies: [{ status: 500, body: { error: { type: "api_error", message: "Boom." } } }],
    served: unknown("connector_call_failed"),
    direct: { outcome: "unknown", code: "unavailable", retryable: true, advice: false },
    recovery: true,
  },

  // A composite: a served refusal speaks only for a call that sent one request.
  {
    name: "Composite write: second step refused after the first was accepted",
    family: "acme",
    tool: "sync_items",
    args: {},
    write: true,
    replies: [{ status: 201, body: { id: 1 } }, { status: 400 }],
    served: unknown("invalid_args"),
  },
  {
    name: "Composite write: first step refused, nothing else sent",
    family: "acme",
    tool: "sync_items",
    args: {},
    write: true,
    replies: [{ status: 400 }],
    served: known("invalid_args", false),
  },
  {
    name: "Composite write: second step answered 500",
    family: "acme",
    tool: "sync_items",
    args: {},
    write: true,
    replies: [{ status: 201, body: { id: 1 } }, { status: 500 }],
    served: unknown("connector_call_failed"),
  },
  {
    name: "Composite write: both steps accepted",
    family: "acme",
    tool: "sync_items",
    args: {},
    write: true,
    replies: [
      { status: 201, body: { id: 1 } },
      { status: 201, body: { id: 2 } },
    ],
    served: { outcome: "ok", code: undefined, retryable: undefined, advice: false },
  },
];

describe("the kit and today's api() core reach one verdict (decision 0010)", () => {
  it.each(ROWS.map((row) => [row.name, row] as const))(
    "INV-9: %s",
    async (_name, row) => {
      const family: Family = FAMILIES[row.family];
      const sides = { core: family.core(), kit: family.kit() };
      const seen = {} as Record<keyof typeof sides, { direct: Verdict; served?: Verdict; sent: string[] }>;
      for (const [side, connector] of Object.entries(sides) as Array<[keyof typeof sides, Connector]>) {
        const call = await direct(row, connector);
        // A served call's cancellation is the invocation's own, the same for any connector.
        seen[side] = {
          direct: call.verdict,
          ...(row.abort ? {} : { served: await served(row, connector, call.advice) }),
          sent: call.sent,
        };
      }
      // The same requests leave on both sides.
      expect(seen.kit.sent, "requests").toEqual(seen.core.sent);
      if (row.q8) {
        // Q8: the kit's verdict is the 401 back-port's; today's core still reports a refusal.
        expect(seen.kit.served).toMatchObject(row.served);
        expect(seen.core.served).toMatchObject(row.q8.served);
        expect(seen.kit.direct).toMatchObject(row.served);
        return;
      }
      expect(seen.kit.direct, "direct").toEqual(seen.core.direct);
      expect(seen.kit.served, "served").toEqual(seen.core.served);
      expect(seen.kit.direct).toMatchObject(row.direct ?? row.served);
      if (!row.abort) expect(seen.kit.served).toMatchObject(row.served);
      if (row.recovery) {
        expect(seen.kit.served?.recovery).toBe(true);
        expect(seen.kit.sent).toEqual(["POST /v1/customers key=case-key-1"]);
      }
    },
    30_000,
  );
});
