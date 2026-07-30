import {
  compactDiscoverySchema,
  compactSchema,
  lexicalCorpusStatistics,
  lexicalQueryTerms,
  lexicalSearchQuery,
  rankTools,
  schemaObjectKeys,
  summarizeDiscoveryDescription,
  summarizeDescription,
} from "./catalog.js";
import {
  mapSettledWithConcurrency,
  resolveDiscoveryConcurrency,
} from "./concurrency.js";
import { classifyCallError, framingError } from "./errors.js";
import type { CallErrorDetails } from "./errors.js";
import type {
  ConnectorOperationOptions,
  RegistryView,
} from "./registry.js";
import {
  connectorGuide,
  connectorSkillName,
} from "./skills.js";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  normalizeTimeoutMs,
  withAbortableTimeout,
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
const MAX_QUERY_ANALYSIS_TERMS = 8;
const MAX_QUERY_ANALYSIS_TERM_LENGTH = 64;

const encoder = new TextEncoder();

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
      `addresses must contain at most ${MAX_DESCRIBE_ADDRESSES} entries. Split a larger list across describe_tools calls.`,
    );
  }
  return value;
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
  tool: {
    name: string;
    address: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    inputSchemaTruncated?: true;
    outputSchemaTruncated?: true;
    inputKeys?: string[];
    requiredInputKeys?: string[];
    outputKeys?: string[];
    annotations?: ToolDef["annotations"];
  };
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
    ...(outputKeys ? { outputKeys: outputKeys.properties } : {}),
  };
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
    guidance?: string;
  };
}

export interface CatalogDescription {
  address: string;
  name?: string;
  description?: string;
  guide?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: ToolDef["annotations"];
  error?: string;
}

export interface ResolvedCatalogTool {
  connector: Connector;
  toolName: string;
  definition: ToolDef;
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
  private readonly loaded = new Map<string, ToolDef[]>();
  private readonly loading = new Map<string, Promise<ToolDef[]>>();

  constructor(
    private readonly registry: RegistryView,
    readonly baseUrl: string,
    options: {
      requestScope?: object;
      probeTimeoutMs?: number;
      concurrency?: number;
    } = {},
  ) {
    this.requestScope = options.requestScope ?? {};
    this.probeTimeoutMs =
      normalizeTimeoutMs(options.probeTimeoutMs) ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.concurrency = resolveDiscoveryConcurrency(options.concurrency);
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
      .getTools(id, this.baseUrl, this.requestScope, callOptions)
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
    return withAbortableTimeout(
      (signal) =>
        this.loadConnector(id, {
          signal,
          timeoutMs: this.probeTimeoutMs,
        }),
      this.probeTimeoutMs,
      label,
    );
  }

  async resolveTool(
    address: string,
    callOptions: ConnectorOperationOptions = {},
  ): Promise<CatalogResolution> {
    const resolved = this.registry.resolveAddress(address);
    if (!resolved) {
      return {
        ok: false,
        error: framingError(
          "unknown_address",
          `Unknown address "${address}"`,
        ),
        catalogMs: 0,
      };
    }
    const started = Date.now();
    let tools: ToolDef[];
    try {
      tools = await this.loadConnector(resolved.connector.id, callOptions);
    } catch (cause) {
      return {
        ok: false,
        error: classifyCallError(cause, "catalog_lookup_failed"),
        catalogMs: Date.now() - started,
        connector: resolved.connector,
        toolName: resolved.toolName,
        cause,
      };
    }
    const definition = tools.find((tool) => tool.name === resolved.toolName);
    if (!definition) {
      return {
        ok: false,
        error: framingError(
          "unknown_tool",
          `Unknown tool "${resolved.toolName}" on connector "${resolved.connector.id}"`,
        ),
        catalogMs: Date.now() - started,
        connector: resolved.connector,
        toolName: resolved.toolName,
      };
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
      return {
        ok: false,
        error: framingError(
          "unknown_address",
          `Unknown address "${connectorId}.${alias}"`,
        ),
        catalogMs: 0,
      };
    }
    const started = Date.now();
    let tools: ToolDef[];
    try {
      tools = await this.loadConnector(connector.id, callOptions);
    } catch (cause) {
      return {
        ok: false,
        error: classifyCallError(cause, "catalog_lookup_failed"),
        catalogMs: Date.now() - started,
        connector,
        toolName: alias,
        cause,
      };
    }
    const [definition, ...collisions] = tools.filter(
      (tool) => aliasFor(tool.name) === alias,
    );
    if (!definition) {
      return {
        ok: false,
        error: framingError(
          "unknown_tool",
          `Unknown tool "${alias}" on connector "${connector.id}"`,
        ),
        catalogMs: Date.now() - started,
        connector,
        toolName: alias,
      };
    }
    if (collisions.length > 0) {
      const names = [definition, ...collisions]
        .map((tool) => `"${tool.name}"`)
        .join(", ");
      return {
        ok: false,
        error: {
          code: "ambiguous_tool_alias",
          message: `Tool alias "${alias}" is ambiguous on connector "${connector.id}" because ${names} sanitize to the same name. Use connecta.call with an exact address.`,
          retryable: false,
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
    }> = [];
    let matchMode: "all" | "partial" = "all";
    const statistics = lexicalCorpusStatistics(
      searchableCatalogs.flatMap((catalog) =>
        catalog.status === "fulfilled" ? [catalog.value] : [],
      ),
      retrievalQuery,
    );
    const collectMatches = (mode: "all" | "partial") => {
      matches.length = 0;
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
          )) {
            matches.push({
              connector,
              tool: ranked.tool,
              score: ranked.score,
              order: orderBase + ranked.order,
            });
          }
        }
        orderBase +=
          catalog.status === "fulfilled" ? catalog.value.length : 1;
      });
    };
    collectMatches("all");
    if (query.trim() && matches.length === 0) {
      matchMode = "partial";
      collectMatches(matchMode);
    }
    matches.sort((a, b) => b.score - a.score || a.order - b.order);
    const pageMatches = matches.slice(offset, offset + limit);
    const entries = pageMatches.map((match) => {
      const input = match.tool.inputSchema ?? { type: "object" };
      const renderedInput = args.includeSchemas
        ? renderSearchSchema(input, args.includeSchemas)
        : undefined;
      const renderedOutput =
        args.includeSchemas && match.tool.outputSchema
          ? renderSearchSchema(match.tool.outputSchema, args.includeSchemas)
          : undefined;
      const schemaKeys =
        args.includeSchemas && args.includeSchemaKeys
          ? schemaKeyMetadata(input, match.tool.outputSchema)
          : undefined;
      const description = summarizeDiscoveryDescription(
        match.tool.description,
        args.fullDescriptions === true,
      );
      return {
        connector: match.connector,
        ...(connectorGuide(match.connector)
          ? { guide: connectorSkillName(match.connector.id) }
          : {}),
        tool: {
          name: match.tool.name,
          address: `${match.connector.id}.${match.tool.name}`,
          ...(description !== undefined ? { description } : {}),
          ...(args.includeSchemas
            ? {
                inputSchema: renderedInput?.schema,
              }
            : {}),
          ...(renderedInput?.truncated
            ? { inputSchemaTruncated: true as const }
            : {}),
          ...(args.includeSchemas && match.tool.outputSchema
            ? {
                outputSchema: renderedOutput?.schema,
              }
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
        },
      };
    });
    const nextOffset =
      offset + entries.length < matches.length
        ? offset + entries.length
        : undefined;
    const queryTerms = lexicalQueryTerms(retrievalQuery);
    const analyzedTerms = queryTerms.slice(0, MAX_QUERY_ANALYSIS_TERMS);
    const displayTerm = (term: string) =>
      term.length <= MAX_QUERY_ANALYSIS_TERM_LENGTH
        ? term
        : `${term.slice(0, MAX_QUERY_ANALYSIS_TERM_LENGTH - 1)}…`;
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
    const safetyLabel =
      safety === "readOnly"
        ? "read-only "
        : safety === "approvalRequired"
          ? "approval-required "
          : "";
    const filterRecovery =
      safety === "all" ? "" : " Change safety to inspect the other tools.";
    const guidance =
      queryTerms.length === 0
        ? undefined
        : matches.length === 0
          ? args.connector && !scopedConnector
            ? `Connector "${args.connector}" is not configured in this deployment. Omit connector to search all configured tools.`
            : scopedConnector
              ? unavailableCatalogs > 0
                ? `Connector "${scopedConnector.id}" could not be searched because its catalog was unavailable. Retry later.`
                : `No matching ${safetyLabel}capability was found on connector "${scopedConnector.id}". Refine terms or browse it with an empty query.${filterRecovery}`
              : unavailableCatalogs === 0
                ? `No matching ${safetyLabel}capability is configured in this deployment. Refine terms, scope by connector, or browse with an empty query.${filterRecovery}`
                : `No matching ${safetyLabel}capability was found in the catalogs that answered; ${unavailableCatalogs} connector catalog${unavailableCatalogs === 1 ? " was" : "s were"} unavailable. Refine terms, scope by connector, or browse with an empty query.${filterRecovery}`
          : matchMode === "partial"
            ? scopedConnector
              ? `No single tool on connector "${scopedConnector.id}" matched every term. Split distinct intents into separate searches.`
              : unavailableCatalogs === 0
              ? "No single tool matched every term. Split distinct intents into separate searches."
              : "No single tool matched every term in the catalogs that answered. Split distinct intents into separate searches."
            : undefined;
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
      ...(queryTerms.length > 0 && matchMode === "partial"
        ? {
            queryAnalysis: {
              representedTerms,
              otherResultTerms,
              unmatchedTerms,
              ...(queryTerms.length > analyzedTerms.length ||
              analyzedTerms.some(
                (term) => term.length > MAX_QUERY_ANALYSIS_TERM_LENGTH,
              )
                ? { truncated: true as const }
                : {}),
              ...(args.connector ? { connectorScope: args.connector } : {}),
              ...(args.connector && !scopedConnector
                ? { unknownConnector: true as const }
                : {}),
              ...(unavailableCatalogs > 0
                ? { unavailableConnectorCount: unavailableCatalogs }
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
        this.loadForDiscovery(id, `describe_tools probe of "${id}"`),
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
        return { address, error: `Unknown address "${address}"` };
      }
      const catalog = catalogs.get(addressResolution.connector.id);
      if (catalog instanceof Error) {
        return { address, error: catalog.message };
      }
      const tool = catalog?.find(
        (item) => item.name === addressResolution.toolName,
      );
      if (!tool) {
        return {
          address,
          error: `Unknown tool "${addressResolution.toolName}" on connector "${addressResolution.connector.id}"`,
        };
      }
      const input = tool.inputSchema ?? { type: "object" };
      const description = summarizeDescription(
        tool.description,
        args.fullDescriptions === true,
      );
      return {
        address,
        name: tool.name,
        ...(description !== undefined ? { description } : {}),
        ...(connectorGuide(addressResolution.connector)
          ? { guide: connectorSkillName(addressResolution.connector.id) }
          : {}),
        inputSchema: renderSchema(input, format),
        ...(tool.outputSchema
          ? {
              outputSchema: renderSchema(tool.outputSchema, format),
            }
          : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      };
    });
  }
}

export function groupedSearchResult(page: CatalogSearchPage) {
  const groups: Array<{
    id: string;
    title?: string;
    guide?: string;
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
        tools: [],
      };
      byConnector.set(entry.connector.id, group);
      groups.push(group);
      group.tools.push(entry.tool);
    }
  }
  return {
    connectors: groups,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    hasMore: page.hasMore,
    ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
    ...(page.matchMode ? { matchMode: page.matchMode } : {}),
    ...(page.queryAnalysis ? { queryAnalysis: page.queryAnalysis } : {}),
  };
}

export function flatSearchResult(page: CatalogSearchPage) {
  return {
    tools: page.entries.map((entry) => ({
      ...entry.tool,
      ...(entry.guide ? { guide: entry.guide } : {}),
    })),
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    hasMore: page.hasMore,
    ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
    ...(page.matchMode ? { matchMode: page.matchMode } : {}),
    ...(page.queryAnalysis ? { queryAnalysis: page.queryAnalysis } : {}),
  };
}
