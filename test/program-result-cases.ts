import { expect } from "vitest";
import { createExecuteTool } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { PROGRAM_RESULT_INLINE_BYTES } from "../src/program-result.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import { resultKeys, scopes } from "../src/storage/keys.js";
import { activitySink, silentLogger } from "./helpers.js";
import type { Connector, Executor, KVStorage } from "../src/types.js";

const BASE = "https://program-results.test";

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
