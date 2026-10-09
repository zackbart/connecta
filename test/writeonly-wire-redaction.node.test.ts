// Node-only: verifies raw-wire redaction and program result paging with the real QuickJS child-process executor.
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { ConnectorCallError } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { quickJsExecutor } from "../src/executors/quickjs.js";
import { createMetaTools } from "../src/meta-tools.js";
import { SentSecrets } from "../src/sent-secrets.js";
import { memoryStorage } from "../src/storage/memory.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { activitySink, makeRegistry, silentLogger } from "./helpers.js";
import type { Connector } from "../src/types.js";

const BASE = "https://wire-redaction.test";
const REDACTED = "[redacted]";
const executor = quickJsExecutor({ cpuTimeMs: 5_000 });
vi.setConfig({ testTimeout: 20_000 });
afterAll(async () => await executor.close?.());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function wireConnector(reply: () => unknown, kind: "mcp" | "api" = "mcp"): Connector {
  return {
    id: "wire",
    kind,
    async listTools() {
      return [
        {
          name: "read",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: { value: { type: "string", writeOnly: true } } },
        },
      ];
    },
    async callTool() {
      const value = reply();
      return kind === "mcp" ? { content: [{ type: "text", text: value }] } : value;
    },
  };
}

async function readPages(registry: ReturnType<typeof makeRegistry>, id: string): Promise<string> {
  let body = "";
  for (let offset = 0; ;) {
    // Fresh requests cannot rely on the original private argument set.
    const page = await createMetaTools(registry, BASE).readResult({ id, offset, maxBytes: 32_768 });
    expect(page.isError).toBeFalsy();
    const value = page.structuredContent!;
    body += value.text;
    if (!value.hasMore) return body;
    offset = value.nextOffset as number;
  }
}

it("INV-5: raw scalar private echoes and registration refusals stay redacted before JSON parsing, QuickJS and stash persistence", async () => {
  let reply = "";
  const registry = makeRegistry([wireConnector(() => reply)], { storage: memoryStorage(), maxResultBytes: 1_024 });
  const meta = createMetaTools(registry, BASE);
  const run = createExecuteTool(registry, BASE, executor, silentLogger);
  const stash = vi.spyOn(registry, "stashResult");
  for (const value of ["12345678", "true", "null", "1234567", "7".repeat(1_048_577)]) {
    reply = value;
    for (const resultMode of ["mcp", "value"] as const) {
      const result = await meta.callTool({ address: "wire.read", args: { value }, resultMode });
      expect(result.isError).toBeFalsy();
      if (resultMode === "mcp") expect(result.content[0]!.text).toBe(REDACTED);
      else expect(result.structuredContent).toMatchObject({ ok: true, data: REDACTED, format: "text" });
    }
    // The oversized value exceeds QuickJS's independent host-call IPC cap.
    if (value.length < 1_048_576) {
      const program = await run({
        code: `async () => await connecta.call("wire.read", { value: ${JSON.stringify(value)} })`,
      });
      expect(program.isError, JSON.stringify(program.structuredContent)).toBeFalsy();
      expect(program.structuredContent).toMatchObject({ result: { data: REDACTED, format: "text" } });
    }
  }
  expect(stash).not.toHaveBeenCalled();
  reply = " ".repeat(1_016) + "12345678" + " ".repeat(8_000);
  const result = await meta.callTool({ address: "wire.read", args: { value: "12345678" }, resultMode: "value" });
  const notice = result.structuredContent!.data as { resultId: string };
  expect(await readPages(registry, notice.resultId)).toBe(JSON.stringify(reply.replace("12345678", REDACTED)));
  const chunks = stash.mock.calls[0]![1];
  const persisted = chunks.map((chunk, i) => atob(i === 0 ? chunk.slice(chunk.lastIndexOf(":") + 1) : chunk)).join("");
  expect(persisted).not.toContain("12345678");
  const crossToken = '12345678,"next":"allowed';
  const secrets = new SentSecrets();
  secrets.arguments({ value: crossToken }, { type: "object", properties: { value: { writeOnly: true } } });
  const raw = JSON.stringify({
    id: "needed-id",
    numeric: 12345678,
    next: "allowed",
    padding: Array.from({ length: 8 }, () => "x".repeat(200_000)),
  });
  expect(secrets.text(raw)).toBe(REDACTED);
});

it("INV-5 INV-6: private values containing the placeholder stay redacted through errors, QuickJS output, reconstruction and result pages", async () => {
  const value = "private-[redacted]-793";
  let reply: unknown = { id: "needed-id", echo: value };
  let failed = false;
  for (const kind of ["mcp", "api"] as const) {
    const sink = activitySink();
    const record = vi.fn();
    const registry = makeRegistry(
      [
        wireConnector(() => {
          if (failed) throw new ConnectorCallError("invalid_args", value);
          return kind === "mcp" ? JSON.stringify(reply) : reply;
        }, kind),
      ],
      {
        storage: memoryStorage(),
        maxResultBytes: 32_768,
        logger: { debug: record, info: record, warn: record, error: record },
      },
    );
    const meta = createMetaTools(registry, BASE, { activity: sink.activity });
    const run = createExecuteTool(registry, BASE, executor, silentLogger, sink.activity);
    const stash = vi.spyOn(registry, "stashResult");
    reply = { id: "needed-id", echo: value };
    for (const failure of [false, true]) {
      failed = failure;
      for (const resultMode of ["mcp", "value"] as const) {
        const result = await meta.callTool({ address: "wire.read", args: { value }, resultMode });
        expect(result.isError === true).toBe(failure);
        expect(JSON.stringify(result)).not.toContain(value);
        if (failure) expect(result.structuredContent!.error).toMatchObject({ code: "invalid_args", retryable: false });
        else if (resultMode === "value")
          expect(result.structuredContent!.data).toEqual({ id: "needed-id", echo: REDACTED });
      }
    }
    failed = false;
    const program = await run({
      code: `async () => {
      const result = await connecta.call("wire.read", { value: ${JSON.stringify(value)} });
      console.log(${JSON.stringify(value)});
      connecta.emit({ type: "text", text: ${JSON.stringify(value)} });
      return { result, echo: ${JSON.stringify(value)} };
    }`,
    });
    expect(program.isError, JSON.stringify(program.structuredContent)).toBeFalsy();
    expect(program.structuredContent).toMatchObject({ result: { echo: REDACTED }, logs: REDACTED });
    expect(program.content.at(-1)?.text).toBe(REDACTED);
    reply = { id: "needed-id", echo: value, padding: "x".repeat(318_000) };
    const reconstructed = await run({
      code: `async () => {
      const result = await connecta.call("wire.read", { value: ${JSON.stringify(value)} });
      return { id: result.data.id, echo: result.data.echo, length: result.data.padding.length };
    }`,
    });
    expect(reconstructed.isError, JSON.stringify(reconstructed.structuredContent)).toBeFalsy();
    expect(reconstructed.structuredContent).toMatchObject({
      result: { id: "needed-id", echo: REDACTED, length: 318_000 },
    });
    reply = { id: "needed-id", echo: value, padding: Array.from({ length: 8 }, () => "x".repeat(160_000)) };
    const paged = await run({
      code: `async () => {
      const handle = await connecta.call("wire.read", { value: ${JSON.stringify(value)} });
      const page = await connecta.result(handle, { page: 0, maxBytes: 1024 });
      return { handle, text: page.text };
    }`,
    });
    expect(paged.isError, JSON.stringify(paged.structuredContent)).toBeFalsy();
    const result = paged.structuredContent!.result as { handle: { format: string; resultId: string }; text: string };
    expect(result.handle.format).toBe("paged");
    expect(result.text).toContain(`"echo":"${REDACTED}"`);
    const stored = await readPages(registry, result.handle.resultId);
    expect(JSON.parse(stored)).toEqual({ ...(reply as object), echo: REDACTED });
    const follow = await run({
      code: `async () => await connecta.result(${JSON.stringify(result.handle.resultId)}, { page: 0 })`,
    });
    expect(follow.isError).toBeFalsy();
    expect(JSON.stringify(follow)).not.toContain(value);
    expect(stash).toHaveBeenCalledTimes(2);
    for (const [, chunks] of stash.mock.calls) {
      const bytes = chunks.map((chunk, i) => atob(i === 0 ? chunk.slice(chunk.lastIndexOf(":") + 1) : chunk)).join("");
      expect(bytes).not.toContain(value);
    }
    expect(JSON.stringify([program, record.mock.calls, sink.events])).not.toContain(value);
  }
});

it("INV-5: public-schema remote tools redact bare numeric bearer credentials in direct modes and QuickJS", async () => {
  const token = "12345678";
  const downstream = httpDownstream(
    (server) =>
      server.registerTool(
        "read",
        {
          description: "Read public data",
          annotations: { readOnlyHint: true },
        },
        async () => ({ content: [{ type: "text", text: token }] }),
      ),
    {
      capture: (request) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      },
    },
  );
  vi.stubGlobal("fetch", downstream.fetch);
  const registry = makeRegistry([
    remoteMcp("remote", {
      url: downstream.url,
      auth: { type: "headers", headers: { Authorization: `Bearer ${token}` } },
    }),
  ]);
  for (const resultMode of ["mcp", "value"] as const) {
    const result = await createMetaTools(registry, BASE).callTool({ address: "remote.read", resultMode });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).toContain(REDACTED);
  }
  const result = await createExecuteTool(
    registry,
    BASE,
    executor,
    silentLogger,
  )({
    code: 'async () => await connecta.call("remote.read")',
  });
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
  expect(result.structuredContent).toMatchObject({ result: { data: REDACTED, format: "text" } });
});

it("INV-5: literal JSON redaction preserves public whitespace and unchanged wire bytes", () => {
  const secrets = new SentSecrets();
  secrets.header("Bearer 12345678");
  const publicText = ' \n{ "id" : "needed-id", "status" : "ok" }\n ';
  expect(secrets.text(publicText)).toBe(publicText);
  const echoed = ' \n{ "id" : "needed-id", "echo" : "12345678" }\n ';
  expect(secrets.text(echoed)).toBe(echoed.replace("12345678", REDACTED));
});
