// Catalog intake: every tools/resources listing page is checked before the
// SDK can aggregate or cache it (INV-8), and listTools serves the result.
import { authFlow, authCall, authInvoke, authMethod } from "../../auth/native.js";
import { Client, SdkHttpError, specTypeSchemas, UnauthorizedError } from "@modelcontextprotocol/client";
import type {
  CacheableRequestOptions,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ListToolsResult,
  RequestOptions,
  StandardSchemaV1,
  Tool,
} from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { redactCatalog } from "../../sent-secrets.js";
import { MAX_CATALOG_TOOLS, MAX_SERIALIZED_CATALOG_BYTES } from "../../catalog-limits.js";
import {
  catalogClientOptions,
  catalogItems,
  observeCompletedCatalogRefresh,
  type CatalogMethod,
  type CompletedCatalogRefresh,
  type CatalogResult,
  observeCatalogFetch,
  observeCatalogExpiry,
} from "../../catalog-cache.js";
import { ConnectorCallError, msg } from "../../errors.js";
import { carryFailureFacts, failureRecord, logFailure } from "../../operator-record.js";
import { assertDownstreamOutputSafe } from "../../downstream-input-context.js";
import type { ConnectorContext, ToolDef } from "../../types.js";
import type { RemoteMcpRuntime, RemoteMcpShared } from "./runtime.js";
import type { Preread } from "./connection.js";
import { hasSdkPayload, ownAbortReason, requiresAuthorization } from "./errors.js";

/** SDK aggregation cap; intake also refuses loops and non-progress (INV-8). */
export const MAX_TOOL_PAGES = 10_000;

/**
 * Compatibility concession for hand-rolled servers that serialize
 * end-of-pagination as `null`. Only the cursor is widened; every tool and every
 * other result field still passes through the SDK's pinned schema.
 */
const CompatibleListToolsResultSchema: StandardSchemaV1<unknown, ListToolsResult> = {
  "~standard": {
    version: 1,
    vendor: "connecta",
    validate(value) {
      const normalized =
        typeof value === "object" && value !== null && "nextCursor" in value && value.nextCursor === null
          ? (() => {
              const copy = { ...value };
              delete copy.nextCursor;
              return copy;
            })()
          : value;
      return specTypeSchemas.ListToolsResult["~standard"].validate(normalized);
    },
  },
};

/**
 * True for a result-parse failure caused by the page's `nextCursor` itself.
 * `null` is accepted deliberately; other non-string values remain a named
 * downstream nonconformance instead of surfacing as a raw validation dump.
 * Duck-typed rather than `instanceof ZodError`: the SDK may parse with its own
 * zod instance, and cross-instance `instanceof` is a coin flip.
 */
function isCursorShapeError(err: unknown): boolean {
  const issues = (err as { issues?: unknown } | null)?.issues;
  if (
    Array.isArray(issues) &&
    issues.some((issue) => {
      const path = (issue as { path?: unknown }).path;
      return Array.isArray(path) && path[0] === "nextCursor";
    })
  ) {
    return true;
  }
  // SDK v2 wraps Standard Schema failures in a ProtocolError and preserves the
  // failing path in the message rather than exposing the validator's issues.
  return msg(err).startsWith("Invalid result for tools/list: nextCursor:");
}

/** One connector's catalog intake and listTools operation. */
export function remoteMcpCatalog(
  rt: RemoteMcpRuntime,
): Pick<RemoteMcpShared, "installCatalogIntake" | "listingContexts" | "liveListings" | "listToolsOperation"> {
  const { id } = rt;
  // Listings that must reach the downstream: a credential test proves the
  // stored value against the server, never against a cached catalog.
  const liveListings = new WeakSet<ConnectorContext>();

  /** Wrap the public request seam, before listTools aggregates or auto-caches.
   * SDK 2.3.1 treats an identical repeated page as completion. Refuse it here:
   * an advertised successor is never proof of a complete catalog (INV-8). */
  const listingContexts = new WeakMap<RequestOptions, ConnectorContext>();
  const installCatalogIntake = (
    client: Client,
    ctx: ConnectorContext,
    cache: Awaited<ReturnType<typeof catalogClientOptions>>,
  ): void => {
    let toolPages = 0;
    const listingContext = (options?: RequestOptions) => {
      const { signal: _signal, timeoutMs: _timeout, ...base } = ctx;
      return (
        (options && listingContexts.get(options)) ?? {
          ...base,
          requestScope: ctx.requestScope ?? ctx,
          ...(options?.signal ? { signal: options.signal } : {}),
          ...(options?.timeout ? { timeoutMs: options.timeout } : {}),
        }
      );
    };
    const listTools = client.listTools.bind(client);
    client.listTools = authMethod(
      (
        params:
          | {
              _meta?:
                | {
                    [x: string]: unknown;
                    progressToken?: string | number | undefined;
                    "io.modelcontextprotocol/related-task"?:
                      | {
                          taskId: string;
                        }
                      | undefined;
                  }
                | undefined;
              cursor?: string | undefined;
            }
          | undefined,
        options: CacheableRequestOptions | undefined,
      ) =>
        authInvoke(cache, "withListing", [
          listingContext(options),
          authMethod(() =>
            authFlow<ListToolsResult>(function* () {
              const before = toolPages;
              let result: ListToolsResult;
              try {
                result = (yield authCall(listTools, [params, options])) as ListToolsResult;
              } catch (error) {
                const bounded = rt.atMcpBoundary(cache.currentContext(), error, "tools/list", client.transport, [
                  cache.currentContext().signal,
                ]);
                const transient =
                  (error instanceof SdkHttpError && [502, 503, 504].includes(error.status)) ||
                  (bounded instanceof ConnectorCallError && bounded.code === "unavailable");
                const fallback =
                  transient && toolPages === before
                    ? ((yield authInvoke(cache, "fallbackTools", [])) as ListToolsResult | undefined)
                    : undefined;
                if (!fallback) throw error;
                return fallback;
              }
              if (toolPages !== before && params?.cursor === undefined) {
                const refresh = (yield authInvoke(cache, "completeCatalogRefresh", [result])) as
                  | CompletedCatalogRefresh
                  | undefined;
                if (refresh) {
                  try {
                    (yield authCall(observeCompletedCatalogRefresh, [cache.currentContext(), refresh])) as void;
                  } catch (error) {
                    logFailure(
                      cache.currentContext().logger,
                      "catalog refresh observation failed",
                      failureRecord({ connector: id }, error),
                    );
                  }
                }
              }
              return result;
            }),
          ),
        ]) as Effect.Effect<ListToolsResult, unknown>,
    );
    const listResources = client.listResources.bind(client);
    client.listResources = authMethod(
      (
        params:
          | {
              _meta?:
                | {
                    [x: string]: unknown;
                    progressToken?: string | number | undefined;
                    "io.modelcontextprotocol/related-task"?:
                      | {
                          taskId: string;
                        }
                      | undefined;
                  }
                | undefined;
              cursor?: string | undefined;
            }
          | undefined,
        options: CacheableRequestOptions | undefined,
      ) =>
        authInvoke(cache, "withListing", [
          listingContext(options),
          authMethod(() => authCall(listResources, [params, options]) as Effect.Effect<ListResourcesResult, unknown>),
        ]) as Effect.Effect<ListResourcesResult, unknown>,
    );
    const listResourceTemplates = client.listResourceTemplates.bind(client);
    client.listResourceTemplates = authMethod(
      (
        params:
          | {
              _meta?:
                | {
                    [x: string]: unknown;
                    progressToken?: string | number | undefined;
                    "io.modelcontextprotocol/related-task"?:
                      | {
                          taskId: string;
                        }
                      | undefined;
                  }
                | undefined;
              cursor?: string | undefined;
            }
          | undefined,
        options: CacheableRequestOptions | undefined,
      ) =>
        authInvoke(cache, "withListing", [
          listingContext(options),
          authMethod(
            () =>
              authCall(listResourceTemplates, [params, options]) as Effect.Effect<ListResourceTemplatesResult, unknown>,
          ),
        ]) as Effect.Effect<ListResourceTemplatesResult, unknown>,
    );
    const request = client.request.bind(client);
    const walks = new WeakMap<
      object,
      {
        names: Set<string>;
        cursors: Set<string>;
        barren: number;
        bytes: number;
        first?: CatalogResult & { ttlMs: number; cacheScope: "public" | "private" };
      }
    >();
    client.request = authMethod((...args: unknown[]) =>
      authFlow<any>(function* () {
        const message = args[0] as {
          method: string;
          params?: {
            cursor?: string;
          };
        };
        if (
          message.method !== "tools/list" &&
          message.method !== "resources/list" &&
          message.method !== "resources/templates/list"
        )
          return yield authCall(request, args, client);
        const method: CatalogMethod = message.method;
        const ctx = cache.currentContext();
        const options = (args.length === 3 ? args[2] : args[1]) as RequestOptions | undefined;
        if (rt.isClosed(rt.entryFor(ctx))) throw rt.scopeEndedError();
        if (options?.signal?.aborted) throw options.signal.reason;
        const key = options ?? message;
        let walk = walks.get(key);
        if (message.params?.cursor === undefined || !walk) {
          walk = { names: new Set(), cursors: new Set(), barren: 0, bytes: 0 };
          walks.set(key, walk);
        }
        let page: CatalogResult;
        try {
          page = (yield authCall(request, [
            message as Parameters<Client["request"]>[0],
            method === "tools/list"
              ? CompatibleListToolsResultSchema
              : method === "resources/list"
                ? specTypeSchemas.ListResourcesResult
                : specTypeSchemas.ListResourceTemplatesResult,
            options,
          ])) as ListToolsResult | ListResourcesResult | ListResourceTemplatesResult;
        } catch (error) {
          if (isCursorShapeError(error))
            throw new ConnectorCallError(
              "connector_call_failed",
              "Downstream catalog nextCursor must be a string, null, or absent.",
              { retryable: false },
            );
          throw error;
        }
        assertDownstreamOutputSafe(ctx.requestScope ?? ctx, page);
        const clean = cache.intake(ctx, method, page);
        if (method === "tools/list") toolPages++;
        if (message.params?.cursor === undefined) observeCatalogFetch(ctx, Date.now(), method);
        const tools = catalogItems(method, clean).filter(
          (
            item:
              | Tool
              | ListResourcesResult["resources"][number]
              | {
                  uriTemplate: string;
                  name: string;
                  description?: string | undefined;
                  mimeType?: string | undefined;
                  annotations?:
                    | {
                        audience?: ("user" | "assistant")[] | undefined;
                        priority?: number | undefined;
                        lastModified?: string | undefined;
                      }
                    | undefined;
                  _meta?:
                    | {
                        [x: string]: unknown;
                      }
                    | undefined;
                  icons?:
                    | {
                        src: string;
                        mimeType?: string | undefined;
                        sizes?: string[] | undefined;
                        theme?: "light" | "dark" | undefined;
                      }[]
                    | undefined;
                  title?: string | undefined;
                },
          ) => {
            const name =
              method === "tools/list"
                ? item.name
                : method === "resources/list"
                  ? (
                      item as {
                        uri: string;
                      }
                    ).uri
                  : (
                      item as {
                        uriTemplate: string;
                      }
                    ).uriTemplate;
            if (walk.names.has(name)) return false;
            walk.names.add(name);
            return true;
          },
        );
        walk.bytes += new TextEncoder().encode(JSON.stringify(tools)).byteLength;
        if (walk.names.size > MAX_CATALOG_TOOLS || walk.bytes > MAX_SERIALIZED_CATALOG_BYTES) {
          throw new ConnectorCallError(
            "connector_call_failed",
            "Downstream catalog exceeds the complete-catalog ceiling.",
            { retryable: false },
          );
        }
        if (clean.nextCursor !== undefined) {
          if (walk.cursors.has(clean.nextCursor))
            throw new ConnectorCallError("connector_call_failed", "Downstream catalog pagination chain loops.", {
              retryable: false,
            });
          if (tools.length === 0 && ++walk.barren > 1)
            throw new ConnectorCallError("connector_call_failed", "Downstream catalog pagination is not advancing.", {
              retryable: false,
            });
          if (tools.length > 0) walk.barren = 0;
          walk.cursors.add(clean.nextCursor);
        }
        const field =
          method === "tools/list" ? "tools" : method === "resources/list" ? "resources" : "resourceTemplates";
        const result = { ...clean, [field]: tools };
        if (!walk.first) walk.first = result;
        else {
          walk.first.ttlMs = Math.min(walk.first.ttlMs, clean.ttlMs);
          if (clean.cacheScope !== "public") walk.first.cacheScope = "private";
        }
        observeCatalogExpiry(ctx, method, walk.first.ttlMs);
        return result;
      }),
    ) as Client["request"];
  };

  // The SDK walks the whole chain and writes one complete result. Intake
  // runs on its public request seam before any page can enter that cache.
  const listToolsOperation = authMethod((ctx: ConnectorContext) =>
    authFlow<ToolDef[]>(function* () {
      const state = rt.stateFor(ctx);
      // Without a connection in this scope, a complete cached catalog is
      // served as it stands. A live connection reads the same cache through
      // the SDK, and a credential test always lists live.
      const cached =
        state.client || state.connecting || state.authRequired || liveListings.has(ctx)
          ? {}
          : ((yield authCall(rt.cachedCatalog, [ctx])) as Preread & { tools?: Tool[] });
      let clean: ListToolsResult["tools"];
      if (cached.tools) clean = redactCatalog(ctx, cached.tools);
      else {
        const client = (yield authCall(rt.ensureConnected, [ctx, state, cached])) as Client;
        // A credential test must observe the downstream answer itself, never
        // the SDK cache a modern connection reads without any request.
        const options: CacheableRequestOptions = {
          ...rt.requestOptions(ctx),
          ...(liveListings.has(ctx) ? { cacheMode: "bypass" as const } : {}),
        };
        listingContexts.set(options, ctx);
        try {
          const result = (yield authInvoke(client, "listTools", [undefined, options])) as ListToolsResult;
          clean = redactCatalog(ctx, result.tools);
        } catch (err) {
          if (ownAbortReason(err, [ctx.signal]) && !hasSdkPayload(err)) throw err;
          const bounded = rt.atMcpBoundary(ctx, err, "tools/list", client.transport, [ctx.signal]);
          if (requiresAuthorization(bounded)) {
            if (state.client === client) state.authRequired = true;
            if (bounded instanceof UnauthorizedError) throw carryFailureFacts(bounded, rt.authRequiredError(ctx));
          }
          throw bounded;
        } finally {
          listingContexts.delete(options);
        }
      }
      state.toolDefinitions = new Map(clean.map((tool: Tool) => [tool.name, tool]));
      return clean.map((t: Tool) => ({
        name: t.name,
        ...(t.title !== undefined ? { title: t.title } : {}),
        ...(t.icons !== undefined
          ? {
              icons: t.icons.filter((icon) => !/^data:/i.test(icon.src)) as NonNullable<ToolDef["icons"]>,
            }
          : {}),
        ...(t.execution !== undefined ? { execution: t.execution as NonNullable<ToolDef["execution"]> } : {}),
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.inputSchema !== undefined
          ? {
              inputSchema: t.inputSchema as NonNullable<ToolDef["inputSchema"]>,
            }
          : {}),
        ...(t.outputSchema !== undefined
          ? {
              outputSchema: t.outputSchema as NonNullable<ToolDef["outputSchema"]>,
            }
          : {}),
        ...(t.annotations !== undefined
          ? {
              annotations: t.annotations as NonNullable<ToolDef["annotations"]>,
            }
          : {}),
      }));
    }),
  );
  return { installCatalogIntake, listingContexts, liveListings, listToolsOperation };
}
