import { defineDynamic as defineDynamicSkill, defineSkill } from "eve/skills";
import {
  defineDynamic as defineDynamicConnection,
  defineMcpClientConnection,
  type DynamicContext,
  type McpClientConnectionDefinition,
} from "eve/connections";
import { defineDynamic, defineInstructions } from "eve/instructions";
import { never, type Approval, type ApprovalPolicy } from "eve/tools/approval";
import { CONNECTA_VERSION } from "./version.js";

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
  /**
   * Extra request headers, such as a service token for an edge in front of
   * Connecta. A function is resolved on every request. These never replace
   * the helper's bearer or MCP protocol headers on guidance requests.
   */
  headers?: ConnectaHeaders;
}

/** Fixed headers, or a resolver called on every request. */
export type ConnectaHeaders =
  | Readonly<Record<string, string>>
  | (() => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>);

/** App-owned pool policy; use `ctx.memo` when its result should stay fixed. */
export type ConnectaPoolSelector = (ctx: DynamicContext) => string | Promise<string>;

/** App-owned caller/turn policy, evaluated before selecting a pool or fetching guidance. */
export type ConnectaPredicate = (ctx: DynamicContext) => boolean | Promise<boolean>;

export interface ConnectaConnectionOptions extends Omit<ConnectaEndpointOptions, "pool"> {
  /** A fixed pool, or a policy Eve evaluates before every model call. */
  pool?: string | ConnectaPoolSelector;
  /** Omit this value when false or when the policy throws. Evaluated every model call. */
  when?: ConnectaPredicate;
  /**
   * What the connection offers, in Eve's catalog listing and in the words every
   * tool of this connection matches in `eve__search`. Defaults to a fixed
   * neutral line. Describe the domain in prose; do not list connectors or
   * operations here, because a query naming one then matches every tool.
   */
  description?: string;
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
  /** Omit this value when false or when the policy throws. Evaluated every model call. */
  when?: ConnectaPredicate;
  /**
   * The Eve connection's name, which is its file under `agent/connections/`.
   * The model calls `<connection>__<tool>`. Default `connecta`.
   */
  connection?: string;
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
  options: ConnectaConnectionOptions & { when: ConnectaPredicate },
): ReturnType<typeof defineDynamicConnection>;
export function connectaConnection(
  options: ConnectaConnectionOptions & { pool: ConnectaPoolSelector },
): ReturnType<typeof defineDynamicConnection>;
export function connectaConnection(
  options: ConnectaConnectionOptions & { pool?: string; when?: undefined },
): McpClientConnectionDefinition;
export function connectaConnection(
  options: ConnectaConnectionOptions,
): McpClientConnectionDefinition | ReturnType<typeof defineDynamicConnection>;
export function connectaConnection(options: ConnectaConnectionOptions) {
  warnOnGenericDescription(options.description);
  const { pool, ...rest } = options;
  if (typeof pool === "function" || options.when) {
    return defineDynamicConnection(async (ctx) => {
      if (!(await enabled(options.when, ctx))) return null;
      // Only a static `pool` may be omitted; connectaEndpoint validates it. A
      // selector must name a valid pool, or the turn fails instead of using the base URL.
      let selected = pool as string | undefined;
      if (typeof pool === "function") {
        selected = await pool(ctx);
        validatePool(selected);
      }
      return connectionDefinition(
        options,
        connectaEndpoint({ ...rest, ...(selected === undefined ? {} : { pool: selected }) }),
        selected,
      );
    });
  }
  return connectionDefinition(options, connectaEndpoint(pool === undefined ? rest : { ...rest, pool }));
}

/**
 * Eve matches these words against every search query, and a short word also
 * matches longer query words ("use" hits "users"), so this avoids common stems.
 */
const DEFAULT_DESCRIPTION = "Connecta integration gateway.";
/** "Company tools through Connecta" and other strings any Connecta connection could claim. */
const GENERIC_DESCRIPTION =
  /\b(?:tools?|services?|integrations?|apps?)\s+(?:through|via|from|using|on|in|with)\s+connecta\b|^\W*(?:(?:the|our|all|my|company|connecta|mcp|tools?|services?|integrations?|connections?|gateway|server|access|through|via|using)\W*)*$/i;

function warnOnGenericDescription(description: string | undefined): void {
  if (description === undefined || !GENERIC_DESCRIPTION.test(description)) return;
  console.warn(
    `[connecta-eve] Connection description ${JSON.stringify(description)} gives the model no domain information. Omit it, or say what this agent reaches in prose without listing connectors.`,
  );
}

function connectionDefinition(
  options: ConnectaConnectionOptions,
  endpoint: string,
  instanceKey?: string,
): McpClientConnectionDefinition {
  const { headers } = options;
  return defineMcpClientConnection({
    url: endpoint,
    ...(instanceKey === undefined ? {} : { instanceKey }),
    description: options.description ?? DEFAULT_DESCRIPTION,
    ...(headers === undefined ? {} : { headers: typeof headers === "function" ? () => headers() : headers }),
    auth: {
      principalType: "app",
      getToken: async () => ({ token: await tokenFor(options) }),
    },
    approval: options.approval ?? (options.gateWrites ? gateConnectaWrites : never()),
  });
}

async function enabled(when: ConnectaPredicate | undefined, ctx: DynamicContext): Promise<boolean> {
  try {
    return when ? (await when(ctx)) === true : true;
  } catch {
    return false;
  }
}

/** The neutral endpoint facts Connecta advertises in `capabilities.extensions`. */
interface EndpointFacts {
  surface: "meta" | "native";
  executeCode: boolean;
  connectors: { id: string; title?: string; readFirst?: string }[];
}

/** Older servers omit the extension; anything malformed reads the same way. */
function endpointFacts(value: unknown): EndpointFacts | undefined {
  const facts = value as Partial<EndpointFacts> | null | undefined;
  if (facts?.surface !== "meta" && facts?.surface !== "native") return undefined;
  if (typeof facts.executeCode !== "boolean" || !Array.isArray(facts.connectors)) return undefined;
  const text = (field: unknown) => (typeof field === "string" ? field.replace(/\s+/g, " ").trim() : "");
  return {
    surface: facts.surface,
    executeCode: facts.executeCode,
    connectors: facts.connectors.flatMap((connector) => {
      const id = text(connector?.id);
      if (!id) return [];
      const title = text(connector.title);
      const readFirst = text(connector.readFirst);
      return [{ id, ...(title ? { title } : {}), ...(readFirst ? { readFirst } : {}) }];
    }),
  };
}

const ROSTER_MAX_BYTES = 512;

/** Detail degrades before names do, as the server's own inventory does. */
function connectorRoster(facts: EndpointFacts, prefix: string): string {
  const fits = (line: string) => new TextEncoder().encode(line).length <= ROSTER_MAX_BYTES;
  const entry = ({ id, title, readFirst }: EndpointFacts["connectors"][number], withTitle: boolean) => {
    const notes = [
      ...(withTitle && title ? [title] : []),
      // A native tool's description already carries its guide pointer.
      ...(readFirst && facts.surface === "meta" ? [`read first: ${prefix}skills { name: "${readFirst}" }`] : []),
    ];
    return notes.length ? `${id} (${notes.join("; ")})` : id;
  };
  for (const withTitle of [true, false]) {
    const line = facts.connectors.map((connector) => entry(connector, withTitle)).join(", ");
    if (fits(line)) return line;
  }
  const entries = facts.connectors.map((connector) => entry(connector, false));
  let shown = 0;
  while (fits(`${entries.slice(0, shown + 1).join(", ")}; +${entries.length - shown - 1} more`)) shown++;
  return `${entries.slice(0, shown).join(", ")}${shown ? "; " : ""}+${entries.length - shown} more`;
}

/**
 * How Eve's deferred catalog reaches this endpoint's tools. Connecta's own text
 * names tools as MCP lists them; Eve adds the connection prefix and hides them
 * behind `eve__tool`, and its search covers listed tools only.
 */
function eveGuide(connection: string, facts: EndpointFacts | undefined): string {
  const prefix = `${connection}__`;
  if (!facts) {
    return `Connecta tools are deferred: call eve__tool({ name: "${prefix}<tool>", input }). Names in this guidance and in nextAction omit the "${prefix}" prefix.`;
  }
  const roster = facts.connectors.length ? connectorRoster(facts, prefix) : undefined;
  if (facts.surface === "meta") {
    return `Connecta tools are deferred: call eve__tool({ name: "${prefix}<tool>", input }). Names in this guidance and in nextAction omit the "${prefix}" prefix. Go straight to ${prefix}execute_code without eve__search, input { code: "async () => { const { tools } = await connecta.search({ query: 'list invoices', safety: 'readOnly' }); const r = await connecta.call(tools[0].address, {}); return r.data; }" }. eve__search sees only Connecta's routing tools, never downstream operations, so empty results do not mean a capability is missing; search inside the program.${roster ? ` Reachable: ${roster}.` : ""}`;
  }
  return `Connecta tools are deferred: call eve__tool({ name: "${prefix}<connector>__<tool>", input }). Find them with eve__search; scope one connector with "${prefix}<connector>__", not "<connector>__". Names in this guidance and in nextAction omit "${prefix}".${facts.executeCode ? ` For several, dependent or reduced calls, go straight to ${prefix}execute_code with { code: "async () => { ... }" }, using the program address ending each tool's description.` : ""} Missing tools: ${prefix}authorize_connector. Tool lists refresh every step, so no reconnect is needed.${roster ? ` Connectors: ${roster}.` : ""}`;
}

/** Release lines a helper and server must share; a patch difference is compatible. */
const releaseLine = (version: unknown) =>
  typeof version === "string" ? /^(\d+\.\d+)\./.exec(version)?.[1] : undefined;

/** An endpoint may embed credentials or a token in its URL; logs get only its origin and path. */
function loggableEndpoint(endpoint: string): string {
  try {
    const { origin, pathname } = new URL(endpoint);
    return `${origin}${pathname}`;
  } catch {
    return "the configured endpoint";
  }
}

/** A deployment that renamed its server may version it independently, so only `connecta` is compared. */
function warnOnVersionSkew(endpoint: string, server: { name?: unknown; version?: unknown } | undefined): void {
  if (server?.name !== "connecta") return;
  const line = releaseLine(server.version);
  if (line === undefined || line === releaseLine(CONNECTA_VERSION)) return;
  // The version is remote text, so only its validated numeric line reaches logs.
  console.warn(
    `[connecta-eve] Helper ${CONNECTA_VERSION} and Connecta ${line}.x at ${loggableEndpoint(endpoint)} are different releases. Install the helper matching your server.`,
  );
}

/** Headers for a guidance request. The caller's extras can never replace what the request itself needs. */
async function guidanceHeaders(options: Pick<ConnectaEndpointOptions, "headers">, own: Record<string, string>) {
  const extra = typeof options.headers === "function" ? await options.headers() : options.headers;
  const headers = new Headers(extra);
  for (const [name, value] of Object.entries(own)) headers.set(name, value);
  return Object.fromEntries(headers);
}

interface EndpointGuidance {
  instructions: string;
  facts: EndpointFacts | undefined;
  server: { name?: unknown; version?: unknown } | undefined;
}

/** Connecta's MCP `instructions` and endpoint facts for one endpoint, or null when unavailable. */
async function instructionRequest(
  options: ConnectaInstructionsOptions,
  endpoint: string,
  method: "server/discover" | "initialize",
  signal: AbortSignal,
): Promise<EndpointGuidance | null> {
  const modern = method === "server/discover";
  const clientInfo = { name: options.clientName ?? "connecta-eve-instructions", version: "1" };
  const response = await (options.fetch ?? fetch)(endpoint, {
    method: "POST",
    headers: await guidanceHeaders(options, {
      Authorization: `Bearer ${await tokenFor(options)}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(modern ? { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method } : {}),
    }),
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
  const { result } = JSON.parse(json) as {
    result?: {
      instructions?: unknown;
      capabilities?: { extensions?: Record<string, unknown> };
      serverInfo?: EndpointGuidance["server"];
      _meta?: Record<string, unknown>;
    };
  };
  const instructions = result?.instructions;
  if (typeof instructions !== "string" || !instructions.trim()) return null;
  return {
    instructions: instructions.trim(),
    facts: endpointFacts(result?.capabilities?.extensions?.["dev.connecta/endpoint"]),
    server: (result?._meta?.["io.modelcontextprotocol/serverInfo"] as EndpointGuidance["server"]) ?? result?.serverInfo,
  };
}

async function fetchConnectaInstructions(
  options: ConnectaInstructionsOptions,
  endpoint: string,
  signal: AbortSignal,
): Promise<EndpointGuidance | null> {
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
  const connection = options.connection ?? "connecta";
  if (!/^[A-Za-z0-9._-]+$/.test(connection)) {
    throw new Error(`Connecta connection "${connection}" must be the file name under agent/connections.`);
  }
  const endpoints = new Map<
    string,
    { cached?: { at: number; content: string }; retryAfter: number; versionChecked?: boolean }
  >();
  const current = async (endpoint: string, signal: AbortSignal): Promise<string | null> => {
    signal.throwIfAborted();
    let state = endpoints.get(endpoint);
    if (!state) endpoints.set(endpoint, (state = { retryAfter: 0 }));
    const { cached, retryAfter } = state;
    if (cached && Date.now() - cached.at <= ttlMs) return cached.content;
    if (Date.now() < retryAfter) return cached?.content ?? null;
    let fresh: string | null;
    try {
      const guidance = await fetchConnectaInstructions(options, endpoint, signal);
      if (guidance && !state.versionChecked) {
        state.versionChecked = true;
        warnOnVersionSkew(endpoint, guidance.server);
      }
      // Eve's half comes first: it says how to read every name in Connecta's own text.
      fresh = guidance && `${eveGuide(connection, guidance.facts)}\n${guidance.instructions}`;
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
    if (!(await enabled(options.when, ctx))) return null;
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

/** One explicitly selected Connecta guide projected as a deferred Eve skill. */
export interface ConnectaSkillOptions extends Omit<ConnectaInstructionsOptions, "connection"> {
  /** Exact skills-tool name, for example `connector:crm`. */
  name: string;
  /** Short task selector Eve can search without loading the guide. */
  description: string;
}

/**
 * Opt-in deferred instructions, installed from an agent/skills module.
 * Resolves only after caller policy, with no tools added by loading the skill.
 * Eve's public API takes content, not a load callback: fetching is per turn;
 * only model-context inclusion is lazy.
 */
export function connectaSkill(options: ConnectaSkillOptions) {
  if (!options.name.trim() || !options.description.trim()) throw new Error("A skill needs a name and description.");
  return defineDynamicSkill(async (ctx) => {
    if (!(await enabled(options.when, ctx))) return null;
    const { pool, ...endpointOptions } = options;
    const selected = typeof pool === "function" ? await pool(ctx) : pool;
    if (typeof options.pool === "function") validatePool(selected!);
    const endpoint = connectaEndpoint({ ...endpointOptions, ...(selected === undefined ? {} : { pool: selected }) });
    const content = await ctx.memo(
      ["connecta-skill", endpoint, options.name, ctx.turn?.id ?? null],
      async ({ abortSignal }) => {
        try {
          const response = await (options.fetch ?? fetch)(endpoint, {
            method: "POST",
            headers: await guidanceHeaders(options, {
              Authorization: `Bearer ${await tokenFor(options)}`,
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "MCP-Protocol-Version": "2026-07-28",
              "Mcp-Method": "tools/call",
              "Mcp-Name": "skills",
            }),
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "skills",
                arguments: { name: options.name },
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                  "io.modelcontextprotocol/clientCapabilities": {},
                },
              },
            }),
            signal: AbortSignal.any([abortSignal, AbortSignal.timeout(5_000)]),
          });
          if (!response.ok) return null;
          const text = await response.text();
          const json = text.trimStart().startsWith("{")
            ? text
            : text
                .split("\n")
                .find((line) => line.startsWith("data:"))
                ?.slice(5);
          if (!json) return null;
          const reply = JSON.parse(json) as {
            result?: { isError?: boolean; content?: { type: string; text?: string }[] };
          };
          if (!reply.result || reply.result.isError) return null;
          return (
            reply.result.content
              ?.filter((block) => block.type === "text")
              .map((block) => block.text ?? "")
              .join("\n") || null
          );
        } catch {
          // Endpoint failures omit optional guidance; turn cancellation still propagates.
          abortSignal.throwIfAborted();
          return null;
        }
      },
    );
    return content ? defineSkill({ description: options.description, content, deferred: true }) : null;
  });
}
