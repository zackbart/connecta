import { describe, expect, it } from "vitest";
import { api } from "../src/connectors/api.js";
import { artifacts, kvArtifactStore } from "../src/artifacts.js";
import { ArtifactOperations } from "../src/artifacts/operations.js";
import { ArtifactRefreshService } from "../src/artifacts/refresh.js";
import type { ArtifactRenderCheck } from "../src/artifacts/connector.js";
import { resolveAllowlist, resolveLimits } from "../src/artifacts/validate.js";
import { createConnecta } from "../src/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Executor, ExecutorProvider } from "../src/types.js";

const actor = { kind: "test", id: "alice" };
const owner = { identity: { actor, interactive: false } };
const source = '<!doctype html><main id="artifact-root"><script>document.body.textContent=window.artifact.data.data.value</script></main>';

function setup(execute: Executor["execute"], access?: () => readonly string[], renderCheck?: ArtifactRenderCheck) {
  let writeCalls = 0;
  let readCalls = 0;
  const store = kvArtifactStore(memoryStorage());
  const module = artifacts({ store, ...(renderCheck ? { renderCheck } : {}) });
  const operations = new ArtifactOperations({ store, limits: resolveLimits(), allowlist: resolveAllowlist() });
  const shared = { ...api("shared", {
    description: "Shared test data",
    tools: [
      { name: "read", description: "Read", annotations: { readOnlyHint: true },
        handler: async () => { readCalls++; return { value: 2 }; } },
      { name: "write", description: "Write", annotations: { readOnlyHint: false },
        handler: async () => { writeCalls++; return { written: true }; } },
    ],
  }), approval: "never" as const };
  const personal = { ...api("personal", {
    description: "Private test data",
    tools: [{ name: "read", description: "Read", annotations: { readOnlyHint: true },
      handler: async () => ({ secret: true }) }],
  }), authScope: "personal" as const };
  const app = createConnecta({
    connectors: [shared, personal], executor: { execute }, artifacts: module,
    publicUrl: "https://connecta.test", storage: memoryStorage(), logger: "silent",
    ...(access ? { identity: { connectorAccess: access } } : {}),
  });
  const create = async () => {
    const made = await operations.create({ id: "weekly", title: "Weekly", kind: "html", source,
      documents: { data: { value: 1 } }, by: actor });
    if (!made.ok) throw new Error(made.message);
  };
  const configure = async (program: string, schedule: "manual" | "daily" | "weekly" = "manual") => {
    const saved = await operations.setRefresh({
      id: "weekly", document: "data", program, schedule, baseVersion: 0, by: actor, owner,
    });
    if (!saved.ok) throw new Error(saved.message);
  };
  return { app, module, operations, store, create, configure,
    writeCalls: () => writeCalls, readCalls: () => readCalls };
}

const hostCall = (providers: ExecutorProvider[], address: string) =>
  providers[0]!.fns.call!(address, {});

describe("artifact refresh", () => {
  it("settles an unresponsive admission wait at claim expiry before another run starts", async () => {
    const { operations, create, configure } = setup(async () => ({ result: null }));
    await create();
    await configure("async () => ({ value: 2 })");
    const refresh = new ArtifactRefreshService(operations);
    let attempts = 0;
    let dispatched = 0;
    refresh.bind({ claimMs: 40, execute: async () => {
      attempts++;
      if (attempts === 1) {
        await new Promise<void>(() => {});
      }
      dispatched++;
      return { content: [{ type: "text", text: JSON.stringify({ result: { value: 2 } }) }] };
    } });
    const first = refresh.run("weekly", { manual: actor });
    for (let n = 0; n < 100 && attempts === 0; n++) await Promise.resolve();
    expect(attempts).toBe(1);
    expect(await refresh.run("weekly", { manual: actor })).toEqual({ status: "skipped" });
    expect(await first).toMatchObject({ status: "failed" });
    expect(dispatched).toBe(0);
    expect(await refresh.run("weekly", { manual: actor })).toMatchObject({ status: "succeeded" });
    expect(dispatched).toBe(1);
  });

  it("records a failed run and releases its claim when the first history write fails", async () => {
    const { module, operations, create, configure, store } = setup(async () => ({ result: { value: 2 } }));
    await create();
    await configure("async () => ({ value: 2 })");
    const putRun = store.putRun.bind(store);
    let fail = true;
    store.putRun = async (...args) => {
      if (fail) { fail = false; throw new Error("temporary run-store failure"); }
      return putRun(...args);
    };
    expect(await module.refresh("weekly", actor)).toMatchObject({ status: "failed" });
    expect((await store.head("weekly"))?.head.refresh?.claim).toBeUndefined();
    expect((await store.head("weekly"))?.head.refresh?.last?.status).toBe("failed");
    expect((await store.runs("weekly", 1))[0]?.message).toContain("temporary run-store failure");
    expect(await operations.getDocument("weekly", "data")).toMatchObject({ ok: true, value: { value: 1 } });
  });

  it("marks a prior good page stale when its refresh program body becomes unreadable", async () => {
    const { module, operations, create, configure, store } = setup(async () => ({ result: { value: 2 } }));
    await create();
    await configure("async () => ({ value: 2 })");
    expect(await module.refresh("weekly", actor)).toMatchObject({ status: "succeeded" });
    const body = store.body.bind(store);
    const key = (await store.head("weekly"))?.head.refresh?.program.body;
    store.body = async (requested) => {
      if (requested === key) throw new Error("temporary body-store failure");
      return body(requested);
    };
    expect(await module.refresh("weekly", actor)).toMatchObject({ status: "failed" });
    expect((await store.head("weekly"))?.head.refresh?.last?.status).toBe("failed");
    expect((await store.head("weekly"))?.head.refresh?.claim).toBeUndefined();
    expect((await store.runs("weekly", 2))[0]?.message).toContain("temporary body-store failure");
    expect(await operations.getDocument("weekly", "data")).toMatchObject({ ok: true, value: { value: 2 } });
  });
  it("runs the configured render check before publishing refreshed data", async () => {
    let checked = 0;
    const { module, operations, create, configure, store } = setup(async () => ({ result: { value: 2 } }),
      undefined, async ({ document }) => {
        checked++;
        expect(document).toContain('"value":2');
        return { ok: false, errors: ["private render rejection"] };
      });
    await create();
    await configure("async () => ({ value: 2 })");
    expect(await module.refresh("weekly", actor)).toMatchObject({ status: "failed" });
    expect(checked).toBe(1);
    expect(await operations.getDocument("weekly", "data")).toMatchObject({ ok: true, value: { value: 1 } });
    expect((await store.head("weekly"))?.head.refresh?.last?.status).toBe("failed");
  });
  it("rechecks the program owner's current connector grants before each run", async () => {
    let grant: readonly string[] = ["artifacts"];
    let dispatched = 0;
    const { module, operations, create, configure, readCalls } = setup(async (_code, providers) => {
      dispatched++;
      return { result: await hostCall(providers, "shared.read") };
    }, () => grant);
    await create();
    await configure('async () => connecta.call("shared.read", {})');
    expect(await module.refresh("weekly", actor)).toMatchObject({ status: "failed" });
    expect(dispatched).toBe(1);
    expect(readCalls()).toBe(0);
    expect(await operations.getDocument("weekly", "data")).toMatchObject({ ok: true, value: { value: 1 } });
    grant = ["artifacts", "shared.read"];
    expect(await module.refresh("weekly", actor)).toMatchObject({ status: "succeeded" });
    expect(readCalls()).toBe(1);
    grant = ["artifacts.run_refresh", "shared.read"];
    expect(await module.refresh("weekly", actor)).toMatchObject({ status: "failed" });
    expect(readCalls()).toBe(1);
    expect(await operations.getDocument("weekly", "data")).toMatchObject({ ok: true, value: { value: 2 } });
  });
  it("runs a shared read and makes one validated data version", async () => {
    const { module, operations, store, create, configure } = setup(async (_code, providers) => ({
      result: await hostCall(providers, "shared.read"), logs: ["refreshed"],
    }));
    await create();
    await configure('async () => connecta.call("shared.read", {})');
    const outcome = await module.refresh("weekly", actor);
    expect(outcome).toMatchObject({ status: "succeeded", documentVersion: 2 });
    expect(await operations.getDocument("weekly", "data")).toMatchObject({ ok: true, value: { value: 2 } });
    expect((await store.runs("weekly", 5))[0]).toMatchObject({
      status: "succeeded", documentVersion: 2, trigger: { manual: actor }, logs: "refreshed",
    });
    expect((await store.head("weekly"))?.head.refresh?.last?.status).toBe("succeeded");
  });

  it("fails a caught write or personal call with a typed error and preserves last-good data", async () => {
    let dispatched = 0;
    const { module, operations, store, create, configure, writeCalls } = setup(async (code, providers) => {
      try {
        await hostCall(providers, code.includes("personal") ? "personal.read" : "shared.write");
      } catch { /* Guest code catches the refusal; the refresh still fails. */ }
      dispatched++;
      return { result: { value: 999 } };
    });
    await create();
    await configure('async () => connecta.call("shared.write", {})');
    expect(await module.refresh("weekly", actor)).toMatchObject({ status: "failed", errorCode: expect.any(String) });
    const first = (await store.runs("weekly", 1))[0];
    expect(first?.errorCode).toBeTruthy();
    const current = await operations.refreshConfig("weekly");
    if (!current.ok) throw new Error(current.message);
    expect(await operations.setRefresh({ id: "weekly", document: "data",
      program: 'async () => connecta.call("personal.read", {})', schedule: "manual",
      baseVersion: 1, by: actor, owner })).toMatchObject({ ok: true });
    expect(await module.refresh("weekly", actor)).toMatchObject({ status: "failed", errorCode: expect.any(String) });
    expect(await operations.getDocument("weekly", "data")).toMatchObject({ ok: true, value: { value: 1 } });
    expect(writeCalls()).toBe(0);
    expect(dispatched).toBe(2);
  });

  it("claims once across concurrent triggers and fences an expired old claim", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    const { module, operations, store, create, configure } = setup(async () => {
      entered++;
      await blocked;
      return { result: { value: 2 } };
    });
    await create();
    await configure("async () => 2");
    const first = module.refresh("weekly", actor);
    for (let n = 0; n < 100 && entered === 0; n++) await Promise.resolve();
    expect(entered).toBe(1);
    expect(await module.refresh("weekly", actor)).toEqual({ status: "skipped" });
    release();
    expect(await first).toMatchObject({ status: "succeeded" });
    const current = await store.head("weekly");
    expect(current?.head.documents.data?.version).toBe(2);
    const stale = await operations.setDocuments({ id: "weekly", documents: { data: { baseVersion: 2, value: { value: 3 } } },
      by: { kind: "refresh" }, op: "refresh", runId: "old", programVersion: 1 });
    expect(stale).toMatchObject({ ok: false, code: "conflict" });
    expect((await store.head("weekly"))?.head.documents.data?.version).toBe(2);
  });

  it("never publishes an old run after a new claim replaces its expired claim", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    const { module, operations, store, create, configure } = setup(async () => {
      entered++;
      if (entered === 1) await blocked;
      return { result: { value: entered } };
    });
    await create();
    await configure("async () => 2");
    const old = module.refresh("weekly", actor);
    for (let n = 0; n < 100 && entered === 0; n++) await Promise.resolve();
    expect(entered).toBe(1);
    const current = await store.head("weekly");
    if (!current?.head.refresh?.claim) throw new Error("missing claim");
    expect(await store.swapHead("weekly", current.token, {
      ...current.head,
      refresh: { ...current.head.refresh, claim: {
        ...current.head.refresh.claim, until: "2000-01-01T00:00:00.000Z",
      } },
    })).toBe(true);
    const newer = await module.refresh("weekly", actor);
    expect(newer).toMatchObject({ status: "succeeded", documentVersion: 2 });
    release();
    expect(await old).toMatchObject({ status: "superseded" });
    expect(await operations.getDocument("weekly", "data")).toMatchObject({ ok: true, value: { value: 2 } });
    expect((await store.head("weekly"))?.head.refresh?.last?.runId).toBe(newer.status === "skipped" ? "" : newer.runId);
  });

  it("runs weekly work only when due and keeps a failed run stale", async () => {
    let fail = false;
    const { module, operations, store, create, configure } = setup(async () =>
      fail ? { result: undefined, error: "downstream unavailable" } : { result: { value: 2 } });
    await create();
    await configure("async () => 2", "weekly");
    expect(await module.runDue()).toMatchObject({ started: 0 });
    const configured = await store.head("weekly");
    if (!configured?.head.refresh) throw new Error("missing refresh");
    expect(await store.swapHead("weekly", configured.token, {
      ...configured.head,
      refresh: { ...configured.head.refresh, configuredAt: "2000-01-01T00:00:00.000Z" },
    })).toBe(true);
    expect(await module.runDue()).toMatchObject({ started: 1, succeeded: 1 });
    expect(await module.runDue()).toMatchObject({ started: 0 });
    const afterSuccess = await store.head("weekly");
    if (!afterSuccess?.head.refresh?.last) throw new Error("missing last run");
    fail = true;
    expect(await store.swapHead("weekly", afterSuccess.token, {
      ...afterSuccess.head,
      refresh: { ...afterSuccess.head.refresh,
        last: { ...afterSuccess.head.refresh.last, at: "2000-01-01T00:00:00.000Z" } },
    })).toBe(true);
    expect(await module.runDue()).toMatchObject({ started: 1, failed: 1 });
    expect(await operations.getDocument("weekly", "data")).toMatchObject({ ok: true, value: { value: 2 } });
    expect((await store.head("weekly"))?.head.refresh?.last?.status).toBe("failed");
  });

  it("persists a scan cursor so a due head beyond the first 1,000 is reached", async () => {
    const { module, store, create, configure } = setup(async () => ({ result: { value: 2 } }));
    await create();
    await configure("async () => ({ value: 2 })", "weekly");
    const current = await store.head("weekly");
    if (!current?.head.refresh) throw new Error("missing refresh");
    expect(await store.swapHead("weekly", current.token, {
      ...current.head, refresh: { ...current.head.refresh, configuredAt: "2000-01-01T00:00:00.000Z" },
    })).toBe(true);
    const due = (await store.head("weekly"))!.head;
    const fakeHead = { ...due };
    delete fakeHead.refresh;
    const entries = Array.from({ length: 1_000 }, (_, n) => ({
      id: `f${String(n).padStart(4, "0")}`, head: fakeHead,
    })).concat([{ id: "weekly", head: due }]);
    store.heads = async ({ after, limit }) => {
      const start = after ? entries.findIndex((entry) => entry.id === after) + 1 : 0;
      const heads = entries.slice(start, start + limit);
      return { heads, ...(start + limit < entries.length ? { next: heads.at(-1)!.id } : {}) };
    };
    expect(await module.runDue()).toMatchObject({ scanned: 1_000, started: 0, capped: true });
    expect(await store.refreshScanCursor()).toBe("f0999");
    expect(await module.runDue()).toMatchObject({ scanned: 1, started: 1, succeeded: 1 });
  });

  it("advances past a listed page whose head records were deleted", async () => {
    const { module, store, create, configure } = setup(async () => ({ result: { value: 2 } }));
    await create();
    await configure("async () => ({ value: 2 })", "weekly");
    const current = await store.head("weekly");
    if (!current?.head.refresh) throw new Error("missing refresh");
    expect(await store.swapHead("weekly", current.token, {
      ...current.head, refresh: { ...current.head.refresh, configuredAt: "2000-01-01T00:00:00.000Z" },
    })).toBe(true);
    const due = (await store.head("weekly"))!.head;
    store.heads = async ({ after }) => after
      ? { heads: [{ id: "weekly", head: due }] }
      : { heads: [], next: "f0099" };
    expect(await module.runDue()).toMatchObject({ scanned: 101, started: 1, succeeded: 1 });
  });
});
