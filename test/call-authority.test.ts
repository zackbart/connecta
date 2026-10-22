import { describe, expect, it, vi } from "vitest";
import { chargeConnectorCall } from "../src/call-admission-context.js";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { deriveContext } from "../src/derived-context.js";
import { createMetaTools } from "../src/meta-tools.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import { sentSecretsFor } from "../src/sent-secrets.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectorContext } from "../src/types.js";
import { makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.example";

describe("call authority at nested api boundaries", () => {
  it.each(["derived", "spread"] as const)(
    "INV-4 INV-10: a %s context cannot mint a noncharging budget inside an admitted call",
    async (kind) => {
      const fetch = vi.fn(async () => Response.json({ ok: true }));
      const send = guardedFetch({
        provider: "Tickets",
        baseUrl: "https://tickets.example",
        maxResponseBytes: 1024,
        authenticate: () => ({}),
        fetch,
      });
      const entered = vi.fn();
      const inner = api("tickets", {
        tools: [
          {
            name: "read",
            description: "Read.",
            annotations: { readOnlyHint: true },
            handler: async (_, ctx) => {
              entered();
              await chargeConnectorCall(ctx);
              return send({ method: "GET", path: "/notes" }, ctx, async () => ({}));
            },
          },
        ],
      });
      let refusal: unknown;
      const outer = api("crm", {
        callAdmission: { rules: [{ budget: { kind: "rolling-window", maxCalls: 1, windowMs: 60_000 } }] },
        tools: [
          {
            name: "read",
            description: "Read.",
            annotations: { readOnlyHint: true },
            handler: async (_, ctx) => {
              try {
                await inner.callTool("read", {}, kind === "derived" ? deriveContext(ctx, {}) : { ...ctx });
              } catch (error) {
                refusal = error;
              }
              return {};
            },
          },
        ],
      });
      const registry = makeRegistry([outer]);
      expect((await createMetaTools(registry, BASE).callTool({ address: "crm.read" })).isError).not.toBe(true);
      expect(refusal).toMatchObject({ code: kind === "derived" ? "rate_limited" : "connector_call_failed" });
      expect(entered).toHaveBeenCalledTimes(kind === "derived" ? 1 : 0);
      expect(fetch).not.toHaveBeenCalled();
      expect(registry.callAdmissionSnapshot()["crm"]).toMatchObject({ totals: { admitted: 1 } });
    },
  );

  it.each(["derived", "spread"] as const)(
    "INV-4 INV-9: a %s context cannot hide a nested write's 401 from the whole-call ledger",
    async (kind) => {
      const fetch = vi.fn(async () => new Response(null, { status: 401 }));
      const send = guardedFetch({
        provider: "Tickets",
        baseUrl: "https://tickets.example",
        maxResponseBytes: 1024,
        authenticate: () => ({}),
        fetch,
      });
      const inner = tracksEveryRequest(
        api("tickets", {
          tools: [
            {
              name: "write",
              description: "Write.",
              annotations: { readOnlyHint: false },
              handler: (_, ctx) => send({ method: "POST", path: "/notes" }, ctx, async () => ({})),
            },
          ],
        }),
      );
      let refusal: unknown;
      const outer = tracksEveryRequest(
        api("crm", {
          tools: [
            {
              name: "write",
              description: "Write.",
              annotations: { readOnlyHint: false },
              handler: async (_, ctx) => {
                try {
                  await inner.callTool("write", {}, kind === "derived" ? deriveContext(ctx, {}) : { ...ctx });
                } catch (error) {
                  refusal = error;
                }
                return { ok: true };
              },
            },
          ],
        }),
      );
      const result = await createMetaTools(makeRegistry([outer]), BASE).callDestructiveTool({ address: "crm.write" });
      if (kind === "derived") {
        expect(result.structuredContent).toMatchObject({
          error: {
            code: "auth_required",
            writeOutcome: "unknown",
            retryable: false,
            reconciliationRequired: true,
            nextAction: { tool: "authorize_connector" },
          },
        });
        expect(fetch).toHaveBeenCalledTimes(1);
      } else {
        expect(refusal).toMatchObject({ code: "connector_call_failed" });
        expect(fetch).not.toHaveBeenCalled();
        expect(result.isError).not.toBe(true);
      }
    },
  );

  it("INV-4 INV-10: deriving an unregistered spread cannot restore an admitted call's authority", async () => {
    const outer = api("crm", {
      tools: [
        {
          name: "read",
          description: "Read.",
          annotations: { readOnlyHint: true },
          handler: async (_, ctx) => {
            expect(() => deriveContext({ ...ctx }, {})).toThrow(/call has ended/);
            return {};
          },
        },
      ],
    });
    expect((await createMetaTools(makeRegistry([outer]), BASE).callTool({ address: "crm.read" })).isError).not.toBe(
      true,
    );
  });

  it.each(["during", "after"] as const)(
    "INV-4 INV-10: a spread of a served call used %s closure cannot enter the standalone api path",
    async (phase) => {
      const entered = vi.fn(async () => ({}));
      const inner = api("tickets", {
        tools: [{ name: "read", description: "Read.", annotations: { readOnlyHint: true }, handler: entered }],
      });
      let retained!: ConnectorContext;
      const refuse = async (copy: ConnectorContext) => {
        await expect(inner.callTool("read", {}, copy)).rejects.toMatchObject({ code: "connector_call_failed" });
      };
      const outer = api("crm", {
        tools: [
          {
            name: "read",
            description: "Read.",
            annotations: { readOnlyHint: true },
            handler: async (_, ctx) => {
              retained = ctx;
              if (phase === "during") await refuse({ ...ctx });
              return {};
            },
          },
        ],
      });
      const scope = {};
      const tools = createMetaTools(makeRegistry([outer]), BASE, { requestScope: scope });
      expect((await tools.callTool({ address: "crm.read" })).isError).not.toBe(true);
      if (phase === "after") await refuse({ ...retained });
      expect(entered).not.toHaveBeenCalled();
    },
  );

  it("INV-4 INV-10: a spread's secret entry registered before admission cannot mint call authority afterward", async () => {
    const entered = vi.fn(async () => ({}));
    const inner = api("tickets", {
      tools: [{ name: "read", description: "Read.", annotations: { readOnlyHint: true }, handler: entered }],
    });
    let copy!: ConnectorContext;
    const outer = api("crm", {
      tools: [
        {
          name: "read",
          description: "Read.",
          annotations: { readOnlyHint: true },
          handler: async () => {
            await expect(inner.callTool("read", {}, copy)).rejects.toMatchObject({ code: "connector_call_failed" });
            return {};
          },
        },
      ],
    });
    const registry = makeRegistry([outer]);
    const scope = {};
    copy = { ...registry.contextFor("crm", BASE, scope) };
    sentSecretsFor(copy);
    expect(
      (await createMetaTools(registry, BASE, { requestScope: scope }).callTool({ address: "crm.read" })).isError,
    ).not.toBe(true);
    expect(entered).not.toHaveBeenCalled();
  });

  it("INV-4 INV-10: independent standalone contexts can share an unadmitted request scope", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = vi.fn(async () => {
      await gate;
      return { ok: true };
    });
    const connector = api("crm", {
      tools: [{ name: "read", description: "Read.", annotations: { readOnlyHint: true }, handler: entered }],
    });
    const first: ConnectorContext = { storage: memoryStorage(), logger: silentLogger, baseUrl: BASE, requestScope: {} };
    const a = connector.callTool("read", {}, first);
    const b = connector.callTool("read", {}, { ...first });
    const results = Promise.all([a, b]);
    release();
    await expect(results).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(entered).toHaveBeenCalledTimes(2);
  });

  it("INV-4 INV-10: standalone direct calls and anonymous credential probes retain their explicit authority", async () => {
    const candidate = "candidate-secret-1234";
    let reads = 0;
    const probe = api("tickets", {
      tools: [],
      testCredential: async (_, ctx) => {
        await chargeConnectorCall(ctx);
        expect(await ctx.credential!.get()).toBe(candidate);
        return { ok: true };
      },
    });
    const outer = api("crm", {
      tools: [
        {
          name: "read",
          description: "Read.",
          annotations: { readOnlyHint: true },
          handler: async (_, ctx) => {
            reads++;
            expect(await probe.testCredential!(candidate, ctx)).toEqual({ ok: true });
            return {};
          },
        },
      ],
    });
    const registry = makeRegistry([outer]);
    const operation: ConnectorContext = registry.contextFor("crm", BASE, {});
    await outer.callTool("read", {}, operation);
    await outer.callTool("read", {}, operation);
    expect((await createMetaTools(registry, BASE).callTool({ address: "crm.read" })).isError).not.toBe(true);
    expect(reads).toBe(3);
  });
});
