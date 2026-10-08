import {
  createRequestStateCodec, inputRequired, ProtocolError, INVALID_PARAMS,
  PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY,
  type InputRequiredResult, type ServerContext,
} from "@modelcontextprotocol/server";
import type { CredentialVault } from "./credential-contract.js";
import type { ToolResult } from "./meta-tools.js";
import type { RegistryView } from "./registry.js";

const TTL_MS = 10 * 60_000;
const MAX_ROUNDS = 3;
const INPUT_KEY = "connecta_auth";
const MESSAGE = "Connect this service in your browser, then retry the request.";

interface AuthRequestState {
  version: 1;
  principal: string;
  endpoint: string;
  connector: string;
  tool: string;
  address?: string;
  digest: string;
  round: number;
  expiresAt: number;
}

/** The SDK signs a secret-free payload. The raw deployment key stays in the vault. */
export async function authRequestStateCodec(raw: Uint8Array) {
  const material = await crypto.subtle.importKey("raw", new Uint8Array(raw), "HKDF", false, ["deriveBits"]);
  const key = new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF", hash: "SHA-256",
    salt: new TextEncoder().encode("connecta:request-state:v1"),
    info: new TextEncoder().encode("auth-elicitation"),
  }, material, 256));
  return createRequestStateCodec({ key, ttlSeconds: TTL_MS / 1000 });
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidState(): never {
  throw new ProtocolError(INVALID_PARAMS, "Invalid or expired requestState", { reason: "invalid_request_state" });
}

/** JSON object order is immaterial; array order and every submitted value are bound. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => object(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

async function digest(tool: string, args: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(canonical({ tool, args }));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

function failure(code: string, message: string): ToolResult {
  const structuredContent = { ok: false, error: { code, message, retryable: false } };
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError: true };
}

/** Request-local auth recovery at the MCP boundary, never inside a guest provider. */
export class AuthElicitation {
  constructor(private readonly options: {
    vault: CredentialVault | undefined;
    publicUrl: string | undefined;
    endpoint: string;
    principal: string | undefined;
    registry: RegistryView;
    canManage: (id: string) => boolean;
    connectUrl: (id: string, force?: boolean) => Promise<string>;
    unavailable: string | undefined;
    credentialUi: boolean;
  }) {}

  /** The SDK runs this before any tool handler, including non-auth tools. */
  async verify(wire: string, context: ServerContext): Promise<AuthRequestState> {
    const { vault, endpoint, principal, registry, canManage } = this.options;
    if (!vault?.verifyRequestState || wire.length > 8192) return invalidState();
    const state = await vault.verifyRequestState(wire);
    if (!object(state) || state.version !== 1 || !principal || state.principal !== principal ||
        state.endpoint !== endpoint || typeof state.connector !== "string" ||
        !registry.getConnector(state.connector) || !canManage(state.connector) ||
        !Number.isSafeInteger(state.expiresAt) || (state.expiresAt as number) <= Date.now() ||
        (state.expiresAt as number) > Date.now() + TTL_MS ||
        !Number.isInteger(state.round) || (state.round as number) < 1 || (state.round as number) > MAX_ROUNDS ||
        !["call_tool", "call_destructive_tool", "execute_code", "authorize_connector"].includes(String(state.tool)) ||
        typeof state.digest !== "string" || !/^[a-f0-9]{64}$/.test(state.digest) ||
        (state.address !== undefined && typeof state.address !== "string")) return invalidState();
    if (context.mcpReq.method !== "tools/call" ||
        context.http?.req?.headers.get("Mcp-Name") !== state.tool) return invalidState();
    return state as unknown as AuthRequestState;
  }

  async run(
    tool: string, args: Record<string, unknown>, context: ServerContext,
    operation: () => Promise<ToolResult>,
  ): Promise<ToolResult | InputRequiredResult> {
    const previous = context.mcpReq.requestState<AuthRequestState>();
    const requestDigest = previous ? await digest(tool, args) : undefined;
    if (previous && (previous.tool !== tool || previous.digest !== requestDigest ||
        previous.address !== args.address)) return failure("invalid_request_state", "Invalid or expired requestState");
    const response = context.mcpReq.inputResponses?.[INPUT_KEY];
    if (previous && object(response)) {
      if (response.action === "decline") return failure("auth_declined", "Connection was declined. The request was not retried.");
      if (response.action === "cancel") return failure("auth_cancelled", "Connection was cancelled. The request was not retried.");
      if (response.action !== "accept") throw new ProtocolError(INVALID_PARAMS, "Invalid auth elicitation response", { reason: "invalid_input_response" });
    }
    const result = await operation();
    const error = result.structuredContent?.error;
    const authFailure = result.isError && object(error) &&
      (error.code === "auth_required" || error.code === "downstream_oauth_required");
    const explicit = tool === "authorize_connector" &&
      ["oauth", "operator_config"].includes(String(result.structuredContent?.recovery));
    const id = authFailure ? error.connector : explicit ? args.connector : undefined;
    const { registry, vault, principal, publicUrl, canManage, unavailable } = this.options;
    const connector = typeof id === "string" ? registry.getConnector(id) : undefined;
    const recoverable = connector?.startAuth || (connector?.credential && this.options.credentialUi);
    if (typeof id !== "string" || !/^[a-z0-9_-]+$/.test(id) || !recoverable ||
        !principal || !publicUrl || unavailable || !canManage(id)) return result;
    // finish() adds host-owned write counts to any failing program that sent a write.
    if (tool === "execute_code" && object(error) && error.writes !== undefined) return result;
    const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined;
    const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY];
    const elicitation = object(capabilities) ? capabilities.elicitation : undefined;
    const capable = envelope?.[PROTOCOL_VERSION_META_KEY] === "2026-07-28" &&
      object(elicitation) && Object.hasOwn(elicitation, "url") && object(elicitation.url);
    if (!capable || !vault?.mintRequestState || !vault.verifyRequestState || !vault.seal || !vault.open) {
      if (!authFailure) return result;
      const structuredContent = { ...result.structuredContent, error: {
        ...error, authorizationUrl: await this.options.connectUrl(id),
      } };
      return { ...result, structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
    }
    if (previous && previous.round >= MAX_ROUNDS) return failure("auth_round_limit", "Connection is still required after three prompts. Connect explicitly, then start a new request.");
    const state: AuthRequestState = {
      version: 1, principal, endpoint: this.options.endpoint, connector: id, tool,
      ...(typeof args.address === "string" ? { address: args.address } : {}),
      digest: requestDigest ?? await digest(tool, args),
      round: (previous?.round ?? 0) + 1,
      expiresAt: previous?.expiresAt ?? Date.now() + TTL_MS,
    };
    return inputRequired({
      inputRequests: { [INPUT_KEY]: inputRequired.elicitUrl({
        message: MESSAGE,
        url: await this.options.connectUrl(id, explicit && args.force === true),
      }) },
      requestState: await vault.mintRequestState(state),
    });
  }
}
