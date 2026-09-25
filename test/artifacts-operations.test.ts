import { describe, expect, it } from "vitest";
import {
  kvArtifactStore,
  type ArtifactHeadRecord,
  type ArtifactStore,
} from "../src/artifacts.js";
import { ArtifactOperations, applyPatch } from "../src/artifacts/operations.js";
import { resolveAllowlist, resolveLimits } from "../src/artifacts/validate.js";
import type { ArtifactLimits } from "../src/artifacts/types.js";
import { memoryStorage } from "../src/storage/memory.js";

const alice = { kind: "bearer", id: "alice" };
const bob = { kind: "bearer", id: "bob" };

const page = (body: string) =>
  `<!doctype html>\n<main id="artifact-root">\n${body}\n</main>\n`;

function setup(limits: Partial<ArtifactLimits> = {}, store?: ArtifactStore) {
  let clock = Date.parse("2026-03-01T00:00:00.000Z");
  const artifacts = store ?? kvArtifactStore(memoryStorage());
  const ops = new ArtifactOperations({
    store: artifacts,
    limits: resolveLimits(limits),
    allowlist: resolveAllowlist(),
    now: () => (clock += 1000),
  });
  return { ops, store: artifacts };
}

async function created(ops: ArtifactOperations, id = "q3-bugs") {
  const result = await ops.create({
    id,
    title: "Q3 bugs",
    kind: "html",
    source: page("<h1>Bugs by team</h1>"),
    documents: { data: { rows: [1, 2, 3] } },
    by: alice,
  });
  if (!result.ok) throw new Error(result.message);
  return result.head;
}

describe("creating", () => {
  it("creates the view and its documents in one commit", async () => {
    const { ops } = setup();
    const head = await created(ops);
    expect(head).toMatchObject({
      revision: 1,
      title: "Q3 bugs",
      kind: "html",
      archived: false,
      createdBy: alice,
      view: { version: 1, op: "create", by: alice },
      documents: { data: { version: 1, op: "create", by: alice } },
    });
    const read = await ops.getDocument("q3-bugs", "data");
    expect(read.ok && read.value).toEqual({ rows: [1, 2, 3] });
  });

  it("refuses a taken id, archived ones included", async () => {
    const { ops } = setup();
    const head = await created(ops);
    await ops.setArchived({ id: "q3-bugs", baseRevision: head.revision, archived: true, by: alice });
    const again = await ops.create({
      id: "q3-bugs",
      title: "Again",
      kind: "markdown",
      source: "# again",
      by: bob,
    });
    expect(again).toMatchObject({ ok: false, code: "invalid_args" });
    expect(!again.ok && again.message).toMatch(/is taken \(archived artifacts keep their ids\)/);
  });

  it("refuses ids the URL space reserves and titles over the limit", async () => {
    const { ops } = setup();
    for (const id of ["_api", "_frame", "Upper", "a--", "-a", "", "x".repeat(65)]) {
      const result = await ops.create({ id, title: "t", kind: "markdown", source: "# t", by: alice });
      expect(result, id).toMatchObject({ ok: false, code: "invalid_args" });
    }
    const long = await ops.create({ id: "t", title: "x".repeat(161), kind: "markdown", source: "# t", by: alice });
    expect(!long.ok && long.message).toMatch(/161 characters; the limit is 160/);
  });

  it("refuses invalid pages with the validation attached", async () => {
    const { ops } = setup();
    const result = await ops.create({
      id: "bad",
      title: "Bad",
      kind: "html",
      source: "<p>no root</p>",
      by: alice,
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_args" });
    expect(!result.ok && result.validation?.errors[0]?.code).toBe("E_ROOT");
    expect(!result.ok && result.message).toMatch(/id="artifact-root"/);
  });
});

describe("conflicts", () => {
  it("lets exactly one of two writes from the same base win", async () => {
    const { ops } = setup();
    await created(ops);
    const [first, second] = await Promise.all([
      ops.update({ id: "q3-bugs", baseVersion: 1, source: page("<h1>A</h1>"), by: alice }),
      ops.update({ id: "q3-bugs", baseVersion: 1, source: page("<h1>B</h1>"), by: bob }),
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    const loser = outcomes.find((outcome) => !outcome.ok);
    expect(loser).toMatchObject({
      ok: false,
      code: "conflict",
      current: { revision: 2, view: 2, "document:data": 1 },
    });
    expect(loser && !loser.ok && loser.message).toBe(
      "Artifact 'q3-bugs' view is at version 2, not 1. Re-read it with artifacts.get_artifact, " +
        "reapply the change, and retry with baseVersion 2.",
    );
  });

  it("lets exactly one of twenty concurrent same-base writes win", async () => {
    const { ops } = setup();
    await created(ops);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        ops.patch({
          id: "q3-bugs",
          baseVersion: 1,
          edits: [{ find: "Bugs by team", replace: `Writer ${i}` }],
          by: alice,
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "conflict")).toHaveLength(19);
  });

  it("retries an unrelated head move instead of reporting a conflict", async () => {
    const { ops } = setup();
    await created(ops);
    // Two writers touching different streams from the same head: the second
    // loses the swap, re-reads, finds its own base still current, and lands.
    const [view, data] = await Promise.all([
      ops.update({ id: "q3-bugs", baseVersion: 1, source: page("<h1>New</h1>"), by: alice }),
      ops.setDocuments({ id: "q3-bugs", documents: { data: { baseVersion: 1, value: { rows: [] } } }, by: bob }),
    ]);
    expect(view.ok).toBe(true);
    expect(data.ok).toBe(true);
    const head = (await ops.get("q3-bugs")).ok ? ((await ops.get("q3-bugs")) as { head: ArtifactHeadRecord }).head : undefined;
    expect(head?.revision).toBe(3);
    expect(head?.view.version).toBe(2);
    expect(head?.documents.data?.version).toBe(2);
  });

  it("checks documents against their own versions and archive against the revision", async () => {
    const { ops } = setup();
    const head = await created(ops);
    const stale = await ops.setDocuments({
      id: "q3-bugs",
      documents: { data: { baseVersion: 0, value: 1 }, extra: { baseVersion: 2, value: 1 } },
      by: bob,
    });
    expect(stale).toMatchObject({ ok: false, code: "conflict" });
    expect(!stale.ok && stale.message).toMatch(
      /'data' is at version 1, not 0; 'extra' does not exist yet \(use baseVersion 0\), not version 2/,
    );
    const archive = await ops.setArchived({ id: "q3-bugs", baseRevision: head.revision + 5, archived: true, by: bob });
    expect(!archive.ok && archive.message).toBe(
      "Artifact 'q3-bugs' is at revision 1, not 6. Re-read it with artifacts.get_artifact and retry with baseRevision 1.",
    );
  });
});

describe("history", () => {
  it("never rewrites a version, and rollback appends one reusing the old body", async () => {
    const { ops, store } = setup();
    await created(ops);
    const v2 = await ops.update({ id: "q3-bugs", baseVersion: 1, source: page("<h1>Two</h1>"), by: bob });
    expect(v2.ok).toBe(true);
    const before = await store.versions("q3-bugs", "view", { limit: 10 });
    const rolled = await ops.rollback({ id: "q3-bugs", target: "view", version: 1, baseVersion: 2, by: bob });
    expect(rolled.ok).toBe(true);
    const got = await ops.get("q3-bugs");
    if (!got.ok) throw new Error(got.message);
    expect(got.view).toMatchObject({ version: 3, op: "rollback", restoredFrom: 1, by: bob });
    expect(got.source).toBe(page("<h1>Bugs by team</h1>"));
    expect(got.view.body).toBe(got.history.at(-1)?.body);
    expect(got.history.map((record) => [record.version, record.op])).toEqual([
      [3, "rollback"],
      [2, "update"],
      [1, "create"],
    ]);
    // What was stored before the rollback is still there, byte for byte.
    const after = await store.versions("q3-bugs", "view", { limit: 10 });
    expect(after.slice(-before.length)).toEqual(before);
    const old = await ops.get("q3-bugs", { version: 2 });
    expect(old.ok && old.source).toBe(page("<h1>Two</h1>"));
  });

  it("rolls a document back and refuses a rollback to the current version", async () => {
    const { ops } = setup();
    await created(ops);
    await ops.setDocuments({ id: "q3-bugs", documents: { data: { baseVersion: 1, value: { rows: [9] } } }, by: bob });
    const same = await ops.rollback({ id: "q3-bugs", target: "document", name: "data", version: 2, baseVersion: 2, by: bob });
    expect(same).toMatchObject({ ok: false, code: "invalid_args" });
    const rolled = await ops.rollback({ id: "q3-bugs", target: "document", name: "data", version: 1, baseVersion: 2, by: bob });
    expect(rolled.ok).toBe(true);
    const doc = await ops.getDocument("q3-bugs", "data");
    expect(doc.ok && doc.value).toEqual({ rows: [1, 2, 3] });
    expect(doc.ok && doc.record).toMatchObject({ version: 3, op: "rollback", restoredFrom: 1 });
  });

  it("revalidates a rolled-back view against today's rules", async () => {
    const storage = memoryStorage();
    const loose = setup({}, kvArtifactStore(storage)).ops;
    await created(loose);
    await loose.update({ id: "q3-bugs", baseVersion: 1, source: page(`<h1>${"x".repeat(2000)}</h1>`), by: alice });
    const strict = setup({ sourceBytes: 1000 }, kvArtifactStore(storage)).ops;
    await strict.update({ id: "q3-bugs", baseVersion: 2, source: page("<h1>small</h1>"), by: alice });
    const back = await strict.rollback({ id: "q3-bugs", target: "view", version: 2, baseVersion: 3, by: alice });
    expect(back).toMatchObject({ ok: false, code: "invalid_args" });
    expect(!back.ok && back.validation?.errors[0]?.code).toBe("E_TOO_LARGE");
  });

  it("removes a document with a tombstone that keeps its numbering", async () => {
    const { ops } = setup();
    await created(ops);
    const removed = await ops.setDocuments({ id: "q3-bugs", documents: { data: { baseVersion: 1, value: null } }, by: bob });
    expect(removed.ok && removed.head.documents.data).toMatchObject({ version: 2, removed: true, bytes: 0 });
    const page2 = await ops.page("q3-bugs");
    expect(page2.ok && Object.keys(page2.documents)).toEqual([]);
    const again = await ops.setDocuments({ id: "q3-bugs", documents: { data: { baseVersion: 2, value: [1] } }, by: bob });
    expect(again.ok && again.head.documents.data?.version).toBe(3);
    const missing = await ops.setDocuments({ id: "q3-bugs", documents: { other: { baseVersion: 0, value: null } }, by: bob });
    expect(!missing.ok && missing.message).toMatch(/no document 'other' to remove/);
  });
});

describe("patching", () => {
  it("applies every edit against the base, simultaneously", () => {
    expect(
      applyPatch("alpha beta gamma", [
        { find: "gamma", replace: "G" },
        { find: "alpha", replace: "beta" },
      ]),
    ).toBe("beta beta G");
  });

  it("refuses the whole patch when any edit is ambiguous, missing, or overlapping", () => {
    const source = "a\nrow\nb\nrow\nc\nrow\nd";
    expect(
      applyPatch(source, [
        { find: "a", replace: "A" },
        { find: "row", replace: "ROW" },
        { find: "zzz", replace: "" },
      ]),
    ).toEqual([
      "edit 2: find matched 3 times (lines 2, 4, 6); include surrounding text so it matches once",
      "edit 3: find matched 0 times; copy it exactly from the current source (artifacts.get_artifact), whitespace included",
    ]);
    expect(
      applyPatch("abcdef", [
        { find: "abc", replace: "" },
        { find: "cde", replace: "" },
      ]),
    ).toEqual(["edits 1 and 2 overlap (line 1); merge them into one edit"]);
  });

  it("records a patch as its own version and changes nothing when refused", async () => {
    const { ops } = setup();
    await created(ops);
    const refused = await ops.patch({
      id: "q3-bugs",
      baseVersion: 1,
      edits: [{ find: "Bugs by team", replace: "x" }, { find: "nope", replace: "y" }],
      by: bob,
    });
    expect(refused).toMatchObject({ ok: false, code: "invalid_args" });
    expect(!refused.ok && refused.message).toMatch(/^The patch was not applied; nothing changed\. edit 2: find matched 0 times/);
    const patched = await ops.patch({
      id: "q3-bugs",
      baseVersion: 1,
      edits: [{ find: "Bugs by team", replace: "Open bugs by project" }],
      by: bob,
    });
    expect(patched.ok && patched.head.view).toMatchObject({ version: 2, op: "patch", by: bob });
    const got = await ops.get("q3-bugs");
    expect(got.ok && got.source).toBe(page("<h1>Open bugs by project</h1>"));
  });

  it("validates the patched page and bounds the edits", async () => {
    const { ops } = setup();
    await created(ops);
    const broken = await ops.patch({
      id: "q3-bugs",
      baseVersion: 1,
      edits: [{ find: 'id="artifact-root"', replace: 'id="root"' }],
      by: bob,
    });
    expect(!broken.ok && broken.validation?.errors[0]?.code).toBe("E_ROOT");
    const many = await ops.patch({
      id: "q3-bugs",
      baseVersion: 1,
      edits: Array.from({ length: 51 }, () => ({ find: "x", replace: "y" })),
      by: bob,
    });
    expect(!many.ok && many.message).toMatch(/1 to 50/);
    const empty = await ops.patch({ id: "q3-bugs", baseVersion: 1, edits: [{ find: "", replace: "y" }], by: bob });
    expect(!empty.ok && empty.message).toMatch(/edit 1: find must be 1 to 16384 bytes/);
  });
});

describe("archiving", () => {
  it("refuses writes to an archived artifact until it is restored", async () => {
    const { ops } = setup();
    const head = await created(ops);
    const archived = await ops.setArchived({ id: "q3-bugs", baseRevision: head.revision, archived: true, by: bob });
    expect(archived.ok && archived.head).toMatchObject({ archived: true, revision: 2 });
    const write = await ops.update({ id: "q3-bugs", baseVersion: 1, source: page("x"), by: bob });
    expect(!write.ok && write.message).toBe(
      "Artifact 'q3-bugs' is archived. Restore it first with artifacts.restore_artifact.",
    );
    const listed = await ops.list({ limit: 10 });
    expect(listed.ok && listed.items).toEqual([]);
    const withArchived = await ops.list({ limit: 10, includeArchived: true });
    expect(withArchived.ok && withArchived.items.map((item) => item.id)).toEqual(["q3-bugs"]);
    const restored = await ops.setArchived({ id: "q3-bugs", baseRevision: 2, archived: false, by: bob });
    expect(restored.ok && restored.head.archived).toBe(false);
    expect((await ops.update({ id: "q3-bugs", baseVersion: 1, source: page("x"), by: bob })).ok).toBe(true);
  });
});

describe("limits", () => {
  it("bounds documents by count, size, and total", async () => {
    const { ops } = setup({ documents: 2, documentBytes: 100, totalDocumentBytes: 150 });
    await created(ops);
    const big = await ops.setDocuments({ id: "q3-bugs", documents: { data: { baseVersion: 1, value: "x".repeat(200) } }, by: bob });
    expect(!big.ok && big.validation?.errors[0]?.message).toMatch(/Document 'data' is 202 bytes serialized; one document may be at most 100/);
    const total = await ops.setDocuments({
      id: "q3-bugs",
      documents: { data: { baseVersion: 1, value: "x".repeat(90) }, more: { baseVersion: 0, value: "y".repeat(90) } },
      by: bob,
    });
    expect(!total.ok && total.validation?.errors[0]?.message).toMatch(/would total 184 bytes; the limit is 150/);
    const count = await ops.setDocuments({
      id: "q3-bugs",
      documents: { a: { baseVersion: 0, value: 1 }, b: { baseVersion: 0, value: 1 } },
      by: bob,
    });
    expect(!count.ok && count.validation?.errors[0]?.message).toMatch(/would have 3 documents; the limit is 2/);
  });

  it("bounds distinct document names while retaining removed names' versions", async () => {
    const { ops } = setup({ documents: 2 });
    await created(ops);
    for (let index = 1; index < 64; index++) {
      const name = `d${index}`;
      const added = await ops.setDocuments({ id: "q3-bugs", documents: { [name]: { baseVersion: 0, value: index } }, by: bob });
      expect(added.ok).toBe(true);
      const removed = await ops.setDocuments({ id: "q3-bugs", documents: { [name]: { baseVersion: 1, value: null } }, by: bob });
      expect(removed.ok).toBe(true);
    }
    const overflow = await ops.setDocuments({ id: "q3-bugs", documents: { d64: { baseVersion: 0, value: 64 } }, by: bob });
    expect(!overflow.ok && overflow.message).toMatch(/64 distinct document names/);
    const reused = await ops.setDocuments({ id: "q3-bugs", documents: { d1: { baseVersion: 2, value: 1 } }, by: bob });
    expect(reused.ok && reused.head.documents.d1?.version).toBe(3);
  });

  it("refuses values a page could not read as data", async () => {
    const { ops } = setup();
    await created(ops);
    for (const [value, pattern] of [
      [{ n: Number.NaN }, /\/n is NaN/],
      [JSON.parse('{"__proto__": {"x": 1}}'), /"__proto__" key/],
      [{ f: () => 1 }, /a function/],
    ] as const) {
      const result = await ops.setDocuments({ id: "q3-bugs", documents: { data: { baseVersion: 1, value } }, by: bob });
      expect(!result.ok && result.validation?.errors[0]?.message).toMatch(pattern);
    }
    const nested = await ops.setDocuments({
      id: "q3-bugs",
      documents: { data: { baseVersion: 1, value: JSON.parse("[".repeat(70) + "]".repeat(70)) } },
      by: bob,
    });
    expect(!nested.ok && nested.validation?.errors[0]?.message).toMatch(/nests deeper than 64 levels/);
    const name = await ops.setDocuments({ id: "q3-bugs", documents: { "my-data": { baseVersion: 0, value: 1 } }, by: bob });
    expect(!name.ok && name.validation?.errors[0]?.message).toMatch(/artifact\.data\.<name>/);
  });

  it("stores documents script-safe, so the bytes counted are the bytes a page gets", async () => {
    const { ops, store } = setup();
    const result = await ops.create({
      id: "safe",
      title: "Safe",
      kind: "html",
      source: page("x"),
      documents: { data: { html: "</script><!--" } },
      by: alice,
    });
    if (!result.ok) throw new Error(result.message);
    const record = result.head.documents.data;
    const body = await store.body(record?.body ?? "");
    expect(body).toBe('{"html":"\\u003c/script>\\u003c!--"}');
    expect(record?.bytes).toBe(body?.length);
    const read = await ops.getDocument("safe", "data");
    expect(read.ok && read.value).toEqual({ html: "</script><!--" });
  });

  it("only lets a deployment tighten a limit", () => {
    expect(resolveLimits({ sourceBytes: 1000 }).sourceBytes).toBe(1000);
    expect(() => resolveLimits({ sourceBytes: 2 * 1024 * 1024 })).toThrow(/tightened, not raised/);
    expect(() => resolveLimits({ nope: 1 } as Partial<ArtifactLimits>)).toThrow(/unknown limit/);
  });
});

describe("reading", () => {
  it("pages the library by id, searching titles, and pins a snapshot", async () => {
    const { ops } = setup();
    for (const [id, title] of [["a-one", "Revenue"], ["b-two", "Bugs"], ["c-three", "Revenue by plan"]] as const) {
      await ops.create({ id, title, kind: "markdown", source: `# ${title}`, by: alice });
    }
    const first = await ops.list({ limit: 2 });
    expect(first.ok && first.items.map((item) => item.id)).toEqual(["a-one", "b-two"]);
    const second = await ops.list({ limit: 2, ...(first.ok && first.nextCursor ? { cursor: first.nextCursor } : {}) });
    expect(second.ok && second.items.map((item) => item.id)).toEqual(["c-three"]);
    expect(second.ok && second.nextCursor).toBeUndefined();
    const search = await ops.list({ query: "REVENUE", limit: 10 });
    expect(search.ok && search.items.map((item) => item.id)).toEqual(["a-one", "c-three"]);

    await created(ops, "pinned");
    await ops.setDocuments({ id: "pinned", documents: { data: { baseVersion: 1, value: "new" } }, by: bob });
    await ops.update({ id: "pinned", baseVersion: 1, source: page("<h1>Current</h1>"), by: bob });
    const snapshot = await ops.page("pinned", { view: 1, documents: { data: 1 } });
    if (!snapshot.ok) throw new Error(snapshot.message);
    expect(snapshot.source).toBe(page("<h1>Bugs by team</h1>"));
    expect(snapshot.documents.data?.value).toEqual({ rows: [1, 2, 3] });
    const current = await ops.page("pinned");
    expect(current.ok && current.documents.data?.value).toBe("new");
    const unlisted = await ops.page("pinned", { view: 1, documents: {} });
    expect(unlisted.ok && unlisted.documents).toEqual({});
  });

  it("answers a missing artifact as not_found naming the way to list", async () => {
    const { ops } = setup();
    expect(await ops.get("nope")).toMatchObject({
      ok: false,
      code: "not_found",
      message: "No artifact 'nope'. Find ids with artifacts.list_artifacts.",
    });
  });
});
