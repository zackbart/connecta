import {
  compactSchema,
  lexicalCorpusStatistics,
  lexicalSearchQuery,
  rankTools,
  summarizeDescription,
} from "./catalog.js";
import {
  mapSettledWithConcurrency,
  resolveDiscoveryConcurrency,
} from "./concurrency.js";
import { classifyCallError, messageLooksRetryable } from "./errors.js";
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
import type {
  Connector,
  JsonSchema,
  ToolDef,
} from "./types.js";

export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 100;
export const MAX_DESCRIBE_ADDRESSES = 100;
export const MAX_DISCOVERY_RESULT_BYTES = 256_000;

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

/** Validate the raw list so duplicate addresses consume the same bound. */
function discoveryAddresses(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new DiscoveryPolicyError(
      "invalid_args",
      "addresses must be an array.",
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
  limit?: number;
  offset?: number;
  fullDescriptions?: boolean;
  includeSchemas?: "compact" | "json";
  /** Code-mode helper metadata; never exposed by the public search_tools schema. */
  includeSchemaKeys?: boolean;
}

export interface CatalogDescribeArgs {
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
    inputKeys?: string[];
    requiredInputKeys?: string[];
    outputKeys?: string[];
    annotations?: ToolDef["annotations"];
  };
}

function schemaPropertyKeys(schema: JsonSchema | undefined): string[] {
  if (
    !schema ||
    schema.properties === null ||
    Array.isArray(schema.properties) ||
    typeof schema.properties !== "object"
  ) {
    return [];
  }
  return Object.keys(schema.properties as Record<string, unknown>);
}

function schemaRequiredKeys(schema: JsonSchema | undefined): string[] {
  return Array.isArray(schema?.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
}

export interface CatalogSearchPage {
  entries: CatalogSearchEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset?: number;
  matchMode?: "partial";
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

function framingError(code: string, message: string): CallErrorDetails {
  return { code, message, retryable: messageLooksRetryable(message) };
}

function renderSchema(schema: JsonSchema, format: "compact" | "json"): unknown {
  return format === "json" ? schema : compactSchema(schema);
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
    const limit = discoverySearchLimit(args.limit);
    const offset = Math.max(0, Math.trunc(args.offset ?? 0));
    const connectors = args.connector
      ? [this.registry.getConnector(args.connector)].filter(
          (connector): connector is Connector => Boolean(connector),
        )
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
    const matches: Array<{
      connector: Connector;
      tool: ToolDef;
      score: number;
      order: number;
    }> = [];
    let matchMode: "all" | "partial" = "all";
    const statistics = lexicalCorpusStatistics(
      catalogs.flatMap((catalog) =>
        catalog.status === "fulfilled" ? [catalog.value] : [],
      ),
      retrievalQuery,
    );
    const collectMatches = (mode: "all" | "partial") => {
      matches.length = 0;
      let orderBase = 0;
      catalogs.forEach((catalog, connectorIndex) => {
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
    const entries = matches.slice(offset, offset + limit).map((match) => {
      const input = match.tool.inputSchema ?? { type: "object" };
      const description = summarizeDescription(
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
                inputSchema:
                  renderSchema(input, args.includeSchemas),
              }
            : {}),
          ...(args.includeSchemas && match.tool.outputSchema
            ? {
                outputSchema:
                  renderSchema(match.tool.outputSchema, args.includeSchemas),
              }
            : {}),
          ...(args.includeSchemas && args.includeSchemaKeys
            ? {
                inputKeys: schemaPropertyKeys(input),
                requiredInputKeys: schemaRequiredKeys(input),
                ...(match.tool.outputSchema
                  ? { outputKeys: schemaPropertyKeys(match.tool.outputSchema) }
                  : {}),
              }
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
    };
  }

  async describe(args: CatalogDescribeArgs): Promise<CatalogDescription[]> {
    const addresses = discoveryAddresses(args.addresses);
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
    description?: string;
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
        ...(entry.connector.description !== undefined
          ? { description: entry.connector.description }
          : {}),
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
  };
}

export function flatSearchResult(page: CatalogSearchPage) {
  return {
    tools: page.entries.map((entry) => entry.tool),
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    hasMore: page.hasMore,
    ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
    ...(page.matchMode ? { matchMode: page.matchMode } : {}),
  };
}
