import { recordToolActivity } from "../src/activity.js";
import { describe, expect, it, vi } from "vitest";
import { connectorWith } from "./fixtures/connectors.js";
import { CallAdmissionError, ConnectorCallAdmissionController } from "../src/call-admission.js";
import { chargeConnectorCall } from "../src/call-admission-context.js";
import { buildSandboxProviders } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import type { Connector, ConnectorCallAdmissionPolicy, ConnectorContext, ToolDef } from "../src/types.js";
import { createTestConnecta, required, makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const READ_TOOL: ToolDef = {
  name: "read",
  description: "Read a value",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
};

function policy(
  rule: ConnectorCallAdmissionPolicy["rules"][number],
  maxPartitions?: number,
): ConnectorCallAdmissionPolicy {
  return {
    rules: [rule],
    ...(maxPartitions === undefined ? {} : { maxPartitions }),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition was not reached.");
}

describe("connector call admission controller", () => {
  it.each([false, { kind: "unknown", maxCalls: 1, windowMs: 1 }, { kind: "rolling-window", maxCalls: 0, windowMs: 1 }])(
    "INV-11: rejects the malformed nested budget %j at construction",
    (budget) => {
      for (const maxConcurrency of [undefined, 3]) {
        expect(
          () => new ConnectorCallAdmissionController("limited", policy({ maxConcurrency, budget } as never)),
        ).toThrow(/callAdmission.*budget/);
      }
    },
  );

  it("bounds one partition while admitting another independently", async () => {
    const admission = new ConnectorCallAdmissionController(
      "limited",
      policy({
        maxConcurrency: 1,
        maxQueueSize: 2,
        partitionKey: ({ args }) => (args as { project: string }).project,
      }),
    );
    const first = await admission.acquire({
      toolName: "read",
      args: { project: "a" },
    });
    const queued = admission.acquire({
      toolName: "read",
      args: { project: "a" },
    });
    const independent = await admission.acquire({
      toolName: "read",
      args: { project: "b" },
    });

    expect(admission.snapshot()).toMatchObject({
      partitions: 2,
      active: 2,
      queued: 1,
      totals: { admitted: 2, queued: 1 },
    });
    first.release();
    (await queued).release();
    independent.release();
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("returns the exact rolling-window reset and admits at the boundary", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const admission = new ConnectorCallAdmissionController(
        "budgeted",
        policy({
          budget: {
            kind: "rolling-window",
            maxCalls: 2,
            windowMs: 1_000,
          },
        }),
      );
      (await admission.acquire({ toolName: "read", args: {} })).release();
      vi.setSystemTime(10_250);
      (await admission.acquire({ toolName: "read", args: {} })).release();

      await expect(admission.acquire({ toolName: "read", args: {} })).rejects.toMatchObject({
        name: "CallAdmissionError",
        admissionKind: "budget",
        code: "rate_limited",
        retryable: true,
        retryAfterMs: 750,
      });
      expect(admission.snapshot().totals.rateLimited).toBe(1);

      vi.setSystemTime(10_999);
      await expect(admission.acquire({ toolName: "read", args: {} })).rejects.toMatchObject({ retryAfterMs: 1 });
      vi.setSystemTime(11_000);
      (await admission.acquire({ toolName: "read", args: {} })).release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds partition state and contains partition-key failures", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const bounded = new ConnectorCallAdmissionController(
        "limited",
        policy(
          {
            budget: {
              kind: "rolling-window",
              maxCalls: 1,
              windowMs: 100,
            },
            partitionKey: ({ args }) => String(args),
          },
          1,
        ),
      );
      (await bounded.acquire({ toolName: "read", args: "a" })).release();
      await expect(bounded.acquire({ toolName: "read", args: "b" })).rejects.toMatchObject({
        admissionKind: "partition",
        code: "rate_limited",
      });
      vi.setSystemTime(1_100);
      (await bounded.acquire({ toolName: "read", args: "b" })).release();

      const throwing = new ConnectorCallAdmissionController(
        "throwing",
        policy({
          maxConcurrency: 1,
          partitionKey() {
            throw new Error("secret details");
          },
        }),
      );
      await expect(throwing.acquire({ toolName: "read", args: {} })).rejects.toMatchObject({
        admissionKind: "partition",
        code: "connector_call_failed",
        message: 'Connector "throwing" call-admission partitionKey threw.',
      });
      await expect(
        new ConnectorCallAdmissionController(
          "long",
          policy({
            maxConcurrency: 1,
            partitionKey: () => "x".repeat(129),
          }),
        ).acquire({ toolName: "read", args: {} }),
      ).rejects.toBeInstanceOf(CallAdmissionError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("connector call admission integration", () => {
  it("shares one base-registry limiter between direct and code-mode calls", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const connector: Connector = connectorWith({
      id: "limited",
      kind: "api",
      description: "Limited",
      staticTools: [READ_TOOL],
      callAdmission: policy({ maxConcurrency: 1, maxQueueSize: 2 }),
      tools: [READ_TOOL],
      call: async (_name, args) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return args;
      },
    });
    const registry = makeRegistry([connector]);
    const direct = createMetaTools(registry, BASE).callTool({
      address: "limited.read",
      args: { source: "direct" },
    });
    await waitFor(() => releases.length === 1);

    const providers = await buildSandboxProviders(registry, BASE, silentLogger);
    const connecta = providers.find(({ name }) => name === "connecta")!;
    const codeMode = required(connecta.fns.call)("limited.read", { source: "code" });
    await waitFor(() => required(registry.callAdmissionSnapshot().limited).queued === 1);

    releases.shift()!();
    await direct;
    await waitFor(() => releases.length === 1);
    releases.shift()!();
    await expect(codeMode).resolves.toEqual({ data: { source: "code" }, format: "json" });
    expect(maxActive).toBe(1);
  });

  it("INV-7: stops a retained connector context from charging after its invocation ends", async () => {
    let captured: ConnectorContext | undefined;
    const connector = connectorWith({
      id: "limited",
      kind: "api",
      tools: [READ_TOOL],
      callAdmission: policy({ maxConcurrency: 1, budget: { kind: "rolling-window", maxCalls: 3, windowMs: 60_000 } }),
      call: async (_name, _args, ctx) => {
        captured = ctx;
        await chargeConnectorCall(ctx);
        return {};
      },
    });
    const registry = makeRegistry([connector]);
    const result = await createMetaTools(registry, BASE).callTool({ address: "limited.read" });
    expect(result.isError).not.toBe(true);
    await expect(chargeConnectorCall(required(captured))).rejects.toMatchObject({ admissionKind: "closed" });
    expect(registry.callAdmissionSnapshot()["limited"]).toMatchObject({
      active: 0,
      queued: 0,
      totals: { admitted: 2 },
    });
  });

  it("threads direct-call cancellation into the shared admission queue", async () => {
    let release!: () => void;
    const connector: Connector = connectorWith({
      id: "limited",
      kind: "api",
      description: "Limited",
      staticTools: [READ_TOOL],
      callAdmission: policy({ maxConcurrency: 1, maxQueueSize: 1 }),
      tools: [READ_TOOL],
      call: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {};
      },
    });
    const registry = makeRegistry([connector]);
    const active = createMetaTools(registry, BASE).callTool({
      address: "limited.read",
    });
    await waitFor(() => required(registry.callAdmissionSnapshot().limited).active === 1);
    const controller = new AbortController();
    const queued = createMetaTools(registry, BASE, {
      requestSignal: controller.signal,
    }).callTool({
      address: "limited.read",
      resultMode: "value",
    });
    await waitFor(() => required(registry.callAdmissionSnapshot().limited).queued === 1);
    controller.abort(new Error("caller left"));

    expect(JSON.parse(required((await queued).content[0]).text)).toMatchObject({
      ok: false,
      error: { code: "cancelled", retryable: false },
      attempts: 1,
    });
    expect(registry.callAdmissionSnapshot().limited).toMatchObject({
      active: 1,
      queued: 0,
      totals: { cancelled: 1 },
    });
    release();
    await active;
  });

  it("does not dispatch, retry, or poison health after caller cancellation", async () => {
    let calls = 0;
    let connectorSignal: AbortSignal | undefined;
    const events: Array<{
      outcome: string;
      attempts: number;
      errorCode?: string;
    }> = [];
    const connector: Connector = connectorWith({
      id: "limited",
      kind: "api",
      description: "Limited",
      staticTools: [READ_TOOL],
      callAdmission: policy({ maxConcurrency: 1 }),
      tools: [READ_TOOL],
      call: async (_name, _args, ctx) => {
        calls++;
        connectorSignal = ctx.signal;
        await new Promise<never>((_, reject) => {
          const cancelled = () => reject(ctx.signal?.reason ?? new Error("caller left"));
          ctx.signal?.addEventListener("abort", cancelled, { once: true });
          if (ctx.signal?.aborted) cancelled();
        });
      },
    });
    const registry = makeRegistry([connector]);
    const activity = {
      recordTool: recordToolActivity,
      sink: {
        record(event: (typeof events)[number]) {
          events.push(event);
        },
      },
      actor: { kind: "test" },
      requestId: "request",
      serverInfo: { name: "connecta", version: "test" },
      logger: silentLogger,
    };
    const controller = new AbortController();
    const pending = createMetaTools(registry, BASE, {
      requestSignal: controller.signal,
      activity,
    }).callTool({
      address: "limited.read",

      resultMode: "value",
    });
    await waitFor(() => calls === 1);
    controller.abort(new Error("caller left"));

    expect(JSON.parse(required((await pending).content[0]).text)).toMatchObject({
      ok: false,
      error: { code: "cancelled", retryable: false },
      attempts: 1,
    });
    expect(calls).toBe(1);
    expect(connectorSignal?.aborted).toBe(true);
    expect(registry.callAdmissionSnapshot().limited).toMatchObject({
      active: 0,
      queued: 0,
      totals: { admitted: 1 },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      connectorId: "limited",
      toolName: "read",
      outcome: "cancelled",
      attempts: 1,
      errorCode: "cancelled",
    });
  });

  it("partitions personal budgets by principal while sharing shared budgets", async () => {
    const connectors = ["personal", "shared"].map((id) =>
      connectorWith({
        id,
        ...(id === "personal" ? { authScope: "personal" as const } : {}),
        tools: [READ_TOOL],
        call: async () => ({}),
        callAdmission: policy({ budget: { kind: "rolling-window", maxCalls: 1, windowMs: 60_000 } }),
      }),
    );
    const registry = makeRegistry(connectors);
    const alice = registry.scoped({ connectorIds: "all", principalKey: "alice" });
    const bob = registry.scoped({ connectorIds: "all", principalKey: "bob" });
    const input = { toolName: "read", args: {} };
    (await alice.admitCall("personal", input)).release();
    (await bob.admitCall("personal", input)).release();
    for (const view of [alice, bob])
      await expect(view.admitCall("personal", input)).rejects.toMatchObject({ code: "rate_limited" });
    (await alice.admitCall("shared", input)).release();
    await expect(bob.admitCall("shared", input)).rejects.toMatchObject({ code: "rate_limited" });
    expect(registry.callAdmissionSnapshot().personal).toMatchObject({ totals: { admitted: 2, rateLimited: 2 } });
    registry.closeCallAdmission();
  });

  it("retains personal budgets at the registry cap and evicts only drained controllers", async () => {
    vi.useFakeTimers();
    try {
      const registry = makeRegistry([
        connectorWith({
          id: "personal",
          authScope: "personal",
          tools: [READ_TOOL],
          call: async () => ({}),
          callAdmission: policy({ budget: { kind: "rolling-window", maxCalls: 1, windowMs: 1_000 } }),
        }),
      ]);
      const input = { toolName: "read", args: {} };
      const first = registry.scoped({ connectorIds: "all", principalKey: "0" });
      (await first.admitCall("personal", input)).release();
      for (let i = 1; i < 1_024; i++) {
        const view = registry.scoped({ connectorIds: "all", principalKey: String(i) });
        (await view.admitCall("personal", input)).release();
      }
      expect(() => registry.scoped({ connectorIds: "all", principalKey: "overflow" })).toThrow(/capacity is exhausted/);
      await expect(first.admitCall("personal", input)).rejects.toMatchObject({ code: "rate_limited" });
      vi.advanceTimersByTime(1_000);
      const next = registry.scoped({ connectorIds: "all", principalKey: "overflow" });
      await expect(first.admitCall("personal", input)).rejects.toMatchObject({ admissionKind: "closed" });
      (await next.admitCall("personal", input)).release();
      registry.closeCallAdmission();
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes payload-free connector aggregates on health", async () => {
    const connector: Connector = connectorWith({
      id: "limited",
      kind: "api",
      description: "Limited",
      staticTools: [READ_TOOL],
      callAdmission: policy({
        maxConcurrency: 1,
        partitionKey: () => "tenant-visible-only-inside-the-limiter",
      }),
      tools: [READ_TOOL],
      call: async () => ({}),
    });
    const connecta = createTestConnecta({
      connectors: [connector],
      logger: silentLogger,
    });
    const permit = await connecta.registry.admitCall("limited", {
      toolName: "read",
      args: { privatePayload: "never expose me" },
    });
    const response = await connecta.fetch(new Request(`${BASE}/health`));
    const body = await response.json();
    const text = JSON.stringify(body);

    expect(body).toMatchObject({
      admission: {
        downstreamCalls: {
          policy: "connector-partitioned-per-runtime",
          aggregate: {
            rules: 1,
            partitions: 1,
            active: 1,
            queued: 0,
            totals: {
              admitted: 1,
              rejected: 0,
              rateLimited: 0,
            },
          },
        },
      },
    });
    expect(text).not.toContain('"limited"');
    expect(text).not.toContain("tenant-visible-only-inside-the-limiter");
    expect(text).not.toContain("never expose me");
    permit.release();
    await connecta.close();
  });

  it("returns admission retry hints without waiting or poisoning connector health", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      let calls = 0;
      const events: Array<{ outcome: string; attempts: number; errorCode?: string }> = [];
      const connector: Connector = connectorWith({
        id: "budgeted",
        kind: "api",
        description: "Budgeted",
        staticTools: [READ_TOOL],
        callAdmission: policy({
          budget: {
            kind: "rolling-window",
            maxCalls: 1,
            windowMs: 50,
          },
        }),
        tools: [READ_TOOL],
        call: async () => {
          calls++;
          return { calls };
        },
      });
      const registry = makeRegistry([connector]);
      const activity = {
        recordTool: recordToolActivity,
        sink: {
          record(event: (typeof events)[number]) {
            events.push(event);
          },
        },
        actor: { kind: "test" },
        requestId: "request",
        serverInfo: { name: "connecta", version: "test" },
        logger: silentLogger,
      };
      const tools = createMetaTools(registry, BASE, { activity });
      await tools.callTool({ address: "budgeted.read" });

      const refused = await tools.callTool({
        address: "budgeted.read",
        resultMode: "value",
      });
      expect(JSON.parse(required(refused.content[0]).text)).toMatchObject({
        ok: false,
        error: {
          code: "rate_limited",
          retryable: true,
          retryAfterMs: 50,
        },
        attempts: 1,
      });
      expect(events.at(-1)).toMatchObject({
        outcome: "error",
        attempts: 1,
        errorCode: "rate_limited",
      });
      expect(events.map(({ outcome, attempts }) => ({ outcome, attempts }))).toEqual([
        { outcome: "success", attempts: 1 },
        { outcome: "error", attempts: 1 },
      ]);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(50);
      const retried = await tools.callTool({ address: "budgeted.read", resultMode: "value" });
      expect(JSON.parse(required(retried.content[0]).text)).toMatchObject({ ok: true, attempts: 1 });
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
