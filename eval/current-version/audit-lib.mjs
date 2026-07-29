import { Buffer } from "node:buffer";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getEncoding } from "js-tiktoken";

export function serialized(value) {
  return JSON.stringify(value) ?? "null";
}

export function round(value, places = 1) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

export function structured(result) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function textContent(result) {
  return result.content?.find((item) => item.type === "text")?.text;
}

export function errorCode(result) {
  const value = structured(result);
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.error &&
    typeof value.error === "object" &&
    typeof value.error.code === "string"
  ) {
    return value.error.code;
  }
  return undefined;
}

export async function createAuditClient({
  url,
  token,
  tokenizerName,
}) {
  const tokenizer = getEncoding(tokenizerName);
  const tokens = (value) => tokenizer.encode(serialized(value)).length;
  const bytes = (value) => Buffer.byteLength(serialized(value), "utf8");
  const client = new Client({
    name: "connecta-current-version-audit",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });

  const started = performance.now();
  await client.connect(transport);
  const listed = await client.listTools();
  const connection = {
    latencyMs: round(performance.now() - started),
    toolsListBytes: bytes(listed),
    toolsListTokens: tokens(listed),
    toolCount: listed.tools.length,
    tools: listed.tools.map((tool) => ({
      name: tool.name,
      definitionBytes: bytes(tool),
      definitionTokens: tokens(tool),
    })),
  };
  const observations = [];

  async function call(name, tool, args, classify = () => ({})) {
    const params = { name: tool, arguments: args };
    const callStarted = performance.now();
    const result = await client.callTool(params);
    const classification = classify(result);
    const observation = {
      name,
      tool,
      latencyMs: round(performance.now() - callStarted),
      requestBytes: bytes(params),
      requestTokens: tokens(params),
      responseBytes: bytes(result),
      responseTokens: tokens(result),
      contentTokens: tokens(result.content ?? null),
      structuredContentTokens: tokens(result.structuredContent ?? null),
      hasContent: Array.isArray(result.content),
      hasStructuredContent: result.structuredContent !== undefined,
      isError: result.isError === true,
      ...classification,
    };
    observations.push(observation);
    return { result, observation };
  }

  return {
    client,
    transport,
    tokenizerName,
    tokens,
    bytes,
    listed,
    connection,
    observations,
    call,
    async close() {
      tokenizer.free?.();
      await transport.close();
    },
  };
}
