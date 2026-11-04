import { expect, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { CredentialVault } from "../src/credentials.js";
import { createExecuteTool } from "../src/execute.js";
import { createMetaTools, releaseStashedResult } from "../src/meta-tools.js";
import { PROGRAM_RESULT_INLINE_BYTES } from "../src/program-result.js";
import { HeldResults, type HeldResult } from "../src/result-seal.js";
import { PendingWork } from "../src/runtime/request-scope.js";
import { sentSecretsFor, sentSecretsForRequest } from "../src/sent-secrets.js";
import { Registry, type RegistryView } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import { resultKeys, scopes } from "../src/storage/keys.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { scriptedExecutor } from "./fixtures/misc.js";
import { seedGrant } from "./fixtures/oauth.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
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
  // nextAction reads the whole return and runs as written, fitting its own return.
  expect(notice.nextAction.arguments.code).toContain("{ all: true }");
  const first = await execute(notice.nextAction.arguments);
  expect(first.isError, JSON.stringify(first.structuredContent)).toBeUndefined();
  expect(first.structuredContent!.result).toEqual(expect.stringContaining("雪"));
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
const LATE_SECRET = 'late"secret/value+with space-9876543210';
const retainedForms = (secret: string): Record<string, string> => ({
  plain: secret,
  json: JSON.stringify(secret).slice(1, -1),
  url: encodeURIComponent(secret),
  base64: btoa(secret),
});
const allForms = (...secrets: string[]) => secrets.flatMap((secret) => Object.values(retainedForms(secret)));

const PAD = "x".repeat(1_100_000);
const CLEAN = { keep: "kept-clean", PAD };

interface RetainedOptions {
  /** What `vault.read` and `vault.write` answer. `vault.clean` always answers `CLEAN`. */
  echoed: () => unknown;
  onUse?: () => void;
  /** What a slow credential read waits for before it answers `LATE_SECRET`. */
  credentialRead?: () => Promise<void>;
  /** Called by `vault.land`, a program's last act. */
  onLand?: () => void;
}

/**
 * `vault.use` registers a value, as sending a credential does. `slow` lists its tools
 * by reading its credential, and `vault.wait` answers once that read has begun.
 */
function retainedRegistry(storage: KVStorage, { echoed, onUse, credentialRead, onLand }: RetainedOptions) {
  const state = { writes: 0, ctx: undefined as ConnectorContext | undefined };
  let reading = () => {};
  const readBegan = new Promise<void>((resolve) => (reading = resolve));
  const vault: Connector = {
    id: "vault",
    kind: "api",
    async listTools() {
      return [
        ...["read", "clean", "use", "wait", "land"].map((name) => ({ name, annotations: { readOnlyHint: true } })),
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
      if (name === "wait") {
        await readBegan;
        return "began";
      }
      if (name === "land") {
        onLand?.();
        return "landing";
      }
      if (name === "clean") return CLEAN;
      if (name === "write") state.writes++;
      return echoed();
    },
  };
  const slow: Connector = {
    id: "slow",
    kind: "api",
    credential: { label: "API token" },
    async listTools(ctx) {
      await ctx.credential!.getAll();
      return [{ name: "tool", annotations: { readOnlyHint: true } }];
    },
    async callTool() {
      return "unused";
    },
  };
  const vaultStore = new CredentialVault(memoryStorage(), btoa("k".repeat(32)));
  vaultStore.getAll = async () => {
    reading();
    await credentialRead?.();
    return { value: LATE_SECRET };
  };
  const registry = new Registry(credentialRead ? [vault, slow] : [vault], {
    storage,
    logger: silentLogger,
    ...(credentialRead ? { credentialVault: vaultStore } : {}),
  });
  return { registry, state };
}

/** Another request, over the same stored bytes, knowing none of the run's secrets. */
const laterReader = (storage: KVStorage) =>
  createMetaTools(retainedRegistry(storage, { echoed: () => null }).registry, BASE, { readOnly: false });

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

const refusalOf = async (registry: Registry, id: string) =>
  (await createMetaTools(registry, BASE, { readOnly: false }).readResult({ id })).structuredContent?.error as
    | { code: string; message: string; retryable: boolean }
    | undefined;

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

const RETAINED_PROGRAM = (tool: string) => `async () => {
  const handle = await connecta.call("vault.${tool}");
  await connecta.call("vault.use");
  return handle.resultId;
}`;

/** Bytes a run stored before a later call in it registered a secret, read after it ended. */
export async function checkRetainedResultsPassFinalSet(executor: Executor): Promise<void> {
  const forms = allForms(RETAINED_SECRET);
  const cases: Array<{ label: string; tool: string; echoed: unknown }> = [
    { label: "oversized JSON", tool: "read", echoed: { forms, keep: "kept-json", PAD } },
    { label: "oversized text", tool: "read", echoed: `kept-text ${forms.join(" ")} ${PAD}` },
    { label: "paged write", tool: "write", echoed: { forms, keep: "kept-write", PAD } },
  ];
  for (const { label, tool, echoed } of cases) {
    const inner = memoryStorage();
    const { registry, state } = retainedRegistry(inner, { echoed: () => echoed });
    const outcome = await createExecuteTool(registry, BASE, executor, silentLogger, undefined, { readOnly: false })({
      code: RETAINED_PROGRAM(tool),
    });
    expect(outcome.isError, `${label}: ${JSON.stringify(outcome.structuredContent)}`).toBeUndefined();
    const error = await refusalOf(registry, outcome.structuredContent!.result as string);
    expect(error, label).toMatchObject({ code: "result_not_retained", retryable: false });
    if (tool === "write") {
      expect(error!.message).toContain("do not call it again");
      expect(outcome.structuredContent?.note).toContain("do not repeat it");
    } else {
      expect(error!.message).toContain("Rerun the read");
      expect(outcome.structuredContent?.note).toContain("Rerun the read");
    }
    // The old bytes are gone from storage too, not only from what a page returns.
    expectNoForms(await storedResultText(inner));
    expect(state.writes).toBe(tool === "write" ? 1 : 0);
  }

  // A secret split across two text blocks is one match, as it is when the result enters.
  const split = RETAINED_SECRET.length >> 1;
  const inner = memoryStorage();
  const { registry } = retainedRegistry(inner, {
    echoed: () => ({
      content: [
        { type: "text", text: RETAINED_SECRET.slice(0, split) },
        { type: "text", text: RETAINED_SECRET.slice(split) },
      ],
      keep: "kept-blocks",
      PAD,
    }),
  });
  const blocks = await createExecuteTool(registry, BASE, executor, silentLogger)({ code: RETAINED_PROGRAM("read") });
  expect(await refusalOf(registry, blocks.structuredContent!.result as string)).toMatchObject({
    code: "result_not_retained",
  });

  // An id in a program's error is covered as surely as one in its return.
  const failing = retainedRegistry(memoryStorage(), { echoed: () => ({ forms, PAD }) });
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
  expect(await refusalOf(failing.registry, id)).toMatchObject({ code: "result_not_retained" });

  // A result the grown set finds nothing in stays whole, with no note: only growth was seen.
  const clean = retainedRegistry(memoryStorage(), { echoed: () => CLEAN });
  const kept = await createExecuteTool(
    clean.registry,
    BASE,
    executor,
    silentLogger,
  )({ code: RETAINED_PROGRAM("read") });
  expect(kept.structuredContent).not.toHaveProperty("note");
  expect(JSON.parse(await pageFromLaterRun(clean.registry, kept.structuredContent!.result as string))).toEqual(CLEAN);
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
  const { registry } = retainedRegistry(storage, { echoed: () => `same-run ${PAD}` });
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

  // One write per chunk, chunk 0 last, as a stash has always cost; a clean read-back wrote nothing.
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

const RESULT_PREFIX = scopes.results + "result:";
const isHeader = (key: string) => key.startsWith(RESULT_PREFIX) && !key.includes("#");
const isMarker = (value: string) => value.startsWith("connecta-result-refused-v4:");
type StorageHooks = {
  get?: (key: string) => unknown;
  set?: (key: string, value: string) => unknown;
};

/** Hooks see result keys once `armed`; a credential read, when given, answers late. */
function sealingHarness(
  hooks: StorageHooks,
  options: {
    tool?: string;
    watchdogMs?: number;
    armed?: boolean;
    code?: string;
    echoed?: () => unknown;
    credentialRead?: () => Promise<void>;
    onLand?: () => void;
  } = {},
) {
  const inner = memoryStorage();
  const armed = { on: options.armed ?? false };
  const storage: KVStorage = {
    ...inner,
    async get(key) {
      if (armed.on && key.startsWith(RESULT_PREFIX)) await hooks.get?.(key);
      return inner.get(key);
    },
    async set(key, value, opts) {
      if (armed.on && key.startsWith(RESULT_PREFIX)) await hooks.set?.(key, value);
      return inner.set(key, value, opts);
    },
  };
  const built = retainedRegistry(storage, {
    echoed: options.echoed ?? (() => ({ forms: allForms(RETAINED_SECRET, LATE_SECRET), keep: "kept", PAD })),
    onUse: () => {
      armed.on = true;
    },
    ...(options.credentialRead ? { credentialRead: options.credentialRead } : {}),
    ...(options.onLand ? { onLand: options.onLand } : {}),
  });
  const run = async () => {
    const outcome = await createExecuteTool(built.registry, BASE, executor(), silentLogger, undefined, {
      readOnly: false,
      ...(options.watchdogMs ? { watchdogMs: options.watchdogMs } : {}),
    })({ code: options.code ?? RETAINED_PROGRAM(options.tool ?? "read") });
    // Later requests read from storage that has recovered: only what is stored counts.
    armed.on = false;
    return outcome;
  };
  let current: Executor;
  const executor = () => current;
  return {
    ...built,
    inner,
    run: (using: Executor) => {
      current = using;
      return run();
    },
  };
}

const after = (ms: number) => () => new Promise<void>((resolve) => setTimeout(resolve, ms));
const LATE_READ_PROGRAM = `async () => {
  connecta.describe({ address: "slow.tool" }).catch(() => {});
  await connecta.call("vault.wait");
  const first = await connecta.call("vault.read");
  const second = await connecta.call("vault.read");
  await connecta.call("vault.land");
  return [first.resultId, second.resultId];
}`;
/** A credential read that answers shortly after the program's last act. */
const landingAfterProgram = () => {
  let open = () => {};
  const landed = new Promise<void>((resolve) => (open = resolve));
  return { credentialRead: () => landed, onLand: () => void setTimeout(open, 100) };
};

const expectNothingReadable = async (built: ReturnType<typeof sealingHarness>, ids: string[], code?: string) => {
  for (const id of ids) {
    const page = await laterReader(built.inner).readResult({ id });
    expect(page.isError, JSON.stringify(page.structuredContent)).toBe(true);
    if (code) expect(page.structuredContent?.error).toMatchObject({ code, retryable: false });
  }
};

const OAUTH_ISSUER = "https://authorization.test";
const OAUTH_MCP_URL = "https://downstream.test/mcp";

/** Answers discovery and the token endpoint, and calls `sent` when a token request goes out. */
function stubOAuthFetch(sent: () => void, downstream?: { fetch: typeof fetch }) {
  installOwnedTransport();
  vi.stubGlobal("fetch", (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/.well-known/oauth-protected-resource"))
      return Response.json({ resource: OAUTH_MCP_URL, authorization_servers: [OAUTH_ISSUER] });
    if (url.includes("/.well-known/"))
      return Response.json({
        issuer: OAUTH_ISSUER,
        authorization_endpoint: `${OAUTH_ISSUER}/authorize`,
        token_endpoint: `${OAUTH_ISSUER}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      });
    if (url === `${OAUTH_ISSUER}/token`) {
      sent();
      return Response.json({
        access_token: "new-access-token-value",
        refresh_token: "new-refresh-token-value",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (downstream) return downstream.fetch(input, init);
    return Response.json({ ok: true });
  }) as typeof fetch);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
}

/**
 * A result retained before an OAuth refresh starts, in a run that ends while the refresh waits
 * on its claim. Whatever the token request will carry already counts when the run seals.
 */
async function checkRefreshCredentialCounts(
  executor: Executor,
  setup: (
    secret: string,
    namespace: string,
    storage: KVStorage,
  ) => Promise<{ connector: Connector; address: string; downstream?: { fetch: typeof fetch } }>,
): Promise<void> {
  const secret = "synthetic-oauth-credential-0123456";
  const inner = memoryStorage();
  let claimed = () => {};
  const claim = new Promise<void>((resolve) => (claimed = resolve));
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let sent = () => {};
  const tokenRequest = new Promise<void>((resolve) => (sent = resolve));
  const storage: KVStorage = {
    ...inner,
    async compareAndSet(key, expected, value, options) {
      if (key.includes("oauth:refresh:") && expected === null) {
        claimed();
        await released;
      }
      return inner.compareAndSet(key, expected, value, options);
    },
  };
  const source: Connector = {
    id: "source",
    kind: "api",
    async listTools() {
      return ["read", "wait"].map((name) => ({ name, annotations: { readOnlyHint: true } }));
    },
    async callTool(name) {
      if (name === "wait") {
        await claim;
        return "claimed";
      }
      return { value: secret, PAD };
    },
  };
  const { connector, address, downstream } = await setup(secret, scopes.connector("oauth"), inner);
  stubOAuthFetch(() => sent(), downstream);
  const registry = new Registry([source, connector], { storage, logger: silentLogger });
  const outcome = await createExecuteTool(registry, BASE, executor, silentLogger, undefined, {
    readOnly: false,
    hostCallTimeoutMs: 2000,
  })({
    code: `async () => {
      const handle = await connecta.call("source.read");
      connecta.call(${JSON.stringify(address)}).catch(() => {});
      await connecta.call("source.wait");
      return handle.resultId;
    }`,
  });
  const id = outcome.structuredContent!.result as string;
  expect(await refusalOf(registry, id)).toMatchObject({ code: "result_not_retained", retryable: false });
  expect(outcome.structuredContent?.note).toContain("Rerun the read");
  release();
  await tokenRequest;
  expect(await refusalOf(registry, id)).toMatchObject({ code: "result_not_retained" });
}

const dueGrant = (secret: string, mode: string) => ({
  issuer: mode === "remote" ? OAUTH_ISSUER : `${OAUTH_ISSUER}/token`,
  client: {
    value: {
      client_id: "client-identifier-123456",
      redirect_uris: ["https://program-results.test/connect/callback"],
      token_endpoint_auth_method: "none",
    },
  },
  tokens: {
    access_token: "old-access-token-value",
    refresh_token: mode === "refresh-token" ? secret : "old-refresh-token-value",
    token_type: "Bearer",
  },
  expiresAt: Date.now() - 10_000,
});

/** `api()`: the configured client secret and token-request headers are part of what counts. */
const apiRefreshCase = (mode: "refresh-token" | "client-secret" | "token-header") => (executor: Executor) =>
  checkRefreshCredentialCounts(executor, async (secret, namespace, storage) => {
    await seedGrant(storage, dueGrant(secret, mode), "v3:seeded", namespace);
    return {
      address: "oauth.read",
      connector: api("oauth", {
        oauth: {
          authorizationEndpoint: `${OAUTH_ISSUER}/authorize`,
          tokenEndpoint: `${OAUTH_ISSUER}/token`,
          clientId: "client-identifier-123456",
          clientSecret: mode === "client-secret" ? secret : "synthetic-client-secret-value",
          apiOrigins: [OAUTH_ISSUER],
          ...(mode === "token-header" ? { tokenRequestHeaders: { "X-Secret": secret } } : {}),
        },
        tools: [
          {
            name: "read",
            description: "Read a resource",
            annotations: { readOnlyHint: true },
            async handler(_args, ctx) {
              return (await ctx.oauth!.fetch(`${OAUTH_ISSUER}/me`)).json();
            },
          },
        ],
      }),
    };
  });

/** `remoteMcp()`: a renewal before a write carries the stored grant's credentials the same way. */
const remoteRefreshCase = (mode: "refresh-token" | "client-secret") => (executor: Executor) =>
  checkRefreshCredentialCounts(executor, async (secret, namespace, storage) => {
    const downstream = httpDownstream(
      (server) =>
        server.registerTool("write", { description: "Write", inputSchema: z.object({}) }, async () => ({
          content: [{ type: "text", text: "done" }],
        })),
      { url: OAUTH_MCP_URL },
    );
    const grant = dueGrant(secret, mode === "refresh-token" ? "refresh-token" : "remote");
    await seedGrant(
      storage,
      {
        ...grant,
        issuer: OAUTH_ISSUER,
        client: {
          value: {
            ...grant.client.value,
            ...(mode === "client-secret"
              ? { client_secret: secret, token_endpoint_auth_method: "client_secret_post" }
              : {}),
          },
        },
        tokens: { ...grant.tokens, expires_in: 30 },
      },
      "v3:seeded",
      namespace,
    );
    return {
      address: "oauth.write",
      connector: remoteMcp("oauth", { url: OAUTH_MCP_URL, auth: { type: "oauth" } }),
      downstream: downstream as { fetch: typeof fetch },
    };
  });

/** A run publishes nothing until its secret set is final; every other outcome leaves ids refused. */
export const retainedSealingCases: Record<string, (executor: Executor) => Promise<void>> = {
  "a refresh's stored refresh token counts when the run seals (api)": apiRefreshCase("refresh-token"),
  "a refresh's client secret counts when the run seals (api)": apiRefreshCase("client-secret"),
  "a refresh's configured token-request header counts when the run seals (api)": apiRefreshCase("token-header"),
  "a refresh's stored refresh token counts when the run seals (remote)": remoteRefreshCase("refresh-token"),
  "a refresh's client secret counts when the run seals (remote)": remoteRefreshCase("client-secret"),
  "a typed array from an api() handler is refused once a second connector grows the set": async (executor) => {
    const original = { bytes: new TextEncoder().encode(LATE_SECRET), PAD };
    const vault = new CredentialVault(memoryStorage(), btoa("k".repeat(32)));
    vault.getAll = async () => ({ value: LATE_SECRET });
    const registry = new Registry(
      [
        api("download", {
          tools: [
            {
              name: "read",
              description: "Read bytes",
              annotations: { readOnlyHint: true },
              async handler() {
                return original;
              },
            },
          ],
        }),
        api("authenticated", {
          credential: { label: "Token" },
          tools: [
            {
              name: "use",
              description: "Use a credential",
              annotations: { readOnlyHint: true },
              async handler(_args, ctx) {
                await ctx.credential!.getAll();
                return "used";
              },
            },
          ],
        }),
      ],
      { storage: memoryStorage(), logger: silentLogger, credentialVault: vault },
    );
    const outcome = await createExecuteTool(registry, BASE, executor, silentLogger, undefined, { readOnly: false })({
      code: `async () => {
        const handle = await connecta.call("download.read");
        await connecta.call("authenticated.use");
        return handle.resultId;
      }`,
    });
    expect(await refusalOf(registry, outcome.structuredContent!.result as string)).toMatchObject({
      code: "result_not_retained",
      retryable: false,
    });
    expect(outcome.structuredContent?.note).toContain("Rerun the read");
  },
  "binary serialized into a result is refused after growth, however JSON stored it": async (executor) => {
    const bytes = new TextEncoder().encode(RETAINED_SECRET);
    const units = Array.from(RETAINED_SECRET, (char) => char.charCodeAt(0));
    const numbers = (item: ArrayLike<number>) => Array.from(item);
    const refused: Record<string, unknown> = {
      Uint8Array: bytes,
      Uint16Array: Uint16Array.from(units),
      Float32Array: Float32Array.from(units),
      DataView: new DataView(bytes.slice().buffer),
      ArrayBuffer: bytes.slice().buffer,
      "a typed array with its own toJSON": Object.assign(bytes.slice(), {
        toJSON(this: Uint8Array) {
          return numbers(this);
        },
      }),
      "an ArrayBuffer with its own toJSON": Object.assign(bytes.slice().buffer, {
        toJSON(this: ArrayBuffer) {
          return numbers(new Uint8Array(this));
        },
      }),
      "a parent toJSON returning typed bytes": { toJSON: () => bytes.slice() },
      "a nested typed array": { deep: [{ deeper: { bytes: bytes.slice() } }] },
      "a nested typed array with its own toJSON": {
        deep: [
          Object.assign(bytes.slice(), {
            toJSON(this: Uint8Array) {
              return numbers(this);
            },
          }),
        ],
      },
      "text a toJSON returned": { toJSON: () => RETAINED_SECRET },
      ...(typeof Buffer === "function" ? { Buffer: Buffer.from(bytes) } : {}),
    };
    const run = async (value: unknown, code = RETAINED_PROGRAM("read")) => {
      const { registry } = retainedRegistry(memoryStorage(), { echoed: () => value });
      const outcome = await createExecuteTool(registry, BASE, executor, silentLogger)({ code });
      return { registry, id: outcome.structuredContent!.result as string };
    };
    for (const [label, value] of Object.entries(refused)) {
      const { registry, id } = await run({ value, PAD });
      expect(await refusalOf(registry, id), label).toMatchObject({ code: "result_not_retained" });
    }
    const whole = await run(new Uint8Array(200_000));
    expect(await refusalOf(whole.registry, whole.id), "a top-level typed array").toMatchObject({
      code: "result_not_retained",
    });

    // What JSON stores as `{}` holds nothing to check, and a plain object is not binary.
    const published: Array<[string, unknown, unknown]> = [
      ["Blob", new Blob([bytes]), {}],
      ["Map", new Map([[RETAINED_SECRET, RETAINED_SECRET]]), {}],
      ["Set", new Set([RETAINED_SECRET]), {}],
      ["a numeric key", { "0": 1 }, { "0": 1 }],
      ["a date", new Date(0), new Date(0).toISOString()],
    ];
    for (const [label, value, stored] of published) {
      const { registry, id } = await run({ value, PAD });
      expect(JSON.parse(await pageFromLaterRun(registry, id)), label).toEqual({ value: stored, PAD });
    }

    // With no growth past the stash, binary holding no match is published as JSON stored it.
    const clean = new TextEncoder().encode("clean");
    const quiet = await run(
      { value: clean, PAD },
      `async () => {
        await connecta.call("vault.use");
        return (await connecta.call("vault.read")).resultId;
      }`,
    );
    expect(JSON.parse(await pageFromLaterRun(quiet.registry, quiet.id)).value).toEqual({ ...clean });
  },
  "binary in a program's oversized return is refused after growth": async () => {
    const returned = sealingHarness(
      {},
      {
        echoed: () => CLEAN,
        ...landingAfterProgram(),
      },
    );
    const outcome = await returned.run(
      scriptedExecutor(async (fns) => {
        void fns.describe!({ address: "slow.tool" }).catch(() => {});
        await fns.call!("vault.wait", {});
        await fns.call!("vault.land", {});
        return { bytes: new TextEncoder().encode(LATE_SECRET), PAD };
      }),
    );
    const id = (outcome.structuredContent!.result as { resultId: string }).resultId;
    expect(await refusalOf(returned.registry, id)).toMatchObject({ code: "result_not_retained" });
    expect(outcome.structuredContent?.note).toContain("Rerun the read");
  },
  "an offset issued during the run finds the same bytes, or an explicit refusal": async (executor) => {
    const continued = `async () => {
    const handle = await connecta.call("vault.read");
    const first = await connecta.result(handle, { offset: 0, maxBytes: 70 });
    const second = await connecta.result(handle, { offset: first.nextOffset, maxBytes: 70 });
    await connecta.call("vault.use");
    return { id: handle.resultId, nextOffset: first.nextOffset, second: second.text };
  }`;
    const records = (head: string) => ({ head, records: Array.from({ length: 120_000 }, (_, at) => `record-${at}`) });
    const unchanged = retainedRegistry(memoryStorage(), { echoed: () => records("no-secret-in-this-field") });
    const resumed = await createExecuteTool(unchanged.registry, BASE, executor, silentLogger)({ code: continued });
    const issued = resumed.structuredContent!.result as { id: string; nextOffset: number; second: string };
    const later = await createMetaTools(unchanged.registry, BASE, { readOnly: false }).readResult({
      id: issued.id,
      offset: issued.nextOffset,
      maxBytes: 70,
    });
    expect(later.structuredContent!.text).toBe(issued.second);
    const matching = retainedRegistry(memoryStorage(), { echoed: () => records(RETAINED_SECRET) });
    const stale = await createExecuteTool(matching.registry, BASE, executor, silentLogger)({ code: continued });
    const staleIssued = stale.structuredContent!.result as { id: string; nextOffset: number };
    const resumedStale = await createMetaTools(matching.registry, BASE, { readOnly: false }).readResult({
      id: staleIssued.id,
      offset: staleIssued.nextOffset,
      maxBytes: 70,
    });
    expect(resumedStale.isError).toBe(true);
    expect(resumedStale.structuredContent?.error).toMatchObject({ code: "result_not_retained", retryable: false });
  },
  "a credential read still pending when the program returns is waited for, and what it registers counts": async (
    executor,
  ) => {
    const read = sealingHarness({}, { code: LATE_READ_PROGRAM, ...landingAfterProgram() });
    const outcome = await read.run(executor);
    expect(outcome.isError, JSON.stringify(outcome.structuredContent)).toBeUndefined();
    await expectNothingReadable(read, outcome.structuredContent!.result as string[], "result_not_retained");
    expect(outcome.structuredContent?.note).toContain("Rerun the read");
  },
  "what a late credential read adds does not touch a result with no match in it": async (executor) => {
    const read = sealingHarness({}, { code: LATE_READ_PROGRAM, ...landingAfterProgram(), echoed: () => CLEAN });
    const outcome = await read.run(executor);
    expect(outcome.structuredContent).not.toHaveProperty("note");
    for (const id of outcome.structuredContent!.result as string[])
      expect(JSON.parse(await pageFromLaterRun(read.registry, id))).toEqual(CLEAN);
  },
  "a credential read still pending at the deadline leaves every entry unpublished, even once it lands": async (
    executor,
  ) => {
    let land = () => {};
    const gate = new Promise<void>((resolve) => (land = resolve));
    const headers: string[] = [];
    const read = sealingHarness(
      {
        set(key, value) {
          if (isHeader(key) && !isMarker(value)) headers.push(key);
        },
      },
      { code: LATE_READ_PROGRAM, credentialRead: () => gate, watchdogMs: 3000, armed: true, echoed: () => CLEAN },
    );
    const started = Date.now();
    const outcome = await read.run(executor);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(headers).toEqual([]);
    expect(outcome.structuredContent?.note).toContain("Rerun the read");
    const ids = outcome.structuredContent!.result as string[];
    await expectNothingReadable(read, ids, "result_not_retained");
    land();
    await after(20)();
    await expectNothingReadable(read, ids, "result_not_retained");
  },
  "a header write that stalls cannot leave an earlier entry readable with an unchecked secret": async (executor) => {
    let attempts = 0;
    const read = sealingHarness(
      {
        set(key) {
          if (isHeader(key) && ++attempts === 2) return new Promise(() => {});
          return undefined;
        },
      },
      { code: LATE_READ_PROGRAM, ...landingAfterProgram(), watchdogMs: 3000, armed: true },
    );
    const outcome = await read.run(executor);
    expect(outcome.structuredContent?.note).toContain("Rerun the read");
    await expectNothingReadable(read, outcome.structuredContent!.result as string[]);
  },
  "with a final set, a stalled header write costs that entry alone": async (executor) => {
    let attempts = 0;
    const stalled = sealingHarness(
      {
        set(key) {
          if (isHeader(key) && ++attempts === 2) return new Promise(() => {});
          return undefined;
        },
      },
      {
        armed: true,
        watchdogMs: 3000,
        echoed: () => CLEAN,
        code: `async () => [
          (await connecta.call("vault.read")).resultId,
          (await connecta.call("vault.clean")).resultId,
        ]`,
      },
    );
    const outcome = await stalled.run(executor);
    expect(outcome.structuredContent?.note).toContain("may fail");
    const pages = await Promise.all(
      (outcome.structuredContent!.result as string[]).map((id) => laterReader(stalled.inner).readResult({ id })),
    );
    expect(pages.filter((page) => page.isError)).toHaveLength(1);
  },
  "a marker is only a better message: failing to store it serves nothing, and the note stands": async (executor) => {
    const read = sealingHarness(
      {
        set(key, value) {
          if (isHeader(key) && isMarker(value)) throw new Error("storage offline");
        },
      },
      { code: LATE_READ_PROGRAM, ...landingAfterProgram(), armed: true },
    );
    const outcome = await read.run(executor);
    expect(outcome.structuredContent?.note).toContain("Rerun the read");
    await expectNothingReadable(read, outcome.structuredContent!.result as string[], "not_found");
  },
  "a registration that reaches the set while it is being checked stops publication": async (executor) => {
    let registered = false;
    const late = sealingHarness({
      get() {
        if (registered) return;
        registered = true;
        sentSecretsFor(late.state.ctx!).add(LATE_SECRET);
      },
    });
    const outcome = await late.run(executor);
    expect(registered).toBe(true);
    expect(outcome.structuredContent?.note).toContain("Rerun the read");
    await expectNothingReadable(late, [outcome.structuredContent!.result as string], "result_not_retained");
  },
  "a failed read-back refuses: a read says to rerun, and a write says not to repeat itself": async (executor) => {
    for (const tool of ["read", "write"]) {
      const failing = sealingHarness(
        {
          get() {
            throw new Error("storage offline");
          },
        },
        { tool, echoed: () => CLEAN },
      );
      const outcome = await failing.run(executor);
      expect(outcome.isError).toBeUndefined();
      const error = await refusalOf(failing.registry, outcome.structuredContent!.result as string);
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
    }
  },
  "storage that refuses every later operation cannot mark the entry, and still serves nothing": async (executor) => {
    const failing = sealingHarness(
      {
        get() {
          throw new Error("storage offline");
        },
        set() {
          throw new Error("storage offline");
        },
      },
      { echoed: () => CLEAN },
    );
    const outcome = await failing.run(executor);
    expect(outcome.structuredContent?.note).toContain("Rerun the read");
    await expectNothingReadable(failing, [outcome.structuredContent!.result as string], "not_found");
  },
  "storage that never answers cannot hold the response past the deadline": async (executor) => {
    const hung = sealingHarness(
      { get: () => new Promise(() => {}), set: () => new Promise(() => {}) },
      { watchdogMs: 3000, echoed: () => CLEAN },
    );
    const started = Date.now();
    const outcome = await hung.run(executor);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.structuredContent?.note).toContain("Rerun the read");
  },
};

/** At every storage step of sealing, another request reads only what sealing has published. */
export async function checkRetainedResultsUnreadableWhileSealing(executor: Executor): Promise<void> {
  const observed: Array<{ id: string; published: boolean; readable: boolean; text: string }> = [];
  let probing = false;
  const probe = async () => {
    if (probing) return;
    probing = true;
    const keys = await built.inner.list(RESULT_PREFIX);
    const ids = new Set(keys.map((key) => key.slice(RESULT_PREFIX.length).split("#")[0]!));
    const reader = laterReader(built.inner);
    for (const id of ids) {
      const page = await reader.readResult({ id, maxBytes: 24_000 });
      const stored = await built.inner.get(RESULT_PREFIX + id);
      observed.push({
        id,
        published: stored !== null && !isMarker(stored),
        readable: !page.isError,
        text: String(page.structuredContent?.text ?? ""),
      });
    }
    probing = false;
  };
  const built = sealingHarness(
    {
      get: probe,
      set: probe,
    },
    {
      echoed: () => ({ forms: allForms(RETAINED_SECRET), keep: "kept", PAD }),
      code: `async () => {
        const matched = await connecta.call("vault.read");
        const clean = await connecta.call("vault.clean");
        await connecta.call("vault.use");
        return { matched: matched.resultId, clean: clean.resultId };
      }`,
    },
  );
  const outcome = await built.run(executor);
  await probe();
  const { matched, clean } = outcome.structuredContent!.result as { matched: string; clean: string };
  const steps = (id: string) => observed.filter((step) => step.id === id);
  expect(steps(matched).length).toBeGreaterThan(0);
  expect(steps(clean).length).toBeGreaterThan(0);
  expect(steps(matched).filter((step) => step.readable)).toEqual([]);
  // Before its header is stored the clean entry reads as nothing, then it reads whole.
  expect(steps(clean).some((step) => !step.readable)).toBe(true);
  for (const step of steps(clean)) expect(step.readable).toBe(step.published);
  expect(steps(clean).at(-1)!.readable).toBe(true);
  for (const step of observed) expectNoForms(step.text);
}

/** A finished read's stash is reclaimed; a write's waits for the run; a disclosed handle stays. */
export async function checkTransferReclaim(executor: Executor): Promise<void> {
  const storage = memoryStorage();
  const bytes = 600_000;
  const registry = new Registry(
    [
      {
        id: "store",
        kind: "api",
        async listTools() {
          return [
            { name: "read", annotations: { readOnlyHint: true } },
            { name: "write", annotations: { readOnlyHint: false, destructiveHint: true } },
          ];
        },
        async callTool(_name, args) {
          return "x".repeat((args as { bytes?: number }).bytes ?? bytes);
        },
      },
    ],
    { storage, logger: silentLogger },
  );
  const execute = createExecuteTool(registry, BASE, executor, silentLogger, undefined, { readOnly: false });
  const charges = async () => {
    const raw = await storage.get("result-stash:v1:ledger");
    return raw === null ? 0 : (JSON.parse(raw) as { entries: unknown[] }).entries.length;
  };
  // Sealing runs after the program, so a released id must not get its header back then.
  const stored = () => storage.list(RESULT_PREFIX);
  const run = (code: string) => execute({ code });

  // Read: nothing stays charged or stored once the value is whole and the run has sealed.
  let out = await run(`async () => (await connecta.call("store.read")).data.length`);
  expect(out.structuredContent!.result, JSON.stringify(out.structuredContent)).toBe(bytes);
  expect(await charges()).toBe(0);
  expect(await stored()).toEqual([]);

  // Write in a successful run: released with the run.
  out = await run(`async () => (await connecta.call("store.write")).data.length`);
  expect(out.structuredContent!.result, JSON.stringify(out.structuredContent)).toBe(bytes);
  expect(await charges()).toBe(0);
  expect(await stored()).toEqual([]);

  // Write in a failed run: the output's bytes stay until they expire (INV-9).
  out = await run(`async () => { await connecta.call("store.write"); throw new Error("after the write"); }`);
  expect(out.isError).toBe(true);
  expect(await charges()).toBe(1);
  expect(await stored()).not.toEqual([]);

  // An oversized return's nextAction, edited at its mark, reduces the whole value.
  out = await run(`async () => ({ rows: Array.from({ length: 400 }, (_, i) => ({ i, pad: "x".repeat(80) })) })`);
  const notice = out.structuredContent!.result as { nextAction: { arguments: { code: string } } };
  expect(notice.nextAction.arguments.code).toContain("/* reduce data to what you need */");
  out = await run(notice.nextAction.arguments.code.replace(/return .*; \}$/, "return data.rows.length; }"));
  expect(out.structuredContent!.result, JSON.stringify(out.structuredContent)).toBe(400);

  // A handle the guest saw stays readable after it reads the whole thing, in this run or the next.
  const big = 1_200_000;
  out = await run(`async () => {
    const handle = await connecta.call("store.read", { bytes: ${big} });
    return { id: handle.resultId, length: (await connecta.result(handle, { all: true })).data.length };
  }`);
  const { id, length } = out.structuredContent!.result as { id: string; length: number };
  expect(length).toBe(big);
  out = await run(`async () => (await connecta.result(${JSON.stringify(id)}, { all: true })).data.length`);
  expect(out.structuredContent!.result, JSON.stringify(out.structuredContent)).toBe(big);
  // The failed run's write, the oversized return, and the handle.
  expect(await charges()).toBe(3);
}

/** A whole read is paging repeated: it sees exactly what a page may, and never more. */
export const wholeReadSealingCases: Record<string, (executor: Executor) => Promise<void>> = {
  "reads a held entry with no chunk 0 in its own run, then whole in a later run after read-back": async (executor) => {
    const inner = memoryStorage();
    const { registry } = retainedRegistry(inner, { echoed: () => ({ keep: "kept", PAD }) });
    const execute = createExecuteTool(registry, BASE, executor, silentLogger, undefined, { readOnly: false });
    const outcome = await execute({
      code: `async () => {
        const handle = await connecta.call("vault.read");
        const whole = await connecta.result(handle, { all: true });
        await connecta.call("vault.use");
        return { id: handle.resultId, keep: whole.data.keep, length: whole.data.PAD.length };
      }`,
    });
    const { id, keep, length } = outcome.structuredContent!.result as { id: string; keep: string; length: number };
    expect([keep, length]).toEqual(["kept", PAD.length]);
    // Sealing grew past it, read it back, found no match and published it unchanged.
    expect(outcome.structuredContent).not.toHaveProperty("note");
    expect(await inner.get(RESULT_PREFIX + id)).not.toBeNull();
    const later = await execute({
      code: `async () => (await connecta.result(${JSON.stringify(id)}, { all: true })).data.keep`,
    });
    expect(later.structuredContent!.result).toBe("kept");
  },
  "another request gets nothing from an entry its run still holds": async (executor) => {
    const inner = memoryStorage();
    const seen: Array<{ code: string | undefined; stored: boolean }> = [];
    const { registry } = retainedRegistry(inner, { echoed: () => ({ keep: "kept", PAD }) });
    const prober: Connector = {
      id: "probe",
      kind: "api",
      async listTools() {
        return [{ name: "other_request", annotations: { readOnlyHint: true } }];
      },
      async callTool(_name, args) {
        const { id } = args as { id: string };
        const page = await laterReader(inner).readResult({ id });
        seen.push({
          code: (page.structuredContent?.error as { code: string } | undefined)?.code,
          stored: (await inner.get(RESULT_PREFIX + id)) !== null,
        });
        return "probed";
      },
    };
    const both = new Registry([...registry.listConnectors(), prober], { storage: inner, logger: silentLogger });
    const outcome = await createExecuteTool(both, BASE, executor, silentLogger, undefined, { readOnly: false })({
      code: `async () => {
        const handle = await connecta.call("vault.read");
        await connecta.call("probe.other_request", { id: handle.resultId });
        return (await connecta.result(handle, { all: true })).data.keep;
      }`,
    });
    expect(outcome.structuredContent!.result, JSON.stringify(outcome.structuredContent)).toBe("kept");
    expect(seen).toEqual([{ code: "not_found", stored: false }]);
  },
  "a refused entry fails a later whole read catchably, with no bytes": async (executor) => {
    const forms = allForms(RETAINED_SECRET);
    for (const { tool, words } of [
      { tool: "read", words: "Rerun the read" },
      { tool: "write", words: "do not call it again" },
    ]) {
      const inner = memoryStorage();
      const { registry } = retainedRegistry(inner, { echoed: () => ({ forms, keep: "kept", PAD }) });
      const execute = createExecuteTool(registry, BASE, executor, silentLogger, undefined, { readOnly: false });
      const outcome = await execute({ code: RETAINED_PROGRAM(tool) });
      const id = outcome.structuredContent!.result as string;
      const later = await execute({
        code: `async () => {
          try { return { data: (await connecta.result(${JSON.stringify(id)}, { all: true })).data }; }
          catch (err) { return { code: err.code, retryable: err.retryable, message: err.message }; }
        }`,
      });
      const refused = later.structuredContent!.result as { code: string; retryable: boolean; message: string };
      expect(refused).toMatchObject({ code: "result_not_retained", retryable: false });
      expect(refused.message).toContain(words);
      expect(JSON.stringify(later.structuredContent)).not.toContain("kept");
      expectNoForms(JSON.stringify(later.structuredContent));
      // Its charge and missing bytes aren't handed back or reissued by asking whole.
      expectNoForms(await storedResultText(inner));
    }
  },
  "an entry sealing never published answers a later whole read with not_found": async (executor) => {
    // Every storage step after the set grows fails, so neither header nor marker lands.
    const built = sealingHarness(
      {
        set: async () => {
          throw new Error("storage down");
        },
      },
      { echoed: () => ({ keep: "kept", PAD }) },
    );
    const outcome = await built.run(executor);
    const id = outcome.structuredContent!.result as string;
    expect(await built.inner.get(RESULT_PREFIX + id)).toBeNull();
    const later = await createExecuteTool(built.registry, BASE, executor, silentLogger, undefined, {
      readOnly: false,
    })({
      code: `async () => {
        try { return (await connecta.result(${JSON.stringify(id)}, { all: true })).data.keep; }
        catch (err) { return { code: err.code }; }
      }`,
    });
    expect(later.structuredContent!.result).toEqual({ code: "not_found" });
  },
  "a credential registered before the read is redacted from what the run gets and returns": async (executor) => {
    const { registry } = retainedRegistry(memoryStorage(), {
      echoed: () => ({ forms: [RETAINED_SECRET], keep: "kept", PAD }),
    });
    const outcome = await createExecuteTool(registry, BASE, executor, silentLogger, undefined, { readOnly: false })({
      code: `async () => {
        const handle = await connecta.call("vault.read");
        await connecta.call("vault.use");
        const whole = await connecta.result(handle, { all: true });
        return { forms: whole.data.forms, keep: whole.data.keep };
      }`,
    });
    expect(outcome.structuredContent!.result).toEqual({ forms: ["[redacted]"], keep: "kept" });
    expect(JSON.stringify(outcome.structuredContent)).not.toContain(RETAINED_SECRET);
  },
  "a reclaimed transfer leaves no header, charge or refusal after the set grows": async (executor) => {
    // Under 1 MiB, inlined with no handle shown, and given back before the set grows.
    const inner = memoryStorage();
    const { registry } = retainedRegistry(inner, { echoed: () => ({ keep: "kept", pad: "x".repeat(300_000) }) });
    const outcome = await createExecuteTool(registry, BASE, executor, silentLogger, undefined, { readOnly: false })({
      code: `async () => {
        const inlined = await connecta.call("vault.read");
        await connecta.call("vault.use");
        return inlined.data.keep;
      }`,
    });
    expect(outcome.structuredContent!.result, JSON.stringify(outcome.structuredContent)).toBe("kept");
    expect(outcome.structuredContent).not.toHaveProperty("note");
    expect(await inner.list(RESULT_PREFIX)).toEqual([]);
    expect(await inner.get("result-stash:v1:ledger")).toBeNull();
  },
  "a stalled reclaim costs its charge, never the answer": async (executor) => {
    for (const tool of ["read", "write"]) {
      const inner = memoryStorage();
      const stalled: KVStorage = {
        ...inner,
        delete: (key) => (key.startsWith(RESULT_PREFIX) ? new Promise<never>(() => {}) : inner.delete(key)),
      };
      const { registry } = retainedRegistry(stalled, { echoed: () => ({ keep: "kept", pad: "x".repeat(300_000) }) });
      const started = Date.now();
      const outcome = await createExecuteTool(registry, BASE, executor, silentLogger, undefined, {
        readOnly: false,
        hostCallTimeoutMs: 250,
        watchdogMs: 4_000,
      })({ code: `async () => (await connecta.call("vault.${tool}")).data.keep` });
      expect(outcome.structuredContent!.result, JSON.stringify(outcome.structuredContent)).toBe("kept");
      // The ceiling is the watchdog plus a margin of at most 2 seconds.
      expect(Date.now() - started).toBeLessThan(6_000);
    }
  },
};

/** Sealing owns an entry from the moment it begins: a later reclaim gives nothing back. */
export async function checkReclaimAfterSealingBegan(): Promise<void> {
  const secrets = sentSecretsForRequest({});
  const entry = (id: string): HeldResult => ({
    id,
    binding: "e30=",
    total: 3,
    chunkBytes: 3,
    cap: 3,
    first: "YWJj",
    chunks: 1,
    passed: 0,
    binary: false,
    format: "text",
    write: false,
    expiresAtMs: Date.now() + 60_000,
  });
  const held = new HeldResults(secrets, new PendingWork());
  const releaseResult = vi.fn(async () => {});
  const registry = { releaseResult } as unknown as RegistryView;
  held.add(entry("given-back"));
  held.add(entry("kept"));
  await releaseStashedResult(registry, held, "given-back", 3);
  expect(releaseResult).toHaveBeenCalledTimes(1);
  expect(held.stored("given-back")).toBeUndefined();
  // An id this run never held is not this run's to give back.
  await releaseStashedResult(registry, held, "someone-elses", 3);
  expect(releaseResult).toHaveBeenCalledTimes(1);
  expect(held.close().map(({ id }) => id)).toEqual(["kept"]);
  await releaseStashedResult(registry, held, "kept", 3);
  expect(releaseResult).toHaveBeenCalledTimes(1);
}
