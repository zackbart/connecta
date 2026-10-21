// A write answered HTTP 401 is an unknown outcome by default: a server may act
// on a request before it rejects the credential. It keeps its authorization
// code and handoff, is never retryable, and is a refusal only where the
// transport declares reviewed vendor evidence that the vendor authenticates
// first (`authBeforeExecution`). Decided once, in `src/write-outcome.ts`, from
// the status the ledger recorded, before any key or untracked exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { CredentialVault } from "../src/credentials.js";
import { classifyCallError, ConnectorCallError, resendAdvice, type CallErrorDetails } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { renewedAfterUnauthorized, tracksEveryRequest } from "../src/provider-call.js";
import { stripe } from "../src/providers/stripe/index.js";
import { tithely } from "../src/providers/tithely/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { classifyWriteOutcome } from "../src/write-outcome.js";
import { scriptedExecutor } from "./fixtures/misc.js";
import { makeRegistry, required, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const SENTENCE =
  "The write was sent before Tickets rejected its credential, so whether it took effect is unknown: check the target before repeating it.";
const RECONCILE = "re-read the target of the write that failed to check whether it took effect before any fresh call";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Evidence = Parameters<typeof guardedFetch>[0]["authBeforeExecution"];

/** A guarded credential connector whose vendor answers each path with its status. */
function tickets(statuses: Record<string, number>, authBeforeExecution?: Evidence) {
  const sent: string[] = [];
  const send = guardedFetch({
    provider: "Tickets",
    baseUrl: "https://tickets.example",
    authenticate: () => ({ Authorization: "Bearer fixture-secret" }),
    maxResponseBytes: 1024,
    ...(authBeforeExecution ? { authBeforeExecution } : {}),
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      sent.push(`${init.method} ${path}`);
      const status = statuses[path] ?? 200;
      return Response.json(status === 401 ? { error: "invalid_token" } : { id: "t-1" }, {
        status,
        headers: status === 401 ? { "retry-after": "30", "www-authenticate": "Bearer" } : {},
      });
    },
  });
  const mapped =
    <T>(path: string, method: "GET" | "POST") =>
    (_: unknown, ctx: Parameters<typeof send>[1]) =>
      send({ method, path, body: method === "POST" ? { title: "Fixture" } : undefined }, ctx, async (response) => {
        if (response.status === 401)
          throw new ConnectorCallError("auth_required", "Tickets rejected the configured token.", {
            retryAfterMs: 30_000,
          });
        return (await response.json()) as T;
      });
  const connector = tracksEveryRequest(
    api("tickets", {
      credential: { label: "Tickets token" },
      tools: [
        {
          name: "create",
          description: "Create a ticket",
          annotations: { readOnlyHint: false },
          handler: mapped("/tickets", "POST"),
        },
        {
          name: "create_twice",
          description: "Create a ticket, then its follow-up",
          annotations: { readOnlyHint: false },
          handler: async (args, ctx) => {
            await mapped("/tickets", "POST")(args, ctx);
            return mapped("/follow-ups", "POST")(args, ctx);
          },
        },
        {
          name: "get",
          description: "Read a ticket",
          annotations: { readOnlyHint: true },
          handler: mapped("/tickets/t-1", "GET"),
        },
      ],
    }),
  );
  return { connector, sent, send };
}

/** A registry holding `connector`'s fixture credential. */
async function registryFor(connector: Connector, values: Record<string, string> = { value: "fixture-secret" }) {
  const storage = memoryStorage();
  const vault = new CredentialVault(storage, btoa("k".repeat(32)));
  await vault.setAll(connector.id, values, "fixture");
  return makeRegistry([connector], { storage, credentialVault: vault });
}

async function call(
  connector: Connector,
  tool: string,
  write: boolean,
  args: Record<string, unknown> = {},
  values?: Record<string, string>,
) {
  const meta = createMetaTools(await registryFor(connector, values), BASE, {
    credentialHandoffUrl: `${BASE}/connections`,
  });
  const result = await (write ? meta.callDestructiveTool : meta.callTool)({
    address: `${connector.id}.${tool}`,
    args,
  });
  return (result.structuredContent as { error: CallErrorDetails }).error;
}

/** A direct caller's view of a failed call: no invocation, so `classifyCallError` composes advice. */
async function callDirect(
  connector: Connector,
  tool: string,
  args: Record<string, unknown>,
  values: Record<string, string>,
) {
  const registry = await registryFor(connector, values);
  const failure = await connector
    .callTool(tool, args, registry.contextFor(connector.id, BASE))
    .catch((e: unknown) => e);
  return classifyCallError(failure);
}

/** A 401 verdict asking for a wait and a resend, as a careless mapper might. */
const retryingRefusal = (): never => {
  throw resendAdvice(
    new ConnectorCallError("auth_required", "Tickets rejected the configured token.", {
      retryable: true,
      retryAfterMs: 30_000,
    }),
    " Retry the write.",
  );
};

/**
 * A Tickets write answered 401 inside a larger handler: after an accepted
 * write (`composite`), before a failure of the handler's own (`later`), or
 * after a renewal the handler reports (`renewed`, a read replayed with the
 * new token and then a write the vendor fails). `tracked: false` is a
 * handler the ledger cannot vouch for.
 */
function ticketsAround(kind: "sole" | "composite" | "later" | "renewed", tracked = true) {
  const sent: string[] = [];
  const send = guardedFetch({
    provider: "Tickets",
    baseUrl: "https://tickets.example",
    authenticate: () => ({ Authorization: "Bearer fixture-secret" }),
    maxResponseBytes: 1024,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      sent.push(`${init.method} ${path}`);
      if (path === "/accepted") return Response.json({ id: "t-1" });
      if (path === "/failing") return new Response(null, { status: 503 });
      if (kind === "renewed" && sent.length > 1) return Response.json({ id: "t-1" });
      return new Response(null, { status: 401 });
    },
  });
  const connector = api("tickets", {
    credential: { label: "Tickets token" },
    tools: [
      {
        name: "create",
        description: "Create a ticket",
        annotations: { readOnlyHint: false },
        handler: async (_args, ctx) => {
          if (kind === "renewed") {
            const rejected = await send({ method: "GET", path: "/tickets/t-1" }, ctx, (response) => response.status);
            if (rejected === 401) renewedAfterUnauthorized(ctx);
            await send({ method: "GET", path: "/tickets/t-1" }, ctx, (response) => response.json());
            return send({ method: "POST", path: "/failing" }, ctx, () => {
              throw new ConnectorCallError("unavailable", "Tickets is unavailable.", { retryAfterMs: 30_000 });
            });
          }
          if (kind === "composite") await send({ method: "POST", path: "/accepted" }, ctx, (r) => r.json());
          const write = send({ method: "POST", path: "/tickets" }, ctx, retryingRefusal);
          if (kind !== "later") return write;
          await write.catch(() => undefined);
          throw new ConnectorCallError("unavailable", "An auxiliary request failed.");
        },
      },
    ],
  });
  return { connector: tracked ? tracksEveryRequest(connector) : connector, sent };
}

const declared = (matches: Exclude<Evidence, undefined>["matches"]): Evidence => ({
  evidence: "https://tickets.example/docs/auth: requests are authenticated before any processing begins.",
  matches,
});

describe("a write answered 401", () => {
  it("INV-9: keeps its auth code and outcome-aware handoff, with an unknown outcome and no retry or wait", async () => {
    const { connector, sent } = tickets({ "/tickets": 401 });
    const error = await call(connector, "create", true);
    expect(error).toMatchObject({
      code: "auth_required",
      retryable: false,
      writeOutcome: "unknown",
      reconciliationRequired: true,
      recovery: "operator_config",
      nextAction: { tool: "authorize_connector", arguments: { connector: "tickets" } },
      message: `Tickets rejected the configured token. ${SENTENCE}`,
    });
    expect(error).not.toHaveProperty("retryAfterMs");
    expect(error.retry).not.toMatch(/^Retry /);
    expect(error.instructions).toContain(RECONCILE);
    expect(error.instructions).not.toContain("retry the original call");
    expect(classifyWriteOutcome({ ok: false, dispatched: true, answered: false, error })).toBe("unknown");
    expect(sent).toEqual(["POST /tickets"]);
  });

  it("INV-9: a read answered 401 is unchanged: a known refusal whose handoff says to retry", async () => {
    const { connector, sent } = tickets({ "/tickets/t-1": 401 });
    const error = await call(connector, "get", false);
    expect(error).toMatchObject({
      code: "auth_required",
      retryable: false,
      message: "Tickets rejected the configured token.",
      retry: "Retry tickets.get after the operator completes recovery.",
    });
    expect(error).not.toHaveProperty("writeOutcome");
    expect(error).not.toHaveProperty("reconciliationRequired");
    expect(error.instructions).toContain("retry the original call");
    expect(sent).toEqual(["GET /tickets/t-1"]);
  });

  it.each([
    ["a matching predicate", declared(({ headers }) => headers.get("www-authenticate") === "Bearer"), "failed"],
    ["a predicate that does not match", declared(({ method }) => method === "GET"), "unknown"],
    [
      "a predicate that throws",
      declared(() => {
        throw new Error("predicate bug");
      }),
      "unknown",
    ],
  ] as const)("INV-9: reviewed authBeforeExecution evidence with %s", async (_name, evidence, state) => {
    const { connector, sent } = tickets({ "/tickets": 401 }, evidence);
    const error = await call(connector, "create", true);
    expect(error).toMatchObject({ code: "auth_required", retryable: false });
    expect(classifyWriteOutcome({ ok: false, dispatched: true, answered: state === "failed", error })).toBe(state);
    if (state === "failed") {
      expect(error).not.toHaveProperty("writeOutcome");
      expect(error.message).toBe("Tickets rejected the configured token.");
      expect(error.instructions).toContain("retry the original call");
    } else {
      expect(error).toMatchObject({
        writeOutcome: "unknown",
        message: `Tickets rejected the configured token. ${SENTENCE}`,
      });
      expect(error.instructions).toContain(RECONCILE);
    }
    expect(sent).toEqual(["POST /tickets"]);
  });

  it("INV-9: declared evidence never makes a 401 a refusal once another write in the call may have run", async () => {
    const { connector, sent } = tickets(
      { "/follow-ups": 401 },
      declared(() => true),
    );
    const error = await call(connector, "create_twice", true);
    expect(error).toMatchObject({
      code: "auth_required",
      retryable: false,
      writeOutcome: "unknown",
      reconciliationRequired: true,
      nextAction: { tool: "authorize_connector" },
    });
    expect(error.instructions).toContain(RECONCILE);
    expect(sent).toEqual(["POST /tickets", "POST /follow-ups"]);
  });

  it("INV-9: a direct guarded write outside a call ledger is unknown unless declared; a read is a refusal", async () => {
    const ctx = makeRegistry([]).contextFor("tickets", BASE);
    const refusal = (response: { status: number }) => {
      if (response.status === 401)
        throw new ConnectorCallError("auth_required", "Tickets rejected the configured token.");
    };
    const undeclared = tickets({ "/tickets": 401, "/tickets/t-1": 401 }).send;
    await expect(undeclared({ method: "POST", path: "/tickets" }, ctx, refusal)).rejects.toMatchObject({
      code: "auth_required",
      retryable: false,
      writeOutcome: "unknown",
      message: `Tickets rejected the configured token. ${SENTENCE}`,
    });
    const read = await undeclared({ method: "GET", path: "/tickets/t-1" }, ctx, refusal).catch((e: unknown) => e);
    expect(read).toMatchObject({ code: "auth_required", retryable: false, writeOutcome: undefined });
    const reviewed = tickets(
      { "/tickets": 401 },
      declared(() => true),
    ).send;
    const known = await reviewed({ method: "POST", path: "/tickets" }, ctx, refusal).catch((e: unknown) => e);
    expect(known).toMatchObject({ code: "auth_required", retryable: false, writeOutcome: undefined });
  });

  it.each([true, false])(
    "INV-9: a program whose write was answered 401 counts it unknown, keeping its handoff (caught: %s)",
    async (caught) => {
      const { connector, sent } = tickets({ "/tickets": 401 });
      const storage = memoryStorage();
      const vault = new CredentialVault(storage, btoa("k".repeat(32)));
      await vault.setAll("tickets", { value: "fixture-secret" }, "fixture");
      const registry = makeRegistry([connector], { storage, credentialVault: vault });
      const execute = createExecuteTool(
        registry,
        BASE,
        scriptedExecutor(async (fns) => {
          try {
            await required(fns.call)("tickets.create", {});
          } catch (error) {
            if (!caught) throw error;
          }
          return "done";
        }),
        silentLogger,
        undefined,
        { readOnly: false },
      );
      const result = (await execute({ code: "async () => null" })).structuredContent as Record<string, any>;
      expect(result.result).toBeUndefined();
      expect(result.error).toMatchObject({
        code: "auth_required",
        retryable: false,
        writeOutcome: "unknown",
        writes: { succeeded: 0, failed: 0, unknown: 1 },
        reconciliationRequired: true,
        nextAction: { tool: "authorize_connector", arguments: { connector: "tickets" } },
      });
      expect(sent).toEqual(["POST /tickets"]);
    },
  );
});

describe("a write answered 401 is decided before every other exception", () => {
  const STRIPE_SENTENCE =
    "The write was sent before Stripe rejected its credential, so whether it took effect is unknown: check the target before repeating it.";
  const stripeRefusal = (headers: Record<string, string>) => () =>
    Response.json(
      { error: { type: "invalid_request_error", message: "Invalid API Key provided." } },
      { status: 401, headers },
    );

  it("INV-9: a keyed direct guarded write outside a call ledger gets no wait, resend advice or key exception", async () => {
    const ctx = makeRegistry([]).contextFor("tickets", BASE);
    const { send } = tickets({ "/tickets": 401 });
    const failure = await send({ method: "POST", path: "/tickets", idempotencyKey: "fixed-key" }, ctx, retryingRefusal)
      .then(() => undefined)
      .catch((e: unknown) => e);
    const error = classifyCallError(failure);
    expect(error).toMatchObject({
      code: "auth_required",
      retryable: false,
      writeOutcome: "unknown",
      message: `Tickets rejected the configured token. ${SENTENCE}`,
    });
    expect(error).not.toHaveProperty("retryAfterMs");
  });

  it("INV-9: a direct Stripe write answered 401 without Request-Id gets no key-reuse advice", async () => {
    vi.stubGlobal("fetch", vi.fn(stripeRefusal({})));
    const connector = stripe("billing", { purpose: "Review", auth: { type: "apiKey" }, mode: "sandbox" });
    const args = { method: "POST", path: "/v1/refunds", body: { charge: "ch_1" } };
    const error = await callDirect(connector, "stripe_api_write", args, { value: "sk_test_fixture" });
    expect(error).toMatchObject({ code: "auth_required", retryable: false, writeOutcome: "unknown" });
    expect(error.message).toContain(STRIPE_SENTENCE);
    expect(error.message).not.toContain("Reusing it");
    // The reviewed exception still stands: Stripe's own v1 answer is a
    // refusal, so its key keeps protecting a deliberate repeat.
    vi.stubGlobal("fetch", vi.fn(stripeRefusal({ "request-id": "req_1" })));
    const declared = await callDirect(connector, "stripe_api_write", args, { value: "sk_test_fixture" });
    expect(declared).toMatchObject({ code: "auth_required", retryable: false });
    expect(declared).not.toHaveProperty("writeOutcome");
    expect(declared.message).toContain("Reusing it with the exact original arguments");
  });

  it("INV-9: a Tithe.ly write answered 401 past its response ceiling keeps its auth handoff", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 401, headers: { "content-length": "5000000" } })),
    );
    const connector = tithely("giving", { purpose: "Review", environment: "test" });
    const error = await call(
      connector,
      "tithely_api_mutate",
      true,
      { method: "POST", path: "/charges", form: [{ name: "account_id", value: "user_jane" }] },
      { publicKey: "pub_abc123", privateKey: "pri_def456" },
    );
    expect(error).toMatchObject({
      code: "auth_required",
      retryable: false,
      writeOutcome: "unknown",
      reconciliationRequired: true,
      nextAction: { tool: "authorize_connector", arguments: { connector: "giving" } },
      message:
        "Tithe.ly answered this write with HTTP 401. The write was sent before Tithe.ly rejected its credential, " +
        "so whether it took effect is unknown: check the target before repeating it.",
    });
    expect(error.instructions).toContain(RECONCILE);
  });

  it("INV-9: a direct guarded write answered 401 past its response ceiling is an auth verdict too", async () => {
    const ctx = makeRegistry([]).contextFor("tickets", BASE);
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.example",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
      fetch: async () => new Response("denied", { status: 401, headers: { "content-length": "10000" } }),
    });
    const failure = await send({ method: "POST", path: "/tickets" }, ctx, retryingRefusal).catch((e: unknown) => e);
    expect(classifyCallError(failure)).toMatchObject({
      code: "auth_required",
      retryable: false,
      writeOutcome: "unknown",
      message: `Tickets answered this write with HTTP 401. ${SENTENCE}`,
    });
  });

  it("INV-9: a 401 the handler caught keeps its own auth verdict after a later failure", async () => {
    const { connector, sent } = ticketsAround("later");
    const error = await call(connector, "create", true);
    expect(error).toMatchObject({
      code: "auth_required",
      retryable: false,
      writeOutcome: "unknown",
      reconciliationRequired: true,
      nextAction: { tool: "authorize_connector", arguments: { connector: "tickets" } },
      message: `Tickets rejected the configured token. ${SENTENCE}`,
    });
    expect(error).not.toHaveProperty("retryAfterMs");
    expect(sent).toEqual(["POST /tickets"]);
  });

  it.each([
    ["after an accepted write", "composite", true, ["POST /accepted", "POST /tickets"]],
    ["in a handler the ledger cannot vouch for", "sole", false, ["POST /tickets"]],
  ] as const)(
    "INV-9: a write answered 401 %s drops the wait and resend advice",
    async (_name, kind, tracked, requests) => {
      const { connector, sent } = ticketsAround(kind, tracked);
      const error = await call(connector, "create", true);
      expect(error).toMatchObject({
        code: "auth_required",
        retryable: false,
        writeOutcome: "unknown",
        nextAction: { tool: "authorize_connector" },
        message: `Tickets rejected the configured token. ${SENTENCE}`,
      });
      expect(error).not.toHaveProperty("retryAfterMs");
      expect(sent).toEqual(requests);
    },
  );

  it("INV-9: a 401 whose credential a renewal replaced needs no handoff; the write stays unknown", async () => {
    const { connector, sent } = ticketsAround("renewed");
    const error = await call(connector, "create", true);
    expect(error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
    expect(error).not.toHaveProperty("nextAction");
    expect(sent).toEqual(["GET /tickets/t-1", "GET /tickets/t-1", "POST /failing"]);
  });
});

describe("authBeforeExecution construction", () => {
  it.each([
    ["empty evidence", { evidence: " ", matches: () => true }],
    ["no predicate", { evidence: "https://tickets.example/docs/auth" }],
  ])("INV-11: refuses a declaration with %s before any request", (_name, evidence) => {
    expect(() =>
      guardedFetch({
        provider: "Tickets",
        baseUrl: "https://tickets.example",
        authenticate: () => ({}),
        maxResponseBytes: 1024,
        authBeforeExecution: evidence as NonNullable<Evidence>,
      }),
    ).toThrow("Tickets authBeforeExecution needs nonempty evidence and a narrow matches predicate.");
  });
});
