import { expect } from "vitest";
import { createExecuteTool } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { PROGRAM_RESULT_INLINE_BYTES } from "../src/program-result.js";
import { sentSecretsFor } from "../src/sent-secrets.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import { resultKeys, scopes } from "../src/storage/keys.js";
import { activitySink, silentLogger } from "./helpers.js";
import type { Connector, ConnectorContext, Executor, KVStorage } from "../src/types.js";

const BASE = "https://program-results.test";

export async function checkProgramResultSurrogates(executor: Executor): Promise<void> {
  const text = "x".repeat(23_999) + "\ud800!\udc00" + "x".repeat(276_001);
  for (const route of ["program", "direct"] as const) {
    let writes = 0;
    const registry = new Registry(
      [
        {
          id: "surrogates",
          kind: route === "direct" ? "mcp" : "api",
          async listTools() {
            return ["write", "json"].map((name) => ({ name, annotations: { readOnlyHint: name !== "write" } }));
          },
          async callTool(name) {
            if (name === "write") writes++;
            if (route === "direct")
              return { content: [{ type: "text", text: name === "json" ? JSON.stringify({ text }) : text }] };
            return name === "json" ? { text } : text;
          },
        },
      ],
      { storage: memoryStorage(), logger: silentLogger },
    );
    const sink = activitySink();
    if (route === "program") {
      const outcome = await createExecuteTool(registry, BASE, executor, silentLogger, sink.activity, {
        readOnly: false,
        maxHostCalls: 2,
      })({
        code: `async () => {
          const notice = await connecta.call("surrogates.write");
          const json = await connecta.call("surrogates.json");
          const expected = "x".repeat(23999) + "\\ud800!\\udc00" + "x".repeat(276001);
          return { notice, exact: json.data.text === expected,
            units: [json.data.text.charCodeAt(23999), json.data.text.charCodeAt(24001)] };
        }`,
      });
      expect(outcome.isError, JSON.stringify(outcome.structuredContent)).toBeUndefined();
      expect(outcome.structuredContent).toMatchObject({
        result: { exact: true, units: [0xd800, 0xdc00], notice: { format: "paged", valueFormat: "text" } },
        hostCalls: { attempted: 2, admitted: 2, succeeded: 2, failed: 0 },
      });
      const notice = (outcome.structuredContent!.result as { notice: Record<string, unknown> }).notice;
      expect(notice).not.toHaveProperty("resultId");
      expect(notice).not.toHaveProperty("data");
      expect(notice.hint).toContain("text contains unpaired surrogates and can't be paged as text");
      expect(notice.hint).toContain("request the value as JSON");
      expect(notice.hint).toContain("This write already ran");
    } else {
      const direct = createMetaTools(registry, BASE, { readOnly: false, activity: sink.activity });
      const call = await direct.callDestructiveTool({ address: "surrogates.write" });
      expect(call.isError).toBeUndefined();
      const [line, preview] = call.content[0]!.text.split("\n");
      const notice = JSON.parse(line!);
      expect(notice).not.toHaveProperty("resultId");
      expect(notice).not.toHaveProperty("nextAction");
      expect(notice.hint).toContain("text contains unpaired surrogates and can't be paged as text");
      expect(notice.hint).toContain("request the value as JSON");
      expect(notice.hint).toContain("This write already ran");
      expect(preview).toBe("");
      const json = await direct.callTool({ address: "surrogates.json" });
      const id = JSON.parse(json.content[0]!.text.split("\n")[0]!).resultId as string;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      for (const mode of ["page", "offset"] as const) {
        let joined = "",
          offset = 0;
        for (let page = 0; ; page++) {
          const result = await direct.readResult({ id, ...(mode === "page" ? { page } : { offset }) });
          expect(result.isError).toBeUndefined();
          const value = result.structuredContent!;
          joined += value.text;
          if (!value.hasMore) break;
          offset = value.nextOffset as number;
        }
        const restored = JSON.parse(joined).text as string;
        expect(restored).toBe(text);
        expect([restored.charCodeAt(23_999), restored.charCodeAt(24_001)]).toEqual([0xd800, 0xdc00]);
      }
    }
    expect(writes).toBe(1);
    const records = sink.events.filter((event) => event.classification === "write");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "success", attempts: 1 });
  }
}

export async function checkProgramResultBom(executor: Executor): Promise<void> {
  // The text starts with U+FEFF; both payloads also put one at byte 24,000,
  // the start of the second page under the default connector cap.
  const text = "\uFEFF" + "x".repeat(23_997) + "\uFEFF" + "x".repeat(276_003);
  const json = { text: "x".repeat(23_991) + "\uFEFF" + "x".repeat(276_009) };
  let writes = 0;
  const registry = new Registry(
    [
      {
        id: "bom",
        kind: "api",
        async listTools() {
          return ["write", "text", "json"].map((name) => ({ name, annotations: { readOnlyHint: name !== "write" } }));
        },
        async callTool(name) {
          if (name === "write") writes++;
          return name === "json" ? json : text;
        },
      },
      {
        id: "bom_direct",
        kind: "mcp",
        async listTools() {
          return ["text", "json"].map((name) => ({ name, annotations: { readOnlyHint: true } }));
        },
        async callTool(name) {
          return { content: [{ type: "text", text: name === "json" ? JSON.stringify(json) : text }] };
        },
      },
    ],
    { storage: memoryStorage(), logger: silentLogger },
  );
  const sink = activitySink();
  const outcome = await createExecuteTool(registry, BASE, executor, silentLogger, sink.activity, {
    readOnly: false,
    maxHostCalls: 2,
  })({
    code: `async () => {
      const text = await connecta.call("bom.write");
      const json = await connecta.call("bom.json");
      return {
        textExact: text.data === "\\uFEFF" + "x".repeat(23997) + "\\uFEFF" + "x".repeat(276003),
        jsonExact: json.data.text === "x".repeat(23991) + "\\uFEFF" + "x".repeat(276009),
        formats: [text.format, json.format]
      };
    }`,
  });
  expect(outcome.isError, JSON.stringify(outcome.structuredContent)).toBeUndefined();
  expect(outcome.structuredContent).toMatchObject({
    result: { textExact: true, jsonExact: true, formats: ["text", "json"] },
    hostCalls: { attempted: 2, admitted: 2, succeeded: 2, failed: 0 },
  });
  expect(writes).toBe(1);
  const writeEvents = sink.events.filter((event) => event.classification === "write");
  expect(writeEvents).toHaveLength(1);
  expect(writeEvents[0]).toMatchObject({ outcome: "success", attempts: 1 });

  const direct = createMetaTools(registry, BASE);
  for (const [name, expected] of [
    ["text", text],
    ["json", JSON.stringify(json)],
  ] as const) {
    const call = await direct.callTool({ address: `bom_direct.${name}` });
    expect(call.isError).toBeUndefined();
    const id = (JSON.parse(call.content[0]!.text.split("\n")[0]!) as { resultId: string }).resultId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    let joined = "";
    for (let page = 0; ; page++) {
      const result = await direct.readResult({ id, page });
      expect(result.isError).toBeUndefined();
      const value = result.structuredContent!;
      const pageText = value.text as string;
      expect(new TextEncoder().encode(pageText).byteLength).toBe(value.bytes);
      if (page === 1 || (page === 0 && name === "text")) expect(pageText.startsWith("\uFEFF")).toBe(true);
      joined += pageText;
      if (!value.hasMore) break;
    }
    expect(joined).toBe(expected);
  }
  expect(writes).toBe(1);
}

export async function checkLargeProgramRead(executor: Executor, storage: KVStorage = memoryStorage()): Promise<void> {
  const text = '雪"\\\n'.repeat(60_000);
  let calls = 0;
  const connector: Connector = {
    id: "large",
    kind: "api",
    maxResultBytes: 40_000,
    async listTools() {
      return ["json", "text"].map((name) => ({ name, annotations: { readOnlyHint: true } }));
    },
    async callTool(name) {
      calls++;
      return name === "json" ? { text } : text;
    },
  };
  const registry = new Registry([connector], { storage, logger: silentLogger });
  const outcome = await createExecuteTool(registry, BASE, executor, silentLogger, undefined, { maxHostCalls: 2 })({
    code: `async () => {
      const json = await connecta.call("large.json");
      const text = await connecta.call("large.text");
      return { same: json.data.text === text.data,
        length: text.data.length, end: text.data.slice(-4),
        formats: [json.format, text.format] };
    }`,
  });
  expect(outcome.isError, JSON.stringify(outcome.structuredContent)).toBeUndefined();
  expect(outcome.structuredContent).toMatchObject({
    result: { same: true, length: text.length, end: text.slice(-4), formats: ["json", "text"] },
    hostCalls: { attempted: 2, admitted: 2, succeeded: 2, failed: 0 },
  });
  expect(calls).toBe(2);
}

export async function checkLargeProgramWrite(executor: Executor, storage: KVStorage = memoryStorage()): Promise<void> {
  const text = '雪"\\\n'.repeat(Math.ceil(PROGRAM_RESULT_INLINE_BYTES / 4));
  const serialized = JSON.stringify({ text });
  let writes = 0;
  const connector: Connector = {
    id: "large",
    kind: "api",
    maxResultBytes: 1001,
    async listTools() {
      return [{ name: "write", annotations: { readOnlyHint: false } }];
    },
    async callTool() {
      writes++;
      return { text };
    },
  };
  const registry = new Registry([connector], { storage, logger: silentLogger });
  const sink = activitySink();
  const execute = createExecuteTool(registry, BASE, executor, silentLogger, sink.activity, { readOnly: false });
  const outcome = await execute({
    code: `async () => {
      const handle = await connecta.call("large.write");
      const first = await connecta.result(handle, { page: 0 });
      const second = await connecta.result(handle, { page: 1 });
      return { handle, text: first.text + second.text, offset: second.offset,
        firstEnd: first.nextOffset, nextOffset: second.nextOffset };
    }`,
  });
  expect(outcome.isError, JSON.stringify(outcome.structuredContent)).toBeUndefined();
  const result = outcome.structuredContent!.result as {
    handle: { resultId: string };
    text: string;
    offset: number;
    firstEnd: number;
    nextOffset: number;
  };
  expect(result.handle).toMatchObject({ format: "paged", valueFormat: "json", truncated: true });
  expect(result.handle.resultId).toMatch(/^[0-9a-f-]{36}$/);
  expect(result.firstEnd).toBe(result.offset);
  expect(result.text).toBe(new TextDecoder().decode(new TextEncoder().encode(serialized).slice(0, result.nextOffset)));
  expect(writes).toBe(1);
  expect(sink.events).toHaveLength(1);
  expect(sink.events[0]).toMatchObject({ outcome: "success", attempts: 1 });
  expect(outcome.structuredContent!.hostCalls).toEqual({ attempted: 3, admitted: 3, succeeded: 3, failed: 0 });
  // The direct-call reader understands the same id and original connector page cap.
  const direct = await createMetaTools(registry, BASE, { readOnly: false }).readResult({ id: result.handle.resultId });
  const directText = direct.structuredContent!.text as string;
  expect(directText).toBe(result.text.slice(0, directText.length));
  expect(direct.structuredContent?.bytes).toBeLessThanOrEqual(1001);
  const follow = await execute({
    code: `async () => await connecta.result(${JSON.stringify(result.handle.resultId)}, { offset: ${result.nextOffset} })`,
  });
  expect(follow.isError).toBeUndefined();
  expect(writes).toBe(1);
}

export async function checkProgramPagingFailure(executor: Executor): Promise<void> {
  for (const exhausted of [false, true]) {
    let writes = 0;
    const inner = memoryStorage();
    const storage: KVStorage = {
      ...inner,
      async get(key) {
        if (key.startsWith(scopes.results + resultKeys.chunk("", 0))) throw new Error("storage offline");
        return inner.get(key);
      },
    };
    const registry = new Registry(
      [
        {
          id: "large",
          kind: "api",
          async listTools() {
            return [{ name: "write", annotations: { readOnlyHint: false } }];
          },
          async callTool() {
            writes++;
            return "x".repeat(300_000);
          },
        },
      ],
      {
        storage,
        logger: silentLogger,
        ...(exhausted ? { results: { maxStashEntries: 0 } } : {}),
      },
    );
    const sink = activitySink();
    const outcome = await createExecuteTool(registry, BASE, executor, silentLogger, sink.activity, {
      readOnly: false,
      maxHostCalls: 1,
    })({
      code: `async () => {
        const handle = await connecta.call("large.write");
        console.log(JSON.stringify(handle));
        throw new Error("Failure after a completed write");
      }`,
    });
    // A later program failure exposes the run's accounting for the completed write.
    expect(outcome.structuredContent?.error).toMatchObject({
      code: "program_error",
      writes: { succeeded: 1, failed: 0, unknown: 0 },
    });
    const handle = JSON.parse(outcome.structuredContent?.logs as string);
    expect(handle).toMatchObject({ format: "paged", totalBytes: 300_000 });
    expect(Boolean(handle.resultId)).toBe(!exhausted);
    expect(writes).toBe(1);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ outcome: "success", attempts: 1 });
    expect(outcome.structuredContent?.hostCalls).toEqual({ attempted: 1, admitted: 1, succeeded: 1, failed: 0 });
  }
}

/** A completed program return uses the direct stash without replaying its write. */
export async function checkProgramReturnPaging(executor: Executor): Promise<void> {
  // Also crosses the QuickJS per-message IPC ceiling and exercises JSON escaping.
  const credential = "pR3-x8Wm-5Kq2-Tz7V";
  const value = { text: '雪"\\\n'.repeat(150_000), credential };
  const expected = { ...value, credential: "[redacted]" };
  let writes = 0;
  const registry = new Registry(
    [
      {
        id: "exporter",
        kind: "api",
        maxResultBytes: 9_001,
        async listTools() {
          return [{ name: "export", annotations: { readOnlyHint: false } }];
        },
        async callTool(_name, _args, ctx) {
          writes++;
          sentSecretsFor(ctx).add(credential);
          return { text: "ready" };
        },
      },
    ],
    { storage: memoryStorage(), logger: silentLogger },
  );
  const sink = activitySink();
  const execute = createExecuteTool(registry, BASE, executor, silentLogger, sink.activity, {
    readOnly: false,
    maxHostCalls: 512,
  });
  const outcome = await execute({
    code: `async () => {
    await connecta.call("exporter.export");
    console.log("program log");
    return { text: '雪"\\\\\\n'.repeat(150000), credential: ${JSON.stringify(credential)} };
  }`,
  });
  expect(outcome.isError, JSON.stringify(outcome.structuredContent)).toBeUndefined();
  const notice = outcome.structuredContent!.result as {
    resultId: string;
    totalBytes: number;
    preview: string;
    nextAction: { arguments: { code: string } };
    hint: string;
  };
  expect(notice.resultId).toMatch(/^[a-f0-9-]{36}$/);
  expect(notice.totalBytes).toBe(new TextEncoder().encode(JSON.stringify(expected)).length);
  expect(notice.preview).toBeTruthy();
  expect(notice.hint).toContain("This write already ran: do not call it again");
  expect(outcome.structuredContent!.logs).toBe("program log");
  const spilled = outcome.content[0]!.text.slice(0, 2_000);
  expect(spilled).toContain(notice.resultId);
  expect(spilled).toContain("nextAction");
  expect(spilled).toContain("connecta.result");
  expect(spilled).toContain("This write already ran");
  const first = await execute(notice.nextAction.arguments);
  expect(first.isError).toBeUndefined();
  expect(first.structuredContent!.result).toMatchObject({ resultId: notice.resultId, offset: 0, hasMore: true });
  // Recover the entire JSON in a new guest run and return only verification facts.
  const restored = await execute({
    code: `async () => {
    let text = "", offset = 0, page;
    do {
      page = await connecta.result(${JSON.stringify(notice.resultId)}, { offset, maxBytes: 9001 });
      text += page.text; offset = page.nextOffset;
    } while (page.hasMore);
    const value = JSON.parse(text);
    return { exact: value.text === '雪"\\\\\\n'.repeat(150000), credential: value.credential, totalBytes: page.totalBytes };
  }`,
  });
  expect(restored.isError, JSON.stringify(restored.structuredContent)).toBeUndefined();
  expect(restored.structuredContent!.result).toEqual({
    exact: true,
    credential: "[redacted]",
    totalBytes: notice.totalBytes,
  });
  // The same reader obeys the original connector cap and reconstructs all bytes.
  const meta = createMetaTools(registry, BASE, { readOnly: false });
  let text = "",
    offset = 0;
  let hasMore = true;
  while (hasMore) {
    const page = await meta.readResult({ id: notice.resultId, offset, maxBytes: 20_000 });
    expect(page.isError).toBeUndefined();
    expect(page.structuredContent!.bytes).toBeLessThanOrEqual(9_001);
    text += page.structuredContent!.text;
    hasMore = page.structuredContent!.hasMore as boolean;
    offset = page.structuredContent!.nextOffset as number;
  }
  expect(JSON.parse(text)).toEqual(expected);
  expect(text).not.toContain(credential);
  expect(writes).toBe(1);
  expect(sink.events).toHaveLength(1);
  expect(sink.events[0]).toMatchObject({ classification: "write", outcome: "success", attempts: 1 });
}

/** Stash exhaustion preserves success, the old preview, and the no-replay warning. */
export async function checkProgramReturnFallback(executor: Executor): Promise<void> {
  for (const write of [false, true]) {
    let calls = 0;
    const registry = new Registry(
      [
        {
          id: "exporter",
          kind: "api",
          async listTools() {
            return [{ name: "run", annotations: { readOnlyHint: !write } }];
          },
          async callTool() {
            calls++;
            return { text: "x".repeat(50_000) };
          },
        },
      ],
      { storage: memoryStorage(), logger: silentLogger, results: { maxStashEntries: 0 } },
    );
    const sink = activitySink();
    const outcome = await createExecuteTool(registry, BASE, executor, silentLogger, sink.activity, {
      readOnly: !write,
    })({
      code: 'async () => (await connecta.call("exporter.run")).data',
    });
    expect(outcome.isError).toBeUndefined();
    const notice = outcome.structuredContent!.result as Record<string, unknown>;
    expect(notice).toMatchObject({
      truncated: true,
      totalChars: 50_011,
      preview: expect.any(String),
      hint: expect.stringContaining("Paging is unavailable"),
    });
    expect(notice).not.toHaveProperty("resultId");
    expect(notice).not.toHaveProperty("nextAction");
    expect(notice.hint).toContain("filter/map/slice");
    if (write) expect(notice.hint).toContain("This write already ran");
    expect(JSON.stringify(notice).length).toBeLessThanOrEqual(24_000);
    expect(calls).toBe(1);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ outcome: "success", attempts: 1 });
  }
}

/** Paging a prior write preserves authority without claiming a write ran again. */
export async function checkProgramReturnWriteWarning(executor: Executor): Promise<void> {
  for (const exhausted of [false, true]) {
    let writes = 0;
    const registry = new Registry(
      [
        {
          id: "exporter",
          kind: "api",
          async listTools() {
            return [{ name: "write", annotations: { readOnlyHint: false } }];
          },
          async callTool() {
            writes++;
            return { text: "w".repeat(30_000) };
          },
        },
      ],
      { storage: memoryStorage(), logger: silentLogger, ...(exhausted ? { results: { maxStashEntries: 1 } } : {}) },
    );
    const execute = createExecuteTool(registry, BASE, executor, silentLogger, undefined, { readOnly: false });
    const original = await execute({ code: 'async () => (await connecta.call("exporter.write")).data' });
    expect(original.isError).toBeUndefined();
    const first = original.structuredContent!.result as { resultId: string; hint: string };
    expect(first.resultId).toMatch(/^[a-f0-9-]{36}$/);
    expect(first.hint).toContain("This write already ran");
    const derived = await execute({
      code: `async () => {
      let text = "", offset = 0, page;
      do { page = await connecta.result(${JSON.stringify(first.resultId)}, { offset });
        text += page.text; offset = page.nextOffset; } while (page.hasMore);
      return JSON.parse(text);
    }`,
    });
    expect(derived.isError).toBeUndefined();
    const notice = derived.structuredContent!.result as { resultId?: string; hint: string };
    expect(notice.hint).not.toContain("This write already ran");
    expect(derived.structuredContent).not.toHaveProperty("writes");
    expect(writes).toBe(1);
    if (exhausted) {
      expect(notice.resultId).toBeUndefined();
      expect(notice.hint).toContain("Paging is unavailable");
    } else {
      expect(notice.resultId).toMatch(/^[a-f0-9-]{36}$/);
      const trusted = await createMetaTools(registry, BASE, { readOnly: false }).readResult({ id: notice.resultId! });
      expect(trusted.isError).toBeUndefined();
      const readonly = await createMetaTools(registry, BASE, { readOnly: true }).readResult({
        id: notice.resultId!,
      });
      expect(readonly.isError).toBe(true);
    }
  }
}

const RETAINED_SECRET = 'retained"secret/value+with space-0123456789';
const retainedForms = (secret: string): Record<string, string> => ({
  plain: secret,
  json: JSON.stringify(secret).slice(1, -1),
  url: encodeURIComponent(secret),
  base64: btoa(secret),
});

/** A connector whose reads echo a value and whose `use` registers it, as sending a credential does. */
function retainedRegistry(storage: KVStorage, echoed: () => unknown, onUse?: () => void) {
  const state = { writes: 0, ctx: undefined as ConnectorContext | undefined };
  const connector: Connector = {
    id: "vault",
    kind: "api",
    async listTools() {
      return [
        { name: "read", annotations: { readOnlyHint: true } },
        { name: "use", annotations: { readOnlyHint: true } },
        { name: "write", annotations: { readOnlyHint: false } },
      ];
    },
    async callTool(name, _args, ctx) {
      state.ctx = ctx;
      if (name === "use") {
        sentSecretsFor(ctx).add(RETAINED_SECRET);
        onUse?.();
        return "used";
      }
      if (name === "write") state.writes++;
      return echoed();
    },
  };
  return { registry: new Registry([connector], { storage, logger: silentLogger }), state };
}

/** Everything a later request with an empty secret set can page out of `id`. */
async function pageFromLaterRun(registry: Registry, id: string): Promise<string> {
  const meta = createMetaTools(registry, BASE, { readOnly: false });
  let text = "";
  for (let offset = 0; ;) {
    const page = await meta.readResult({ id, offset, maxBytes: 24_000 });
    expect(page.isError, JSON.stringify(page.structuredContent)).toBeUndefined();
    text += page.structuredContent!.text as string;
    if (!page.structuredContent!.hasMore) return text;
    offset = page.structuredContent!.nextOffset as number;
  }
}

const storedResultText = async (inner: KVStorage) => {
  const keys = await inner.list(scopes.results + "result:");
  return (await Promise.all(keys.map((key) => inner.get(key))))
    .map((value) => {
      const body = value!.replace(/^connecta-result(?:-refused)?-v4:[^:]*:(?:\d+:\d+:\d+:)?/, "");
      return new TextDecoder().decode(Uint8Array.from(atob(body), (char) => char.charCodeAt(0)));
    })
    .join("");
};

const expectNoForms = (text: string, secret = RETAINED_SECRET) => {
  for (const [name, form] of Object.entries(retainedForms(secret)))
    expect(text.includes(form), `${name} form survived`).toBe(false);
};

const PAD = "x".repeat(1_100_000);
const RETAINED_PROGRAM = (tool: string) => `async () => {
  const handle = await connecta.call("vault.${tool}");
  await connecta.call("vault.use");
  return handle.resultId;
}`;

/** Bytes a run stored before a later call in it registered a secret, read after it ended. */
export async function checkRetainedResultsPassFinalSet(executor: Executor): Promise<void> {
  const forms = Object.values(retainedForms(RETAINED_SECRET));
  const cases: Array<{ label: string; tool: string; echoed: unknown; marker: string }> = [
    { label: "oversized JSON", tool: "read", echoed: { forms, keep: "kept-json", PAD }, marker: "kept-json" },
    { label: "oversized text", tool: "read", echoed: `kept-text ${forms.join(" ")} ${PAD}`, marker: "kept-text" },
    { label: "paged write", tool: "write", echoed: { forms, keep: "kept-write", PAD }, marker: "kept-write" },
  ];
  for (const { label, tool, echoed, marker } of cases) {
    const inner = memoryStorage();
    const { registry, state } = retainedRegistry(inner, () => echoed);
    const outcome = await createExecuteTool(registry, BASE, executor, silentLogger, undefined, { readOnly: false })({
      code: RETAINED_PROGRAM(tool),
    });
    expect(outcome.isError, `${label}: ${JSON.stringify(outcome.structuredContent)}`).toBeUndefined();
    expect(outcome.structuredContent).not.toHaveProperty("note");
    const paged = await pageFromLaterRun(registry, outcome.structuredContent!.result as string);
    expectNoForms(paged);
    expect(paged.includes(marker), label).toBe(true);
    expect(paged).toContain("[redacted]");
    // The old bytes are gone from storage too, not only from what a page returns.
    expectNoForms(await storedResultText(inner));
    expect(state.writes).toBe(tool === "write" ? 1 : 0);
  }

  // A secret split across two text blocks is one match, as it is when the result enters.
  const split = RETAINED_SECRET.length >> 1;
  const inner = memoryStorage();
  const { registry } = retainedRegistry(inner, () => ({
    content: [
      { type: "text", text: RETAINED_SECRET.slice(0, split) },
      { type: "text", text: RETAINED_SECRET.slice(split) },
    ],
    keep: "kept-blocks",
    PAD,
  }));
  const blocks = await createExecuteTool(registry, BASE, executor, silentLogger)({ code: RETAINED_PROGRAM("read") });
  const paged = await pageFromLaterRun(registry, blocks.structuredContent!.result as string);
  expect(paged).toContain("kept-blocks");
  expect(paged).not.toContain(RETAINED_SECRET.slice(0, split));
  expect(paged).not.toContain(RETAINED_SECRET.slice(split));

  // An id in a program's error is delivered as surely as one in its return.
  const thrown = memoryStorage();
  const failing = retainedRegistry(thrown, () => ({ forms, PAD }));
  const failed = await createExecuteTool(
    failing.registry,
    BASE,
    executor,
    silentLogger,
  )({
    code: `async () => {
      const handle = await connecta.call("vault.read");
      await connecta.call("vault.use");
      throw new Error("id " + handle.resultId);
    }`,
  });
  expect(failed.isError).toBe(true);
  const id = /id ([0-9a-f-]{36})/.exec(JSON.stringify(failed.structuredContent))![1]!;
  expectNoForms(await pageFromLaterRun(failing.registry, id));
}

/** The same run keeps paging; a run that retained nothing new pays nothing new. */
export async function checkRetainedResultsSameRunAndCost(executor: Executor): Promise<void> {
  const inner = memoryStorage();
  const sets: string[] = [];
  let gets = 0;
  const prefix = scopes.results + "result:";
  const storage: KVStorage = {
    ...inner,
    async get(key) {
      if (key.startsWith(prefix)) gets++;
      return inner.get(key);
    },
    async set(key, value, options) {
      if (key.startsWith(prefix)) sets.push(key);
      return inner.set(key, value, options);
    },
  };
  const { registry } = retainedRegistry(storage, () => `same-run ${PAD}`);
  const execute = createExecuteTool(registry, BASE, executor, silentLogger);
  const outcome = await execute({
    code: `async () => {
      const handle = await connecta.call("vault.read");
      const before = await connecta.result(handle, { maxBytes: 8 });
      await connecta.call("vault.use");
      const after = await connecta.result(handle.resultId, { offset: 500000, maxBytes: 8 });
      return { id: handle.resultId, before: before.text, after: after.text, total: after.totalBytes };
    }`,
  });
  expect(outcome.isError, JSON.stringify(outcome.structuredContent)).toBeUndefined();
  const result = outcome.structuredContent!.result as { id: string; before: string; after: string; total: number };
  expect(result).toMatchObject({ before: "same-run", after: "xxxxxxxx", total: 1_100_009 });

  // One write per chunk, chunk 0 last, as a stash has always cost; the clean recheck wrote nothing.
  const chunks = Math.ceil(result.total / 49_152);
  expect(sets).toHaveLength(chunks);
  expect(new Set(sets).size).toBe(chunks);
  expect(sets.at(-1)).toBe(scopes.results + resultKeys.chunk(result.id, 0));

  // No growth after the stash: storage sees exactly the stash and nothing is read back.
  sets.length = 0;
  gets = 0;
  const quiet = await execute({
    code: `async () => { await connecta.call("vault.use"); return (await connecta.call("vault.read")).resultId; }`,
  });
  expect(quiet.isError).toBeUndefined();
  expect(sets).toHaveLength(chunks);
  expect(new Set(sets).size).toBe(chunks);
  expect(gets).toBe(0);
  // A run that retained nothing touches no result key.
  sets.length = 0;
  await execute({ code: `async () => 1` });
  expect(sets).toEqual([]);
  expect(gets).toBe(0);
}

/** Growth during sealing is checked again or refused; a failed seal is refused, never served. */
export async function checkRetainedResultsSealingRaces(executor: Executor): Promise<void> {
  const LATE = 'late"secret/value+with space-9876543210';
  const forms = Object.values(retainedForms(RETAINED_SECRET)).concat(Object.values(retainedForms(LATE)));
  const prefix = scopes.results + "result:";
  const isHeader = (key: string) => key.startsWith(prefix) && !key.includes("#");
  const harness = (
    hooks: { get?: (key: string) => unknown; set?: (key: string) => unknown },
    tool = "read",
    watchdogMs?: number,
  ) => {
    const inner = memoryStorage();
    const armed = { on: false };
    const storage: KVStorage = {
      ...inner,
      async get(key) {
        if (armed.on && key.startsWith(prefix)) await hooks.get?.(key);
        return inner.get(key);
      },
      async set(key, value, options) {
        if (armed.on && key.startsWith(prefix)) await hooks.set?.(key);
        return inner.set(key, value, options);
      },
    };
    const built = retainedRegistry(
      storage,
      () => ({ forms, keep: "kept", PAD }),
      () => {
        armed.on = true;
      },
    );
    const run = async () => {
      const outcome = await createExecuteTool(built.registry, BASE, executor, silentLogger, undefined, {
        readOnly: false,
        ...(watchdogMs ? { watchdogMs } : {}),
      })({
        code: `async () => {
          const handle = await connecta.call("vault.${tool}");
          await connecta.call("vault.use");
          return handle.resultId;
        }`,
      });
      // The later run reads from storage that has recovered: the refusal is what is stored.
      armed.on = false;
      return outcome;
    };
    return { ...built, inner, run };
  };
  const refusal = async (registry: Registry, id: string) =>
    (await createMetaTools(registry, BASE, { readOnly: false }).readResult({ id })).structuredContent?.error as
      | { code: string; message: string; retryable: boolean }
      | undefined;

  // A credential read that finishes during the recheck is checked in another round.
  {
    let registered = false;
    const late = harness({
      get() {
        if (registered) return;
        registered = true;
        sentSecretsFor(late.state.ctx!).add(LATE);
      },
    });
    const outcome = await late.run();
    expect(outcome.structuredContent).not.toHaveProperty("note");
    expect(registered).toBe(true);
    const paged = await pageFromLaterRun(late.registry, outcome.structuredContent!.result as string);
    expectNoForms(paged);
    expectNoForms(paged, LATE);
    expect(paged).toContain("kept");
  }
  // One that finishes while the header is on its way was checked by nothing, so it is refused.
  {
    let registered = false;
    const late = harness({
      set(key) {
        if (registered || !isHeader(key)) return;
        registered = true;
        sentSecretsFor(late.state.ctx!).add(LATE);
      },
    });
    const outcome = await late.run();
    expect(registered).toBe(true);
    expect(outcome.structuredContent?.note).toContain("Rerun the read");
    const error = await refusal(late.registry, outcome.structuredContent!.result as string);
    expect(error).toMatchObject({ code: "result_not_retained", retryable: false });
    expect(error!.message).toContain("Rerun the read");
    expectNoForms(await storedResultText(late.inner), LATE);
  }
  // A failed recheck refuses: a read says to rerun, and a write says not to repeat itself.
  for (const tool of ["read", "write"]) {
    const failing = harness(
      {
        get() {
          throw new Error("storage offline");
        },
      },
      tool,
    );
    const outcome = await failing.run();
    expect(outcome.isError).toBeUndefined();
    const error = await refusal(failing.registry, outcome.structuredContent!.result as string);
    expect(error).toMatchObject({ code: "result_not_retained", retryable: false });
    if (tool === "write") {
      expect(error!.message).toContain("not retrievable");
      expect(error!.message).toContain("do not call it again");
      expect(outcome.structuredContent?.note).toContain("do not repeat it");
      expect(failing.state.writes).toBe(1);
    } else {
      expect(error!.message).toContain("Rerun the read");
      expect(outcome.structuredContent?.note).toContain("Rerun the read");
    }
    expectNoForms(await storedResultText(failing.inner));
  }
  // Storage that refuses every later write cannot mark the entry, and still serves nothing.
  {
    const failing = harness({
      get() {
        throw new Error("storage offline");
      },
      set() {
        throw new Error("storage offline");
      },
    });
    const outcome = await failing.run();
    expect(outcome.structuredContent?.note).toContain("Rerun the read");
    expect(await refusal(failing.registry, outcome.structuredContent!.result as string)).toMatchObject({
      code: "not_found",
      retryable: false,
    });
  }
  // Storage that never answers cannot hold the response past the deadline.
  {
    const hung = harness({ get: () => new Promise(() => {}), set: () => new Promise(() => {}) }, "read", 3000);
    const started = Date.now();
    const outcome = await hung.run();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.structuredContent?.note).toContain("Rerun the read");
  }
}
