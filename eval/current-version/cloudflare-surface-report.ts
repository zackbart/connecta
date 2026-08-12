/**
 * Measure what every Cloudflare named tool costs and what it buys — issue #350.
 *
 * The provider audit ([#342](https://github.com/zackbart/connecta/issues/342))
 * asks whether a tool is well formed. This lane asks the other question: does
 * the named tool earn its place above the three raw escape hatches that already
 * reach every v4 endpoint? A named tool is only worth its permanent catalog
 * weight if it beats `cloudflare_api_get` / `_mutate` / `_upload` on at least
 * one of the four costs the [provider conventions](../../documentation/provider-conventions.md)
 * name: discovery tokens, wrong-tool selection, argument retries, result size.
 *
 * So the lane is deterministic on purpose. Every number comes from product
 * code — `CatalogService.search`, the compact discovery renderer, the real
 * `api()` validation path, the real handlers — with `fetch` replaced by a probe
 * that records the request. Nothing is stubbed inside the provider, no
 * credential is used, and no packet leaves the process. A model-driven lane
 * would answer a fuzzier version of the same question at one agent run per
 * named tool, and would not repeat: selection here is exactly the ranking an
 * agent's `search_tools` call runs, not a model's impression of it.
 *
 * What it deliberately does not measure: result size against real provider
 * payloads. Hand-writing a fat, faithful response for every Cloudflare product
 * family would measure this file's imagination, so the probe carries known
 * identity and noise keys instead, and projection is reported as the detector
 * it honestly is — did the handler drop the noise, hand it back whole, or
 * answer with a confirmation shape of its own?
 *
 *   node --import tsx eval/current-version/cloudflare-surface-report.ts
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getEncoding } from "js-tiktoken";

import { createConnecta } from "../../src/index.js";
import { CatalogService, groupedSearchResult } from "../../src/catalog-service.js";
import { cloudflare } from "../../src/providers/cloudflare.js";
import { memoryStorage } from "../../src/storage/memory.js";
import type {
  ConnectorContext,
  JsonSchema,
  Logger,
  ToolDef,
} from "../../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const args = process.argv.slice(2);

function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

const outputPath = resolve(
  here,
  option("--output", "results/issue-350-cloudflare-surface.json"),
);
const reportPath = resolve(
  here,
  option("--report", "results/issue-350-cloudflare-surface.md"),
);
const tokenizerName = process.env["CONNECTA_EVAL_TOKENIZER"] ?? "o200k_base";
const tokenizer = getEncoding(tokenizerName as Parameters<typeof getEncoding>[0]);

const serialized = (value: unknown): string => JSON.stringify(value) ?? "null";
const tokens = (value: unknown): number => tokenizer.encode(serialized(value)).length;
const bytes = (value: unknown): number => Buffer.byteLength(serialized(value), "utf8");
const round = (value: number, places = 2): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** The three tools every named tool is measured against. */
const HATCHES = ["cloudflare_api_get", "cloudflare_api_mutate", "cloudflare_api_upload"];
/** Named, but a credential check rather than a control-plane operation. */
const CREDENTIAL_TOOLS = ["verify_api_token", "verify_global_api_key"];

const BASE_URL = "https://connecta.example";
const CONNECTOR_ID = "cloudflare";

/**
 * The unscoped shape on purpose: no `zoneId`, no `accountId`. That is what a
 * fresh deployment gets, and it is the harder case — every zone- and
 * account-scoped tool keeps its id argument required, so nothing here is
 * flattered by a default that happens to be configured.
 */
const connection = cloudflare(CONNECTOR_ID, {
  purpose: "Measure the named surface against the raw escape hatches",
});

const { registry } = createConnecta({
  connectors: [connection],
  storage: memoryStorage(),
  logger: silentLogger,
  executor: { execute: async () => ({ result: null }) },
  publicUrl: BASE_URL,
});

/** One connector context for the whole run; its credential never leaves it. */
const context: ConnectorContext = {
  storage: memoryStorage(),
  logger: silentLogger,
  baseUrl: BASE_URL,
  credential: {
    get: async () => "probe-token",
    getAll: async () => ({
      value: "probe-token",
      email: "probe@example.test",
      apiKey: "probe-key",
    }),
  },
};

const catalog = new CatalogService(registry, BASE_URL);
const definitions = await connection.listTools(context);
const byName = new Map(definitions.map((tool) => [tool.name, tool]));

// ---------------------------------------------------------------------------
// Catalog weight
// ---------------------------------------------------------------------------

/**
 * What one tool costs an agent that browses this connector with compact
 * schemas — the exact per-entry payload `search_tools` emits, measured one
 * entry at a time so a tool's share of the catalog is its own.
 */
const browse = await catalog.search({
  connector: CONNECTOR_ID,
  limit: 100,
  includeSchemas: "compact",
  includeSchemaKeys: true,
});
const compactEntries = new Map(
  browse.entries.map((entry) => [entry.tool.name, entry.tool]),
);
const wholeCatalogTokens = tokens(groupedSearchResult(browse));

const described = await catalog.describe({
  addresses: definitions.map((tool) => `${CONNECTOR_ID}.${tool.name}`),
  format: "json",
  fullDescriptions: true,
});
const describedByName = new Map(
  described.map((entry) => [entry.address.split(".").slice(1).join("."), entry]),
);

// ---------------------------------------------------------------------------
// Argument handling
// ---------------------------------------------------------------------------

interface FetchProbe {
  method: string;
  url: string;
}

let probeRequests: FetchProbe[] = [];
let probeResult: unknown = {};
let probeResultInfo: Record<string, unknown> | undefined;

const realFetch = globalThis.fetch;

/**
 * A Cloudflare envelope with known noise in it. Every key under `noise` is
 * something no projection keeps, so a handler that returns them passed the
 * provider's object through untouched.
 */
const NOISE_KEYS = [
  "meta",
  "permissions",
  "plan",
  "owner",
  "tenant",
  "development_mode",
  "original_registrar",
  "cname_suffix",
];

/** Identity values only a handler that echoed the provider's object can return. */
const IDENTITY_VALUES = ["probe-id", "probe-name", "probe-title", "probe-key"];

/** The `result_info` counters Cloudflare sends beside a page of records. */
const PROBE_RESULT_INFO = {
  page: 1,
  per_page: 20,
  count: 1,
  total_count: 1,
  total_pages: 1,
};

/** Cloudflare's other collection shape: the records under a product-named key. */
function collectionProbe(): Record<string, unknown> {
  const named: Record<string, unknown> = {};
  for (const key of ["buckets", "objects", "keys", "delimitedPrefixes", "values"]) {
    named[key] = [probeObject()];
  }
  return named;
}

function probeObject(): Record<string, unknown> {
  const value: Record<string, unknown> = {
    id: "probe-id",
    name: "probe-name",
    title: "probe-title",
    // R2 objects and KV keys are identified by `key`, not `id`.
    key: "probe-key",
    status: "active",
  };
  for (const key of NOISE_KEYS) {
    value[key] = { measured: "noise", size: key.length };
  }
  return value;
}

globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  probeRequests.push({
    method: String(init.method ?? "GET"),
    url: String(input),
  });
  const body = {
    success: true,
    errors: [],
    messages: [],
    result: probeResult,
    ...(probeResultInfo ? { result_info: probeResultInfo } : {}),
  };
  const text = JSON.stringify(body);
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  } as unknown as Response;
  Object.assign(response, { clone: () => response });
  return response;
}) as unknown as typeof fetch;

function schemaProperties(schema: JsonSchema | undefined): Record<string, JsonSchema> {
  const properties = schema?.["properties"];
  return properties && typeof properties === "object"
    ? (properties as Record<string, JsonSchema>)
    : {};
}

function requiredKeys(schema: JsonSchema | undefined): string[] {
  const required = schema?.["required"];
  return Array.isArray(required) ? required.map(String) : [];
}

/** A value the schema itself says is acceptable, so a rejection is real news. */
function sampleValue(schema: JsonSchema, name: string): unknown {
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0];
  const type = schema["type"];
  if (type === "number" || type === "integer") {
    const minimum = schema["minimum"];
    return typeof minimum === "number" ? minimum : 1;
  }
  if (type === "boolean") return true;
  if (type === "array") {
    const items = schema["items"];
    const minItems = typeof schema["minItems"] === "number" ? schema["minItems"] : 0;
    if (minItems < 1) return [];
    const item =
      items && typeof items === "object"
        ? sampleValue(items as JsonSchema, `${name}Item`)
        : "probe";
    return [item];
  }
  if (type === "object") {
    const nested: Record<string, unknown> = {};
    for (const key of requiredKeys(schema)) {
      const property = schemaProperties(schema)[key];
      nested[key] = property ? sampleValue(property, key) : "probe";
    }
    return nested;
  }
  if (name.toLowerCase().endsWith("id")) return "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
  return "probe";
}

/** Every required argument, filled from the schema's own vocabulary. */
function requiredArgs(tool: ToolDef): Record<string, unknown> {
  const properties = schemaProperties(tool.inputSchema);
  const built: Record<string, unknown> = {};
  for (const key of requiredKeys(tool.inputSchema)) {
    const property = properties[key];
    built[key] = property ? sampleValue(property, key) : "probe";
  }
  return built;
}

interface CallOutcome {
  ok: boolean;
  code?: string;
  requests: FetchProbe[];
  result?: unknown;
}

async function call(
  tool: ToolDef,
  callArgs: Record<string, unknown>,
  options: { result?: unknown; resultInfo?: Record<string, unknown> } = {},
): Promise<CallOutcome> {
  probeRequests = [];
  probeResult = options.result ?? probeObject();
  probeResultInfo = options.resultInfo;
  try {
    const result = await connection.callTool(tool.name, callArgs, context);
    return { ok: true, requests: probeRequests, result };
  } catch (error) {
    const code = (error as { code?: string }).code;
    return {
      ok: false,
      ...(code !== undefined ? { code } : {}),
      requests: probeRequests,
    };
  }
}

/**
 * The guard measurement. Each mutation is a mistake an agent actually makes;
 * a named tool earns its "argument retries" claim only if the mistake is
 * refused here rather than at Cloudflare, which the raw hatch — whose path is
 * an opaque string — structurally cannot do.
 */
interface Mutation {
  kind: string;
  args: Record<string, unknown>;
}

function mutations(tool: ToolDef, valid: Record<string, unknown>): Mutation[] {
  const built: Mutation[] = [
    { kind: "unknownProperty", args: { ...valid, notACloudflareArgument: "x" } },
  ];
  const required = requiredKeys(tool.inputSchema);
  if (required.length > 0) {
    const dropped = { ...valid };
    delete dropped[required[0]!];
    built.push({ kind: "missingRequired", args: dropped });
  }
  const properties = schemaProperties(tool.inputSchema);
  const enumKey = Object.keys(properties).find((key) =>
    Array.isArray(properties[key]?.["enum"]),
  );
  if (enumKey) {
    built.push({
      kind: "unknownEnumValue",
      args: { ...valid, [enumKey]: "not-a-cloudflare-value" },
    });
  }
  const perPage = properties["perPage"];
  const maximum = perPage?.["maximum"];
  if (typeof maximum === "number") {
    built.push({ kind: "pageSizeOverMaximum", args: { ...valid, perPage: maximum + 1 } });
  }
  return built;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface TaskFile {
  tasks: { tool: string; query: string; args?: Record<string, unknown> }[];
}

const taskFile = JSON.parse(
  await readFile(resolve(here, "cloudflare-surface-tasks.json"), "utf8"),
) as TaskFile;
const taskByTool = new Map(taskFile.tasks.map((task) => [task.tool, task]));

const missingTask = definitions
  .map((tool) => tool.name)
  .filter(
    (name) =>
      !HATCHES.includes(name) &&
      !CREDENTIAL_TOOLS.includes(name) &&
      !taskByTool.has(name),
  );
if (missingTask.length > 0) {
  throw new Error(
    `Named tools with no representative task: ${missingTask.join(", ")}. ` +
      "Every named tool gets a verdict, so every named tool gets a task.",
  );
}
const staleTask = taskFile.tasks
  .map((task) => task.tool)
  .filter((name) => !byName.has(name));
if (staleTask.length > 0) {
  throw new Error(`Tasks naming tools that no longer exist: ${staleTask.join(", ")}.`);
}

interface ToolMeasurement {
  name: string;
  role: "named" | "hatch" | "credential";
  readOnly: boolean;
  compactTokens?: number;
  compactBytes?: number;
  schemaTruncated: boolean;
  jsonDefinitionTokens?: number;
  declaredOutputKeys: number;
  openOutput: boolean;
  query?: string;
  selectionRank?: number;
  selectionTop?: string;
  selectionResultTokens?: number;
  hatchOutranked?: boolean;
  validCallAccepted?: boolean;
  validCallCode?: string;
  request?: string;
  guards: { kind: string; refusedLocally: boolean; code?: string }[];
  guardMisses: number;
  /**
   * `projected` — the handler kept identity fields and dropped the probe's
   * noise; `passthrough` — Cloudflare's object came back whole; `fixed` — the
   * handler returns its own confirmation shape and never echoes the provider.
   */
  resultShape?: "projected" | "passthrough" | "fixed";
  noiseKeysReturned?: number;
  resultReductionPercent?: number;
}

const measurements: ToolMeasurement[] = [];

for (const tool of definitions) {
  const role: ToolMeasurement["role"] = HATCHES.includes(tool.name)
    ? "hatch"
    : CREDENTIAL_TOOLS.includes(tool.name)
      ? "credential"
      : "named";
  const compact = compactEntries.get(tool.name);
  const outputKeys = compact?.outputKeys ?? [];
  const openOutput =
    outputKeys.length === 0 &&
    (tool.outputSchema?.["additionalProperties"] !== false ||
      Object.keys(schemaProperties(tool.outputSchema)).length === 0);

  const measurement: ToolMeasurement = {
    name: tool.name,
    role,
    readOnly: tool.annotations?.readOnlyHint === true,
    ...(compact ? { compactTokens: tokens(compact), compactBytes: bytes(compact) } : {}),
    schemaTruncated:
      compact?.inputSchemaTruncated === true || compact?.outputSchemaTruncated === true,
    ...(describedByName.has(tool.name)
      ? { jsonDefinitionTokens: tokens(describedByName.get(tool.name)) }
      : {}),
    declaredOutputKeys: outputKeys.length,
    openOutput,
    guards: [],
    guardMisses: 0,
  };

  const task = taskByTool.get(tool.name);
  if (task) {
    const page = await catalog.search({
      query: task.query,
      limit: 8,
      includeSchemas: "compact",
      includeSchemaKeys: true,
    });
    const names = page.entries.map((entry) => entry.tool.name);
    const rank = names.indexOf(tool.name);
    measurement.query = task.query;
    measurement.selectionRank = rank < 0 ? -1 : rank + 1;
    measurement.selectionTop = names[0] ?? "(nothing matched)";
    measurement.selectionResultTokens = tokens(groupedSearchResult(page));
    const hatchRank = names.findIndex((name) => HATCHES.includes(name));
    measurement.hatchOutranked =
      hatchRank >= 0 && (rank < 0 || hatchRank < rank);
  }

  if (role === "named") {
    const valid = { ...requiredArgs(tool), ...task?.args };
    // A collection endpoint gets a collection back, or the projection under
    // measurement never runs and every list tool would score as "fixed".
    // An array of *objects* is a collection; an array of strings is a field
    // (a zone's name servers), and handing that tool an array would measure
    // the probe rather than the projection.
    const collection = Object.values(schemaProperties(tool.outputSchema)).some(
      (property) => {
        if (property["type"] !== "array") return false;
        const items = property["items"];
        return Boolean(
          items &&
            typeof items === "object" &&
            ((items as JsonSchema)["type"] === "object" ||
              (items as JsonSchema)["properties"] !== undefined),
        );
      },
    );
    // Cloudflare returns a collection two ways — a bare array under `result`,
    // and a named collection such as `{ buckets: [...] }` for R2 — so a
    // collection tool is offered both and scored on the one its handler
    // actually consumes. Guessing one shape would file a working projection as
    // a fixed return.
    const probes: unknown[] = collection
      ? [[probeObject()], collectionProbe()]
      : [probeObject()];
    let best:
      | { outcome: CallOutcome; raw: unknown; shape: ToolMeasurement["resultShape"]; noise: number }
      | undefined;
    for (const raw of probes) {
      const outcome = await call(tool, valid, {
        result: raw,
        ...(collection ? { resultInfo: PROBE_RESULT_INFO } : {}),
      });
      const returned = outcome.ok ? serialized(outcome.result) : "";
      const noise = NOISE_KEYS.filter((key) => returned.includes(`"${key}"`)).length;
      const shape: ToolMeasurement["resultShape"] = !outcome.ok
        ? undefined
        : noise > 0
          ? "passthrough"
          : IDENTITY_VALUES.some((value) => returned.includes(value))
            ? "projected"
            : "fixed";
      if (!best || (best.shape === "fixed" && shape !== undefined && shape !== "fixed")) {
        best = { outcome, raw, shape, noise };
      }
      if (shape !== undefined && shape !== "fixed") break;
    }
    const outcome = best!.outcome;
    measurement.validCallAccepted = outcome.ok;
    if (outcome.code) measurement.validCallCode = outcome.code;
    const request = outcome.requests[0];
    if (request) {
      measurement.request = `${request.method} ${new URL(request.url).pathname}`;
    }
    const shape = best!.shape;
    if (outcome.ok && outcome.result !== undefined && shape !== undefined) {
      measurement.noiseKeysReturned = best!.noise;
      measurement.resultShape = shape;
      measurement.resultReductionPercent = round(
        (1 - bytes(outcome.result) / bytes(best!.raw)) * 100,
        1,
      );
    }
    for (const mutation of mutations(tool, valid)) {
      const attempt = await call(tool, mutation.args);
      const refusedLocally = !attempt.ok && attempt.requests.length === 0;
      measurement.guards.push({
        kind: mutation.kind,
        refusedLocally,
        ...(attempt.code !== undefined ? { code: attempt.code } : {}),
      });
      if (!refusedLocally) measurement.guardMisses += 1;
    }
  }

  measurements.push(measurement);
}

globalThis.fetch = realFetch;

const named = measurements.filter((entry) => entry.role === "named");
const selected = named.filter((entry) => entry.selectionRank === 1);
const rankedTop3 = named.filter(
  (entry) => entry.selectionRank !== undefined && entry.selectionRank > 0 && entry.selectionRank <= 3,
);

const summary = {
  toolCount: measurements.length,
  namedCount: named.length,
  hatchCount: measurements.filter((entry) => entry.role === "hatch").length,
  wholeCatalogTokens,
  namedCatalogTokens: named.reduce((total, entry) => total + (entry.compactTokens ?? 0), 0),
  hatchCatalogTokens: measurements
    .filter((entry) => entry.role === "hatch")
    .reduce((total, entry) => total + (entry.compactTokens ?? 0), 0),
  top1SelectionRate: round(selected.length / named.length, 3),
  top3SelectionRate: round(rankedTop3.length / named.length, 3),
  unselectedTools: named
    .filter((entry) => entry.selectionRank !== 1)
    .map((entry) => entry.name),
  hatchOutrankedTools: named
    .filter((entry) => entry.hatchOutranked === true)
    .map((entry) => entry.name),
  validCallFailures: named
    .filter((entry) => entry.validCallAccepted !== true)
    .map((entry) => entry.name),
  guardMissTools: named.filter((entry) => entry.guardMisses > 0).map((entry) => entry.name),
  passthroughTools: named
    .filter((entry) => entry.resultShape === "passthrough")
    .map((entry) => entry.name),
  openOutputTools: named.filter((entry) => entry.openOutput).map((entry) => entry.name),
  truncatedSchemaTools: measurements
    .filter((entry) => entry.schemaTruncated)
    .map((entry) => entry.name),
};

const artifact = {
  issue: 350,
  generatedAt: new Date().toISOString(),
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  // A commit alone does not identify a surface measured from a working tree,
  // and this lane is most useful exactly while one is being changed.
  workingTreeDirty:
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim().length > 0,
  runtime: process.version,
  tokenizer: tokenizerName,
  scope: "unscoped cloudflare() instance: no zoneId or accountId default",
  summary,
  tools: measurements,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

function row(entry: ToolMeasurement): string {
  const selection =
    entry.selectionRank === undefined
      ? "—"
      : entry.selectionRank < 0
        ? `miss (${entry.selectionTop})`
        : entry.selectionRank === 1
          ? "1"
          : `${entry.selectionRank} (${entry.selectionTop})`;
  const projection = entry.resultShape ?? "—";
  return `| \`${entry.name}\` | ${entry.readOnly ? "read" : "write"} | ${entry.compactTokens ?? "—"} | ${selection} | ${entry.guards.length - entry.guardMisses}/${entry.guards.length} | ${projection} | ${entry.declaredOutputKeys} |`;
}

const report = `# Cloudflare named-tool surface measurements (#350)

Generated by \`eval/current-version/cloudflare-surface-report.ts\` at
${artifact.generatedAt} on ${artifact.runtime}, source commit
\`${artifact.sourceCommit}\`${artifact.workingTreeDirty ? " (working tree modified)" : ""},
tokenizer \`${artifact.tokenizer}\`.
Scope: ${artifact.scope}.

- ${summary.toolCount} tools total: ${summary.namedCount} named, ${summary.hatchCount} escape hatches, ${summary.toolCount - summary.namedCount - summary.hatchCount} credential check.
- Whole-connector compact browse: **${summary.wholeCatalogTokens} tokens**, of which the named surface is ${summary.namedCatalogTokens} and the three hatches are ${summary.hatchCatalogTokens}.
- Top-1 selection on its own representative task: **${round(summary.top1SelectionRate * 100, 1)}%** (top-3 ${round(summary.top3SelectionRate * 100, 1)}%).
- Named tools an escape hatch outranked: ${summary.hatchOutrankedTools.length === 0 ? "none" : summary.hatchOutrankedTools.join(", ")}.
- Argument guards that reached the network instead of being refused locally: ${summary.guardMissTools.length === 0 ? "none" : summary.guardMissTools.join(", ")}.
- Named reads that return Cloudflare's object unprojected: ${summary.passthroughTools.length === 0 ? "none" : summary.passthroughTools.join(", ")}.
- Tools declaring no output keys: ${summary.openOutputTools.length === 0 ? "none" : summary.openOutputTools.join(", ")}.
- Compact schemas the renderer truncated: ${summary.truncatedSchemaTools.length === 0 ? "none" : summary.truncatedSchemaTools.join(", ")}.

\`selection\` is the tool's rank in a real \`search_tools\` call for its task,
with the tool that actually ranked first in parentheses when it was not this
one. \`guards\` counts argument mistakes refused before the round trip.
\`projection\` records whether the handler dropped the probe's noise keys.

| tool | class | compact tokens | selection | guards | projection | output keys |
| --- | --- | --- | --- | --- | --- | --- |
${measurements.map(row).join("\n")}
`;

await writeFile(reportPath, report, "utf8");

console.log(`wrote ${outputPath}`);
console.log(`wrote ${reportPath}`);
console.log(
  `top-1 ${round(summary.top1SelectionRate * 100, 1)}% | catalog ${wholeCatalogTokens} tokens | guard misses ${summary.guardMissTools.length}`,
);
