import { expect } from "vitest";
import { createExecuteTool } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { PROGRAM_RESULT_INLINE_BYTES } from "../src/program-result.js";
import { sentSecretsFor } from "../src/sent-secrets.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import { resultKeys, scopes } from "../src/storage/keys.js";
import { activitySink, silentLogger } from "./helpers.js";
import type { Connector, Executor, KVStorage } from "../src/types.js";

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
        trust: "trusted",
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
      const direct = createMetaTools(registry, BASE, { trust: "trusted", activity: sink.activity });
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
    trust: "trusted",
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
  const execute = createExecuteTool(registry, BASE, executor, silentLogger, sink.activity, { trust: "trusted" });
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
  const direct = await createMetaTools(registry, BASE, { trust: "trusted" }).readResult({ id: result.handle.resultId });
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
      trust: "trusted",
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
  const credential = "program-return-credential";
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
    trust: "trusted",
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
  const meta = createMetaTools(registry, BASE, { trust: "trusted" });
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
      trust: write ? "trusted" : "read-only",
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
