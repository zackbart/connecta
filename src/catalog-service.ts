import {
  compactDiscoverySchema,
  compactSchema,
  lexicalCorpusStatistics,
  lexicalQueryTerms,
  lexicalSearchQuery,
  matchesLexicalTerm,
  rankTools,
  schemaObjectKeys,
  summarizeDiscoveryDescription,
  summarizeDescription,
} from "./catalog.js";
import {
  mapSettledWithConcurrency,
  resolveDiscoveryConcurrency,
} from "./concurrency.js";
import {
  boundedEchoText,
  classifyCallError,
  framingError,
} from "./errors.js";
import type { CallErrorDetails } from "./errors.js";
import type {
  CatalogReadOptions,
  ConnectorOperationOptions,
  RegistryView,
} from "./registry.js";
import type { DeferredWork } from "./connector-scope.js";
import {
  connectorGuide,
  connectorGuideRequired,
  connectorGuideSummary,
  connectorSkillName,
} from "./skills.js";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  normalizeTimeoutMs,
  withDeadline,
} from "./timeout.js";
import { isExplicitlyReadOnly } from "./tool-safety.js";
import type {
  Connector,
  JsonSchema,
  ToolDef,
} from "./types.js";

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

/** Validate before ranking so a huge page request does no proportional work. */
function discoverySearchLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_SEARCH_LIMIT;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_SEARCH_LIMIT
  ) {
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
    throw new DiscoveryPolicyError(
      "invalid_args",
      "describe takes either address or addresses, not both.",
    );
  }
  const value =
    args.address !== undefined
      ? typeof args.address === "string"
        ? [args.address]
        : undefined
      : args.addresses;
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
  return boundedEchoText(
    candidate.replaceAll(/[._-]+/g, " ").trim() || address,
  );
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
          previous[rightIndex]! +
            (left[leftIndex] === right[rightIndex] ? 0 : 1),
        ),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** Nearby names only; descriptions never influence describe-miss recovery. */
function describeSuggestions(
  connectorId: string,
  attemptedName: string,
  tools: ToolDef[],
): string[] {
  const attempted = attemptedName.toLowerCase();
  return tools
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
    .sort((left, right) =>
      left.distance - right.distance || left.order - right.order,
    )
    .map(({ tool }) => `${connectorId}.${tool.name}`)
    // A clipped address would no longer be canonical. Omit an implausibly
    // large catalog name instead of letting one suggestion erase the page.
    .filter((address) => boundedEchoText(address) === address)
    .slice(0, MAX_DESCRIBE_SUGGESTIONS);
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
  includeSchemas?: "compact" | "json";
  /** Code-mode helper metadata; never exposed by the public search_tools schema. */
  includeSchemaKeys?: boolean;
}

function discoverySafety(
  value: unknown,
): "readOnly" | "approvalRequired" | "all" {
  if (value === undefined) return "all";
  if (
    value !== "readOnly" &&
    value !== "approvalRequired" &&
    value !== "all"
  ) {
    throw new DiscoveryPolicyError(
      "invalid_args",
      'safety must be "readOnly", "approvalRequired", or "all".',
    );
  }
  return value;
}

function toolsForSafety(
  tools: ToolDef[],
  safety: "readOnly" | "approvalRequired" | "all",
): ToolDef[] {
  if (safety === "all") return tools;
  return tools.filter((tool) =>
    safety === "readOnly"
      ? isExplicitlyReadOnly(tool)
      : !isExplicitlyReadOnly(tool),
  );
}

export interface CatalogDescribeArgs {
  address?: unknown;
  addresses?: unknown;
  format?: "compact" | "json";
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
    outputSchemaSource?: "observed";
    inputSchemaTruncated?: true;
    outputSchemaTruncated?: true;
    inputKeys?: string[];
    requiredInputKeys?: string[];
    outputKeys?: string[];
    annotations?: ToolDef["annotations"];
    guideRequired?: true;
    guideRequiredReasons?: GuideRequiredReason[];
  };
}

type GuideRequiredReason =
  | "connector_required"
  | "approval_required"
  | "schema_truncated";

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
  if (!isExplicitlyReadOnly(tool)) reasons.push("approval_required");
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
    ...(outputKeys && outputKeys.properties.length > 0
      ? { outputKeys: outputKeys.properties }
      : {}),
  };
}

/**
 * The classified-failure subset a scoped search may echo: enough to tell a
 * transient outage from one an operator must clear, and nothing more. Kept as
 * its own type rather than `CallErrorDetails` so widening the call-path
 * classifier cannot widen this discovery-surface field by accident.
 */
interface CatalogFailureDetail {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

interface CatalogDescriptionFailureDetail extends CatalogFailureDetail {
  nextAction?: NonNullable<CallErrorDetails["nextAction"]>;
  /** Nearby canonical addresses, ranked deterministically by tool name. */
  suggestions?: string[];
}

export interface CatalogSearchPage {
  entries: CatalogSearchEntry[];
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

export interface CatalogDescription {
  address: string;
  name?: string;
  description?: string;
  guide?: string;
  guideSummary?: string;
  guideRequired?: true;
  guideRequiredReasons?: GuideRequiredReason[];
  inputSchema?: unknown;
  outputSchema?: unknown;
  outputSchemaSource?: "observed";
  annotations?: ToolDef["annotations"];
  error?: string;
  errorDetails?: CatalogDescriptionFailureDetail;
}

export interface ResolvedCatalogTool {
  connector: Connector;
  toolName: string;
  definition: ToolDef;
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

function renderSchema(schema: JsonSchema, format: "compact" | "json"): unknown {
  return format === "json" ? schema : compactSchema(schema);
}

function renderSearchSchema(
  schema: JsonSchema,
  format: "compact" | "json",
): { schema: unknown; truncated: boolean } {
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
  private readonly probeTimeoutMs: number;
  private readonly concurrency: number;
  private readonly searchRoute: SearchRoute;
  private readonly readOptions: CatalogReadOptions | undefined;
  private readonly loaded = new Map<string, ToolDef[]>();
  private readonly loading = new Map<string, Promise<ToolDef[]>>();

  constructor(
    private readonly registry: RegistryView,
    readonly baseUrl: string,
    options: {
      requestScope?: object | undefined;
      probeTimeoutMs?: number | undefined;
      concurrency?: number | undefined;
      /** The discovery route recovery records name. Default `search_tools`. */
      searchRoute?: SearchRoute | undefined;
      /** Runtime-owned tail for stale-while-revalidate catalog reads. */
      defer?: DeferredWork | undefined;
    } = {},
  ) {
    this.requestScope = options.requestScope ?? {};
    this.probeTimeoutMs =
      normalizeTimeoutMs(options.probeTimeoutMs) ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.concurrency = resolveDiscoveryConcurrency(options.concurrency);
    this.searchRoute = options.searchRoute ?? "search_tools";
    this.readOptions = options.defer
      ? {
          defer: options.defer,
          refreshTimeoutMs: this.probeTimeoutMs,
        }
      : undefined;
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

  async loadConnector(
    id: string,
    callOptions: ConnectorOperationOptions = {},
  ): Promise<ToolDef[]> {
    const cached = this.loaded.get(id);
    if (cached) return cached;
    const inFlight = this.loading.get(id);
    if (inFlight) return inFlight;
    const loading = this.registry
      .getTools(
        id,
        this.baseUrl,
        this.requestScope,
        callOptions,
        this.readOptions,
      )
      .then((tools) => {
        this.loaded.set(id, tools);
        return tools;
      })
      .finally(() => {
        if (this.loading.get(id) === loading) this.loading.delete(id);
      });
    this.loading.set(id, loading);
    return loading;
  }

  private loadForDiscovery(id: string, label: string): Promise<ToolDef[]> {
    return withDeadline(
      (signal) =>
        this.loadConnector(id, {
          signal,
          timeoutMs: this.probeTimeoutMs,
        }),
      {
        timeoutMs: this.probeTimeoutMs,
        timeoutError: new Error(`${label} timed out after ${this.probeTimeoutMs}ms`),
      },
    );
  }

  private outputSchema(
    connectorId: string,
    tool: ToolDef,
  ): OutputSchemaResolution {
    if (tool.outputSchema) return { schema: tool.outputSchema };
    const observed = this.registry.observedOutputSchema(
      connectorId,
      tool,
    );
    return observed
      ? { schema: observed, source: "observed" }
      : {};
  }

  private unknownAddressFailure(address: string, query: string): CatalogResolution {
    return {
      ok: false,
      error: {
        ...framingError(
          "unknown_address",
          `Unknown address "${boundedEchoText(address)}"`,
        ),
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

  private unknownToolFailure(
    toolName: string,
    connector: Connector,
    started: number,
  ): CatalogResolution {
    return {
      ok: false,
      error: {
        ...framingError(
          "unknown_tool",
          `Unknown tool "${boundedEchoText(toolName)}" on connector "${connector.id}"`,
        ),
        nextAction: this.searchRecovery(
          { query: recoveryQuery(toolName), connector: connector.id },
          "Find the connector's current canonical tool address.",
        ),
      },
      catalogMs: Date.now() - started,
      connector,
      toolName,
    };
  }

  async resolveTool(
    address: string,
    callOptions: ConnectorOperationOptions = {},
  ): Promise<CatalogResolution> {
    const resolved = this.registry.resolveAddress(address);
    if (!resolved) {
      return this.unknownAddressFailure(address, address);
    }
    const started = Date.now();
    let tools: ToolDef[];
    try {
      tools = await this.loadConnector(resolved.connector.id, callOptions);
    } catch (cause) {
      return this.catalogLoadFailure(
        cause,
        started,
        resolved.connector,
        resolved.toolName,
      );
    }
    const definition = tools.find((tool) => tool.name === resolved.toolName);
    if (!definition) {
      return this.unknownToolFailure(
        resolved.toolName,
        resolved.connector,
        started,
      );
    }
    return {
      ok: true,
      resolved: {
        connector: resolved.connector,
        toolName: resolved.toolName,
        definition,
      },
      catalogMs: Date.now() - started,
    };
  }

  /**
   * Resolve the JavaScript-safe property used by a lazy code-mode namespace
   * back to exactly one catalog tool. Ambiguous aliases fail with an explicit
   * escape hatch instead of silently choosing the first tool.
   */
  async resolveToolAlias(
    connectorId: string,
    alias: string,
    aliasFor: (toolName: string) => string,
    callOptions: ConnectorOperationOptions = {},
  ): Promise<CatalogResolution> {
    const connector = this.registry.getConnector(connectorId);
    if (!connector) {
      return this.unknownAddressFailure(`${connectorId}.${alias}`, alias);
    }
    const started = Date.now();
    let tools: ToolDef[];
    try {
      tools = await this.loadConnector(connector.id, callOptions);
    } catch (cause) {
      return this.catalogLoadFailure(cause, started, connector, alias);
    }
    const [definition, ...collisions] = tools.filter(
      (tool) => aliasFor(tool.name) === alias,
    );
    if (!definition) {
      return this.unknownToolFailure(alias, connector, started);
    }
    if (collisions.length > 0) {
      const names = [definition, ...collisions]
        .map((tool) => `"${tool.name}"`)
        .join(", ");
      return {
        ok: false,
        error: {
          code: "ambiguous_tool_alias",
          message: `Tool alias "${boundedEchoText(alias)}" is ambiguous on connector "${connector.id}" because ${names} sanitize to the same name. Use connecta.call with an exact address.`,
          retryable: false,
          nextAction: {
            function: "connecta.call",
            addresses: [definition, ...collisions].map(
              (tool) => `${connector.id}.${tool.name}`,
            ),
            purpose:
              "Choose the intended canonical address and call it with the original arguments.",
          },
        },
        catalogMs: Date.now() - started,
        connector,
        toolName: alias,
      };
    }
    return {
      ok: true,
      resolved: {
        connector,
        toolName: definition.name,
        definition,
      },
      catalogMs: Date.now() - started,
    };
  }

  async search(args: CatalogSearchArgs): Promise<CatalogSearchPage> {
    const query = args.query ?? "";
    const retrievalQuery = lexicalSearchQuery(query);
    const safety = discoverySafety(args.safety);
    const limit = discoverySearchLimit(args.limit);
    const offset = Math.max(0, Math.trunc(args.offset ?? 0));
    const scopedConnector = args.connector
      ? this.registry.getConnector(args.connector)
      : undefined;
    const connectors = args.connector
      ? scopedConnector
        ? [scopedConnector]
        : []
      : this.registry.listConnectors();
    const catalogs = await mapSettledWithConcurrency(
      connectors,
      this.concurrency,
      (connector) =>
        // Unlike the describe path, this label never reaches a caller: search
        // only counts rejected catalogs (`unavailableCatalogs` below) and
        // renders its own guidance, so the folded name here stays internal and
        // needs no surface awareness.
        this.loadForDiscovery(
          connector.id,
          `search_tools probe of "${connector.id}"`,
        ),
    );
    const searchableCatalogs = catalogs.map((catalog) =>
      catalog.status === "fulfilled"
        ? {
            status: "fulfilled" as const,
            value: toolsForSafety(catalog.value, safety),
          }
        : catalog,
    );
    const matches: Array<{
      connector: Connector;
      tool: ToolDef;
      score: number;
      order: number;
      exactName: boolean;
      matchedTermCount: number;
      complete: boolean;
    }> = [];
    let matchMode: "all" | "partial" = "all";
    const statistics = lexicalCorpusStatistics(
      searchableCatalogs.flatMap((catalog) =>
        catalog.status === "fulfilled" ? [catalog.value] : [],
      ),
      retrievalQuery,
    );
    const trimmedQuery = query.trim();
    const isBrowse = trimmedQuery.length === 0;
    const queryTerms = lexicalQueryTerms(retrievalQuery);
    const queryTermCount = queryTerms.length;
    const unsearchableQuery = !isBrowse && queryTermCount === 0;
    const analysisTerms = unsearchableQuery ? [trimmedQuery] : queryTerms;
    const analyzedTerms = analysisTerms.slice(0, MAX_QUERY_TERMS);
    const displayTerm = (term: string) => boundedQueryTerm(term).text;
    const queryMetadataTruncated =
      analysisTerms.length > analyzedTerms.length ||
      analyzedTerms.some((term) => boundedQueryTerm(term).truncated);
    const collectMatches = (mode: "all" | "partial") => {
      const collected: typeof matches = [];
      let orderBase = 0;
      searchableCatalogs.forEach((catalog, connectorIndex) => {
        const connector = connectors[connectorIndex];
        if (!connector) {
          throw new Error("Catalog result has no corresponding connector");
        }
        if (catalog.status === "fulfilled") {
          for (const ranked of rankTools(
            catalog.value,
            retrievalQuery,
            mode,
            statistics,
            query,
          )) {
            collected.push({
              connector,
              tool: ranked.tool,
              score: ranked.score,
              order: orderBase + ranked.order,
              exactName: ranked.exactName,
              matchedTermCount: ranked.matchedTermCount,
              complete:
                isBrowse || ranked.matchedTermCount === queryTermCount,
            });
          }
        }
        orderBase +=
          catalog.status === "fulfilled" ? catalog.value.length : 1;
      });
      return collected;
    };
    // A non-empty query that normalizes to no lexical terms is not a browse.
    // Ranking an empty phrase would otherwise return every tool as an
    // unrelated zero-score match, with no coverage to explain the result.
    const rankedMatches = unsearchableQuery
      ? []
      : collectMatches(isBrowse ? "all" : "partial");
    const completeMatchCount = rankedMatches.filter(
      (match) => match.complete,
    ).length;
    matches.push(
      ...rankedMatches.filter(
        (match) =>
          match.complete ||
          completeMatchCount === 0 ||
          match.exactName ||
          match.matchedTermCount >= 2,
      ),
    );
    if (!isBrowse && !unsearchableQuery && completeMatchCount === 0) {
      matchMode = "partial";
    }
    // Complete matches and exact tool-name phrases share the first rank tier.
    // This lets a strong action/object name beat a weak description-only
    // decoy. Other partial matches fill the remaining page only after every
    // complete match, regardless of a rare-term score spike.
    matches.sort((a, b) => {
      const aFirstTier = a.complete || a.exactName;
      const bFirstTier = b.complete || b.exactName;
      return (
        Number(bFirstTier) - Number(aFirstTier) ||
        b.score - a.score ||
        a.order - b.order
      );
    });
    const pageMatches = matches.slice(offset, offset + limit);
    const withSchemas = args.includeSchemas;
    const entries = pageMatches.map((match) => {
      const output = withSchemas
        ? this.outputSchema(match.connector.id, match.tool)
        : {};
      const input = match.tool.inputSchema ?? { type: "object" };
      const renderedInput = withSchemas
        ? renderSearchSchema(input, withSchemas)
        : undefined;
      const renderedOutput =
        withSchemas && output.schema
          ? renderSearchSchema(output.schema, withSchemas)
          : undefined;
      const schemaKeys =
        withSchemas && args.includeSchemaKeys
          ? schemaKeyMetadata(input, output.schema)
          : undefined;
      const description = summarizeDiscoveryDescription(
        match.tool.description,
        args.fullDescriptions === true,
      );
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
          ...(withSchemas
            ? {
                inputSchema: renderedInput?.schema,
              }
            : {}),
          ...(renderedInput?.truncated
            ? { inputSchemaTruncated: true as const }
            : {}),
          ...(withSchemas && output.schema
            ? {
                outputSchema: renderedOutput?.schema,
              }
            : {}),
          ...(withSchemas && output.source
            ? { outputSchemaSource: output.source }
            : {}),
          ...(renderedOutput?.truncated
            ? { outputSchemaTruncated: true as const }
            : {}),
          ...(schemaKeys && !renderedInput?.truncated
            ? {
                ...(schemaKeys.inputKeys
                  ? { inputKeys: schemaKeys.inputKeys }
                  : {}),
                ...(schemaKeys.requiredInputKeys
                  ? { requiredInputKeys: schemaKeys.requiredInputKeys }
                  : {}),
              }
            : {}),
          ...(schemaKeys?.outputKeys && !renderedOutput?.truncated
            ? { outputKeys: schemaKeys.outputKeys }
            : {}),
          ...(match.tool.annotations
            ? { annotations: match.tool.annotations }
            : {}),
          ...(requiredReasons
            ? {
                guideRequired: true as const,
                guideRequiredReasons: requiredReasons,
              }
            : {}),
        },
      };
    });
    const nextOffset =
      offset + entries.length < matches.length
        ? offset + entries.length
        : undefined;
    const pageTools = new Set(pageMatches.map((match) => match.tool));
    const matchingTools = (term: string) =>
      new Set([
        ...(statistics.nameMatches.get(term) ?? []),
        ...(statistics.descriptionMatches.get(term) ?? []),
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
    const unavailableCatalogs = catalogs.filter(
      (catalog) => catalog.status === "rejected",
    ).length;
    // Named field by field rather than spread: `CallErrorDetails` also carries
    // connector, operation, recovery, and nextAction, and a discovery read is
    // not a call — widening the classifier must not silently widen what a
    // catalog search hands back.
    const scopedCatalogError = ((): CatalogFailureDetail | undefined => {
      if (!scopedConnector || catalogs[0]?.status !== "rejected") {
        return undefined;
      }
      const error = classifyCallError(
        catalogs[0].reason,
        "catalog_lookup_failed",
      );
      return {
        code: error.code,
        message: boundedEchoText(error.message),
        retryable: error.retryable,
        ...(error.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: error.retryAfterMs }),
      };
    })();
    const safetyLabel =
      safety === "readOnly"
        ? "read-only "
        : safety === "approvalRequired"
          ? "approval-required "
          : "";
    const filterRecovery =
      safety === "all" ? "" : " Change safety to inspect the other tools.";
    const scopedGuide =
      matches.length === 0 && scopedConnector && connectorGuide(scopedConnector)
        ? {
            guide: connectorSkillName(scopedConnector.id),
            guideSummary: connectorGuideSummary(scopedConnector),
            required: connectorGuideRequired(scopedConnector),
          }
        : undefined;
    // A connector's own id — the address prefix the caller already has — and
    // the title it is displayed under are the most natural first query terms,
    // and neither is a document in the lexical index. Indexing them would move
    // ranking for every query that already matches tools, so instead a search
    // that matched nothing asks the same lexical question of connector
    // identity and corrects its own sentence: the deployment plainly has this
    // capability, and one scoped browse away are its tools. Unscoped only —
    // guidance for an explicit scope already names that connector rather than
    // claiming the deployment has nothing.
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
                  (connector.title !== undefined &&
                    matchesLexicalTerm(connector.title, term)),
              ),
            )
            .map((connector) => connector.id)
        : [];
    const namedIdentityConnectors = identityConnectorIds
      .slice(0, MAX_IDENTITY_CONNECTORS)
      .map((id) => `"${id}"`)
      .join(", ");
    const unnamedIdentityConnectors =
      identityConnectorIds.length - MAX_IDENTITY_CONNECTORS;
    const identityGuidance =
      identityConnectorIds.length === 0
        ? undefined
        : `No matching ${safetyLabel}capability was found${
            unavailableCatalogs === 0 ? "" : " in the catalogs that answered"
          }, but the query names configured connector${
            identityConnectorIds.length === 1 ? "" : "s"
          } ${namedIdentityConnectors}${
            unnamedIdentityConnectors > 0
              ? ` and ${unnamedIdentityConnectors} more`
              : ""
          }. Scope by connector and browse with an empty query to list the tools there.${filterRecovery}`;
    // A scope that resolved to nothing is the same silence one step earlier in
    // the lookup: no connector resolved, so no catalog was even attempted, so
    // no catalog failed and the unavailable path below never fires. Echo only
    // the ID the caller already supplied — naming what else is configured
    // would answer a question they did not ask, past a filter they may not
    // pass.
    const unknownConnectorGuidance =
      args.connector && !scopedConnector
        ? `Connector "${args.connector}" is not configured in this deployment. Omit connector to search all configured tools.`
        : undefined;
    // Searchable queries report analysis when the scorer had to degrade. A
    // non-empty query with no searchable terms reports the bounded raw input
    // as unmatched instead of silently becoming a browse. A real browse has
    // no terms to analyse and normally reports none at all. Scope failures are
    // the exception, because an empty result alone looks like a connector that
    // correctly exposes no tools.
    const reportsQueryAnalysis =
      unsearchableQuery ||
      (queryTerms.length > 0
        ? matchMode === "partial"
        : unknownConnectorGuidance !== undefined || unavailableCatalogs > 0);
    const searchGuidance = (): string | undefined => {
      if (unknownConnectorGuidance) return unknownConnectorGuidance;
      if (unsearchableQuery) {
        return scopedConnector && unavailableCatalogs > 0
          ? `Connector "${scopedConnector.id}" could not be searched because its catalog was unavailable. Inspect catalogError for the typed reason and recovery detail.`
          : "The query contained no searchable lexical terms. Use 2–4 ASCII action/object terms, or browse with an empty query.";
      }
      if (queryTerms.length === 0) {
        if (unavailableCatalogs === 0) return undefined;
        return scopedConnector
          ? `Connector "${scopedConnector.id}" could not be browsed because its catalog was unavailable. Inspect catalogError for the typed reason and recovery detail.`
          : `${unavailableCatalogs} connector catalog${unavailableCatalogs === 1 ? " was" : "s were"} unavailable, so this browse is incomplete. Scope by connector to see the typed reason.`;
      }
      if (matches.length === 0) {
        if (scopedConnector) {
          if (unavailableCatalogs > 0) {
            return `Connector "${scopedConnector.id}" could not be searched because its catalog was unavailable. Inspect catalogError for the typed reason and recovery detail.`;
          }
          return scopedGuide?.required
            ? `No matching ${safetyLabel}capability was found on connector "${scopedConnector.id}". Fetch queryAnalysis.guide before calling, then refine terms or browse with an empty query.${filterRecovery}`
            : `No matching ${safetyLabel}capability was found on connector "${scopedConnector.id}". Refine terms or browse it with an empty query.${filterRecovery}`;
        }
        if (identityGuidance) return identityGuidance;
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
    return {
      entries,
      total: matches.length,
      offset,
      limit,
      hasMore: nextOffset !== undefined,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      ...(matchMode === "partial" && matches.length > 0
        ? { matchMode }
        : {}),
      ...(reportsQueryAnalysis
        ? {
            queryAnalysis: {
              representedTerms,
              otherResultTerms,
              unmatchedTerms,
              ...(queryMetadataTruncated
                ? { truncated: true as const }
                : {}),
              ...(args.connector ? { connectorScope: args.connector } : {}),
              ...(args.connector && !scopedConnector
                ? { unknownConnector: true as const }
                : {}),
              ...(unavailableCatalogs > 0
                ? { unavailableConnectorCount: unavailableCatalogs }
                : {}),
              ...(scopedCatalogError ? { catalogError: scopedCatalogError } : {}),
              ...(scopedGuide
                ? {
                    guide: scopedGuide.guide,
                    ...(scopedGuide.guideSummary
                      ? { guideSummary: scopedGuide.guideSummary }
                      : {}),
                    ...(scopedGuide.required
                      ? {
                          guideRequired: true as const,
                          guideRequiredReasons: [
                            "connector_required" as const,
                          ],
                        }
                      : {}),
                  }
                : {}),
              ...(guidance ? { guidance } : {}),
            },
          }
        : {}),
    };
  }

  async describe(args: CatalogDescribeArgs): Promise<CatalogDescription[]> {
    const addresses = discoveryAddresses(args);
    const format = args.format ?? "compact";
    const resolved = addresses.map((rawAddress) => {
      const address = String(rawAddress);
      return { address, resolved: this.registry.resolveAddress(address) };
    });
    const connectorIds = [
      ...new Set(
        resolved
          .map((entry) => entry.resolved?.connector.id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const loaded = await mapSettledWithConcurrency(
      connectorIds,
      this.concurrency,
      (id) =>
        this.loadForDiscovery(id, `connecta.describe probe of "${id}"`),
    );
    const catalogs = new Map<string, ToolDef[] | Error>();
    loaded.forEach((result, index) => {
      const connectorId = connectorIds[index];
      if (connectorId === undefined) {
        throw new Error("Catalog result has no corresponding connector id");
      }
      catalogs.set(
        connectorId,
        result.status === "fulfilled"
          ? result.value
          : result.reason instanceof Error
            ? result.reason
            : new Error(String(result.reason)),
      );
    });
    return resolved.map(({ address, resolved: addressResolution }) => {
      if (!addressResolution) {
        const message = `Unknown address "${boundedEchoText(address)}"`;
        return {
          address: boundedEchoText(address),
          error: message,
          errorDetails: {
            ...framingError("unknown_address", message),
            nextAction: this.searchRecovery(
              { query: recoveryQuery(address) },
              "Find the configured canonical address before retrying.",
            ),
          },
        };
      }
      const catalog = catalogs.get(addressResolution.connector.id);
      if (catalog instanceof Error) {
        const classified = classifyCallError(
          catalog,
          "catalog_lookup_failed",
        );
        const message = boundedEchoText(classified.message);
        return {
          address: boundedEchoText(address),
          error: message,
          errorDetails: {
            code: classified.code,
            message,
            retryable: classified.retryable,
            ...(classified.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: classified.retryAfterMs }),
          },
        };
      }
      const tool = catalog?.find(
        (item) => item.name === addressResolution.toolName,
      );
      if (!tool) {
        const message = `Unknown tool "${boundedEchoText(addressResolution.toolName)}" on connector "${addressResolution.connector.id}"`;
        const suggestions = describeSuggestions(
          addressResolution.connector.id,
          addressResolution.toolName,
          catalog ?? [],
        );
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
      const input = tool.inputSchema ?? { type: "object" };
      const output = this.outputSchema(addressResolution.connector.id, tool);
      const description = summarizeDescription(
        tool.description,
        args.fullDescriptions === true,
      );
      const requiredReasons = guideRequiredReasons(
        addressResolution.connector,
        tool,
        false,
      );
      const guideSummary = connectorGuideSummary(addressResolution.connector);
      return {
        address,
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
        inputSchema: renderSchema(input, format),
        ...(output.schema
          ? {
              outputSchema: renderSchema(output.schema, format),
            }
          : {}),
        ...(output.source ? { outputSchemaSource: output.source } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      };
    });
  }
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

export function groupedSearchResult(page: CatalogSearchPage) {
  const groups: Array<{
    id: string;
    title?: string;
    guide?: string;
    guideSummary?: string;
    tools: CatalogSearchEntry["tool"][];
  }> = [];
  const byConnector = new Map<string, (typeof groups)[number]>();
  for (const entry of page.entries) {
    const existing = byConnector.get(entry.connector.id);
    if (existing) {
      existing.tools.push(entry.tool);
    } else {
      const group: (typeof groups)[number] = {
        id: entry.connector.id,
        ...(entry.connector.title ? { title: entry.connector.title } : {}),
        ...(entry.guide ? { guide: entry.guide } : {}),
        ...(entry.guideSummary
          ? { guideSummary: entry.guideSummary }
          : {}),
        tools: [],
      };
      byConnector.set(entry.connector.id, group);
      groups.push(group);
      group.tools.push(entry.tool);
    }
  }
  return {
    connectors: groups,
    ...pageTail(page),
  };
}

export function flatSearchResult(page: CatalogSearchPage) {
  return {
    tools: page.entries.map((entry) => ({
      ...entry.tool,
      ...(entry.guide ? { guide: entry.guide } : {}),
      ...(entry.guideSummary
        ? { guideSummary: entry.guideSummary }
        : {}),
    })),
    ...pageTail(page),
  };
}
