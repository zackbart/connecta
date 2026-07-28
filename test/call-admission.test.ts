import { describe, expect, it, vi } from "vitest";
import {
  CallAdmissionError,
  ConnectorCallAdmissionController,
} from "../src/call-admission.js";
import { buildSandboxProviders } from "../src/execute.js";
import { createConnecta } from "../src/index.js";
import { createMetaTools } from "../src/meta-tools.js";
import { ScopedRegistry } from "../src/registry.js";
import { resolveToolkits } from "../src/toolkits.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
  ToolDef,
} from "../src/types.js";
import { makeRegistry, silentLogger } from "./helpers.js";

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

      await expect(
        admission.acquire({ toolName: "read", args: {} }),
      ).rejects.toMatchObject({
        name: "CallAdmissionError",
        admissionKind: "budget",
        code: "rate_limited",
        retryable: true,
        retryAfterMs: 750,
      });
      expect(admission.snapshot().totals.rateLimited).toBe(1);

      vi.setSystemTime(10_999);
      await expect(
        admission.acquire({ toolName: "read", args: {} }),
      ).rejects.toMatchObject({ retryAfterMs: 1 });
      vi.setSystemTime(11_000);
      (await admission.acquire({ toolName: "read", args: {} })).release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes queued cancellation without consuming a budget token", async () => {
    const admission = new ConnectorCallAdmissionController(
      "limited",
      policy({
        maxConcurrency: 1,
        maxQueueSize: 2,
        budget: {
          kind: "rolling-window",
          maxCalls: 2,
          windowMs: 60_000,
        },
      }),
    );
    const active = await admission.acquire({ toolName: "read", args: {} });
    const controller = new AbortController();
    const cancelled = admission.acquire({
      toolName: "read",
      args: {},
      signal: controller.signal,
    });
    controller.abort(new Error("caller left"));

    await expect(cancelled).rejects.toMatchObject({
      admissionKind: "cancelled",
    });
    active.release();
    (await admission.acquire({ toolName: "read", args: {} })).release();
    await expect(
      admission.acquire({ toolName: "read", args: {} }),
    ).rejects.toMatchObject({ admissionKind: "budget" });
    expect(admission.snapshot().totals).toMatchObject({
      admitted: 2,
      cancelled: 1,
      rateLimited: 1,
    });
  });

  it("does not admit when partition derivation synchronously cancels", async () => {
    const controller = new AbortController();
    const admission = new ConnectorCallAdmissionController(
      "limited",
      policy({
        maxConcurrency: 1,
        budget: {
          kind: "rolling-window",
          maxCalls: 1,
          windowMs: 60_000,
        },
        partitionKey() {
          controller.abort(new Error("cancelled during partitioning"));
          return "project";
        },
      }),
    );

    await expect(
      admission.acquire({
        toolName: "read",
        args: { privatePayload: true },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ admissionKind: "cancelled" });
    expect(admission.snapshot()).toMatchObject({
      active: 0,
      partitions: 0,
      totals: { admitted: 0, cancelled: 1 },
    });
  });

  it("snapshots validated rule values instead of retaining mutable config", async () => {
    const configured = policy({
      maxConcurrency: 2,
      budget: {
        kind: "rolling-window",
        maxCalls: 2,
        windowMs: 60_000,
      },
      partitionKey: () => "original",
    });
    const admission = new ConnectorCallAdmissionController(
      "limited",
      configured,
    );
    const mutable = configured.rules[0] as {
      maxConcurrency?: number;
      budget?: { maxCalls: number; windowMs: number };
      partitionKey?: () => string;
    };
    mutable.maxConcurrency = 1;
    mutable.budget!.maxCalls = 1;
    mutable.partitionKey = () => "mutated";

    const first = await admission.acquire({ toolName: "read", args: {} });
    const second = await admission.acquire({ toolName: "read", args: {} });
    expect(admission.snapshot()).toMatchObject({
      partitions: 1,
      active: 2,
      totals: { admitted: 2, rateLimited: 0 },
    });
    first.release();
    second.release();
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
      await expect(
        bounded.acquire({ toolName: "read", args: "b" }),
      ).rejects.toMatchObject({
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
      await expect(
        throwing.acquire({ toolName: "read", args: {} }),
      ).rejects.toMatchObject({
        admissionKind: "partition",
        code: "connector_call_failed",
        message:
          'Connector "throwing" call-admission partitionKey threw.',
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

  it("rejects empty and multi-rule policies until atomic multi-rule admission exists", () => {
    expect(
      () =>
        new ConnectorCallAdmissionController("empty", {
          rules: [],
        }),
    ).toThrow("must contain exactly one rule");
    expect(
      () =>
        new ConnectorCallAdmissionController("many", {
          rules: [{ maxConcurrency: 1 }, { maxConcurrency: 2 }],
        }),
    ).toThrow("must contain exactly one rule");
  });
});

describe("connector call admission integration", () => {
  it("bounds concurrent batch children and preserves input order", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const connector: Connector = {
      id: "limited",
      kind: "api",
      description: "Limited",
      staticTools: [READ_TOOL],
      callAdmission: policy({ maxConcurrency: 2, maxQueueSize: 4 }),
      async listTools() {
        return [READ_TOOL];
      },
      async callTool(_name, args) {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return { index: (args as { index: number }).index };
      },
    };
    const registry = makeRegistry([connector]);
    const batch = createMetaTools(registry, BASE).batchCall({
      resultMode: "value",
      calls: [0, 1, 2, 3].map((index) => ({
        address: "limited.read",
        args: { index },
      })),
    });

    await waitFor(() => releases.length === 2);
    expect(registry.callAdmissionSnapshot().limited).toMatchObject({
      active: 2,
      queued: 2,
    });
    releases.splice(0, 2).forEach((release) => release());
    await waitFor(() => releases.length === 2);
    releases.splice(0, 2).forEach((release) => release());

    const result = JSON.parse((await batch).content[0].text) as {
      results: Array<{ data: { index: number } }>;
    };
    expect(maxActive).toBe(2);
    expect(result.results.map((entry) => entry.data.index)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("shares one base-registry limiter between direct and code-mode calls", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const connector: Connector = {
      id: "limited",
      kind: "api",
      description: "Limited",
      staticTools: [READ_TOOL],
      callAdmission: policy({ maxConcurrency: 1, maxQueueSize: 2 }),
      async listTools() {
        return [READ_TOOL];
      },
      async callTool(_name, args) {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return args;
      },
    };
    const registry = makeRegistry([connector]);
    const direct = createMetaTools(registry, BASE).callTool({
      address: "limited.read",
      args: { source: "direct" },
    });
    await waitFor(() => releases.length === 1);

    const providers = await buildSandboxProviders(
      registry,
      BASE,
      silentLogger,
    );
    const provider = providers.find(({ name }) => name === "limited")!;
    const codeMode = provider.fns.read({ source: "code" });
    await waitFor(
      () => registry.callAdmissionSnapshot().limited.queued === 1,
    );

    releases.shift()!();
    await direct;
    await waitFor(() => releases.length === 1);
    releases.shift()!();
    await expect(codeMode).resolves.toEqual({ source: "code" });
    expect(maxActive).toBe(1);
  });

  it("makes toolkit views contend on the base registry's limiter", async () => {
    const connector: Connector = {
      id: "limited",
      kind: "api",
      description: "Limited",
      staticTools: [READ_TOOL],
      callAdmission: policy({ maxConcurrency: 1, maxQueueSize: 1 }),
      async listTools() {
        return [READ_TOOL];
      },
      async callTool() {
        return {};
      },
    };
    const registry = makeRegistry([connector]);
    const toolkit = resolveToolkits(
      { team: { connectors: ["limited"] } },
      [connector],
    )!.get("team")!;
    const scoped = new ScopedRegistry(registry, toolkit);
    const basePermit = await registry.admitCall("limited", {
      toolName: "read",
      args: {},
    });
    const scopedPermit = scoped.admitCall("limited", {
      toolName: "read",
      args: {},
    });

    await waitFor(
      () => registry.callAdmissionSnapshot().limited.queued === 1,
    );
    basePermit.release();
    (await scopedPermit).release();
    expect(registry.callAdmissionSnapshot().limited).toMatchObject({
      active: 0,
      queued: 0,
      totals: { admitted: 2, queued: 1 },
    });
  });

  it("threads direct-call cancellation into the shared admission queue", async () => {
    let release!: () => void;
    const connector: Connector = {
      id: "limited",
      kind: "api",
      description: "Limited",
      staticTools: [READ_TOOL],
      callAdmission: policy({ maxConcurrency: 1, maxQueueSize: 1 }),
      async listTools() {
        return [READ_TOOL];
      },
      async callTool() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {};
      },
    };
    const registry = makeRegistry([connector]);
    const active = createMetaTools(registry, BASE).callTool({
      address: "limited.read",
    });
    await waitFor(
      () => registry.callAdmissionSnapshot().limited.active === 1,
    );
    const controller = new AbortController();
    const queued = createMetaTools(registry, BASE, {
      requestSignal: controller.signal,
    }).callTool({
      address: "limited.read",
      resultMode: "value",
    });
    await waitFor(
      () => registry.callAdmissionSnapshot().limited.queued === 1,
    );
    controller.abort(new Error("caller left"));

    expect(JSON.parse((await queued).content[0].text)).toMatchObject({
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
    const connector: Connector = {
      id: "limited",
      kind: "api",
      description: "Limited",
      staticTools: [READ_TOOL],
      callAdmission: policy({ maxConcurrency: 1 }),
      async listTools() {
        return [READ_TOOL];
      },
      async callTool(_name, _args, ctx) {
        calls++;
        connectorSignal = ctx.signal;
        await new Promise<never>((_, reject) => {
          const cancelled = () =>
            reject(ctx.signal?.reason ?? new Error("caller left"));
          ctx.signal?.addEventListener("abort", cancelled, { once: true });
          if (ctx.signal?.aborted) cancelled();
        });
      },
    };
    const registry = makeRegistry([connector]);
    const activity = {
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
      maxRetries: 2,
      resultMode: "value",
    });
    await waitFor(() => calls === 1);
    controller.abort(new Error("caller left"));

    expect(JSON.parse((await pending).content[0].text)).toMatchObject({
      ok: false,
      error: { code: "cancelled", retryable: false },
      attempts: 1,
    });
    expect(calls).toBe(1);
    expect(connectorSignal?.aborted).toBe(true);
    expect(registry.healthFor("limited")).toBeUndefined();
    expect(registry.callAdmissionSnapshot().limited).toMatchObject({
      active: 0,
      queued: 0,
      totals: { admitted: 1 },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "cancelled",
      attempts: 1,
      errorCode: "cancelled",
    });
  });

  it("refuses an already-cancelled call before connector dispatch", async () => {
    let calls = 0;
    const connector: Connector = {
      id: "limited",
      kind: "api",
      description: "Limited",
      staticTools: [READ_TOOL],
      callAdmission: policy({ maxConcurrency: 1 }),
      async listTools() {
        return [READ_TOOL];
      },
      async callTool() {
        calls++;
        return {};
      },
    };
    const registry = makeRegistry([connector]);
    const controller = new AbortController();
    controller.abort(new Error("caller already left"));

    const result = await createMetaTools(registry, BASE, {
      requestSignal: controller.signal,
    }).callTool({
      address: "limited.read",
      maxRetries: 2,
      resultMode: "value",
    });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: false,
      error: { code: "cancelled", retryable: false },
      attempts: 1,
    });
    expect(calls).toBe(0);
    expect(registry.healthFor("limited")).toBeUndefined();
  });

  it("exposes payload-free connector aggregates on health", async () => {
    const connector: Connector = {
      id: "limited",
      kind: "api",
      description: "Limited",
      staticTools: [READ_TOOL],
      callAdmission: policy({
        maxConcurrency: 1,
        partitionKey: () => "tenant-visible-only-inside-the-limiter",
      }),
      async listTools() {
        return [READ_TOOL];
      },
      async callTool() {
        return {};
      },
    };
    const connecta = createConnecta({
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
          connectors: {
            limited: {
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
      },
    });
    expect(text).not.toContain("tenant-visible-only-inside-the-limiter");
    expect(text).not.toContain("never expose me");
    permit.release();
    await connecta.close();
  });

  it("retries short proactive windows and does not poison connector health", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      let calls = 0;
      const events: Array<{ outcome: string; attempts: number; errorCode?: string }> =
        [];
      const connector: Connector = {
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
        async listTools() {
          return [READ_TOOL];
        },
        async callTool() {
          calls++;
          return { calls };
        },
      };
      const registry = makeRegistry([connector]);
      const activity = {
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

      const retried = tools.callTool({
        address: "budgeted.read",
        maxRetries: 1,
        resultMode: "value",
      });
      await vi.advanceTimersByTimeAsync(50);
      const body = JSON.parse((await retried).content[0].text) as {
        ok: boolean;
        attempts: number;
      };
      expect(body).toMatchObject({ ok: true, attempts: 2 });
      expect(calls).toBe(2);
      expect(events.at(-1)).toMatchObject({
        outcome: "success",
        attempts: 2,
      });

      const refused = await tools.callTool({
        address: "budgeted.read",
        resultMode: "value",
      });
      expect(JSON.parse(refused.content[0].text)).toMatchObject({
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
      expect(registry.healthFor("budgeted")).toMatchObject({
        consecutiveFailures: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
