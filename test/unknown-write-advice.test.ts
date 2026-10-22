// No text Connecta attaches to a write whose outcome is unknown tells the
// agent to retry or resend it (#902 round 13): not an authorization or
// credential handoff, not a provider's message, not the invocation's advice.
// Reconcile-first wording stays; a read, a write with a known outcome, and a
// write that carried a genuine idempotency key keep their advice. Round 14:
// that advice is a segment of its own, so neither redaction nor a preflight
// failure after an earlier dispatch can keep it on an unknown write.
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizationHandoff, bindAuthorizationHandoffs } from "../src/authorization-handoff.js";
import { CatalogService } from "../src/catalog-service.js";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { CredentialVault } from "../src/credentials.js";
import { classifyCallError, ConnectorCallError, resendAdvice } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { InvocationService } from "../src/invocation.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import { docs } from "../src/providers/docs/index.js";
import { notion } from "../src/providers/notion/index.js";
import { stripe } from "../src/providers/stripe/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, Executor } from "../src/types.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { resendWording } from "./fixtures/resend-wording.js";
import { PRIVATE_KEY } from "./goldens/rsa-fixture.js";
import { makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.example";

afterEach(() => {
  vi.unstubAllGlobals();
});

function failure(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
}

function catchingProgram(registry: ReturnType<typeof makeRegistry>, address: string, args: unknown = {}) {
  const executor: Executor = {
    async execute(_code, providers) {
      try {
        await providers.find((provider) => provider.name === "connecta")!.fns["call"]!(address, args);
      } catch {
        /* caught by the guest */
      }
      return { result: "caught and continued" };
    },
  };
  return createExecuteTool(registry, BASE, executor, silentLogger, undefined, { readOnly: false })({
    code: "async () => null",
  });
}

async function vaulted(connectors: Connector[], id: string) {
  const storage = memoryStorage();
  const vault = new CredentialVault(storage, btoa("k".repeat(32)));
  await vault.set(id, "sk_test_fixture", "fixture");
  return makeRegistry(connectors, { storage, credentialVault: vault });
}

/** A custom connector whose write applies, then meets `fail`; its read only meets it. */
function tickets(fail: () => unknown, extra: Partial<Connector> = {}) {
  const state = { applied: 0 };
  const connector: Connector = {
    id: "tickets",
    kind: "api",
    description: "Tickets",
    async listTools() {
      return [
        { name: "create_item", description: "Create", annotations: { readOnlyHint: false }, inputSchema: {} },
        { name: "list_items", description: "List", annotations: { readOnlyHint: true }, inputSchema: {} },
      ];
    },
    async callTool(name) {
      if (name === "create_item") state.applied++;
      throw fail();
    },
    ...extra,
  };
  return { state, connector };
}

/** Bind the request's authorization handoffs the way the MCP route does. */
function withHandoffs(registry: ReturnType<typeof makeRegistry>, credentialHandoffUrl?: string) {
  const catalog = new CatalogService(registry, BASE);
  bindAuthorizationHandoffs(catalog.requestScope, (connector) =>
    authorizationHandoff(
      registry,
      BASE,
      catalog.requestScope,
      {
        canManageAuth: () => true,
        oauthConnectUrl: async () => `${BASE}/auth/tickets`,
        ...(credentialHandoffUrl ? { credentialHandoffUrl } : {}),
      },
      { connector },
    ),
  );
  return new InvocationService(registry, catalog);
}

const oauth = () =>
  ({ startAuth: async () => ({ url: "https://idp.example/authorize" }) }) as unknown as Partial<Connector>;
const credentialSlot = { credential: { label: "Tickets key" } } as Partial<Connector>;

/**
 * A composite over Stripe whose first DELETE applies and whose second is
 * refused 429, with a private argument; `password: "Back off"` matches
 * Stripe's own advice, so redacting the message rewrites that advice too.
 */
async function privateComposite() {
  const state = { sent: 0 };
  vi.stubGlobal("fetch", async () =>
    ++state.sent % 2 === 1
      ? Response.json({ id: "cus_1", deleted: true })
      : Response.json({ error: { type: "rate_limit_error", message: "Rate limit" } }, { status: 429 }),
  );
  const billing = stripe("billing", { purpose: "Review", auth: { type: "apiKey" }, mode: "sandbox" });
  const wrapper: Connector = {
    id: "billing",
    kind: "api",
    ...(billing.credential ? { credential: billing.credential } : {}),
    description: "Composite",
    async listTools() {
      return [
        {
          name: "delete_pair",
          description: "Delete two",
          annotations: { readOnlyHint: false },
          inputSchema: { type: "object", properties: { password: { type: "string", writeOnly: true } } },
        },
      ];
    },
    async callTool(_name, _args, ctx) {
      await billing.callTool("stripe_api_write", { method: "DELETE", path: "/v1/customers/cus_1" }, ctx);
      return await billing.callTool("stripe_api_write", { method: "DELETE", path: "/v1/customers/cus_2" }, ctx);
    },
  };
  return { state, registry: await vaulted([wrapper], "billing"), args: { password: "Back off" } };
}

/**
 * Google Docs over a service account whose token request is refused with
 * invalid_grant. `prior` makes a composite that first sends a write of its
 * own, so the token refusal follows a dispatch in the same logical call.
 */
function refusedToken(prior: boolean) {
  const state = { applied: 0, tokens: 0 };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input) === "https://oauth2.googleapis.com/token") {
      state.tokens++;
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    state.applied++;
    return Response.json({ id: "created" });
  });
  const inner = docs("docs", {
    purpose: "Review",
    serviceAccount: { clientEmail: "delegate@project.iam.gserviceaccount.com", privateKey: PRIVATE_KEY },
    subject: "alice@example.com",
  });
  if (!prior) return { state, registry: makeRegistry([inner]), address: "docs.create_document" };
  const wrapper: Connector = {
    id: "docs",
    kind: "api",
    description: "Composite",
    async listTools() {
      return [{ name: "create_pair", description: "Create", annotations: { readOnlyHint: false }, inputSchema: {} }];
    },
    async callTool(_name, _args, ctx) {
      await fetch("https://side.example/apply", { method: "POST" });
      return await inner.callTool("create_document", { title: "Review" }, ctx);
    },
  };
  return { state, registry: makeRegistry([wrapper]), address: "docs.create_pair" };
}

describe("authorization and credential handoffs after a write are outcome-aware", () => {
  it("INV-9: an unknown write's OAuth handoff says to re-read the target, never to retry the original call", async () => {
    const { state, connector } = tickets(() => new ConnectorCallError("auth_required", "Needs authorization"), oauth());
    const served = await withHandoffs(makeRegistry([connector])).invoke(
      "tickets.create_item",
      {},
      { source: "call_destructive_tool" },
    );
    expect(state.applied).toBe(1);
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.error).toMatchObject({
      code: "downstream_oauth_required",
      writeOutcome: "unknown",
      reconciliationRequired: true,
      recovery: "oauth",
      authorizationUrl: `${BASE}/auth/tickets`,
      nextAction: { tool: "authorize_connector" },
    });
    expect(served.error.instructions).toContain(
      "Then re-read the target of the write that failed to check whether it took effect before any fresh call;",
    );
    expect(served.error.instructions).not.toContain("retry the original call");
    expect(resendWording(served.error)).toEqual([]);
  });

  it("INV-9: an unknown write's credential recovery says to re-read the target, never to retry the original call", async () => {
    const { state, connector } = tickets(
      () => new ConnectorCallError("auth_required", "The key was refused"),
      credentialSlot,
    );
    const registry = await vaulted([connector], "tickets");
    const served = await withHandoffs(registry, `${BASE}/operator`).invoke(
      "tickets.create_item",
      {},
      { source: "call_destructive_tool" },
    );
    expect(state.applied).toBe(1);
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.error).toMatchObject({
      code: "auth_required",
      writeOutcome: "unknown",
      recovery: "operator_config",
      operatorUrl: `${BASE}/operator`,
    });
    expect(served.error.instructions).toMatch(
      /^Have the operator open operatorUrl, set and test the credential, then re-read the target of the write that failed to check whether it took effect before any fresh call\. No redeploy is needed\./,
    );
    expect(resendWording(served.error)).toEqual([]);
  });
});

describe("Notion's 529 overload advice", () => {
  async function overloaded() {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(init?.method ?? "GET");
      return Response.json(
        { object: "error", status: 529, code: "service_unavailable", message: "Overloaded" },
        { status: 529 },
      );
    });
    const connector = notion("notes", { purpose: "Review", auth: { type: "token" } });
    return { sent, connector, registry: await vaulted([connector], "notes") };
  }
  const write = { method: "POST", path: "/v1/pages", body: { parent: { page_id: "page-1" }, properties: {} } };

  it("INV-9: a keyless write answered 529 is unknown without retry wording, direct, served and in a program", async () => {
    const { sent, connector, registry } = await overloaded();
    const direct = classifyCallError(
      await failure(connector.callTool("notion_api_write", write, registry.contextFor("notes", BASE))),
    );
    expect(direct).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
    expect(direct.message).toContain("Notion is overloaded. Whether the write took effect at Notion is unknown");
    expect(resendWording(direct)).toEqual([]);

    const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "notes.notion_api_write",
      write,
      { source: "call_destructive_tool" },
    );
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    expect(resendWording(served.error)).toEqual([]);

    const program = await catchingProgram(registry, "notes.notion_api_write", write);
    expect(program.structuredContent).toMatchObject({ error: { code: "write_outcome_unknown" } });
    expect(resendWording(program.structuredContent)).toEqual([]);
    expect(sent).toEqual(["POST", "POST", "POST"]);
  });
});

describe("resend advice is a segment of its own (round 14)", () => {
  it("INV-9: a private argument matching a composite's Stripe advice cannot keep that advice on the unknown write", async () => {
    const { state, registry, args } = await privateComposite();
    const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "billing.delete_pair",
      args,
      { source: "call_destructive_tool" },
    );
    expect(state.sent).toBe(2);
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.error).toMatchObject({ code: "rate_limited", retryable: false, writeOutcome: "unknown" });
    expect(served.error.message).toBe("Stripe rate_limit_error: Rate limit");
    expect(resendWording(served.error)).toEqual([]);
    const program = await catchingProgram(registry, "billing.delete_pair", args);
    expect(program.structuredContent).toMatchObject({ error: { code: "write_outcome_unknown" } });
    expect(resendWording(program.structuredContent)).toEqual([]);
  });

  it("INV-9: a Google token refusal after an earlier dispatch in the same call drops its advice to retry", async () => {
    const { state, registry, address } = refusedToken(true);
    const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      address,
      {},
      { source: "call_destructive_tool" },
    );
    expect(state).toEqual({ applied: 1, tokens: 1 });
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.answered).toBe(false);
    expect(served.error).toMatchObject({ code: "auth_required", retryable: false, writeOutcome: "unknown" });
    expect(served.error.message).toMatch(/Check the deployment's subject mapping and the key\.$/);
    expect(resendWording(served.error)).toEqual([]);
  });
});

describe("a shared token flight hands each caller the refusal's advice (round 15)", () => {
  it.each([
    ["write", "docs.create_document", { title: "Review" }, "call_destructive_tool"],
    ["read", "docs.get_document", { documentId: "document_1" }, "call_tool"],
  ] as const)(
    "INV-9: two concurrent %ss refused by one shared token mint get identical messages and advice",
    async (_kind, address, args, source) => {
      let mints = 0;
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        expect(String(input)).toBe("https://oauth2.googleapis.com/token");
        mints++;
        await pending;
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      });
      const registry = makeRegistry([
        docs("docs", {
          purpose: "Review",
          serviceAccount: { clientEmail: "delegate@project.iam.gserviceaccount.com", privateKey: PRIVATE_KEY },
          subject: "alice@example.com",
        }),
      ]);
      const invocation = new InvocationService(registry, new CatalogService(registry, BASE));
      const calls = [0, 1].map(() => invocation.invoke(address, args, { source }));
      // Long enough for the second caller to join the first one's flight.
      setTimeout(release, 250);
      const [owner, follower] = await Promise.all(calls);
      expect(mints).toBe(1);
      if (owner!.ok || follower!.ok) throw new Error("expected both refusals");
      expect(owner!.error.writeOutcome).toBeUndefined();
      expect(follower!.error.writeOutcome).toBeUndefined();
      expect(owner!.error.message).toMatch(/Check the deployment's subject mapping and the key before retrying\.$/);
      expect(follower!.error.message).toBe(owner!.error.message);
      expect(follower!.error).toEqual(owner!.error);
    },
  );
});

describe("no unknown write's agent-visible text says to retry or resend it", () => {
  /** A tracked api() write that sends two requests; the second is refused with resend advice. */
  function twoRequests() {
    let sent = 0;
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.test",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
      fetch: async () => (++sent === 1 ? Response.json({ id: 1 }) : Response.json({}, { status: 429 })),
    });
    const refuse = (response: { status: number }) => {
      if (response.status === 429)
        throw resendAdvice(
          new ConnectorCallError("rate_limited", "Tickets is throttling."),
          " Back off before retrying.",
        );
      return null;
    };
    return tracksEveryRequest(
      api("tickets", {
        tools: [
          {
            name: "create_pair",
            description: "Create two",
            annotations: { readOnlyHint: false },
            inputSchema: { type: "object" },
            handler: async (_args, ctx) => {
              await send({ method: "POST", path: "/items" }, ctx, refuse);
              return await send({ method: "POST", path: "/items" }, ctx, refuse);
            },
          },
        ],
      }),
    );
  }

  const scenarios: Array<[string, () => Promise<unknown[]>]> = [
    [
      "an OAuth handoff after entry",
      async () => {
        const { connector } = tickets(() => new ConnectorCallError("auth_required", "Needs authorization"), oauth());
        return [
          await withHandoffs(makeRegistry([connector])).invoke(
            "tickets.create_item",
            {},
            { source: "call_destructive_tool" },
          ),
        ];
      },
    ],
    [
      "a credential recovery after entry",
      async () => {
        const { connector } = tickets(() => new ConnectorCallError("auth_required", "Refused key"), credentialSlot);
        const registry = await vaulted([connector], "tickets");
        return [
          await withHandoffs(registry, `${BASE}/operator`).invoke(
            "tickets.create_item",
            {},
            { source: "call_destructive_tool" },
          ),
          await catchingProgram(registry, "tickets.create_item"),
        ];
      },
    ],
    [
      "a provider refusal demoted by a second request in the same call",
      async () => {
        const connector = twoRequests();
        const registry = makeRegistry([connector]);
        const direct = classifyCallError(
          await failure(connector.callTool("create_pair", {}, registry.contextFor("tickets", BASE))),
        );
        expect(direct).toMatchObject({ code: "rate_limited", retryable: false, writeOutcome: "unknown" });
        const fresh = makeRegistry([twoRequests()]);
        const served = await new InvocationService(fresh, new CatalogService(fresh, BASE)).invoke(
          "tickets.create_pair",
          {},
          { source: "call_destructive_tool" },
        );
        return [direct, served];
      },
    ],
    [
      "a Stripe refusal demoted by a composite",
      async () => {
        let sent = 0;
        vi.stubGlobal("fetch", async () =>
          ++sent % 2 === 1
            ? Response.json({ id: "cus_1", deleted: true })
            : Response.json({ error: { type: "rate_limit_error", message: "Rate limit" } }, { status: 429 }),
        );
        const billing = stripe("billing", { purpose: "Review", auth: { type: "apiKey" }, mode: "sandbox" });
        const wrapper: Connector = {
          id: "billing",
          kind: "api",
          ...(billing.credential ? { credential: billing.credential } : {}),
          description: "Composite",
          async listTools() {
            return [{ name: "delete_pair", description: "Delete two", annotations: { readOnlyHint: false } }];
          },
          async callTool(_name, _args, ctx) {
            await billing.callTool("stripe_api_write", { method: "DELETE", path: "/v1/customers/cus_1" }, ctx);
            return await billing.callTool("stripe_api_write", { method: "DELETE", path: "/v1/customers/cus_2" }, ctx);
          },
        };
        const registry = await vaulted([wrapper], "billing");
        return [
          await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
            "billing.delete_pair",
            {},
            { source: "call_destructive_tool" },
          ),
          await catchingProgram(registry, "billing.delete_pair"),
        ];
      },
    ],
    [
      "a Stripe composite whose redacted private argument matches its advice",
      async () => {
        const { registry, args } = await privateComposite();
        return [
          await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
            "billing.delete_pair",
            args,
            { source: "call_destructive_tool" },
          ),
          await catchingProgram(registry, "billing.delete_pair", args),
        ];
      },
    ],
    [
      "a Google token preflight failure after an earlier dispatch",
      async () => {
        const { registry, address } = refusedToken(true);
        return [
          await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
            address,
            {},
            { source: "call_destructive_tool" },
          ),
          await catchingProgram(registry, address),
        ];
      },
    ],
    [
      "invocation advice for a custom connector's permission denial, timeout, and input_required",
      async () => {
        const denied = tickets(() => new ConnectorCallError("provider_permission_denied", "Scope check failed"));
        const timedOut = tickets(() => new ConnectorCallError("timeout", "No reply"));
        const outcomes: unknown[] = [];
        for (const { connector } of [denied, timedOut]) {
          const registry = makeRegistry([connector]);
          outcomes.push(
            await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
              "tickets.create_item",
              {},
              { source: "call_destructive_tool" },
            ),
            await catchingProgram(registry, "tickets.create_item"),
          );
        }
        const downstream = httpDownstream((server) => {
          server.registerTool("create_item", { annotations: { readOnlyHint: false } }, async () => {
            return { resultType: "input_required", requestState: "applied" } as never;
          });
        });
        vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => downstream.fetch(String(input), init));
        const registry = makeRegistry([remoteMcp("tickets", { url: downstream.url })]);
        outcomes.push(
          await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
            "tickets.create_item",
            {},
            { source: "call_destructive_tool" },
          ),
        );
        return outcomes;
      },
    ],
  ];

  it.each(scenarios)("INV-9: %s", async (_label, run) => {
    const visible = (await run()).filter((value) => value !== undefined);
    expect(visible.length).toBeGreaterThan(0);
    for (const value of visible) {
      const outcome = value as { ok?: boolean; error?: { writeOutcome?: string; code?: string } };
      if (outcome.ok === false && outcome.error?.code !== "write_outcome_unknown")
        expect(outcome.error?.writeOutcome).toBe("unknown");
      expect(resendWording(value)).toEqual([]);
    }
  });

  it("INV-9: control: Stripe's genuine idempotency key keeps its key-reuse advice", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: { type: "api_error", message: "Server error" } }, { status: 500 }),
    );
    const billing = stripe("billing", { purpose: "Review", auth: { type: "apiKey" }, mode: "sandbox" });
    const registry = await vaulted([billing], "billing");
    const args = { method: "POST", path: "/v1/customers", body: { name: "x" }, idempotencyKey: "k-500" };
    const direct = classifyCallError(
      await failure(billing.callTool("stripe_api_write", args, registry.contextFor("billing", BASE))),
    );
    expect(direct).toMatchObject({ code: "unavailable", retryable: true });
    const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "billing.stripe_api_write",
      args,
      { source: "call_destructive_tool" },
    );
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.error).toMatchObject({
      writeOutcome: "unknown",
      uncertainCall: { recovery: { idempotencyKey: "k-500" } },
    });
    expect(served.error.retry).toContain("A deliberate retry with uncertainCall.recovery.idempotencyKey");
  });
});
