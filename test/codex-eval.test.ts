import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCodex } from "../eval/agent/codex.js";
import { infraError, stopsBatch } from "../eval/agent/infra.js";
import { parseTrace } from "../eval/agent/trace.js";

const SERVER = String.raw`
const readline = require('node:readline');
const mode = process.argv[2];
const send = x => process.stdout.write(JSON.stringify(x) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    // A server request can reuse a pending client request id. The client must
    // answer it before treating the later id=1 response as initialize's reply.
    send({ id: m.id, method: 'mcpServer/elicitation/request', params: {
      mode: 'form', message: 'Approve?', requestedSchema: { type: 'object', properties: {} },
    } });
  } else if (m.id === 1 && m.result?.action === 'decline') {
    send({ id: 1, result: {} });
  } else if (m.method === 'thread/start') {
    send({ id: m.id, result: { model: m.params.model, thread: { id: 'thread-1' } } });
  } else if (m.method === 'mcpServerStatus/list') {
    send({ id: m.id, result: { data: [{ name: 'connecta', tools: { execute_code: {} } }] } });
  } else if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: 'turn-1' } } });
    if (mode === 'complete') {
      send({ method: 'item/started', params: { item: { type: 'mcpToolCall', id: 'tool-1', server: 'connecta', tool: 'execute_code', arguments: { code: '1' } } } });
      send({ method: 'item/completed', params: { item: { type: 'mcpToolCall', id: 'tool-1', server: 'connecta', tool: 'execute_code', status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } } } });
      send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    }
  }
});
`;

async function fixture(mode: "complete" | "hang", signal?: AbortSignal,
  nextTurn: () => Promise<string | undefined> = async () => undefined, timeoutMs = 10_000) {
  const root = await mkdtemp(join(tmpdir(), "connecta-codex-test-"));
  try {
    const script = join(root, "server.cjs");
    const auth = join(root, "auth.json");
    await writeFile(script, SERVER);
    await writeFile(auth, "{}");
    return await runCodex({
      model: "gpt-6-sol", mcpUrl: "http://127.0.0.1:1/mcp", token: "fake-secret",
      allowedTools: ["execute_code"], deniedTools: [], timeoutMs,
      firstPrompt: "test", nextTurn,
      ...(signal ? { signal } : {}),
      testHost: { executable: process.execPath, args: [script, mode], authFile: auth, version: "fake-codex" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Codex eval app-server", () => {
  it("declines MCP approval with a colliding request id and translates tool events", async () => {
    const run = await fixture("complete");
    const trace = parseTrace(run.events, run.turnStarts, ["test"]);
    expect(trace.permissionDenials).toContain("mcpServer/elicitation/request");
    expect(trace.toolUses).toMatchObject([{ tool: "execute_code", resultText: "ok", isError: false }]);
    expect(trace.resultSubtypes).toEqual(["success"]);
    expect(trace.modelTurns).toBeUndefined();
    expect(trace.apiMs).toBeUndefined();
    expect(run.model).toBe("gpt-6-sol");
    expect(run.loadedTools).toEqual(["mcp__connecta__execute_code"]);
  });

  it("terminates an active turn when interrupted", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 250);
    const started = performance.now();
    try {
      const run = await fixture("hang", controller.signal);
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(run.events.some(event => event.type === "result" && event.subtype !== "success")).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it("bounds a follow-up callback that never settles", async () => {
    const started = performance.now();
    const run = await fixture("complete", undefined, async () => await new Promise(() => {}), 250);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(run.timedOut).toBe(true);
  });

  it("stops the batch on a typed usage limit even when its message has no rate keyword", () => {
    const error = infraError([{ type: "result", subtype: "failed", result: "Usage cap reached",
      codex_error_info: "usageLimitExceeded" }], 0, ["mcp__connecta__execute_code"]);
    expect(error).toContain("usageLimitExceeded");
    expect(stopsBatch(error)).toBe(true);
  });
});
