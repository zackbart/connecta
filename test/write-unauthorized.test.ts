// A write answered HTTP 401 is an unknown outcome by default: a server may act
// on a request before it rejects the credential. It keeps its authorization
// code and handoff, is never retryable, and is a refusal only where the
// transport declares reviewed vendor evidence that the vendor authenticates
// first (`authBeforeExecution`). Decided once, in `servedRefusal`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { CredentialVault } from "../src/credentials.js";
import { ConnectorCallError, type CallErrorDetails } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import { memoryStorage } from "../src/storage/memory.js";
import { classifyWriteOutcome } from "../src/write-outcome.js";
import { scriptedExecutor } from "./fixtures/misc.js";
import { makeRegistry, required, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const SENTENCE =
  "The write was sent before Tickets rejected its credential, so whether it took effect is unknown: check the target before repeating it.";
const RECONCILE = "re-read the target of the write that failed to check whether it took effect before any fresh call";

afterEach(() => {
  vi.restoreAllMocks();
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

async function call(connector: ReturnType<typeof tickets>["connector"], tool: string, write: boolean) {
  const storage = memoryStorage();
  const vault = new CredentialVault(storage, btoa("k".repeat(32)));
  await vault.setAll("tickets", { value: "fixture-secret" }, "fixture");
  const registry = makeRegistry([connector], { storage, credentialVault: vault });
  const meta = createMetaTools(registry, BASE, { credentialHandoffUrl: `${BASE}/connections` });
  const result = await (write ? meta.callDestructiveTool : meta.callTool)({ address: `tickets.${tool}` });
  return (result.structuredContent as { error: CallErrorDetails }).error;
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
