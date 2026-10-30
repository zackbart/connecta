import { registerAuthMethod } from "./auth/native.js";
import { META_ROUTES, routeToolInPlace } from "./agent-routes.js";
import type { AgentRouteNames } from "./types.js";
import { withAuthorizationHandoffEffect } from "./authorization-handoff.js";
import { carryCatalogFreshness, catalogIsFresh } from "./catalog-freshness.js";
import { retainedCatalogIdentity } from "./catalog-cache.js";
import { cloneTool } from "./tool-safety.js";
import { hasControlCharacters } from "./tool-name.js";
import { Effect, Result } from "effect";
import {
  compactDiscoverySchema,
  compactDescriptionSchema,
  lexicalCorpusStatistics,
  lexicalQueryTerms,
  lexicalSearchQuery,
  matchesLexicalTerm,
  rankTools,
  schemaObjectKeys,
  summarizeDiscoveryDescription,
  summarizeDescription,
  typescriptSignature,
} from "./catalog.js";
import { resolveDiscoveryConcurrency } from "./concurrency.js";
import { boundedEchoText, classifyCallError, ConnectorCallError, framingError } from "./errors.js";
import type { CallErrorDetails } from "./errors.js";
import type { ConnectorOperationOptions, RegistryView } from "./registry.js";
import type { DeferredWork } from "./connector-scope.js";
import { connectorGuide, connectorGuideRequired, connectorGuideSummary, connectorSkillName } from "./skills.js";
import { runEdge, withDeadlineEffect } from "./runtime/run.js";
import { registryProgram } from "./runtime/registry.js";
import { SharedRead } from "./runtime/shared-read.js";
import { duringViewEffect } from "./runtime/call.js";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  normalizeTimeoutMs,
  UNSCOPED_DISCOVERY_BUDGET_MS,
  UNSCOPED_PROBE_TIMEOUT_MS,
} from "./timeout.js";
import {
  claimDiscoveryProbe,
  readDiscoveryHealth,
  settleDiscoveryHealth,
  type HealthVerdict,
} from "./discovery-health.js";
import type { Connector, JsonSchema, ToolDef } from "./types.js";
import { keepErrorName } from "./redaction-identity.js";
import { operationVocabularyMatches, searchSynonyms } from "./operation-vocabulary.js";

/** One search probe's outcome, and what its health record settles from. */
interface SearchProbe {
  id: string;
  result: Result.Result<ToolDef[], unknown>;
  settle?: { timeoutError: Error; elapsedMs: number };
}

/** The slice of an unscoped search's budget kept for recording what its probes saw. */
const SETTLE_RESERVE_MS = 500;
/** How long a probe claim outlives its request's discovery budget, for settlement and clock skew. */
const CLAIM_MARGIN_MS = 2_000;

/** A connector unscoped search skipped because its discovery failed recently. */
class DiscoverySkipped extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs: number,
  ) {
    super("Connector discovery skipped after a recent failure");
  }
}

export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 100;
export const MAX_DESCRIBE_ADDRESSES = 100;
export const MAX_DISCOVERY_RESULT_BYTES = 256_000;
const MAX_QUERY_TERMS = 8;
const MAX_QUERY_TERM_LENGTH = 64;
/**
 * Connector IDs a no-match search will name back. Three is enough to point at
 * the connector the query already named without turning a miss into a listing
 * of the deployment.
 */
const MAX_IDENTITY_CONNECTORS = 3;
const MAX_DESCRIBE_SUGGESTIONS = 3;
const MAX_API_SEARCH_POINTERS = 3;
const MAX_API_SEARCH_ADDRESS_BYTES = 256;
/** Fully determined operation reads one search page offers: one per connector, three connectors. */
const MAX_READY_CALLS = 3;

/** Recognize the visible standard family without importing provider implementations or indexes. */
function apiSearchTools(tools: readonly ToolDef[]): ToolDef[] {
  const names = new Set(tools.map((tool) => tool.name));
  return tools.filter((tool) => {
    if (!tool.name.endsWith("_api_search") || tool.classification !== "read") return false;
    const prefix = tool.name.slice(0, -"search".length);
    return (
      names.has(`${prefix}details`) &&
      names.has(`${prefix}read`) &&
      schemaObjectKeys(tool.inputSchema)?.properties.includes("query") === true
    );
  });
}

// Recognized service names are query vocabulary, never a deployment inventory.
// This includes generic hosted connections such as Notion and Mixpanel.
// Unknown/custom services use the explicit connector scope. Keep this independent
// of provider implementations so discovery cannot pull them into root imports.
const SERVICE_NAMES = [
  "GitHub",
  "GitLab",
  "Supabase",
  "PostHog",
  "Linear",
  "Mixpanel",
  "RevenueCat",
  "Stripe",
  "Notion",
  "Slack",
  "Vercel",
  "Cloudflare",
  "Basecamp",
  "Breeze",
  "Tithely",
  "Planning Center",
  "Google Drive",
  "Google Docs",
  "Google Sheets",
  "Google Slides",
  "Gmail",
];

/**
 * Leading verbs that ask to read. A query led by one ranks read rows above
 * write rows within each relevance tier; writes stay on the page.
 */
const READ_INTENT = /^(?:list|get|find|search|show|read|fetch|count)$/;
/** Name words that state an action, never a resource. */
const ACTION_WORD = /^(?:list|get|find|search|show|read|fetch|count|create|update|delete)$/;

function normalizedPhrase(text: string): string {
  return lexicalQueryTerms(text.toLowerCase()).join(" ");
}

function containsPhrase(query: string, phrase: string): boolean {
  const normalized = normalizedPhrase(phrase);
  return normalized.length > 0 && ` ${normalizedPhrase(query)} `.includes(` ${normalized} `);
}

function connectorNames(connector: Connector): string[] {
  return [connector.id, ...(connector.title ? [connector.title] : [])];
}

function connectorMatchRank(query: string, connector: Connector): number {
  if (connectorNames(connector).some((name) => containsPhrase(query, name))) return 2;
  return SERVICE_NAMES.some(
    (service) =>
      containsPhrase(query, service) && connectorNames(connector).some((name) => containsPhrase(name, service)),
  )
    ? 1
    : 0;
}

const encoder = new TextEncoder();

/** Clip one echoed query term without splitting a non-BMP code point. */
function boundedQueryTerm(term: string): {
  text: string;
  truncated: boolean;
} {
  const characters: string[] = [];
  for (const character of term) {
    characters.push(character);
    if (characters.length > MAX_QUERY_TERM_LENGTH) {
      return {
        text: `${characters.slice(0, MAX_QUERY_TERM_LENGTH - 1).join("")}…`,
        truncated: true,
      };
    }
  }
  return { text: characters.join(""), truncated: false };
}

/**
 * The discovery route a routing failure should send a caller back through. Same
 * catalog logic serves both the top-level `search_tools` path and the
 * in-program `connecta.search` path, so callers pass the route they own.
 */
export type SearchRoute = "search_tools" | "connecta.search";

export class DiscoveryPolicyError extends Error {
  constructor(
    readonly code: "invalid_args" | "result_too_large",
    message: string,
  ) {
    super(message);
    this.name = "DiscoveryPolicyError";
  }
}
keepErrorName(DiscoveryPolicyError, "DiscoveryPolicyError");

/** Validate before ranking so a huge page request does no proportional work. */
function discoverySearchLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_SEARCH_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_SEARCH_LIMIT) {
    throw new DiscoveryPolicyError(
      "invalid_args",
      `limit must be a whole number from 1 through ${MAX_SEARCH_LIMIT}. Page through larger catalogs with offset.`,
    );
  }
  return value;
}

/** Normalize the single-address convenience form, then validate the bounded list. */
function discoveryAddresses(args: CatalogDescribeArgs): unknown[] {
  if (args.address !== undefined && args.addresses !== undefined) {
    throw new DiscoveryPolicyError("invalid_args", "describe takes either address or addresses, not both.");
  }
  const value =
    args.address !== undefined ? (typeof args.address === "string" ? [args.address] : undefined) : args.addresses;
  if (!Array.isArray(value)) {
    throw new DiscoveryPolicyError(
      "invalid_args",
      'describe takes { address: "<connectorId>.<toolName>" } or { addresses: ["<connectorId>.<toolName>", ...] }.',
    );
  }
  if (value.length > MAX_DESCRIBE_ADDRESSES) {
    throw new DiscoveryPolicyError(
      "invalid_args",
      `addresses must contain at most ${MAX_DESCRIBE_ADDRESSES} entries. Split a larger list across connecta.describe calls.`,
    );
  }
  return value;
}

/**
 * Search terms derived from an address the catalog could not resolve. Bounded
 * because the address is entirely caller-authored: an invented one can be any
 * length, and this string is copied into a recovery record that is itself
 * copied into both halves of the result envelope.
 */
function recoveryQuery(address: string): string {
  const separator = address.indexOf(".");
  const candidate = separator >= 0 ? address.slice(separator + 1) : address;
  return boundedEchoText(candidate.replaceAll(/[._-]+/g, " ").trim() || address);
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(
        Math.min(
          previous[rightIndex + 1]! + 1,
          current[rightIndex]! + 1,
          previous[rightIndex]! + (left[leftIndex] === right[rightIndex] ? 0 : 1),
        ),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** Nearby names only; descriptions never influence describe-miss recovery. */
function describeSuggestions(connectorId: string, attemptedName: string, tools: ToolDef[]): string[] {
  const attempted = attemptedName.toLowerCase();
  return (
    tools
      .map((tool, order) => {
        const name = tool.name.toLowerCase();
        return { tool, order, distance: editDistance(attempted, name) };
      })
      .filter(({ tool, distance }) => {
        const longest = Math.max(attempted.length, tool.name.length);
        return (
          attempted.includes(tool.name.toLowerCase()) ||
          tool.name.toLowerCase().includes(attempted) ||
          distance <= Math.max(2, Math.floor(longest * 0.4))
        );
      })
      .sort((left, right) => left.distance - right.distance || left.order - right.order)
      .map(({ tool }) => `${connectorId}.${tool.name}`)
      // A clipped address would no longer be canonical. Omit an implausibly
      // large catalog name instead of letting one suggestion erase the page.
      .filter((address) => boundedEchoText(address) === address)
      .slice(0, MAX_DESCRIBE_SUGGESTIONS)
  );
}

/** Serialize once and count the exact bytes the MCP adapter would emit. */
export function boundedDiscoveryText(value: unknown, hint: string): string {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new TypeError("Discovery result is not JSON-serializable.");
  }
  const bytes = encoder.encode(text).length;
  if (bytes > MAX_DISCOVERY_RESULT_BYTES) {
    throw new DiscoveryPolicyError(
      "result_too_large",
      `Discovery result is ${bytes} UTF-8 bytes, over the ${MAX_DISCOVERY_RESULT_BYTES}-byte ceiling. ${hint}`,
    );
  }
  return text;
}

/**
 * How discovery renders a schema: the compact routing notation, the exact
 * JSON, or a TypeScript `signature` replacing both schema fields.
 */
type SchemaFormat = "compact" | "json" | "typescript";

export interface CatalogSearchArgs {
  query?: string;
  connector?: string;
  /**
   * Result classification only; never changes which tools exist or what may
   * execute. Omitted and "all" preserve the complete configured catalog.
   */
  safety?: "readOnly" | "approvalRequired" | "all";
  limit?: number;
  offset?: number;
  fullDescriptions?: boolean;
  includeSchemas?: SchemaFormat;
  /** Code-mode helper metadata; never exposed by the public search_tools schema. */
  includeSchemaKeys?: boolean;
}

function discoverySafety(value: unknown): "readOnly" | "approvalRequired" | "all" {
  if (value === undefined) return "all";
  if (value !== "readOnly" && value !== "approvalRequired" && value !== "all") {
    throw new DiscoveryPolicyError("invalid_args", 'safety must be "readOnly", "approvalRequired", or "all".');
  }
  return value;
}

function toolsForSafety(tools: ToolDef[], safety: "readOnly" | "approvalRequired" | "all"): ToolDef[] {
  if (safety === "all") return tools;
  return tools.filter((tool) =>
    safety === "readOnly" ? tool.classification === "read" : tool.classification !== "read",
  );
}

export interface CatalogDescribeArgs {
  address?: unknown;
  addresses?: unknown;
  format?: SchemaFormat;
  fullDescriptions?: boolean;
}

interface CatalogSearchEntry {
  connector: Connector;
  guide?: string;
  guideSummary?: string;
  tool: {
    name: string;
    address: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    signature?: string;
    schemaFormat?: "json" | "text";
    outputSchemaSource?: "observed";
    inputSchemaTruncated?: true;
    outputSchemaTruncated?: true;
    inputKeys?: string[];
    requiredInputKeys?: string[];
    outputKeys?: string[];
    annotations?: ToolDef["annotations"];
    classification?: ToolDef["classification"];
    guideRequired?: true;
    guideRequiredReasons?: GuideRequiredReason[];
  };
}

type GuideRequiredReason = "connector_required" | "approval_required" | "schema_truncated";

/**
 * Reasons discovery can determine without reading arguments or guessing at a
 * task. Summary-only conventions remain an agent decision; hard requirements
 * are explicit and machine-readable.
 */
function guideRequiredReasons(
  connector: Connector,
  tool: ToolDef,
  schemaTruncated: boolean,
): GuideRequiredReason[] | undefined {
  if (!connectorGuide(connector)) return undefined;
  const reasons: GuideRequiredReason[] = [];
  if (connectorGuideRequired(connector)) reasons.push("connector_required");
  if (tool.classification !== "read") reasons.push("approval_required");
  if (schemaTruncated) reasons.push("schema_truncated");
  return reasons.length > 0 ? reasons : undefined;
}

/**
 * Code-mode key metadata for one match. Each half is omitted when its schema
 * does not resolve to an object shape, so a program reads "no metadata, use the
 * rendered schema" rather than "this tool has no fields".
 */
function schemaKeyMetadata(
  input: JsonSchema,
  output: JsonSchema | undefined,
): {
  inputKeys?: string[];
  requiredInputKeys?: string[];
  outputKeys?: string[];
} {
  const inputKeys = schemaObjectKeys(input);
  const outputKeys = schemaObjectKeys(output);
  return {
    ...(inputKeys
      ? {
          inputKeys: inputKeys.properties,
          requiredInputKeys: inputKeys.required,
        }
      : {}),
    ...(outputKeys && outputKeys.properties.length > 0 ? { outputKeys: outputKeys.properties } : {}),
  };
}

/**
 * The classified-failure subset a scoped search may echo: enough to tell a
 * transient outage from one an operator must clear, and nothing more. Kept as
 * its own type rather than `CallErrorDetails` so widening the call-path
 * classifier cannot widen this discovery-surface field by accident.
 */
interface CatalogFailureDetail extends Partial<import("./errors.js").AuthorizationHandoff> {
  nextAction?: CallErrorDetails["nextAction"];
  retry?: string;
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

interface CatalogDescriptionFailureDetail extends CatalogFailureDetail {
  configuredConnectors?: string[];
  nextAction?: NonNullable<CallErrorDetails["nextAction"]>;
  /** Nearby canonical addresses, ranked deterministically by tool name. */
  suggestions?: string[];
}

interface CatalogSearchFailure extends CatalogFailureDetail {
  connector: string;
  nextAction?: Extract<NonNullable<CallErrorDetails["nextAction"]>, { tool: "authorize_connector" }>;
  retry?: string;
}

/** A complete read call search found in offline operation vocabulary. */
interface CatalogReadyCall {
  connector: Connector;
  call: {
    address: string;
    args: { path: string };
    classification: "read";
    summary: string;
    guideRequired?: true;
    guideRequiredReasons?: GuideRequiredReason[];
  };
  guide?: string;
  guideSummary?: string;
}

export interface CatalogSearchPage {
  entries: CatalogSearchEntry[];
  /** First page only: fully determined operation reads, at most three. */
  readyCalls?: CatalogReadyCall[];
  /** Failures from visible catalogs, with credential failures first. */
  catalogErrors: CatalogSearchFailure[];
  absence?: {
    service: string;
    message: string;
    configuredConnectors: string[];
  };
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset?: number;
  matchMode?: "partial";
  queryAnalysis?: {
    representedTerms: string[];
    otherResultTerms: string[];
    unmatchedTerms: string[];
    truncated?: true;
    connectorScope?: string;
    unknownConnector?: true;
    configuredConnectors?: string[];
    unavailableConnectorCount?: number;
    /** Bounded typed failure for an explicitly scoped unavailable catalog. */
    catalogError?: CatalogFailureDetail;
    guide?: string;
    guideSummary?: string;
    guideRequired?: true;
    guideRequiredReasons?: GuideRequiredReason[];
    guidance?: string;
  };
}

/** Connector facts shared by every row of one connector, stated once per page. */
interface CatalogSearchConnector {
  title?: string;
  guide?: string;
  guideSummary?: string;
}

/**
 * The flat wire page shared by search_tools and connecta.search. Per-connector
 * facts sit once in `connectors`, keyed by the connector id that prefixes each
 * row's address; rows keep only what varies by tool.
 */
export type CatalogSearchResult = Omit<CatalogSearchPage, "entries" | "readyCalls"> & {
  tools: Array<CatalogSearchEntry["tool"]>;
  readyCalls?: Array<CatalogReadyCall["call"]>;
  connectors?: Record<string, CatalogSearchConnector>;
};

const stringListSchema = { type: "array", items: { type: "string" } } as const;
const STRING = { type: "string" } as const;
// The reasons enum is stated once under `$defs` and referenced from each field.
const guideRequiredProperties = {
  guideRequired: { const: true },
  guideRequiredReasons: { $ref: "#/$defs/reasons" },
};
const guideProperties = { guide: STRING, guideSummary: STRING, ...guideRequiredProperties };
const catalogFailureProperties = {
  code: { type: "string" },
  message: { type: "string" },
  retryable: { type: "boolean" },
  retryAfterMs: { type: "integer", minimum: 0 },
  connector: { type: "string" },
  recovery: { enum: ["oauth", "operator_config", "unavailable"] },
  status: { const: "auth_required" },
  authorizationUrl: { type: "string" },
  operatorUrl: { type: "string" },
  instructions: { type: "string" },
  credential: {
    type: "object",
    required: ["label", "fields"],
    additionalProperties: false,
    properties: {
      label: { type: "string" },
      fields: {
        type: "array",
        items: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: { name: { type: "string" }, guidance: { type: "string" } },
        },
      },
    },
  },
  retry: { type: "string" },
  nextAction: {
    type: "object",
    required: ["tool", "arguments", "operatorHandoff"],
    additionalProperties: false,
    properties: {
      tool: { const: "authorize_connector" },
      arguments: {
        type: "object",
        required: ["connector"],
        additionalProperties: false,
        properties: { connector: { type: "string" } },
      },
      operatorHandoff: { type: "string" },
    },
  },
};

/** The one typed failure (and auth handoff) both failure fields reference. */
const FAILURE_REF = { $ref: "#/$defs/failure" } as const;

/**
 * The outputSchema contract for either search adapter. Guest API registration
 * can reuse this value instead of maintaining a second page definition.
 * Every failure field references one local `$defs` entry, so the typed auth
 * handoff is advertised once instead of once per field.
 */
export const CATALOG_SEARCH_RESULT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["catalogErrors", "tools", "total", "offset", "limit", "hasMore"],
  additionalProperties: false,
  $defs: {
    reasons: { type: "array", items: { enum: ["connector_required", "approval_required", "schema_truncated"] } },
    failure: {
      type: "object",
      required: ["code", "message", "retryable"],
      additionalProperties: false,
      properties: catalogFailureProperties,
    },
  },
  properties: {
    // `allOf` rather than a `$ref` sibling keeps `required` enforced by
    // validators that predate 2020-12 sibling semantics.
    catalogErrors: { type: "array", items: { allOf: [FAILURE_REF], required: ["connector"] } },
    absence: {
      type: "object",
      required: ["service", "message", "configuredConnectors"],
      additionalProperties: false,
      properties: {
        service: { type: "string" },
        message: { type: "string" },
        configuredConnectors: stringListSchema,
      },
    },
    tools: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "address"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          address: { type: "string" },
          description: { type: "string" },
          inputSchema: {},
          outputSchema: {},
          signature: { type: "string" },
          schemaFormat: { enum: ["json", "text"] },
          outputSchemaSource: { const: "observed" },
          inputSchemaTruncated: { const: true },
          outputSchemaTruncated: { const: true },
          inputKeys: stringListSchema,
          requiredInputKeys: stringListSchema,
          outputKeys: stringListSchema,
          annotations: { type: "object" },
          classification: { enum: ["read", "write"] },
          ...guideRequiredProperties,
        },
      },
    },
    readyCalls: {
      type: "array",
      maxItems: MAX_READY_CALLS,
      items: {
        type: "object",
        required: ["address", "args", "classification", "summary"],
        properties: {
          address: STRING,
          args: { type: "object", required: ["path"], additionalProperties: false, properties: { path: STRING } },
          classification: { const: "read" },
          summary: STRING,
          ...guideRequiredProperties,
        },
      },
    },
    connectors: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: { title: STRING, guide: STRING, guideSummary: STRING },
      },
    },
    total: { type: "integer", minimum: 0 },
    offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_LIMIT },
    hasMore: { type: "boolean" },
    nextOffset: { type: "integer", minimum: 0 },
    matchMode: { const: "partial" },
    queryAnalysis: {
      type: "object",
      required: ["representedTerms", "otherResultTerms", "unmatchedTerms"],
      additionalProperties: false,
      properties: {
        representedTerms: stringListSchema,
        otherResultTerms: stringListSchema,
        unmatchedTerms: stringListSchema,
        truncated: { const: true },
        connectorScope: { type: "string" },
        unknownConnector: { const: true },
        configuredConnectors: stringListSchema,
        unavailableConnectorCount: { type: "integer", minimum: 0 },
        catalogError: FAILURE_REF,
        ...guideProperties,
        guidance: { type: "string" },
      },
    },
  },
};

export interface CatalogDescription {
  address: string;
  schemaFormat?: "json" | "text";
  name?: string;
  description?: string;
  guide?: string;
  guideSummary?: string;
  guideRequired?: true;
  guideRequiredReasons?: GuideRequiredReason[];
  inputSchema?: unknown;
  outputSchema?: unknown;
  signature?: string;
  outputSchemaSource?: "observed";
  inputSchemaTruncated?: true;
  outputSchemaTruncated?: true;
  annotations?: ToolDef["annotations"];
  error?: string;
  errorDetails?: CatalogDescriptionFailureDetail;
}

export interface ResolvedCatalogTool {
  connector: Connector;
  toolName: string;
  definition: ToolDef;
  /** Registry provenance at classification, private to the host. */
  classificationFresh?: boolean;
}

interface OutputSchemaResolution {
  schema?: JsonSchema;
  source?: "observed";
}

export type CatalogResolution =
  | {
      ok: true;
      resolved: ResolvedCatalogTool;
      catalogMs: number;
    }
  | {
      ok: false;
      error: CallErrorDetails;
      catalogMs: number;
      connector?: Connector;
      toolName?: string;
      cause?: unknown;
    };

function renderSearchSchema(schema: JsonSchema, format: "compact" | "json"): { schema: unknown; truncated: boolean } {
  if (format === "json") return { schema, truncated: false };
  const compact = compactDiscoverySchema(schema);
  return { schema: compact.text, truncated: compact.truncated };
}

/**
 * Request-local catalog operations shared by MCP meta-tools and code mode.
 * Successful catalogs may be reused inside this request; failures are not
 * retained, and the service itself never escapes its request adapter.
 */
export class CatalogService {
  readonly requestScope: object;
  readonly defer: DeferredWork | undefined;
  private readonly probeTimeoutMs: number;
  private readonly discoveryBudgetMs: number;
  private readonly concurrency: number;
  private readonly searchRoute: SearchRoute;
  private readonly requestSignal: AbortSignal | undefined;
  private readonly readOnly: boolean;
  // The request-scoped catalog cache: one shared read per connector asked
  // about, started by the first asker and joined by every later one. A
  // success stays while its in-process invalidation fence matches, so a search
  // and the call after it see one current catalog. The cache owns a deep copy;
  // each asker receives another at public boundaries. Search keeps private, stable safety views
  // so its lexical index can be reused without exposing cached definitions.
  // A failure, or a read cancelled because every asker
  // left it, is dropped so the next ask reads again. The service lives and
  // dies with one request, so no read here is ever awaited from another.
  //
  // Registry.getTools also joins concurrent reads in one request scope, which
  // the operator UI and status reads rely on. This map overlaps it only for
  // reads still in flight and is kept for what the registry's cannot do: hold
  // the success for the rest of the request, recorded by the read itself
  // rather than by an asker, whose probe deadline may have ended its wait.
  private readonly catalogs = new Map<string, { identity: string; read: SharedRead<ToolDef[]> }>();
  // Key by the private source array, never connector id: a replacement read
  // gets new views and indexes. Each service belongs to one request and one
  // registry visibility view (caller/pool, hidden tools and classification).
  private readonly searchViews = new WeakMap<ToolDef[], Map<string, ToolDef[]>>();
  // This request's discovery-health verdicts, read once per connector and kept
  // current by its own probes, so repeated searches read no storage.
  private readonly health = new Map<string, HealthVerdict>();
  private readonly routes: AgentRouteNames;

  constructor(
    private readonly registry: RegistryView,
    readonly baseUrl: string,
    options: {
      requestScope?: object | undefined;
      probeTimeoutMs?: number | undefined;
      /** Unscoped search's whole fan-out budget. Default `UNSCOPED_DISCOVERY_BUDGET_MS`. */
      discoveryBudgetMs?: number | undefined;
      concurrency?: number | undefined;
      /** The discovery route recovery records name. Default `search_tools`. */
      searchRoute?: SearchRoute | undefined;
      /** Runtime-owned connector teardown tail. */
      defer?: DeferredWork | undefined;
      /** The request's cancellation; discovery probes end with it. */
      requestSignal?: AbortSignal | undefined;
      /**
       * A read-only endpoint: search and describe show only reads. Resolution
       * still finds a write, so the call that names one is refused by code.
       */
      readOnly?: boolean | undefined;
      /** The serving surface's names: declared schema descriptions are listed in its wording. */
      routes?: AgentRouteNames | undefined;
    } = {},
  ) {
    void CatalogService.nativePrograms;
    this.routes = options.routes ?? META_ROUTES;
    this.requestScope = options.requestScope ?? {};
    this.probeTimeoutMs = normalizeTimeoutMs(options.probeTimeoutMs) ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.discoveryBudgetMs = normalizeTimeoutMs(options.discoveryBudgetMs) ?? UNSCOPED_DISCOVERY_BUDGET_MS;
    this.concurrency = resolveDiscoveryConcurrency(options.concurrency);
    this.searchRoute = options.searchRoute ?? "search_tools";
    this.requestSignal = options.requestSignal;
    this.defer = options.defer;
    this.readOnly = options.readOnly === true;
  }

  /**
   * Send a caller back to discovery through the surface it can actually reach.
   * Both variants carry the same scoping arguments because `connecta.search`
   * takes the same ones `search_tools` does; only the key naming the callable
   * differs, the way the ambiguous-alias record already names a function.
   *
   * Not private: `InvocationService` builds the same class of record when a
   * call fails schema validation, and it is this catalog's route that decides
   * which key that record carries. Duplicating the branch there would let the
   * two drift.
   */
  searchRecovery(
    args: { query: string; connector?: string },
    purpose: string,
  ): NonNullable<CallErrorDetails["nextAction"]> {
    const searchArgs = {
      query: args.query,
      ...(args.connector !== undefined ? { connector: args.connector } : {}),
      includeSchemas: "compact" as const,
    };
    return this.searchRoute === "connecta.search"
      ? { function: "connecta.search", arguments: searchArgs, purpose }
      : { tool: "search_tools", arguments: searchArgs, purpose };
  }

  loadConnector(id: string, callOptions: ConnectorOperationOptions = {}): Promise<ToolDef[]> {
    return runEdge(this.loadConnectorEffect(id, callOptions));
  }

  loadConnectorEffect(id: string, callOptions: ConnectorOperationOptions = {}): Effect.Effect<ToolDef[], unknown> {
    return Effect.suspend(() =>
      duringViewEffect(
        { requestScope: this.requestScope, signal: callOptions.signal ?? this.requestSignal },
        (signal) =>
          Effect.map(this.catalog(id, { ...callOptions, signal }), (tools) =>
            carryCatalogFreshness(tools, tools.map(cloneTool)),
          ),
      ),
    ).pipe(Effect.catchDefect((error) => Effect.fail(error)));
  }

  // One connector's catalog from the request-scoped cache, reading it through
  // the registry when this request has not yet. No asker's options govern the
  // read: it carries its own signal and the catalog deadline, the probe
  // timeout, whichever asker starts it. Each asker waits under its own signal
  // and deadline, so a short-deadline call that starts the read and a search
  // that joins it each end on their own terms, and the read is cancelled only
  // once every asker has gone.
  private catalog(id: string, callOptions: ConnectorOperationOptions): Effect.Effect<ToolDef[], unknown> {
    return Effect.suspend(() => {
      // Authored static definitions never depend on a downstream cache or
      // credentials. Keep their discovery independent of credential reads.
      const identity = this.registry.getConnector(id)?.staticTools
        ? "static"
        : retainedCatalogIdentity(this.registry.contextFor(id, this.baseUrl, this.requestScope, callOptions));
      let retained = this.catalogs.get(id);
      if (!retained || retained.identity !== identity) {
        const started: SharedRead<ToolDef[]> = new SharedRead(
          (signal) =>
            registryProgram(this.registry, "getTools", id, this.baseUrl, this.requestScope, {
              signal,
              timeoutMs: this.probeTimeoutMs,
              ...(this.defer ? { defer: this.defer } : {}),
            }).pipe(
              Effect.map((tools) => {
                // An authored catalog lists its declared descriptions for this request's surface.
                const connector = this.registry.getConnector(id);
                return carryCatalogFreshness(
                  tools,
                  tools.map((tool) => {
                    // The request's own copy, which keeps the source classification.
                    const copy = cloneTool(tool);
                    routeToolInPlace(connector, copy, this.routes);
                    return copy;
                  }),
                );
              }),
            ),
          (succeeded) => {
            // Evicted before the read resumes anyone, so an asker that
            // retries on hearing of the failure starts a fresh read.
            if (!succeeded && this.catalogs.get(id)?.read === started) {
              this.catalogs.delete(id);
            }
          },
          this.requestScope,
        );
        retained = { identity, read: started };
        this.catalogs.set(id, retained);
      }
      return retained.read.join(callOptions.signal);
    });
  }

  private searchView(
    id: string,
    tools: ToolDef[],
    includeWrites: boolean,
    safety: CatalogSearchArgs["safety"],
  ): ToolDef[] {
    const readOnly = !includeWrites && (this.readOnly || this.registry.getConnector(id)?.readOnly === true);
    const key = `${readOnly}:${safety ?? "all"}`;
    let views = this.searchViews.get(tools);
    if (!views) {
      views = new Map();
      this.searchViews.set(tools, views);
    }
    let view = views.get(key);
    if (!view) {
      view = toolsForSafety(readOnly ? tools.filter((tool) => tool.classification === "read") : tools, safety ?? "all");
      views.set(key, view);
    }
    return view;
  }

  // Every named catalog under its own probe deadline, `concurrency` at a time,
  // each settling in its input slot: an unavailable catalog is a Failure
  // there, not a failed discovery. `route` names the surface in a timeout.
  // A probe also ends with its request, so no listing outlives the caller
  // that asked for it. On a read-only endpoint a write is absent from search
  // and describe, as if the connector never had it. Guides are not filtered.
  private discoveryCatalogs(
    ids: readonly string[],
    route: SearchRoute | "connecta.describe" | "tools/list",
    includeWrites = false,
  ): Effect.Effect<Array<Result.Result<ToolDef[], unknown>>> {
    return Effect.forEach(
      ids,
      (id) =>
        Effect.result(
          this.probe(
            id,
            includeWrites,
            this.probeTimeoutMs,
            new ConnectorCallError("timeout", `${route} probe of "${id}" timed out after ${this.probeTimeoutMs}ms`),
          ),
        ),
      { concurrency: this.concurrency },
    );
  }

  // Search's catalogs. A scoped search probes its connector under the full
  // probe deadline, reads its health record beside the probe, and settles it
  // after. An unscoped search reads health first, skips a connector whose
  // discovery failed recently, probes the rest under a shorter deadline, and
  // settles each record as its probe ends. One discovery budget bounds all of
  // it, health storage included: a probe that starts late gets only what
  // remains less a slice kept for settling, and health I/O starts only within
  // it, then runs to its end. A lapsed record is claimed as its probe is
  // dispatched, leased to the end of this budget plus a margin.
  // Caller cancellation and a probe the budget cut short leave health as it was.
  private searchCatalogs(
    ids: readonly string[],
    scoped: boolean,
  ): Effect.Effect<Array<Result.Result<ToolDef[], unknown>>> {
    return Effect.gen({ self: this }, function* () {
      const deadline = scoped ? this.probeTimeoutMs : Math.min(this.probeTimeoutMs, UNSCOPED_PROBE_TIMEOUT_MS);
      const budgetEnd = scoped ? Infinity : Date.now() + this.discoveryBudgetMs;
      const settleReserve = scoped ? 0 : Math.min(SETTLE_RESERVE_MS, Math.floor(this.discoveryBudgetMs / 10));
      // Health storage starts only while budget remains and the caller is
      // here; running out is not a failure, health is then unknown. Once
      // started, an operation is awaited to its end, never raced or detached:
      // a storage write cannot be withdrawn once sent (INV-7). The budget
      // bounds when health work may start, not when it finishes.
      const withinBudget = <A>(io: Effect.Effect<A>, unknown: A): Effect.Effect<A> =>
        Effect.suspend(() =>
          Date.now() >= budgetEnd || this.requestSignal?.aborted ? Effect.succeed(unknown) : Effect.uninterruptible(io),
        );
      // A skip that has lapsed is read again, so this request can claim the probe.
      const unread = ids.filter((id) => {
        const known = this.health.get(id);
        return !known || (!scoped && known.skip !== undefined && known.skip.retryAt <= Date.now());
      });
      const readHealth = Effect.map(
        withinBudget(
          readDiscoveryHealth(this.registry, unread, this.baseUrl, this.requestScope, { skip: !scoped }),
          unread.map((): HealthVerdict => ({})),
        ),
        (read) => unread.forEach((id, index) => this.health.set(id, read[index]!)),
      );
      // Record what one probe saw, unless the caller left.
      const settleOne = (outcome: SearchProbe): Effect.Effect<void> => {
        const slot = this.health.get(outcome.id)?.slot;
        const { result, settle } = outcome;
        if (!settle || !slot || this.requestSignal?.aborted) return Effect.void;
        return Effect.map(
          withinBudget(
            settleDiscoveryHealth(
              slot,
              Result.isSuccess(result)
                ? { ok: true }
                : {
                    ok: false,
                    failure: result.failure,
                    timedOut: result.failure === settle.timeoutError,
                    elapsedMs: settle.elapsedMs,
                  },
            ),
            undefined,
          ),
          (settled) => {
            if (settled) this.health.set(outcome.id, settled);
          },
        );
      };
      const probeOne = (id: string): Effect.Effect<SearchProbe> =>
        Effect.gen({ self: this }, function* () {
          const verdict = scoped ? undefined : this.health.get(id);
          const skip = verdict?.skip;
          if (skip && skip.retryAt > Date.now())
            return {
              id,
              result: Result.fail(new DiscoverySkipped(skip.code, Math.ceil(skip.retryAt - Date.now()))),
            };
          const timeoutFor = (remaining: number) => {
            const budgetCut = remaining < deadline;
            return {
              budgetCut,
              timeoutMs: budgetCut ? remaining : deadline,
              timeoutError: budgetCut
                ? new ConnectorCallError(
                    "timeout",
                    `${this.searchRoute} stopped probing "${id}" at the ${this.discoveryBudgetMs}ms discovery budget`,
                  )
                : new ConnectorCallError(
                    "timeout",
                    `${this.searchRoute} probe of "${id}" timed out after ${deadline}ms`,
                  ),
            };
          };
          let plan = timeoutFor(Math.ceil(budgetEnd - settleReserve - Date.now()));
          if (plan.timeoutMs <= 0) return { id, result: Result.fail(plan.timeoutError) };
          // A lapsed record: claim this probe now, as it is dispatched. The
          // lease runs to an absolute time, the end of this request's
          // discovery budget plus a margin, so however long the claim write
          // takes, the probe the budget still allows ends inside it.
          if (skip && verdict?.slot) {
            const leaseUntil = budgetEnd + CLAIM_MARGIN_MS;
            const claimed = yield* withinBudget(claimDiscoveryProbe(verdict.slot, leaseUntil), false);
            if (!claimed) {
              this.health.set(id, { slot: verdict.slot, skip: { code: skip.code, retryAt: leaseUntil } });
              return {
                id,
                result: Result.fail(new DiscoverySkipped(skip.code, Math.max(1, Math.ceil(leaseUntil - Date.now())))),
              };
            }
            this.health.set(id, { slot: verdict.slot });
            plan = timeoutFor(Math.ceil(budgetEnd - settleReserve - Date.now()));
            if (plan.timeoutMs <= 0) return { id, result: Result.fail(plan.timeoutError) };
          }
          const started = Date.now();
          const result = yield* Effect.result(this.probe(id, false, plan.timeoutMs, plan.timeoutError));
          // Elapsed time is this probe's own, measured as it settles.
          const elapsedMs = Date.now() - started;
          const outcome: SearchProbe =
            plan.budgetCut && Result.isFailure(result) && result.failure === plan.timeoutError
              ? { id, result }
              : { id, result, settle: { timeoutError: plan.timeoutError, elapsedMs } };
          if (scoped) return outcome;
          yield* settleOne(outcome);
          return { id, result };
        });
      if (!scoped) {
        yield* readHealth;
        const probed = yield* Effect.forEach(ids, probeOne, { concurrency: this.concurrency });
        return probed.map((outcome) => outcome.result);
      }
      const [, probed] = yield* Effect.all(
        [readHealth, Effect.forEach(ids, probeOne, { concurrency: this.concurrency })],
        { concurrency: 2 },
      );
      yield* Effect.forEach(probed, settleOne, { concurrency: "unbounded" });
      return probed.map((outcome) => outcome.result);
    });
  }

  private probe(
    id: string,
    includeWrites: boolean,
    timeoutMs: number,
    timeoutError: Error,
  ): Effect.Effect<ToolDef[], unknown> {
    return withDeadlineEffect(
      (signal) => Effect.map(this.catalog(id, { signal }), (tools) => this.searchView(id, tools, includeWrites, "all")),
      { ...(this.requestSignal ? { signal: this.requestSignal } : {}), timeoutMs, timeoutError },
    );
  }

  /**
   * Every visible catalog as discovery shows it, for a native `tools/list`:
   * a read-only endpoint or connector omits its writes, and each catalog
   * settles on its own, so one unavailable connector is an `error` entry
   * beside the others rather than a failed listing.
   */
  listCatalogs(
    includeWrites = false,
    connectors = this.registry.listConnectors(),
  ): Promise<Array<{ connector: Connector; tools: ToolDef[] } | { connector: Connector; error: unknown }>> {
    return runEdge(this.listCatalogsEffect(includeWrites, connectors));
  }

  listCatalogsEffect(includeWrites = false, connectors?: Connector[]) {
    return duringViewEffect({ requestScope: this.requestScope, signal: this.requestSignal }, () =>
      Effect.suspend(() => {
        const visible = connectors ?? this.registry.listConnectors();
        return Effect.map(
          this.discoveryCatalogs(
            visible.map((connector) => connector.id),
            "tools/list",
            includeWrites,
          ),
          (results) =>
            results.map((result, index) => {
              const connector = visible[index]!;
              return Result.isSuccess(result)
                ? { connector, tools: carryCatalogFreshness(result.success, result.success.map(cloneTool)) }
                : { connector, error: result.failure };
            }),
        );
      }),
    ).pipe(Effect.catchDefect((error) => Effect.fail(error)));
  }

  private outputSchema(connectorId: string, tool: ToolDef): OutputSchemaResolution {
    if (tool.outputSchema) return { schema: tool.outputSchema };
    const observed = this.registry.observedOutputSchema(connectorId, tool);
    return observed ? { schema: observed, source: "observed" } : {};
  }

  private unknownAddressFailure(address: string, query: string): CatalogResolution {
    return {
      ok: false,
      error: {
        ...framingError("unknown_address", `Unknown address "${boundedEchoText(address)}"`),
        configuredConnectors: this.registry.listConnectors().map((connector) => connector.id),
        nextAction: this.searchRecovery(
          { query: recoveryQuery(query) },
          "Find the configured canonical address before retrying.",
        ),
      },
      catalogMs: 0,
    };
  }

  private catalogLoadFailure(
    cause: unknown,
    started: number,
    connector: Connector,
    toolName: string,
  ): CatalogResolution {
    return {
      ok: false,
      error: classifyCallError(cause, "catalog_lookup_failed"),
      catalogMs: Date.now() - started,
      connector,
      toolName,
      cause,
    };
  }

  private unknownToolFailure(toolName: string, connector: Connector, started: number): CatalogResolution {
    return {
      ok: false,
      error: {
        ...framingError(
          "unknown_tool",
          hasControlCharacters(toolName)
            ? `Unknown tool on connector "${connector.id}"`
            : `Unknown tool "${boundedEchoText(toolName)}" on connector "${connector.id}"`,
        ),
        nextAction: this.searchRecovery(
          { query: hasControlCharacters(toolName) ? "" : recoveryQuery(toolName), connector: connector.id },
          "Find the connector's current canonical tool address.",
        ),
      },
      catalogMs: Date.now() - started,
      connector,
      toolName,
    };
  }

  resolveTool(address: string, callOptions: ConnectorOperationOptions = {}): Promise<CatalogResolution> {
    return runEdge(
      duringViewEffect(
        { requestScope: this.requestScope, signal: callOptions.signal ?? this.requestSignal },
        (signal) => this.resolve(address, { ...callOptions, signal }),
      ),
    );
  }

  // resolveTool without the Promise, for InvocationService's pipeline, which
  // yields it inside the call's deadline rather than crossing an edge. Never
  // fails: an unloadable catalog is a resolution like any other refusal.
  resolve(address: string, callOptions: ConnectorOperationOptions = {}): Effect.Effect<CatalogResolution> {
    return Effect.suspend(() => {
      const resolved = this.registry.resolveAddress(address);
      if (!resolved) {
        return Effect.succeed(this.unknownAddressFailure(address, address));
      }
      const { connector, toolName } = resolved;
      const started = Date.now();
      return Effect.match(this.catalog(connector.id, callOptions), {
        onFailure: (cause) => this.catalogLoadFailure(cause, started, connector, toolName),
        onSuccess: (tools): CatalogResolution => {
          const definition = tools.find((tool) => tool.name === toolName);
          if (!definition) {
            return this.unknownToolFailure(toolName, connector, started);
          }
          return {
            ok: true,
            resolved: {
              connector,
              toolName,
              definition: cloneTool(definition),
              classificationFresh: catalogIsFresh(tools),
            },
            catalogMs: Date.now() - started,
          };
        },
      });
    });
  }

  private catalogFailure(connector: Connector, failure: unknown): Effect.Effect<CatalogSearchFailure> {
    return Effect.gen({ self: this }, function* () {
      if (failure instanceof DiscoverySkipped) {
        return {
          connector: connector.id,
          code: failure.code,
          message: `Connector "${connector.id}" was skipped because its catalog lookup failed recently (${failure.code}). Search with connector "${connector.id}" to try it now.`,
          retryable: true,
          retryAfterMs: failure.retryAfterMs,
        };
      }
      const classified = classifyCallError(failure, "catalog_lookup_failed");
      const error: CatalogSearchFailure = {
        connector: connector.id,
        code: classified.code,
        // Catalog discovery reports recovery facts, never connector-authored
        // error text. Clipping a downstream message does not make it safe.
        message:
          classified.code === "downstream_oauth_required"
            ? `Connector "${connector.id}" requires downstream OAuth authorization. When an auth error includes a handoff, give it to the user or operator.`
            : classified.code === "auth_required"
              ? `Connector "${connector.id}" requires operator-managed credentials or configuration. When an auth error includes a handoff, give it to the user or operator.`
              : classified.code === "provider_permission_denied"
                ? `Connector "${connector.id}" requires permission from the provider's resource owner or administrator. Reconnecting alone will not grant access.`
                : `Connector "${connector.id}" catalog lookup failed (${classified.code}).`,
        retryable: classified.retryable,
        ...(classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs }),
      };
      if (error.code === "auth_required" || error.code === "downstream_oauth_required") {
        error.recovery = connector.startAuth
          ? "oauth"
          : this.registry.credentialUiAvailable() &&
              connector.credential &&
              this.registry.contextFor(connector.id, this.baseUrl, this.requestScope).credential
            ? "operator_config"
            : "unavailable";
        error.nextAction = {
          tool: "authorize_connector",
          arguments: { connector: connector.id },
          operatorHandoff: "Give the URL and instructions it returns to the operator.",
        };
        error.retry = `Retry discovery after the operator completes recovery for "${connector.id}".`;
      } else if (error.code === "provider_permission_denied") {
        error.retry =
          "Ask the provider's resource owner or administrator to grant the required permission or scope, then retry. Reconnecting alone will not grant access.";
      }
      return yield* withAuthorizationHandoffEffect(this.requestScope, error);
    });
  }

  search(
    args: CatalogSearchArgs,
    onCatalogReference?: (connector: string, tool?: string) => void,
  ): Promise<CatalogSearchPage> {
    return runEdge(this.searchEffect(args, onCatalogReference));
  }

  searchEffect(
    args: CatalogSearchArgs,
    onCatalogReference?: (connector: string, tool?: string) => void,
  ): Effect.Effect<CatalogSearchPage, unknown> {
    return duringViewEffect({ requestScope: this.requestScope, signal: this.requestSignal }, () =>
      this.searchPage(args, onCatalogReference),
    ).pipe(Effect.catchDefect((error) => Effect.fail(error)));
  }

  private searchPage(
    args: CatalogSearchArgs,
    onCatalogReference?: (connector: string, tool?: string) => void,
  ): Effect.Effect<CatalogSearchPage, unknown> {
    return Effect.gen({ self: this }, function* () {
      if (args.query !== undefined && typeof args.query !== "string") {
        throw new DiscoveryPolicyError(
          "invalid_args",
          "query must be a string. Omit it or use an empty string to browse the catalog.",
        );
      }
      if (args.connector !== undefined && boundedEchoText(args.connector) !== args.connector) {
        // The scope is echoed back as `queryAnalysis.connectorScope`; a clipped
        // copy could name a different connector, so refuse instead of clamping.
        throw new DiscoveryPolicyError("invalid_args", "connector must be at most 512 UTF-8 bytes.");
      }
      const query = args.query ?? "";
      const retrievalQuery = lexicalSearchQuery(query);
      const safety = discoverySafety(args.safety);
      const limit = discoverySearchLimit(args.limit);
      if (
        args.offset !== undefined &&
        (typeof args.offset !== "number" || !Number.isInteger(args.offset) || args.offset < 0)
      ) {
        throw new DiscoveryPolicyError(
          "invalid_args",
          "offset must be a non-negative whole number. Start at 0 or use the previous page's nextOffset.",
        );
      }
      const offset = args.offset ?? 0;
      const scopedConnector = args.connector ? this.registry.getConnector(args.connector) : undefined;
      const visibleConnectors = this.registry.listConnectors();
      const namedService = !args.connector ? SERVICE_NAMES.find((name) => containsPhrase(query, name)) : undefined;
      const absentService =
        args.connector && !scopedConnector
          ? args.connector
          : namedService &&
              !visibleConnectors.some((connector) =>
                connectorNames(connector).some((name) => containsPhrase(name, namedService)),
              )
            ? namedService
            : undefined;
      const absence = absentService
        ? {
            service: absentService,
            message: `No connector for "${absentService}" is configured for this endpoint.`,
            configuredConnectors: visibleConnectors.map((connector) => connector.id),
          }
        : undefined;
      const connectors = absence ? [] : args.connector ? (scopedConnector ? [scopedConnector] : []) : visibleConnectors;
      // Timeout messages name the route the caller used.
      const catalogs = yield* this.searchCatalogs(
        connectors.map((connector) => connector.id),
        args.connector !== undefined,
      );
      const searchableCatalogs = catalogs.map((catalog, index) =>
        Result.map(catalog, (tools) => this.searchView(connectors[index]!.id, tools, true, safety)),
      );
      const matches: Array<{
        connector: Connector;
        tool: ToolDef;
        score: number;
        order: number;
        exactName: boolean;
        exactLookup: boolean;
        connectorRank: number;
        matchedTermCount: number;
        complete: boolean;
      }> = [];
      let matchMode: "all" | "partial" = "all";
      // Provider-declared synonyms widen term matching within their own catalog only.
      const synonymsFor = (tools: ToolDef[]) => {
        const index = searchableCatalogs.findIndex((catalog) => Result.isSuccess(catalog) && catalog.success === tools);
        return index < 0 ? undefined : searchSynonyms(connectors[index]!);
      };
      const statistics = lexicalCorpusStatistics(
        searchableCatalogs.flatMap((catalog) => (Result.isSuccess(catalog) ? [catalog.success] : [])),
        retrievalQuery,
        synonymsFor,
      );
      const trimmedQuery = query.trim();
      const isBrowse = trimmedQuery.length === 0;
      const queryTerms = lexicalQueryTerms(retrievalQuery);
      const rawPhrase = lexicalQueryTerms(query).join(" ");
      const queryTermCount = queryTerms.length;
      const unsearchableQuery = !isBrowse && queryTermCount === 0;
      const analysisTerms = unsearchableQuery ? [trimmedQuery] : queryTerms;
      const analyzedTerms = analysisTerms.slice(0, MAX_QUERY_TERMS);
      const displayTerm = (term: string) => boundedQueryTerm(term).text;
      const queryMetadataTruncated =
        analysisTerms.length > analyzedTerms.length || analyzedTerms.some((term) => boundedQueryTerm(term).truncated);
      const vocabularyTools = new Set<ToolDef>();
      const readyFound: Array<{ connector: Connector; tool: ToolDef; path: string; summary: string }> = [];
      const collectMatches = (mode: "all" | "partial") => {
        const collected: typeof matches = [];
        readyFound.length = 0;
        let orderBase = 0;
        searchableCatalogs.forEach((catalog, connectorIndex) => {
          const connector = connectors[connectorIndex];
          if (!connector) {
            throw new Error("Catalog result has no corresponding connector");
          }
          if (Result.isSuccess(catalog)) {
            const connectorRank = args.connector ? 0 : connectorMatchRank(query, connector);
            const exactConnector = connectorRank > 0;
            const connectorTerms = new Set([
              ...connectorNames(connector).flatMap(lexicalQueryTerms),
              ...(namedService && connectorNames(connector).some((name) => containsPhrase(name, namedService))
                ? lexicalQueryTerms(namedService)
                : []),
            ]);
            const localStatistics = exactConnector
              ? lexicalCorpusStatistics([catalog.success], retrievalQuery, synonymsFor)
              : undefined;
            // An exact identity is a browse even when one tool repeats that
            // identity in its name or description. Action queries still keep
            // identity terms that also name an actual capability.
            const identityBrowse = connectorNames(connector).some(
              (name) => normalizedPhrase(query) === normalizedPhrase(name),
            );
            const toolQuery = identityBrowse
              ? ""
              : exactConnector
                ? queryTerms
                    .filter(
                      (term) =>
                        !connectorTerms.has(term) ||
                        (localStatistics?.nameMatches.get(term)?.size ?? 0) > 0 ||
                        (localStatistics?.descriptionMatches.get(term)?.size ?? 0) > 0,
                    )
                    .join(" ")
                : retrievalQuery;
            const toolTerms = lexicalQueryTerms(toolQuery);
            const toolTermCount = toolTerms.length;
            const rankedTools = rankTools(catalog.success, toolQuery, mode, statistics, query);
            const original = catalogs[connectorIndex]!;
            if (!isBrowse && query.length <= 200 && queryTerms.length <= 8 && Result.isSuccess(original)) {
              const vocabulary = operationVocabularyMatches(
                connector,
                original.success,
                toolTerms.filter((term) => !connectorTerms.has(term)).join(" "),
                safety,
                this.readOnly,
              );
              // At most one ready call per connector: its first hatch's top operation.
              const ready = vocabulary.ready[0];
              if (ready && !readyFound.some((found) => found.connector === connector))
                readyFound.push({ connector, ...ready });
              for (const tool of vocabulary.tools) {
                vocabularyTools.add(tool);
                if (!rankedTools.some((match) => match.tool === tool))
                  rankedTools.push({
                    tool,
                    score: 0,
                    order: original.success.indexOf(tool),
                    exactName: false,
                    matchedTermCount: toolTermCount,
                  });
              }
            }
            for (const ranked of rankedTools) {
              collected.push({
                connector,
                tool: ranked.tool,
                score: vocabularyTools.has(ranked.tool) && !ranked.exactName ? 0 : ranked.score,
                order: orderBase + ranked.order,
                exactName: ranked.exactName,
                exactLookup:
                  rawPhrase === lexicalQueryTerms(ranked.tool.name).join(" ") ||
                  rawPhrase === lexicalQueryTerms(`${connector.id}.${ranked.tool.name}`).join(" "),
                connectorRank,
                matchedTermCount: vocabularyTools.has(ranked.tool) ? toolTermCount : ranked.matchedTermCount,
                complete: isBrowse || vocabularyTools.has(ranked.tool) || ranked.matchedTermCount === toolTermCount,
              });
            }
          }
          orderBase += Result.isSuccess(catalog) ? catalog.success.length : 1;
        });
        return collected;
      };
      // A non-empty query that normalizes to no lexical terms is not a browse.
      // Ranking an empty phrase would otherwise return every tool as an
      // unrelated zero-score match, with no coverage to explain the result.
      const rankedMatches = unsearchableQuery ? [] : collectMatches(isBrowse ? "all" : "partial");
      const completeMatchCount = rankedMatches.filter((match) => match.complete).length;
      matches.push(
        ...rankedMatches.filter(
          (match) =>
            match.complete ||
            completeMatchCount === 0 ||
            match.exactName ||
            match.connectorRank > 0 ||
            match.matchedTermCount >= 2,
        ),
      );
      if (!isBrowse && !unsearchableQuery && completeMatchCount === 0) {
        matchMode = "partial";
      }
      // A read-intent verb leads the query once connector names are set aside.
      const identityTerms = new Set(connectors.flatMap(connectorNames).flatMap(lexicalQueryTerms));
      const readIntent = READ_INTENT.test(lexicalQueryTerms(query).find((term) => !identityTerms.has(term)) ?? "");
      const readFirst = (match: (typeof matches)[number]) => Number(readIntent && match.tool.classification === "read");
      // Exact tool names precede connector identity and lexical scoring. A
      // longer name such as get_issue_status cannot beat an exact get_issue
      // merely because its description repeats rare query terms. Within a
      // tier, a read-intent query puts reads before writes.
      matches.sort((a, b) => {
        const aFirstTier = a.complete || a.exactName;
        const bFirstTier = b.complete || b.exactName;
        return (
          Number(b.exactLookup) - Number(a.exactLookup) ||
          Number(b.exactName) - Number(a.exactName) ||
          b.connectorRank - a.connectorRank ||
          Number(bFirstTier) - Number(aFirstTier) ||
          readFirst(b) - readFirst(a) ||
          b.score - a.score ||
          a.order - b.order
        );
      });
      const pageMatches = matches.slice(offset, offset + limit);
      const withSchemas = args.includeSchemas;
      const entries = pageMatches.map((selected) => {
        const match = { ...selected, tool: cloneTool(selected.tool) };
        const output = withSchemas ? this.outputSchema(match.connector.id, match.tool) : {};
        const input = match.tool.inputSchema ?? { type: "object" };
        const signature =
          withSchemas === "typescript"
            ? typescriptSignature(input, output.schema, {
                observed: output.source === "observed",
                description: false,
              })
            : undefined;
        const schemaFormat = withSchemas === "typescript" ? undefined : withSchemas;
        const renderedInput = signature
          ? { schema: undefined, truncated: signature.inputTruncated }
          : schemaFormat
            ? renderSearchSchema(input, schemaFormat)
            : undefined;
        const renderedOutput = signature
          ? { schema: undefined, truncated: signature.outputTruncated }
          : schemaFormat && output.schema
            ? renderSearchSchema(output.schema, schemaFormat)
            : undefined;
        const schemaKeys = withSchemas && args.includeSchemaKeys ? schemaKeyMetadata(input, output.schema) : undefined;
        const description = summarizeDiscoveryDescription(match.tool.description, args.fullDescriptions === true);
        const requiredReasons = guideRequiredReasons(
          match.connector,
          match.tool,
          renderedInput?.truncated === true || renderedOutput?.truncated === true,
        );
        const guideSummary = connectorGuideSummary(match.connector);
        return {
          connector: match.connector,
          ...(connectorGuide(match.connector)
            ? {
                guide: connectorSkillName(match.connector.id),
                ...(guideSummary ? { guideSummary } : {}),
              }
            : {}),
          tool: {
            name: match.tool.name,
            address: `${match.connector.id}.${match.tool.name}`,
            ...(description !== undefined ? { description } : {}),
            ...(schemaFormat
              ? {
                  inputSchema: renderedInput?.schema,
                }
              : {}),
            ...(withSchemas ? { schemaFormat: withSchemas === "json" ? ("json" as const) : ("text" as const) } : {}),
            ...(signature ? { signature: signature.text } : {}),
            ...(renderedInput?.truncated ? { inputSchemaTruncated: true as const } : {}),
            ...(schemaFormat && output.schema
              ? {
                  outputSchema: renderedOutput?.schema,
                }
              : {}),
            ...(withSchemas && output.source ? { outputSchemaSource: output.source } : {}),
            ...(renderedOutput?.truncated ? { outputSchemaTruncated: true as const } : {}),
            ...(schemaKeys && !renderedInput?.truncated
              ? {
                  ...(schemaKeys.inputKeys ? { inputKeys: schemaKeys.inputKeys } : {}),
                  ...(schemaKeys.requiredInputKeys ? { requiredInputKeys: schemaKeys.requiredInputKeys } : {}),
                }
              : {}),
            ...(schemaKeys?.outputKeys && !renderedOutput?.truncated ? { outputKeys: schemaKeys.outputKeys } : {}),
            ...(match.tool.annotations ? { annotations: match.tool.annotations } : {}),
            classification: match.tool.classification,
            ...(requiredReasons
              ? {
                  guideRequired: true as const,
                  guideRequiredReasons: requiredReasons,
                }
              : {}),
          },
        };
      });
      // An exact name already answers the query, and so does a complete match
      // on an authored tool (not the hatch's own) whose name adds nothing to
      // the query: each name word is an action, or a query word up to
      // plural/singular and declared synonyms. `list_teams` answers "list
      // teams"; `list_project_env_vars` does not answer "list projects".
      const top = matches[0];
      const synonymsOfTop = top && searchSynonyms(top.connector);
      const asked = queryTerms.flatMap((term) => [term, ...(synonymsOfTop?.(term) ?? [])]);
      const answered =
        top !== undefined &&
        (top.exactLookup ||
          top.exactName ||
          (top.complete &&
            !vocabularyTools.has(top.tool) &&
            !readyFound.some((ready) => ready.tool === top.tool) &&
            lexicalQueryTerms(top.tool.name).every(
              (word) => ACTION_WORD.test(word) || asked.some((term) => matchesLexicalTerm(word, term)),
            )));
      const readyCalls =
        offset === 0 && !answered
          ? readyFound.slice(0, MAX_READY_CALLS).map(({ connector, tool, path, summary }): CatalogReadyCall => {
              const reasons = guideRequiredReasons(connector, tool, false);
              const guideSummary = connectorGuideSummary(connector);
              return {
                connector,
                call: {
                  address: `${connector.id}.${tool.name}`,
                  args: { path },
                  classification: "read",
                  summary,
                  ...(reasons ? { guideRequired: true as const, guideRequiredReasons: reasons } : {}),
                },
                ...(connectorGuide(connector)
                  ? { guide: connectorSkillName(connector.id), ...(guideSummary ? { guideSummary } : {}) }
                  : {}),
              };
            })
          : [];
      const nextOffset = offset + entries.length < matches.length ? offset + entries.length : undefined;
      const pageTools = new Set(pageMatches.map((match) => match.tool));
      const matchingTools = (term: string) =>
        new Set([
          ...(statistics.nameMatches.get(term) ?? []),
          ...(statistics.descriptionMatches.get(term) ?? []),
          ...vocabularyTools,
        ]);
      const representedTerms: string[] = [];
      const otherResultTerms: string[] = [];
      const unmatchedTerms: string[] = [];
      for (const term of analyzedTerms) {
        const termTools = matchingTools(term);
        if ([...termTools].some((tool) => pageTools.has(tool))) {
          representedTerms.push(displayTerm(term));
        } else if (termTools.size > 0) {
          otherResultTerms.push(displayTerm(term));
        } else {
          unmatchedTerms.push(displayTerm(term));
        }
      }
      const unavailableCatalogs = catalogs.filter(Result.isFailure).length;
      const catalogErrors = (yield* Effect.forEach(
        catalogs,
        (catalog, index) =>
          Result.isSuccess(catalog)
            ? Effect.succeed([])
            : this.catalogFailure(connectors[index]!, catalog.failure).pipe(Effect.map((error) => [error])),
        { concurrency: "unbounded" },
      )).flat();
      const needsAuth = (error: CatalogSearchFailure) =>
        error.code === "auth_required" ||
        error.code === "downstream_oauth_required" ||
        error.code === "provider_permission_denied";
      catalogErrors.sort((a, b) => Number(needsAuth(b)) - Number(needsAuth(a)));
      const scopedFailure = args.connector ? catalogErrors[0] : undefined;
      const scopedCatalogError: CatalogFailureDetail | undefined = scopedFailure
        ? scopedFailure.code === "auth_required" || scopedFailure.code === "downstream_oauth_required"
          ? scopedFailure
          : {
              code: scopedFailure.code,
              message: scopedFailure.message,
              retryable: scopedFailure.retryable,
              ...(scopedFailure.retryAfterMs === undefined ? {} : { retryAfterMs: scopedFailure.retryAfterMs }),
            }
        : undefined;
      const safetyLabel =
        safety === "readOnly" ? "read-only " : safety === "approvalRequired" ? "approval-required " : "";
      const filterRecovery = safety === "all" ? "" : " Change safety to inspect the other tools.";
      const scopedGuide =
        matches.length === 0 && scopedConnector && connectorGuide(scopedConnector)
          ? {
              guide: connectorSkillName(scopedConnector.id),
              guideSummary: connectorGuideSummary(scopedConnector),
              required: connectorGuideRequired(scopedConnector),
            }
          : undefined;
      // Partial identity words can still explain a miss. Exact identities are
      // already ranking inputs above; this guidance handles a title word such
      // as "warehouse" when the full title is "Warehouse stock".
      const identityConnectorIds =
        matches.length === 0 && !isBrowse && !unsearchableQuery && !scopedConnector
          ? connectors
              // The full query, not `analyzedTerms`: that cap exists to bound
              // the serialized term fields, and ranking already reads every
              // term. A ninth term is a real search term, and a search that
              // ranked against it must not deny the connector it names.
              .filter((connector) =>
                queryTerms.some(
                  (term) =>
                    matchesLexicalTerm(connector.id, term) ||
                    (connector.title !== undefined && matchesLexicalTerm(connector.title, term)),
                ),
              )
              .map((connector) => connector.id)
          : [];
      const namedIdentityConnectors = identityConnectorIds
        .slice(0, MAX_IDENTITY_CONNECTORS)
        .map((id) => `"${id}"`)
        .join(", ");
      const unnamedIdentityConnectors = identityConnectorIds.length - MAX_IDENTITY_CONNECTORS;
      const identityGuidance =
        identityConnectorIds.length === 0
          ? undefined
          : `No matching ${safetyLabel}capability was found${
              unavailableCatalogs === 0 ? "" : " in the catalogs that answered"
            }, but the query names configured connector${
              identityConnectorIds.length === 1 ? "" : "s"
            } ${namedIdentityConnectors}${
              unnamedIdentityConnectors > 0 ? ` and ${unnamedIdentityConnectors} more` : ""
            }. Scope by connector and browse with an empty query to list the tools there.`;
      // Bounded vocabulary is not an exhaustive operation search. Keep the
      // fallback to already-loaded visible tools, in stable connector order.
      // The caller's safety filter is not a visibility boundary: a read search
      // tool is also how one discovers indexed writes for approvalRequired.
      const apiSearchPointers =
        matches.length === 0 && !isBrowse && !unsearchableQuery && !(this.readOnly && safety === "approvalRequired")
          ? catalogs.flatMap((catalog, index) =>
              Result.isSuccess(catalog) && !(safety === "approvalRequired" && connectors[index]!.readOnly === true)
                ? apiSearchTools(catalog.success).map((tool) => ({ connector: connectors[index]!.id, tool: tool.name }))
                : [],
            )
          : [];
      const namedApiSearchPointers = apiSearchPointers
        .filter(({ connector, tool }) => encoder.encode(`${connector}.${tool}`).length <= MAX_API_SEARCH_ADDRESS_BYTES)
        .slice(0, MAX_API_SEARCH_POINTERS);
      const omittedApiSearchPointers = apiSearchPointers.length - namedApiSearchPointers.length;
      const apiSearchGuidance =
        apiSearchPointers.length === 0
          ? undefined
          : "No catalog tool matched this query. Bounded API operation vocabulary was consulted; full API operation indexes have not been searched." +
            (namedApiSearchPointers.length
              ? ` Search operations with ${namedApiSearchPointers.map(({ connector, tool }) => `\`${connector}.${tool}\``).join(", ")}.`
              : "") +
            (omittedApiSearchPointers
              ? ` ${omittedApiSearchPointers} API search tool${omittedApiSearchPointers === 1 ? " was" : "s were"} omitted.`
              : "") +
            ' To list every API search tool, browse with an empty query and follow all pages, or search for "_api_search".' +
            (scopedGuide?.required
              ? " Fetch queryAnalysis.guide before calling."
              : " Read the connector guide before calling when discovery requires it.") +
            (unavailableCatalogs
              ? ` ${unavailableCatalogs} connector catalog${unavailableCatalogs === 1 ? " was" : "s were"} unavailable; inspect catalogErrors.`
              : "") +
            filterRecovery;
      // A scope that resolved to nothing is the same silence one step earlier in
      // the lookup: no connector resolved, so no catalog was even attempted, so
      // no catalog failed and the unavailable path below never fires. Name
      // only configured connectors in the current identity/pool registry view.
      const unknownConnectorGuidance =
        args.connector && !scopedConnector
          ? `Connector "${args.connector}" is not configured in this deployment. Omit connector to search all configured tools. Configured connectors for this endpoint: ${
              this.registry
                .listConnectors()
                .map((connector) => connector.id)
                .join(", ") || "none"
            }.`
          : undefined;
      // Searchable queries report analysis when the scorer had to degrade. A
      // non-empty query with no searchable terms reports the bounded raw input
      // as unmatched instead of silently becoming a browse. A real browse has
      // no terms to analyse and normally reports none at all. Scope failures are
      // the exception, because an empty result alone looks like a connector that
      // correctly exposes no tools.
      const reportsQueryAnalysis =
        absence !== undefined ||
        unsearchableQuery ||
        (queryTerms.length > 0
          ? matchMode === "partial"
          : unknownConnectorGuidance !== undefined || unavailableCatalogs > 0);
      const searchGuidance = (): string | undefined => {
        if (unknownConnectorGuidance) return unknownConnectorGuidance;
        if (absence) return absence.message;
        if (unsearchableQuery) {
          return scopedConnector && unavailableCatalogs > 0
            ? `Connector "${scopedConnector.id}" could not be searched because its catalog was unavailable. Inspect catalogError for the typed reason and recovery detail.`
            : "The query contained no searchable lexical terms. Use 2–4 ASCII action/object terms, or browse with an empty query.";
        }
        if (queryTerms.length === 0) {
          if (unavailableCatalogs === 0) return undefined;
          return scopedConnector
            ? `Connector "${scopedConnector.id}" could not be browsed because its catalog was unavailable. Inspect catalogError for the typed reason and recovery detail.`
            : `${unavailableCatalogs} connector catalog${unavailableCatalogs === 1 ? " was" : "s were"} unavailable, so this browse is incomplete. Inspect catalogErrors for the typed reasons and recovery actions.`;
        }
        if (matches.length === 0) {
          if (scopedConnector) {
            if (unavailableCatalogs > 0) {
              return `Connector "${scopedConnector.id}" could not be searched because its catalog was unavailable. Inspect catalogError for the typed reason and recovery detail.`;
            }
            if (apiSearchGuidance) return apiSearchGuidance;
            return scopedGuide?.required
              ? `No matching ${safetyLabel}capability was found on connector "${scopedConnector.id}". Fetch queryAnalysis.guide before calling, then refine terms or browse with an empty query.${filterRecovery}`
              : `No matching ${safetyLabel}capability was found on connector "${scopedConnector.id}". Refine terms or browse it with an empty query.${filterRecovery}`;
          }
          if (identityGuidance || apiSearchGuidance)
            return (
              [identityGuidance, apiSearchGuidance].filter(Boolean).join(" ") +
              (apiSearchGuidance ? "" : filterRecovery)
            );
          return unavailableCatalogs === 0
            ? `No matching ${safetyLabel}capability is configured in this deployment. Refine terms, scope by connector, or browse with an empty query.${filterRecovery}`
            : `No matching ${safetyLabel}capability was found in the catalogs that answered; ${unavailableCatalogs} connector catalog${unavailableCatalogs === 1 ? " was" : "s were"} unavailable. Refine terms, scope by connector, or browse with an empty query.${filterRecovery}`;
        }
        if (matchMode !== "partial") return undefined;
        if (scopedConnector) {
          return `No single tool on connector "${scopedConnector.id}" matched every term. Split distinct intents into separate searches.`;
        }
        return unavailableCatalogs === 0
          ? "No single tool matched every term. Split distinct intents into separate searches."
          : "No single tool matched every term in the catalogs that answered. Split distinct intents into separate searches.";
      };
      const guidance = searchGuidance();
      // Counts, ranking, and term analysis use the whole searched corpus, not
      // just this page's tools. Bind every searched connector, including failed
      // catalogs and off-page matches, so paging cannot reveal a hidden
      // connector's contribution. Keep provenance host-only.
      for (const connector of connectors) onCatalogReference?.(connector.id);
      for (const entry of entries) onCatalogReference?.(entry.connector.id, entry.tool.name);
      for (const { connector, call } of readyCalls)
        onCatalogReference?.(connector.id, call.address.slice(connector.id.length + 1));
      for (const pointer of apiSearchPointers) onCatalogReference?.(pointer.connector, pointer.tool);
      for (const connector of absence?.configuredConnectors ?? []) onCatalogReference?.(connector);
      // An unknown scope's guidance lists the visible roster without searching it.
      if (reportsQueryAnalysis && args.connector && !scopedConnector)
        for (const connector of visibleConnectors) onCatalogReference?.(connector.id);
      return {
        catalogErrors,
        ...(absence ? { absence } : {}),
        entries,
        ...(readyCalls.length ? { readyCalls } : {}),
        total: matches.length,
        offset,
        limit,
        hasMore: nextOffset !== undefined,
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        ...(matchMode === "partial" && matches.length > 0 ? { matchMode } : {}),
        ...(reportsQueryAnalysis
          ? {
              queryAnalysis: {
                representedTerms,
                otherResultTerms,
                unmatchedTerms,
                ...(queryMetadataTruncated ? { truncated: true as const } : {}),
                ...(args.connector ? { connectorScope: args.connector } : {}),
                ...(args.connector && !scopedConnector
                  ? {
                      unknownConnector: true as const,
                      configuredConnectors: this.registry.listConnectors().map((connector) => connector.id),
                    }
                  : {}),
                ...(unavailableCatalogs > 0 ? { unavailableConnectorCount: unavailableCatalogs } : {}),
                ...(scopedCatalogError ? { catalogError: scopedCatalogError } : {}),
                ...(scopedGuide
                  ? {
                      guide: scopedGuide.guide,
                      ...(scopedGuide.guideSummary ? { guideSummary: scopedGuide.guideSummary } : {}),
                      ...(scopedGuide.required
                        ? {
                            guideRequired: true as const,
                            guideRequiredReasons: ["connector_required" as const],
                          }
                        : {}),
                    }
                  : {}),
                ...(guidance ? { guidance } : {}),
              },
            }
          : {}),
      };
    });
  }

  describe(args: CatalogDescribeArgs): Promise<CatalogDescription[]> {
    return runEdge(this.describeEffect(args));
  }

  describeEffect(args: CatalogDescribeArgs): Effect.Effect<CatalogDescription[], unknown> {
    return duringViewEffect({ requestScope: this.requestScope, signal: this.requestSignal }, () =>
      this.describePage(args),
    ).pipe(Effect.catchDefect((error) => Effect.fail(error)));
  }

  private describePage(args: CatalogDescribeArgs): Effect.Effect<CatalogDescription[], unknown> {
    return Effect.gen({ self: this }, function* () {
      const addresses = discoveryAddresses(args);
      const format = args.format ?? "compact";
      const resolved = addresses.map((rawAddress) => {
        const address = String(rawAddress);
        return { address, resolved: this.registry.resolveAddress(address) };
      });
      const connectorIds = [
        ...new Set(resolved.map((entry) => entry.resolved?.connector.id).filter((id): id is string => Boolean(id))),
      ];
      const loaded = yield* this.discoveryCatalogs(connectorIds, "connecta.describe");
      const catalogs = new Map(connectorIds.map((id, index) => [id, loaded[index]]));
      const authFailures = new Map(
        yield* Effect.forEach(
          connectorIds,
          (id) =>
            Effect.gen({ self: this }, function* () {
              const catalog = catalogs.get(id);
              if (!catalog || !Result.isFailure(catalog)) return [id, undefined] as const;
              const classified = classifyCallError(catalog.failure, "catalog_lookup_failed");
              const connector = this.registry.getConnector(id)!;
              const error =
                classified.code === "auth_required" || classified.code === "downstream_oauth_required"
                  ? yield* this.catalogFailure(connector, catalog.failure)
                  : undefined;
              return [id, error] as const;
            }),
          { concurrency: "unbounded" },
        ),
      );

      return resolved.map(({ address, resolved: addressResolution }) => {
        if (!addressResolution) {
          const message = `Unknown address "${boundedEchoText(address)}"`;
          return {
            address: boundedEchoText(address),
            error: message,
            errorDetails: {
              ...framingError("unknown_address", message),
              configuredConnectors: this.registry.listConnectors().map((connector) => connector.id),
              nextAction: this.searchRecovery(
                { query: recoveryQuery(address) },
                "Find the configured canonical address before retrying.",
              ),
            },
          };
        }
        const catalog = catalogs.get(addressResolution.connector.id);
        if (catalog && Result.isFailure(catalog)) {
          const authFailure = authFailures.get(addressResolution.connector.id);
          if (authFailure)
            return { address: boundedEchoText(address), error: authFailure.message, errorDetails: authFailure };

          const classified = classifyCallError(catalog.failure, "catalog_lookup_failed");
          const message = boundedEchoText(classified.message);
          return {
            address: boundedEchoText(address),
            error: message,
            errorDetails: {
              code: classified.code,
              message,
              retryable: classified.retryable,
              ...(classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs }),
            },
          };
        }
        const tools = catalog?.success ?? [];
        const selected = tools.find((item) => item.name === addressResolution.toolName);
        if (!selected) {
          const message = `Unknown tool "${boundedEchoText(addressResolution.toolName)}" on connector "${addressResolution.connector.id}"`;
          const suggestions = describeSuggestions(addressResolution.connector.id, addressResolution.toolName, tools);
          return {
            address: boundedEchoText(address),
            error: message,
            errorDetails: {
              ...framingError("unknown_tool", message),
              nextAction: this.searchRecovery(
                {
                  query: recoveryQuery(addressResolution.toolName),
                  connector: addressResolution.connector.id,
                },
                "Find the connector's current canonical tool address.",
              ),
              ...(suggestions.length > 0 ? { suggestions } : {}),
            },
          };
        }
        const tool = cloneTool(selected);
        const input = tool.inputSchema ?? { type: "object" };
        const output = this.outputSchema(addressResolution.connector.id, tool);
        const description = summarizeDescription(tool.description, args.fullDescriptions === true);
        const signature =
          format === "typescript"
            ? typescriptSignature(input, output.schema, {
                observed: output.source === "observed",
                description: true,
              })
            : undefined;
        const compactInput = format === "compact" ? compactDescriptionSchema(input) : undefined;
        const compactOutput =
          format === "compact" && output.schema ? compactDescriptionSchema(output.schema) : undefined;
        const inputTruncated = compactInput?.truncated === true || signature?.inputTruncated === true;
        const outputTruncated = compactOutput?.truncated === true || signature?.outputTruncated === true;
        const requiredReasons = guideRequiredReasons(
          addressResolution.connector,
          tool,
          inputTruncated || outputTruncated,
        );
        const guideSummary = connectorGuideSummary(addressResolution.connector);
        return {
          address,
          schemaFormat: format === "json" ? "json" : "text",
          name: tool.name,
          ...(description !== undefined ? { description } : {}),
          ...(connectorGuide(addressResolution.connector)
            ? {
                guide: connectorSkillName(addressResolution.connector.id),
                ...(guideSummary ? { guideSummary } : {}),
              }
            : {}),
          ...(requiredReasons
            ? {
                guideRequired: true as const,
                guideRequiredReasons: requiredReasons,
              }
            : {}),
          ...(signature ? { signature: signature.text } : { inputSchema: compactInput?.text ?? input }),
          ...(inputTruncated ? { inputSchemaTruncated: true as const } : {}),
          ...(outputTruncated ? { outputSchemaTruncated: true as const } : {}),
          ...(output.schema && !signature
            ? {
                outputSchema: compactOutput?.text ?? output.schema,
              }
            : {}),
          ...(output.source ? { outputSchemaSource: output.source } : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          classification: tool.classification,
        };
      });
    });
  }
  private static readonly nativePrograms = /* @__PURE__ */ (() => {
    for (const [key, native] of [
      ["search", "searchEffect"],
      ["describe", "describeEffect"],
      ["listCatalogs", "listCatalogsEffect"],
      ["loadConnector", "loadConnectorEffect"],
      ["resolveTool", "resolve"],
    ] as const) {
      registerAuthMethod(
        CatalogService.prototype,
        key,
        function (...args: any[]) {
          return Reflect.apply(this[native], this, args);
        },
        CatalogService.prototype[key],
      );
    }
  })();
}

function pageTail(page: CatalogSearchPage) {
  return {
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    hasMore: page.hasMore,
    ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
    ...(page.matchMode ? { matchMode: page.matchMode } : {}),
    ...(page.queryAnalysis ? { queryAnalysis: page.queryAnalysis } : {}),
  };
}

export function flatSearchResult(page: CatalogSearchPage): CatalogSearchResult {
  // fromEntries keeps an id such as "__proto__" an own key.
  const connectors = new Map<string, CatalogSearchConnector>();
  for (const { connector, guide, guideSummary } of [...page.entries, ...(page.readyCalls ?? [])]) {
    const title = connector.title && boundedEchoText(connector.title.replace(/\s+/g, " ").trim(), 117);
    if (title || guide)
      connectors.set(connector.id, {
        ...(title ? { title } : {}),
        ...(guide ? { guide } : {}),
        ...(guideSummary ? { guideSummary } : {}),
      });
  }
  return {
    catalogErrors: page.catalogErrors,
    ...(page.absence ? { absence: page.absence } : {}),
    tools: page.entries.map((entry) => entry.tool),
    ...(page.readyCalls ? { readyCalls: page.readyCalls.map((ready) => ready.call) } : {}),
    ...(connectors.size ? { connectors: Object.fromEntries(connectors) } : {}),
    ...pageTail(page),
  };
}
