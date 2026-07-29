import readline from "node:readline";
import { Buffer } from "node:buffer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getEncoding } from "js-tiktoken";

const url =
  process.env.CONNECTA_EVAL_URL ?? "http://127.0.0.1:8797/mcp";
const token = process.env.CONNECTA_EVAL_TOKEN ?? "connecta-eval-token";
const tokenizerName = process.env.CONNECTA_EVAL_TOKENIZER ?? "o200k_base";
const tokenizer = getEncoding(tokenizerName);

const client = new Client({
  name: "connecta-current-version-model-run",
  version: "1.0.0",
});
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: {
    headers: { Authorization: `Bearer ${token}` },
  },
});

const connectionStarted = performance.now();
await client.connect(transport);
const listed = await client.listTools();
const connectionMs = Math.round((performance.now() - connectionStarted) * 10) / 10;

function serialized(value) {
  return JSON.stringify(value);
}

function bytes(value) {
  return Buffer.byteLength(serialized(value), "utf8");
}

function tokens(value) {
  return tokenizer.encode(serialized(value)).length;
}

function resultTokenBreakdown(result) {
  return {
    contentTokens: tokens(result.content ?? null),
    structuredContentTokens: tokens(result.structuredContent ?? null),
    otherTokens: tokens({
      ...result,
      content: undefined,
      structuredContent: undefined,
    }),
  };
}

const observations = [
  {
    operation: "initialize+tools/list",
    latencyMs: connectionMs,
    requestBytes: 0,
    requestTokens: 0,
    responseBytes: Buffer.byteLength(JSON.stringify(listed), "utf8"),
    responseTokens: tokens(listed),
  },
];

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

emit({
  event: "connected",
  connectionMs,
  tokenizer: tokenizerName,
  toolCount: listed.tools.length,
  toolsListBytes: bytes(listed),
  toolsListTokens: tokens(listed),
  tools: listed.tools.map((tool) => ({
    name: tool.name,
    schemaBytes: bytes(tool),
    schemaTokens: tokens(tool),
  })),
});

const input = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

for await (const line of input) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let command;
  try {
    command = JSON.parse(trimmed);
  } catch (error) {
    emit({ event: "client_error", message: String(error) });
    continue;
  }
  if (command.action === "close") break;
  if (command.action === "summary") {
    emit({
      event: "summary",
      operationCount: observations.length,
      totalLatencyMs:
        Math.round(
          observations.reduce((sum, item) => sum + item.latencyMs, 0) * 10,
        ) / 10,
      totalRequestBytes: observations.reduce(
        (sum, item) => sum + item.requestBytes,
        0,
      ),
      totalRequestTokens: observations.reduce(
        (sum, item) => sum + item.requestTokens,
        0,
      ),
      totalResponseBytes: observations.reduce(
        (sum, item) => sum + item.responseBytes,
        0,
      ),
      totalResponseTokens: observations.reduce(
        (sum, item) => sum + item.responseTokens,
        0,
      ),
      observations,
    });
    continue;
  }
  if (command.action === "list") {
    const started = performance.now();
    const result = await client.listTools();
    const observation = {
      operation: "tools/list",
      latencyMs:
        Math.round((performance.now() - started) * 10) / 10,
      requestBytes: bytes({ method: "tools/list", params: {} }),
      requestTokens: tokens({ method: "tools/list", params: {} }),
      responseBytes: bytes(result),
      responseTokens: tokens(result),
      responseTokenBreakdown: resultTokenBreakdown(result),
    };
    observations.push(observation);
    emit({
      event: "tools_list",
      ...observation,
      result,
    });
    continue;
  }
  if (command.action !== "call" || typeof command.tool !== "string") {
    emit({ event: "client_error", message: "Expected action=call and tool." });
    continue;
  }
  const params = {
    name: command.tool,
    arguments: command.args ?? {},
  };
  const started = performance.now();
  try {
    const result = await client.callTool(params);
    const observation = {
      operation: command.tool,
      latencyMs:
        Math.round((performance.now() - started) * 10) / 10,
      requestBytes: bytes(params),
      requestTokens: tokens(params),
      responseBytes: bytes(result),
      responseTokens: tokens(result),
      responseTokenBreakdown: resultTokenBreakdown(result),
    };
    observations.push(observation);
    emit({
      event: "tool_result",
      tool: command.tool,
      ...observation,
      result,
    });
  } catch (error) {
    const observation = {
      operation: command.tool,
      latencyMs:
        Math.round((performance.now() - started) * 10) / 10,
      requestBytes: bytes(params),
      requestTokens: tokens(params),
      responseBytes: 0,
      responseTokens: 0,
    };
    observations.push(observation);
    emit({
      event: "transport_error",
      tool: command.tool,
      ...observation,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

input.close();
await transport.close();
