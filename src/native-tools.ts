// The native tool surface (#703): a pool with `surface: "native"`
// lists each downstream tool directly, for clients that run their own tool
// search, instead of the six meta-tools. This layer resolves tool identity; a
// native call is translated into the exact call_tool or call_destructive_tool
// call and runs through the same handler, so classification, read-only
// refusal, validation, admission, redaction, write settlement and result
// bounds stay in invocation. See documentation/meta-tools.md#native-tool-surface.

import {
  ProtocolError,
  type McpServer,
  type ServerContext,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { withAuthorizationHandoff } from "./authorization-handoff.js";
import { classifyCallError, type CallErrorDetails } from "./errors.js";
import { nativeRecovery } from "./native-recovery.js";
import { CatalogService } from "./catalog-service.js";
import { jsonResult } from "./meta-tools.js";
import { failureRecord, logFailure } from "./operator-record.js";
import type { RegistryView } from "./registry.js";
import type { DeferredWork } from "./connector-scope.js";
import type { Connector, JsonSchema, Logger, ToolDef } from "./types.js";

/**
 * Longest native name. A client prefixes its own connection name, and common
 * tool-name limits are 64 characters: Eve's `connecta__` and Claude Code's
 * `mcp__connecta__` both fit beside 48.
 */
export const NATIVE_NAME_MAX = 48;

/** One page, no cursor: Eve 0.83 reads only the first `tools/list` page. */
const MAX_NATIVE_TOOLS = 1_000;

/** Native `tools/list` cache hint. Shorter than the meta surface's hour: the list follows downstream catalogs. */
export const NATIVE_TOOLS_LIST_TTL_MS = 300_000;

const HASH_CHARS = 6;
const SEPARATOR = "__";
/** No `__`, no leading `_`: the last `__` of a plain name is then always its separator. */
const PLAIN_TOOL = /^[A-Za-z0-9-](?:[A-Za-z0-9-]|_(?!_))*$/;
const NATIVE_NAME = new RegExp(`^[A-Za-z][A-Za-z0-9_-]{0,${NATIVE_NAME_MAX - 1}}$`);

/** Connecta's own tools on a native endpoint. Their names never contain `__`. */
const NATIVE_OWN_TOOLS: readonly string[] = ["execute_code", "skills", "read_result"];

const enc = new TextEncoder();

async function shortHash(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return [...digest.subarray(0, HASH_CHARS / 2)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The connector half of a native name. Connector ids are `[a-z0-9_-]+`; one
 * that does not start with a letter gets an uppercase `C`, which no connector
 * id can contain, so the prefix never collides with another id.
 */
function connectorPart(connectorId: string): string {
  return /^[a-z]/.test(connectorId) ? connectorId : `C${connectorId}`;
}

/**
 * A pure function of the connector id and downstream tool name, so it is
 * stable across catalog refreshes: `<connector>__<tool>` when that is exact,
 * legal and short, otherwise its head plus a six-hex SHA-256 suffix of the
 * original pair.
 */
export async function nativeToolName(connectorId: string, toolName: string): Promise<string> {
  const tool = toolName.replace(/[^A-Za-z0-9_-]/g, "_");
  const plain = `${connectorPart(connectorId)}${SEPARATOR}${tool}`;
  if (tool === toolName && PLAIN_TOOL.test(tool) && plain.length <= NATIVE_NAME_MAX) return plain;
  const head = plain.slice(0, NATIVE_NAME_MAX - HASH_CHARS - 1).replace(/_+$/, "");
  return `${head}_${await shortHash(`${connectorId}.${toolName}`)}`;
}

/** A listed native tool and the downstream tool it calls. */
export interface NativeTool {
  name: string;
  connector: Connector;
  tool: ToolDef;
}

/** Read or write, from the served classification only. */
function annotationsFor(tool: ToolDef) {
  return tool.classification === "read"
    ? { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    : { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
}

/** Object arguments retain every applicable constraint, including local refs. */
function nativeInputSchema(schema: JsonSchema): Record<string, unknown> | undefined {
  function supportsObject(value: unknown, seen = new Set<unknown>()): boolean {
    if (value === true) return true;
    if (!value || typeof value !== "object" || Array.isArray(value) || seen.has(value)) return false;
    const node = value as JsonSchema;
    const next = new Set(seen).add(value);
    if (
      node.type !== undefined &&
      node.type !== "object" &&
      !(Array.isArray(node.type) && node.type.includes("object"))
    )
      return false;
    if (node.$ref !== undefined) {
      if (typeof node.$ref !== "string" || !node.$ref.startsWith("#/")) return false;
      let target: unknown = schema;
      for (const part of node.$ref.slice(2).split("/")) {
        if (!target || typeof target !== "object") return false;
        target = (target as JsonSchema)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      }
      if (!supportsObject(target, next)) return false;
    }
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const branches = node[key];
      if (
        Array.isArray(branches) &&
        !(key === "allOf"
          ? branches.every((branch) => supportsObject(branch, next))
          : branches.some((branch) => supportsObject(branch, next)))
      )
        return false;
    }
    return true;
  }
  if (!supportsObject(schema)) return undefined;
  return schema.type === "object" ? schema : { ...schema, type: "object" };
}

/**
 * The downstream input schema, advertised verbatim. Validation accepts
 * anything: invocation validates against the same catalog definition and
 * returns its structured `invalid_args` with repair, as call_tool does.
 */
function passThroughSchema(schema: JsonSchema | undefined): StandardSchemaWithJSON {
  // Listing has already excluded connectors with unrepresentable schemas.
  const json = schema === undefined ? { type: "object" } : nativeInputSchema(schema)!;
  return {
    "~standard": {
      version: 1,
      vendor: "connecta",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => json, output: () => json },
    },
  } as StandardSchemaWithJSON;
}

function describe(entry: NativeTool, executeCode: boolean): string {
  const lines = [entry.tool.description?.trim() || entry.tool.title || entry.tool.name];
  if (executeCode) lines.push(`Program address: ${entry.connector.id}.${entry.tool.name}`);
  return lines.join("\n\n");
}

/** Run a call on one of the two existing routes. Supplied by registerMetaTools. */
export type NativeCallRoute = (
  route: "call_tool" | "call_destructive_tool",
  call: { address: string; args: Record<string, unknown> },
  request: ServerContext,
) => Promise<unknown>;

export interface NativeSurfaceOptions {
  baseUrl: string;
  executeCode: boolean;
  route: NativeCallRoute;
  bind: (request: ServerContext) => void;
  catalogErrors: string[];
  logger: Logger;
  requestScope: object;
  requestSignal?: AbortSignal | undefined;
  probeTimeoutMs?: number | undefined;
  discoveryConcurrency?: number | undefined;
  readOnly?: boolean | undefined;
  defer?: DeferredWork | undefined;
}

/** What this request will ask of the native surface, read before the server exists. */
export type NativeRequestHint = { method: "tools/list" } | { method: "tools/call"; name: string } | { method: "other" };

export class NativeSurface {
  private readonly catalog: CatalogService;

  constructor(
    private readonly registry: RegistryView,
    private readonly options: NativeSurfaceOptions,
  ) {
    this.catalog = new CatalogService(registry, options.baseUrl, {
      requestScope: options.requestScope,
      requestSignal: options.requestSignal,
      probeTimeoutMs: options.probeTimeoutMs,
      concurrency: options.discoveryConcurrency,
      // Listing omits a read-only endpoint's writes, as search does.
      readOnly: options.readOnly,
      defer: options.defer,
    });
  }

  /**
   * Every listable native tool. A connector whose catalog fails is omitted
   * whole, never partially, with an operator warning; two tools claiming one
   * name are both omitted and stay reachable by address in execute_code.
   */
  private async claims(connectors = this.registry.listConnectors()) {
    const loaded = await this.catalog.listCatalogs(true, connectors);
    const byName = new Map<string, NativeTool | null>();
    for (const entry of loaded) {
      if (!("tools" in entry)) continue;
      for (const tool of entry.tools) {
        const name = await nativeToolName(entry.connector.id, tool.name);
        if (byName.has(name)) {
          byName.set(name, null);
          logFailure(
            this.options.logger,
            "native name collision",
            failureRecord({ connector: entry.connector.id, tool }),
          );
        } else byName.set(name, { name, connector: entry.connector, tool });
      }
    }
    return { loaded, byName };
  }

  private async list(): Promise<NativeTool[]> {
    const { loaded, byName } = await this.claims();
    for (const entry of loaded) {
      // Validate the whole connector before registering any of its tools.
      const tool =
        "tools" in entry
          ? entry.tools.find((tool) => tool.inputSchema !== undefined && !nativeInputSchema(tool.inputSchema))
          : undefined;
      if (!("error" in entry) && !tool) continue;
      this.options.catalogErrors.push(entry.connector.id);
      logFailure(
        this.options.logger,
        "native catalog unavailable",
        failureRecord(
          { connector: entry.connector.id, ...(tool ? { tool } : {}) },
          "error" in entry ? entry.error : undefined,
        ),
      );
    }
    return [...byName.values()].filter(
      (entry): entry is NativeTool =>
        entry !== null &&
        !this.options.catalogErrors.includes(entry.connector.id) &&
        (!(this.options.readOnly || entry.connector.readOnly) || entry.tool.classification === "read"),
    );
  }

  /**
   * The downstream tool behind a native name, from the catalogs whose
   * connector prefix the name could carry, including truncated prefixes. Resolution sees
   * writes on a read-only endpoint, so invocation refuses them by code.
   */
  private async resolve(
    name: string,
  ): Promise<
    | { kind: "found"; entry: NativeTool }
    | { kind: "ambiguous" }
    | { kind: "missing"; failure?: { connector: Connector; cause: unknown } }
  > {
    const prefixed = this.registry.listConnectors().filter((connector) => {
      const prefix = `${connectorPart(connector.id)}${SEPARATOR}`;
      // A hashed name can truncate even the connector prefix, and strips
      // trailing underscores from its head. Include every possible claimant.
      const head = prefix.slice(0, NATIVE_NAME_MAX - HASH_CHARS - 1).replace(/_+$/, "");
      // A hashed name carries a stripped head only as exactly `${head}_` + six hex digits.
      return (
        name.startsWith(prefix) ||
        (name.length === head.length + 1 + HASH_CHARS &&
          name.startsWith(`${head}_`) &&
          /^[0-9a-f]+$/.test(name.slice(-HASH_CHARS)))
      );
    });
    const { loaded, byName } = await this.claims(prefixed);
    const found = byName.get(name);
    if (found === null) return { kind: "ambiguous" };
    // An unavailable possible claimant cannot prove uniqueness.
    for (const entry of loaded)
      if ("error" in entry) return { kind: "missing", failure: { connector: entry.connector, cause: entry.error } };
    return found ? { kind: "found", entry: found } : { kind: "missing" };
  }

  /** A native call: the existing route its current verdict selects. */
  private async call(name: string, args: Record<string, unknown>, request: ServerContext): Promise<unknown> {
    this.options.bind(request);
    const target = await this.resolve(name);
    if (target.kind !== "found") {
      const failure = target.kind === "missing" ? target.failure : undefined;
      const error: CallErrorDetails = failure
        ? {
            ...classifyCallError(failure.cause, "catalog_lookup_failed"),
            connector: failure.connector.id,
            message: `Connector "${failure.connector.id}" catalog lookup failed.`,
          }
        : {
            code: "unknown_tool",
            message:
              target.kind === "ambiguous"
                ? `Ambiguous native name "${name}". Ask the operator to rename a claimant.`
                : `Unknown native tool "${name}".`,
            retryable: false,
          };
      if (failure && (error.code === "auth_required" || error.code === "downstream_oauth_required")) {
        error.nextAction = {
          tool: "authorize_connector",
          arguments: { connector: failure.connector.id },
          operatorHandoff: "Give the returned handoff to the operator.",
        };
      }
      const result = jsonResult({ ok: false, error: await withAuthorizationHandoff(this.options.requestScope, error) });
      result.isError = true;
      return result;
    }
    const address = `${target.entry.connector.id}.${target.entry.tool.name}`;
    return this.options.route(
      target.entry.tool.classification === "read" ? "call_tool" : "call_destructive_tool",
      { address, args },
      request,
    );
  }

  private registerTool(server: McpServer, name: string, entry?: NativeTool): void {
    server.registerTool(
      name,
      {
        ...(entry?.tool.title ? { title: entry.tool.title } : {}),
        ...(entry ? { description: describe(entry, this.options.executeCode) } : {}),
        inputSchema: passThroughSchema(entry?.tool.inputSchema),
        ...(entry ? { annotations: annotationsFor(entry.tool) } : {}),
        ...(entry ? { _meta: { "dev.connecta/address": `${entry.connector.id}.${entry.tool.name}` } } : {}),
      },
      (async (args: Record<string, unknown>, request: ServerContext) =>
        nativeRecovery(await this.call(name, args ?? {}, request), this.options.executeCode, name)) as never,
    );
  }

  /**
   * Register what this request needs before the SDK dispatches it: the whole
   * listing for `tools/list`, the one called name for `tools/call` (resolved
   * when it runs, so a catalog failure comes back as Connecta's structured
   * error rather than "tool not found"), nothing otherwise.
   */
  async register(server: McpServer, hint: NativeRequestHint): Promise<void> {
    if (hint.method === "tools/call") {
      if (NATIVE_NAME.test(hint.name) && !NATIVE_OWN_TOOLS.includes(hint.name)) this.registerTool(server, hint.name);
      return;
    }
    if (hint.method !== "tools/list") return;
    const tools = await this.list();
    if (tools.length > MAX_NATIVE_TOOLS) {
      logFailure(
        this.options.logger,
        "native tools/list refused a pool over the 1,000-tool native cap",
        failureRecord({}),
      );
      server.server.setRequestHandler("tools/list", () => {
        throw new ProtocolError(
          -32603,
          `This endpoint has ${tools.length} tools, over the ${MAX_NATIVE_TOOLS}-tool native listing cap. Ask the operator to narrow the pool or use the meta surface.`,
        );
      });
      return;
    }
    for (const entry of tools) this.registerTool(server, entry.name, entry);
  }
}

/** Read the method and tool name a request carries, for {@link NativeSurface.register}. */
export async function nativeRequestHint(request: Request, modern: boolean): Promise<NativeRequestHint> {
  let method: unknown;
  let name: unknown;
  if (modern) {
    // The SDK checked both headers against the body before calling the factory.
    method = request.headers.get("Mcp-Method")?.trim();
    const header = request.headers.get("Mcp-Name")?.trim();
    const encoded = header && /^=\?base64\?(.*)\?=$/.exec(header);
    try {
      name = encoded ? new TextDecoder().decode(Uint8Array.from(atob(encoded[1]!), (c) => c.charCodeAt(0))) : header;
    } catch {
      name = undefined;
    }
  } else {
    try {
      const body = (await request.clone().json()) as { method?: unknown; params?: { name?: unknown } };
      method = body?.method;
      name = body?.params?.name;
    } catch {
      return { method: "other" };
    }
  }
  if (method === "tools/list") return { method };
  if (method === "tools/call" && typeof name === "string") return { method, name };
  return { method: "other" };
}
