import { expect, it } from "vitest";
import {
  ARTIFACT_RUNS_RETAINED,
  type ArtifactHeadRecord,
  type ArtifactRunRecord,
  type ArtifactStore,
  type ArtifactVersionRecord,
} from "../src/artifacts.js";

/**
 * Shared cases every `ArtifactStore` must pass. Not a suite: each adapter's
 * own suite calls this inside its `describe`, so the same contract runs
 * against memory, the Node file store, and the Worker example's D1 (and D1 +
 * R2) stores.
 */

const actor = { kind: "bearer", id: "tester" };

export function headRecord(revision: number, title = "Page"): ArtifactHeadRecord {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, revision)).toISOString();
  return {
    revision,
    title,
    kind: "html",
    archived: false,
    createdBy: actor,
    createdAt: at,
    updatedBy: actor,
    updatedAt: at,
    view: { version: revision, body: "b".repeat(64), bytes: 10, by: actor, at, op: "update" },
    documents: {},
  };
}

function versionRecord(version: number): ArtifactVersionRecord {
  return {
    version,
    body: String(version).padStart(64, "0"),
    bytes: version,
    by: actor,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, version)).toISOString(),
    op: version === 1 ? "create" : "update",
  };
}

function run(index: number): ArtifactRunRecord {
  return {
    runId: `run-${String(index).padStart(3, "0")}`,
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    status: "succeeded",
    trigger: "schedule",
    programVersion: 1,
  };
}

export function artifactStoreContract(
  open: () => ArtifactStore | Promise<ArtifactStore>,
): void {
  it("lets exactly one of 20 concurrent creates win", async () => {
    const store = await open();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.swapHead("race", null, headRecord(1, `writer ${i}`)),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.indexOf(true);
    expect((await store.head("race"))?.head.title).toBe(`writer ${winner}`);
  });

  it("swaps only from the current token, and a stale token loses", async () => {
    const store = await open();
    expect(await store.head("page")).toBeNull();
    expect(await store.swapHead("page", null, headRecord(1))).toBe(true);
    const first = await store.head("page");
    expect(first?.head.revision).toBe(1);
    expect(await store.swapHead("page", null, headRecord(2))).toBe(false);
    expect(await store.swapHead("page", first?.token ?? "", headRecord(2))).toBe(true);
    expect(await store.swapHead("page", first?.token ?? "", headRecord(3))).toBe(false);
    expect((await store.head("page"))?.head.revision).toBe(2);
  });

  it("lets exactly one of 20 concurrent swaps from one token win", async () => {
    const store = await open();
    await store.swapHead("page", null, headRecord(1));
    const token = (await store.head("page"))?.token ?? "";
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.swapHead("page", token, headRecord(2, `writer ${i}`)),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("persists the bounded refresh scan cursor", async () => {
    const store = await open();
    expect(await store.refreshScanCursor()).toBeUndefined();
    await store.setRefreshScanCursor("page-1000");
    expect(await store.refreshScanCursor()).toBe("page-1000");
    await store.setRefreshScanCursor(undefined);
    expect(await store.refreshScanCursor()).toBeUndefined();
  });

  it("stores bodies by key, idempotently, and round-trips a mebibyte", async () => {
    const store = await open();
    expect(await store.body("a".repeat(64))).toBeNull();
    const big = `<!doctype html>${"é".repeat(512 * 1024)}`;
    await store.putBody("a".repeat(64), big);
    await store.putBody("a".repeat(64), big);
    expect(await store.body("a".repeat(64))).toBe(big);
  });

  it("keeps versions idempotent, newest first, and pages below a version", async () => {
    const store = await open();
    for (let version = 1; version <= 12; version++) {
      await store.putVersion("page", "view", version, versionRecord(version));
    }
    await store.putVersion("page", "view", 3, versionRecord(3));
    await store.putVersion("page", "doc:data", 1, versionRecord(1));
    const all = await store.versions("page", "view", { limit: 100 });
    expect(all.map((record) => record.version)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(
      (await store.versions("page", "view", { below: 12, limit: 3 })).map((r) => r.version),
    ).toEqual([11, 10, 9]);
    expect(
      (await store.versions("page", "view", { below: 3, limit: 5 })).map((r) => r.version),
    ).toEqual([2, 1]);
    expect(
      (await store.versions("page", "view", { below: 9, limit: 1 }))[0],
    ).toEqual(versionRecord(8));
    expect(await store.versions("page", "doc:data", { limit: 10 })).toEqual([versionRecord(1)]);
    expect(await store.versions("other", "view", { limit: 10 })).toEqual([]);
    expect(await store.versions("page", "view", { limit: 0 })).toEqual([]);
  });

  it("lists heads in id order with a cursor", async () => {
    const store = await open();
    for (const id of ["delta", "alpha", "charlie", "bravo", "echo"]) {
      await store.swapHead(id, null, headRecord(1, id));
    }
    const first = await store.heads({ limit: 2 });
    expect(first.heads.map((item) => item.id)).toEqual(["alpha", "bravo"]);
    expect(first.next).toBe("bravo");
    const second = await store.heads({ after: first.next ?? "", limit: 2 });
    expect(second.heads.map((item) => item.id)).toEqual(["charlie", "delta"]);
    const last = await store.heads({ after: second.next ?? "", limit: 2 });
    expect(last.heads.map((item) => item.id)).toEqual(["echo"]);
    expect(last.next).toBeUndefined();
    expect(last.heads[0]?.head.title).toBe("echo");
  });

  it("does not mistake one id for a prefix of another", async () => {
    const store = await open();
    await store.putVersion("q3", "view", 1, versionRecord(1));
    await store.putVersion("q3-bugs", "view", 1, versionRecord(1));
    await store.putVersion("q3-bugs", "view", 2, versionRecord(2));
    expect(await store.versions("q3", "view", { limit: 10 })).toHaveLength(1);
    await store.putRun("q3-bugs", run(1));
    expect(await store.runs("q3", 10)).toEqual([]);
  });

  it(`replaces a run by id and retains the newest ${ARTIFACT_RUNS_RETAINED}`, async () => {
    const store = await open();
    for (let index = 1; index <= ARTIFACT_RUNS_RETAINED + 5; index++) {
      await store.putRun("page", { ...run(index), status: "running" });
      await store.putRun("page", run(index));
    }
    const runs = await store.runs("page", 100);
    expect(runs).toHaveLength(ARTIFACT_RUNS_RETAINED);
    expect(runs[0]?.runId).toBe(`run-${String(ARTIFACT_RUNS_RETAINED + 5).padStart(3, "0")}`);
    expect(runs.at(-1)?.runId).toBe("run-006");
    expect(runs.every((record) => record.status === "succeeded")).toBe(true);
    expect((await store.runs("page", 3)).map((record) => record.runId)).toEqual([
      "run-055",
      "run-054",
      "run-053",
    ]);
    // A hundred and ten writes, each followed by a retention listing: over a
    // local D1 proxy on a loaded machine that is seconds, not milliseconds.
  }, 60_000);
}
