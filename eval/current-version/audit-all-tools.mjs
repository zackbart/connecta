import { writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getEncoding } from "js-tiktoken";

const url =
  process.env.CONNECTA_EVAL_URL ?? "http://127.0.0.1:8797/mcp";
const bearer = process.env.CONNECTA_EVAL_TOKEN ?? "connecta-eval-token";
const tokenizerName = process.env.CONNECTA_EVAL_TOKENIZER ?? "o200k_base";
const outputPath = process.argv[2];
const tokenizer = getEncoding(tokenizerName);

function serialized(value) {
  return JSON.stringify(value);
}

function bytes(value) {
  return Buffer.byteLength(serialized(value), "utf8");
}

function tokens(value) {
  return tokenizer.encode(serialized(value)).length;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function structured(result) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function resultSummary(result) {
  const value = structured(result);
  const text = result.content?.find((item) => item.type === "text")?.text;
  return {
    isError:
      result.isError === true ||
      (value &&
        typeof value === "object" &&
        "ok" in value &&
        value.ok === false),
    structuredKeys:
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value)
        : [],
    structuredSummary: summarizeStructuredValue(value),
    textPreview:
      typeof text === "string"
        ? text.replaceAll(/\s+/g, " ").slice(0, 180)
        : null,
  };
}

function summarizeStructuredValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Array.isArray(value.connectors)) {
    return {
      connectorCount: value.connectors.length,
      toolCount: value.connectors.reduce(
        (sum, connector) =>
          sum +
          (Array.isArray(connector.tools)
            ? connector.tools.length
            : (connector.toolCount ?? 0)),
        0,
      ),
      statusCounts: Object.fromEntries(
        [...new Set(value.connectors.map((connector) => connector.status))]
          .filter(Boolean)
          .map((status) => [
            status,
            value.connectors.filter(
              (connector) => connector.status === status,
            ).length,
          ]),
      ),
      ...(typeof value.total === "number" ? { total: value.total } : {}),
      ...(typeof value.matchMode === "string"
        ? { matchMode: value.matchMode }
        : {}),
    };
  }
  if (Array.isArray(value.tools)) {
    return { toolCount: value.tools.length };
  }
  if (Array.isArray(value.results)) {
    const childDurations = value.results
      .map((entry) => entry.durationMs)
      .filter((duration) => typeof duration === "number");
    return {
      resultCount: value.results.length,
      successCount: value.results.filter((entry) => entry.ok === true).length,
      failureCount: value.results.filter((entry) => entry.ok === false).length,
      ...(typeof value.durationMs === "number"
        ? { batchDurationMs: value.durationMs }
        : {}),
      ...(childDurations.length > 0
        ? {
            maxChildDurationMs: Math.max(...childDurations),
            summedChildDurationMs: childDurations.reduce(
              (sum, duration) => sum + duration,
              0,
            ),
          }
        : {}),
    };
  }
  if ("ok" in value) {
    return {
      ok: value.ok,
      ...(value.error?.code ? { errorCode: value.error.code } : {}),
      ...(value.data?.truncated === true
        ? {
            truncated: true,
            totalBytes: value.data.totalBytes,
          }
        : {}),
      ...(value.data && typeof value.data === "object"
        ? { dataKeys: Object.keys(value.data) }
        : {}),
      ...(typeof value.durationMs === "number"
        ? { durationMs: value.durationMs }
        : {}),
    };
  }
  if ("offset" in value && "text" in value) {
    return {
      offset: value.offset,
      nextOffset: value.nextOffset,
      totalBytes: value.totalBytes,
      textBytes: Buffer.byteLength(value.text, "utf8"),
    };
  }
  if ("status" in value && "connector" in value) {
    return {
      connector: value.connector,
      status: value.status,
      hasAuthorizationUrl:
        typeof value.authorizationUrl === "string" &&
        value.authorizationUrl.length > 0,
    };
  }
  if ("result" in value) {
    return {
      resultType: Array.isArray(value.result)
        ? "array"
        : typeof value.result,
      resultKeys:
        value.result &&
        typeof value.result === "object" &&
        !Array.isArray(value.result)
          ? Object.keys(value.result)
          : [],
    };
  }
  return null;
}

const client = new Client({
  name: "connecta-current-version-tool-audit",
  version: "1.0.0",
});
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: {
    headers: { Authorization: `Bearer ${bearer}` },
  },
});

const connectedAt = performance.now();
await client.connect(transport);
const listed = await client.listTools();
const connectionMs = round(performance.now() - connectedAt);
const cases = [];

async function runCase(name, tool, args) {
  const params = { name: tool, arguments: args };
  const started = performance.now();
  const result = await client.callTool(params);
  const observation = {
    name,
    tool,
    latencyMs: round(performance.now() - started),
    requestBytes: bytes(params),
    requestTokens: tokens(params),
    responseBytes: bytes(result),
    responseTokens: tokens(result),
    contentTokens: tokens(result.content ?? null),
    structuredContentTokens: tokens(result.structuredContent ?? null),
    ...resultSummary(result),
  };
  cases.push(observation);
  return result;
}

await runCase("list available skills", "skills", {});
await runCase("read routing guide", "skills", { name: "usage" });
await runCase("fast connector inventory", "list_connectors", {
  probe: false,
});
await runCase("live connector health", "list_connectors", { probe: true });
await runCase("focused discovery", "search_tools", {
  query: "npm downloads GitHub repository and controlled records",
  includeSchemas: "compact",
  limit: 10,
});
await runCase("inspect complete input schemas", "describe_tools", {
  addresses: [
    "npm.get_download_counts",
    "github.get_repository",
    "controlled.large_document",
    "controlled.records",
    "controlled.increment_counter",
    "protected.whoami",
    "oauth-fixture.whoami",
  ],
  format: "json",
});
await runCase("single live read-only call", "call_tool", {
  address: "npm.get_download_counts",
  args: {
    name: "@modelcontextprotocol/sdk",
    period: "last-week",
  },
  fields: ["package", "downloads", "start", "end"],
  resultMode: "value",
  diagnostics: true,
});
await runCase("read-only gate refuses a write", "call_tool", {
  address: "controlled.increment_counter",
  args: { amount: 1 },
  resultMode: "value",
});
const truncated = await runCase(
  "prepare a truncated result",
  "call_tool",
  {
    address: "controlled.large_document",
    args: { paragraphs: 20 },
    resultMode: "value",
    diagnostics: true,
  },
);
const truncatedValue = structured(truncated);
const resultId = truncatedValue?.data?.resultId;
if (typeof resultId !== "string") {
  throw new Error("Truncation setup did not return a result id.");
}
await runCase("page a stashed result", "get_result", {
  id: resultId,
  offset: 0,
  maxBytes: 700,
});
await runCase("parallel live read-only calls", "batch_call", {
  calls: [
    {
      address: "npm.get_download_counts",
      args: {
        name: "@modelcontextprotocol/sdk",
        period: "last-week",
      },
      fields: ["package", "downloads"],
    },
    {
      address: "github.get_repository",
      args: {
        owner: "modelcontextprotocol",
        repo: "typescript-sdk",
      },
      fields: ["full_name", "stargazers_count", "open_issues_count"],
    },
  ],
  resultMode: "value",
  diagnostics: true,
});
await runCase(
  "approved isolated write",
  "call_destructive_tool",
  {
    address: "controlled.increment_counter",
    args: { amount: 2 },
    resultMode: "value",
    diagnostics: true,
  },
);
await runCase("start simulated OAuth", "authorize_connector", {
  connector: "oauth-fixture",
});
await runCase("sandboxed reduction", "execute_code", {
  code:
    "async () => { " +
    "const rows = await controlled.records({ count: 120 }); " +
    "return rows.reduce((out, row) => { " +
    "const group = out[row.group] ??= { count: 0, sum: 0, max: 0 }; " +
    "group.count++; group.sum += row.score; " +
    "group.max = Math.max(group.max, row.score); return out; }, {}); }",
});

const toolSchemas = listed.tools.map((tool) => ({
  name: tool.name,
  schemaBytes: bytes(tool),
  schemaTokens: tokens(tool),
}));
const toolTotals = toolSchemas.map((schema) => {
  const observations = cases.filter((entry) => entry.tool === schema.name);
  return {
    tool: schema.name,
    schemaTokens: schema.schemaTokens,
    calls: observations.length,
    requestTokens: observations.reduce(
      (sum, entry) => sum + entry.requestTokens,
      0,
    ),
    responseTokens: observations.reduce(
      (sum, entry) => sum + entry.responseTokens,
      0,
    ),
    totalMeasuredTokens:
      schema.schemaTokens +
      observations.reduce(
        (sum, entry) =>
          sum + entry.requestTokens + entry.responseTokens,
        0,
      ),
    averageLatencyMs:
      observations.length > 0
        ? round(
            observations.reduce(
              (sum, entry) => sum + entry.latencyMs,
              0,
            ) / observations.length,
          )
        : null,
    maxLatencyMs:
      observations.length > 0
        ? Math.max(...observations.map((entry) => entry.latencyMs))
        : null,
    errorCases: observations.filter((entry) => entry.isError).length,
  };
});

const callRequestTokens = cases.reduce(
  (sum, entry) => sum + entry.requestTokens,
  0,
);
const callResponseTokens = cases.reduce(
  (sum, entry) => sum + entry.responseTokens,
  0,
);
const audit = {
  capturedAt: new Date().toISOString(),
  sourceCommit: "e3c3ac6a0843ca1668cd28ea75a6726710f4f91d",
  tokenizer: tokenizerName,
  tokenScope:
    "JSON-serialized MCP tools/list definitions, tool-call parameters, and tool results; excludes model deliberation and host envelope tokens.",
  connection: {
    latencyMs: connectionMs,
    toolsListBytes: bytes(listed),
    toolsListTokens: tokens(listed),
    toolCount: listed.tools.length,
  },
  totals: {
    caseCount: cases.length,
    schemaTokens: tokens(listed),
    requestTokens: callRequestTokens,
    responseTokens: callResponseTokens,
    measuredSurfaceTokens:
      tokens(listed) + callRequestTokens + callResponseTokens,
    summedCallLatencyMs: round(
      cases.reduce((sum, entry) => sum + entry.latencyMs, 0),
    ),
  },
  toolSchemas,
  toolTotals,
  cases,
};

const rendered = `${JSON.stringify(audit, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, rendered, "utf8");
process.stdout.write(rendered);

await transport.close();
