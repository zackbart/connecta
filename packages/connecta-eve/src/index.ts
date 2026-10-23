import { defineMcpClientConnection, type McpClientConnectionDefinition } from "eve/connections";
import { defineDynamic, defineInstructions } from "eve/instructions";
import { never, type ApprovalPolicy } from "eve/tools/approval";

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

export interface ConnectaConnectionOptions extends ConnectaEndpointOptions {
  /** What the connection offers, for the model choosing which connection to search. */
  description: string;
  /** Eve's approval policy for every Connecta tool. Defaults to `never()`. */
  approval?: ApprovalPolicy;
  /**
   * Ask a person before every tool not annotated read-only: each write tool
   * on a native endpoint, and `execute_code` on a writable one. Ignored when
   * `approval` is set.
   */
  gateWrites?: boolean;
}

export interface ConnectaInstructionsOptions extends ConnectaEndpointOptions {
  /** How long fetched instructions are reused. Default ten minutes. */
  ttlMs?: number;
  /** Fetch implementation, for tests. */
  fetch?: typeof fetch;
}

function environment(name: string): string | undefined {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
  return value?.trim() || undefined;
}

/** The endpoint URL these options name. */
export function connectaEndpoint(options: ConnectaEndpointOptions = {}): string {
  const url = options.url ?? environment("CONNECTA_URL");
  if (!url) throw new Error("Connecta needs a url, or CONNECTA_URL in the environment.");
  if (options.pool === undefined) return url;
  if (!/^[a-z0-9_-]+$/.test(options.pool)) throw new Error(`Connecta pool "${options.pool}" must match [a-z0-9_-]+.`);
  return `${url.replace(/\/+$/, "")}/agent/${options.pool}`;
}

async function tokenFor(options: ConnectaEndpointOptions): Promise<string> {
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
export function connectaConnection(options: ConnectaConnectionOptions): McpClientConnectionDefinition {
  return defineMcpClientConnection({
    url: connectaEndpoint(options),
    description: options.description,
    auth: {
      credentialOwner: "app",
      getToken: async () => ({ token: await tokenFor(options) }),
    },
    approval: options.approval ?? (options.gateWrites ? gateConnectaWrites : never()),
  });
}

/** Connecta's MCP `instructions` for one endpoint, or null when unavailable. */
async function instructionRequest(options: ConnectaInstructionsOptions, method: "server/discover" | "initialize") {
  const modern = method === "server/discover";
  const response = await (options.fetch ?? fetch)(connectaEndpoint(options), {
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
              "io.modelcontextprotocol/clientInfo": { name: "connecta-eve-instructions", version: "1" },
            },
          }
        : {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "connecta-eve-instructions", version: "1" },
          },
    }),
    signal: AbortSignal.timeout(5_000),
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

async function fetchConnectaInstructions(options: ConnectaInstructionsOptions): Promise<string | null> {
  // Only a completed discovery response can justify legacy negotiation.
  // Network failures and timeouts propagate to the resolver's fail-open path.
  const discovered = await instructionRequest(options, "server/discover");
  return discovered ?? instructionRequest(options, "initialize");
}

/**
 * Connecta's instructions as Eve system instructions, refreshed at turn start.
 * Eve does not pass an MCP server's `instructions` to the model, so this
 * fetches them and caches each success; a failure keeps the last copy, or adds
 * nothing, and the tools still work.
 */
export function connectaInstructions(options: ConnectaInstructionsOptions = {}) {
  const ttlMs = options.ttlMs ?? 600_000;
  let cached: { at: number; content: string } | undefined;
  let retryAfter = 0;
  const current = async (): Promise<string | null> => {
    if (cached && Date.now() - cached.at <= ttlMs) return cached.content;
    if (Date.now() < retryAfter) return cached?.content ?? null;
    const fresh = await fetchConnectaInstructions(options).catch(() => null);
    if (fresh) cached = { at: Date.now(), content: fresh };
    retryAfter = fresh ? 0 : Date.now() + 30_000;
    return fresh ?? cached?.content ?? null;
  };
  return defineDynamic({
    events: {
      "turn.started": async () => {
        const content = await current();
        return content ? defineInstructions({ content: `Connecta guidance:\n${content}` }) : null;
      },
    },
  });
}
