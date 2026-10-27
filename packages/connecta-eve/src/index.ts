import {
  defineDynamic as defineDynamicConnection,
  defineMcpClientConnection,
  type DynamicContext,
  type McpClientConnectionDefinition,
} from "eve/connections";
import { defineDynamic, defineInstructions } from "eve/instructions";
import { never, type Approval, type ApprovalPolicy } from "eve/tools/approval";

/** Where an Eve agent reaches Connecta and how it proves who it is. */
export interface ConnectaEndpointOptions {
  /**
   * The deployment's base URL, or a full endpoint URL when `pool` is absent.
   * Defaults to the `CONNECTA_URL` environment variable.
   */
  url?: string;
  /** The agent's pool; the endpoint is `<url>/agent/<pool>`. */
  pool?: string;
  /**
   * The agent's bearer token, resolved on every request so a rotation needs
   * no restart. Defaults to the `CONNECTA_ACCESS_TOKEN` environment variable.
   */
  getToken?: () => string | Promise<string>;
}

/** App-owned pool policy; use `ctx.memo` when its result should stay fixed. */
export type ConnectaPoolSelector = (ctx: DynamicContext) => string | Promise<string>;

export interface ConnectaConnectionOptions extends Omit<ConnectaEndpointOptions, "pool"> {
  /** A fixed pool, or a policy Eve evaluates before every model call. */
  pool?: string | ConnectaPoolSelector;
  /** What the connection offers, for the model choosing which connection to search. */
  description: string;
  /** Eve's approval for every Connecta tool: a policy or configuration. Defaults to `never()`. */
  approval?: Approval;
  /**
   * Ask a person before every tool not annotated read-only: each write tool
   * on a native endpoint, and `execute_code` on a writable one. Ignored when
   * `approval` is set.
   */
  gateWrites?: boolean;
}

export interface ConnectaInstructionsOptions extends Omit<ConnectaEndpointOptions, "pool"> {
  /** A fixed pool, or the same policy used by the connection. */
  pool?: string | ConnectaPoolSelector;
  /** MCP client name for instruction requests. Default `connecta-eve-instructions`. */
  clientName?: string;
  /** How long fetched instructions are reused. Default ten minutes. */
  ttlMs?: number;
  /** Fetch implementation, for tests. */
  fetch?: typeof fetch;
}

function environment(name: string): string | undefined {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
  return value?.trim() || undefined;
}

function validatePool(pool: string): void {
  if (typeof pool !== "string" || !/^[a-z0-9_-]+$/.test(pool)) {
    throw new Error(`Connecta pool "${pool}" must match [a-z0-9_-]+.`);
  }
}

/** The endpoint URL these options name. */
export function connectaEndpoint(options: ConnectaEndpointOptions = {}): string {
  const url = options.url ?? environment("CONNECTA_URL");
  if (!url) throw new Error("Connecta needs a url, or CONNECTA_URL in the environment.");
  if (options.pool === undefined) return url;
  validatePool(options.pool);
  return `${url.replace(/\/+$/, "")}/agent/${options.pool}`;
}

async function tokenFor(options: Pick<ConnectaEndpointOptions, "getToken">): Promise<string> {
  const token = options.getToken ? (await options.getToken()).trim() : environment("CONNECTA_ACCESS_TOKEN");
  if (!token) throw new Error("Connecta needs an agent token: getToken, or CONNECTA_ACCESS_TOKEN in the environment.");
  return token;
}

/**
 * Approve reads and ask a person about everything else, keyed on the
 * annotations Connecta derives from its own classification.
 */
export const gateConnectaWrites: ApprovalPolicy = ({ toolAnnotations }) =>
  toolAnnotations?.readOnlyHint === true ? "not-applicable" : "user-approval";

/**
 * The Eve connection for a Connecta agent endpoint, with app-owned auth:
 * one agent token, sent as a bearer and re-read on every request.
 */
export function connectaConnection(
  options: ConnectaConnectionOptions & { pool: ConnectaPoolSelector },
): ReturnType<typeof defineDynamicConnection>;
export function connectaConnection(
  options: ConnectaConnectionOptions & { pool?: string },
): McpClientConnectionDefinition;
export function connectaConnection(
  options: ConnectaConnectionOptions,
): McpClientConnectionDefinition | ReturnType<typeof defineDynamicConnection>;
export function connectaConnection(options: ConnectaConnectionOptions) {
  const { pool, ...rest } = options;
  if (typeof pool === "function") {
    return defineDynamicConnection(async (ctx) => {
      const selected = await pool(ctx);
      validatePool(selected);
      return connectionDefinition({ ...rest, pool: selected }, selected);
    });
  }
  return connectionDefinition(pool === undefined ? rest : { ...rest, pool });
}

function connectionDefinition(
  options: ConnectaConnectionOptions & { pool?: string },
  instanceKey?: string,
): McpClientConnectionDefinition {
  return defineMcpClientConnection({
    url: connectaEndpoint(options),
    ...(instanceKey === undefined ? {} : { instanceKey }),
    description: options.description,
    auth: {
      principalType: "app",
      getToken: async () => ({ token: await tokenFor(options) }),
    },
    approval: options.approval ?? (options.gateWrites ? gateConnectaWrites : never()),
  });
}

/** Connecta's MCP `instructions` for one endpoint, or null when unavailable. */
async function instructionRequest(
  options: ConnectaInstructionsOptions,
  endpoint: string,
  method: "server/discover" | "initialize",
  signal: AbortSignal,
) {
  const modern = method === "server/discover";
  const clientInfo = { name: options.clientName ?? "connecta-eve-instructions", version: "1" };
  const response = await (options.fetch ?? fetch)(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await tokenFor(options)}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(modern ? { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: modern
        ? {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": clientInfo,
            },
          }
        : {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo,
          },
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  if (!response.ok) return null;
  const text = await response.text();
  // Streamable HTTP answers as JSON or as one SSE `data:` event.
  const json = text.trimStart().startsWith("{")
    ? text
    : text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice("data:".length);
  if (!json) return null;
  const instructions = (JSON.parse(json) as { result?: { instructions?: unknown } }).result?.instructions;
  return typeof instructions === "string" && instructions.trim() ? instructions.trim() : null;
}

async function fetchConnectaInstructions(
  options: ConnectaInstructionsOptions,
  endpoint: string,
  signal: AbortSignal,
): Promise<string | null> {
  // Only a completed discovery response can justify legacy negotiation.
  // Network failures and timeouts propagate to the resolver's fail-open path.
  const discovered = await instructionRequest(options, endpoint, "server/discover", signal);
  return discovered ?? instructionRequest(options, endpoint, "initialize", signal);
}

/**
 * Connecta's instructions as Eve system instructions, refreshed once per turn.
 * Eve does not pass an MCP server's `instructions` to the model, so this
 * fetches them and caches each success; a failure keeps the last copy, or adds
 * nothing, and the tools still work. Eve evaluates the resolver before every
 * model call; a memo keyed on the endpoint and turn keeps one result for each.
 * Pool policy runs independently of the connection and owns its memo lifetime.
 */
export function connectaInstructions(options: ConnectaInstructionsOptions = {}) {
  const ttlMs = options.ttlMs ?? 600_000;
  const endpoints = new Map<string, { cached?: { at: number; content: string }; retryAfter: number }>();
  const current = async (endpoint: string, signal: AbortSignal): Promise<string | null> => {
    signal.throwIfAborted();
    let state = endpoints.get(endpoint);
    if (!state) endpoints.set(endpoint, (state = { retryAfter: 0 }));
    const { cached, retryAfter } = state;
    if (cached && Date.now() - cached.at <= ttlMs) return cached.content;
    if (Date.now() < retryAfter) return cached?.content ?? null;
    let fresh: string | null;
    try {
      fresh = await fetchConnectaInstructions(options, endpoint, signal);
    } catch {
      // Eve's cancellation is not an endpoint failure: rethrowing keeps it out
      // of the memo and the backoff, which every session of this resolver shares.
      signal.throwIfAborted();
      fresh = null;
    }
    if (fresh) state.cached = { at: Date.now(), content: fresh };
    state.retryAfter = fresh ? 0 : Date.now() + 30_000;
    return fresh ?? cached?.content ?? null;
  };
  return defineDynamic(async (ctx) => {
    const { pool, ...rest } = options;
    let endpoint: string;
    if (typeof pool === "function") {
      const selected = await pool(ctx);
      validatePool(selected);
      endpoint = connectaEndpoint({ ...rest, pool: selected });
    } else {
      // Static configuration errors have always omitted optional guidance.
      try {
        endpoint = connectaEndpoint(pool === undefined ? rest : { ...rest, pool });
      } catch {
        return null;
      }
    }
    const content = await ctx.memo(["connecta-instructions", endpoint, ctx.turn?.id ?? null], ({ abortSignal }) =>
      current(endpoint, abortSignal),
    );
    return content ? defineInstructions({ content: `Connecta guidance:\n${content}` }) : null;
  });
}
