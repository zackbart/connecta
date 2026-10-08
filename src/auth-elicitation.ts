import {
  createRequestStateCodec, inputRequired, ProtocolError, INVALID_PARAMS,
  PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY,
  type InputRequiredResult, type RequestStateCodec, type ServerContext,
} from "@modelcontextprotocol/server";
import type { CredentialVault } from "./credential-contract.js";
import type { ToolResult } from "./meta-tools.js";
import type { RegistryView } from "./registry.js";
import { Effect } from "effect";
import { runEdge, withDeadlineEffect } from "./runtime/run.js";
import { closeScope } from "./runtime/connector-scope.js";
import type { DeferredWork } from "./connector-scope.js";
import { storedCredentialShape } from "./credential-rules.js";
import { authRecoveryFacts, bindReplayReads, classificationDigest, type ReplayRead } from "./invocation-auth.js";
import { CatalogService } from "./catalog-service.js";
import { DownstreamElicitation, MAX_RELAY_STATE_CHARS, type DownstreamRequestState, type SealedDownstreamState } from "./downstream-input.js";
import { canonicalState as canonical, requestDigest as digest, stateObject as object, invalidRequestState as invalidState, REQUEST_STATE_TTL_MS as TTL_MS, MAX_INPUT_ROUNDS as MAX_ROUNDS } from "./request-state.js";

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
  browserNonces: string[];
  reads: ReplayRead[];
}

function failure(code: "invalid_request_state" | "auth_declined" | "auth_cancelled" | "auth_round_limit", message: string): ToolResult {
  const structuredContent = { ok: false, error: { code, message, retryable: false } };
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError: true };
}

/** Request-local auth recovery at the MCP boundary, never inside a guest provider. */
export class AuthElicitation {
  private codec: Promise<RequestStateCodec<AuthRequestState | SealedDownstreamState>> | undefined;
  private readonly downstream: DownstreamElicitation;

  private stateCodec(): Promise<RequestStateCodec<AuthRequestState | SealedDownstreamState>> {
    const key = this.options.vault?.requestStateKey;
    if (!key) return invalidState();
    return this.codec ??= key.call(this.options.vault).then(bytes => createRequestStateCodec<AuthRequestState | SealedDownstreamState>({
      key: bytes, ttlSeconds: TTL_MS / 1000,
      bind: () => canonical({ principal: this.options.principal, endpoint: this.options.endpoint }),
    }));
  }

  constructor(private readonly options: {
    vault: CredentialVault | undefined;
    publicUrl: string | undefined;
    endpoint: string;
    principal: string | undefined;
    registry: RegistryView;
    canManage: (id: string) => boolean;
    connectLink: (id: string, force?: boolean, after?: string) => Promise<{ url: string; nonce: string }>;
    linkProgress: (id: string, nonce: string) => Promise<"claimed" | "started" | "failed" | undefined>;
    closeLinks: (id: string, nonces: string[]) => Promise<void>;
    claimRetry: (id: string, nonce: string) => Promise<boolean>;
    unavailable: string | undefined;
    credentialUi: boolean;
    requestSignal: AbortSignal;
    requestScope: object;
    defer: DeferredWork | undefined;
  }) {
    this.downstream = new DownstreamElicitation({ ...options,
      mint: async (state, context) => (await this.stateCodec()).mint(state, context),
    });
  }

  /** The SDK runs this before any tool handler, including non-auth tools. */
  async verify(wire: string, context: ServerContext): Promise<AuthRequestState | DownstreamRequestState> {
    const { vault, endpoint, principal, registry, canManage } = this.options;
    if (!vault?.requestStateKey || wire.length > MAX_RELAY_STATE_CHARS) return invalidState();
    const state: unknown = await (await this.stateCodec()).verify(wire, context);
    if (object(state) && state.version === 2 && state.kind === "downstream") return this.downstream.verify(state, context);
    if (wire.length > 8192) return invalidState();
    if (!object(state) || state.version !== 1 || !principal || state.principal !== principal ||
        state.endpoint !== endpoint || typeof state.connector !== "string" ||
        !registry.getConnector(state.connector) || !canManage(state.connector) ||
        !Number.isSafeInteger(state.expiresAt) || (state.expiresAt as number) <= Date.now() ||
        (state.expiresAt as number) > Date.now() + TTL_MS ||
        !Number.isInteger(state.round) || (state.round as number) < 1 || (state.round as number) > MAX_ROUNDS ||
        !["call_tool", "call_destructive_tool", "execute_code", "authorize_connector"].includes(String(state.tool)) ||
        typeof state.digest !== "string" || !/^[a-f0-9]{64}$/.test(state.digest) ||
        !Array.isArray(state.browserNonces) || state.browserNonces.length !== state.round ||
        !state.browserNonces.every(nonce => typeof nonce === "string" && /^[a-f0-9-]{36}$/.test(nonce)) ||
        !Array.isArray(state.reads) || !state.reads.every(read => object(read) &&
          typeof read.address === "string" && typeof read.digest === "string" && /^[a-f0-9]{64}$/.test(read.digest)) ||
        (state.address !== undefined && typeof state.address !== "string")) return invalidState();
    if (context.mcpReq.method !== "tools/call" ||
        context.http?.req?.headers.get("Mcp-Name") !== state.tool) return invalidState();
    return state as unknown as AuthRequestState;
  }

  private async browserProgress(state: AuthRequestState): Promise<{ predecessor?: string; completed: boolean }> {
    let started: string | undefined;
    let claimed: string | undefined;
    let completed = false;
    let pending = false;
    for (const nonce of state.browserNonces) {
      const progress = await this.options.linkProgress(state.connector, nonce);
      if (progress === "started") started = nonce;
      if (progress === "claimed") claimed = nonce;
      completed ||= progress === "started";
      pending ||= progress === "claimed";
    }
    const predecessor = started ?? claimed;
    return { ...(predecessor ? { predecessor } : {}), completed: completed && !pending };
  }

  private async connected(id: string, context: ServerContext): Promise<boolean> {
    const { registry, publicUrl, vault, principal, defer } = this.options;
    const connector = registry.getConnector(id)!;
    const scope = {};
    const signal = AbortSignal.any([context.mcpReq.signal, this.options.requestSignal]);
    try {
      return await runEdge(withDeadlineEffect(deadline => Effect.gen(function* () {
        const ctx = registry.contextFor(id, publicUrl!, scope, { signal: deadline });
        yield* Effect.addFinalizer(() => closeScope(connector, ctx, defer));
        if (connector.credential) {
          const metadata = yield* Effect.promise(() => vault!.metadata(id, connector.authScope === "personal" ? principal : undefined));
          if (storedCredentialShape(connector.credential, metadata?.fields ?? null).state !== "valid") return false;
        }
        if (!connector.status) return Boolean(connector.credential);
        return (yield* Effect.promise(() => registry.statusFor(id, publicUrl!, scope, { signal: deadline }))).state === "ok";
      }).pipe(Effect.scoped), { signal, timeoutMs: 5000, timeoutError: new Error("Auth status check timed out") }));
    } catch {
      return false;
    }
  }

  async run(
    tool: string, args: Record<string, unknown>, context: ServerContext,
    operation: () => Promise<ToolResult>,
  ): Promise<ToolResult | InputRequiredResult> {
    this.downstream.bind(context);
    const prior = context.mcpReq.requestState<AuthRequestState | DownstreamRequestState>();
    if (prior?.version === 2) return this.downstream.resume(prior, tool, args, context, operation);
    const previous = prior;
    const requestDigest = previous ? await digest(tool, args) : undefined;
    if (previous && (previous.tool !== tool || previous.digest !== requestDigest ||
        previous.address !== args.address)) return failure("invalid_request_state", "Invalid or expired requestState");
    const response = context.mcpReq.inputResponses?.[INPUT_KEY];
    if (previous && object(response) && !["accept", "decline", "cancel"].includes(String(response.action))) {
      throw new ProtocolError(INVALID_PARAMS, "Invalid auth elicitation response", { reason: "invalid_input_response" });
    }
    if (previous && !await this.options.claimRetry(previous.connector, previous.browserNonces.at(-1)!)) {
      return failure("invalid_request_state", "Invalid or expired requestState");
    }
    if (previous && object(response)) {
      if (response.action === "decline") return failure("auth_declined", "Connection was declined. The request was not retried.");
      if (response.action === "cancel") return failure("auth_cancelled", "Connection was cancelled. The request was not retried.");
    }
    if (previous?.reads.length) {
      const catalog = new CatalogService(this.options.registry, this.options.publicUrl!, {
        requestScope: this.options.requestScope,
        requestSignal: AbortSignal.any([context.mcpReq.signal, this.options.requestSignal]),
      });
      // Recheck every entered read before restarting any part of a program.
      // A trusted pool cannot authorize replay of a newly classified write.
      for (const read of previous.reads) {
        const current = await catalog.resolveTool(read.address, { signal: context.mcpReq.signal });
        if (!current.ok || current.resolved.classificationFresh !== true ||
            current.resolved.definition.classification !== "read" ||
            await classificationDigest(current.resolved.definition) !== read.digest) {
          const structuredContent = { ok: false, error: {
            code: "auth_replay_refused", retryable: false, reconciliationRequired: true,
            message: "An entered read no longer has the same fresh classification. Reconcile its target before starting a new request.",
            authorizationUrl: (await this.options.connectLink(previous.connector)).url,
          } };
          return { isError: true, structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
        }
      }
      bindReplayReads(this.options.requestScope, previous.reads);
    }
    const browser = previous && tool === "authorize_connector" ? await this.browserProgress(previous) : undefined;
    if (browser?.completed && previous) {
      // Retire unspent links before the status read. A browser claim racing
      // these CASes either wins and is observed as pending, or is refused.
      await this.options.closeLinks(previous.connector, previous.browserNonces);
      if ((await this.browserProgress(previous)).completed && await this.connected(previous.connector, context)) {
        const structuredContent = { connector: previous.connector, status: "ok" };
        return { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
      }
    }
    let result = await operation();
    const relayed = await this.downstream.finish(tool, args, context, result, previous);
    if (relayed !== result) return relayed;
    const error = result.structuredContent?.error;
    const authFailure = result.isError && object(error) &&
      (error.code === "auth_required" || error.code === "downstream_oauth_required");
    const explicit = tool === "authorize_connector" &&
      ["oauth", "operator_config"].includes(String(result.structuredContent?.recovery));
    if (!authFailure && !explicit) return result;
    const id = authFailure ? error.connector : explicit ? args.connector : undefined;
    // Every accepted retry owns new request-local facts. Handler-authored
    // errors and program write summaries cannot establish replay eligibility.
    const facts = await authRecoveryFacts(this.options.requestScope, String(id));
    const blocked = !explicit && (!facts.eligible || facts.writeEntered);
    if (authFailure && (facts.unsafeEntered || (tool !== "call_tool" && !facts.eligible))) {
      const structuredContent = { ...result.structuredContent, error: {
        ...error, retryable: false, reconciliationRequired: true,
        retry: "This call may have partially run. Reconcile its target before retrying after the operator completes recovery.",
      } };
      result = { ...result, structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
    }
    const { registry, vault, principal, publicUrl, canManage, unavailable } = this.options;
    const connector = typeof id === "string" ? registry.getConnector(id) : undefined;
    const recoverable = connector?.startAuth || (connector?.credential && this.options.credentialUi);
    if (typeof id !== "string" || !/^[a-z0-9_-]+$/.test(id) || !recoverable ||
        !principal || !publicUrl || unavailable || !canManage(id)) return result;
    const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined;
    const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY];
    const elicitation = object(capabilities) ? capabilities.elicitation : undefined;
    const capable = envelope?.[PROTOCOL_VERSION_META_KEY] === "2026-07-28" &&
      object(elicitation) && Object.hasOwn(elicitation, "url") && object(elicitation.url);
    if (blocked || !capable || !vault?.requestStateKey || !vault.seal || !vault.open) {
      if (!authFailure) return result;
      const structuredContent = { ...result.structuredContent, error: {
        ...(result.structuredContent?.error as Record<string, unknown>), authorizationUrl: (await this.options.connectLink(id)).url,
      } };
      return { ...result, structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
    }
    if (previous && previous.round >= MAX_ROUNDS) return failure("auth_round_limit", "Connection is still required after three prompts. Connect explicitly, then start a new request.");
    // Once a verified browser has started this attempt, retries continue it.
    // A pending consent must never be reset by another force=true prompt.
    const forced = explicit && args.force === true;
    const link = await this.options.connectLink(id, forced && !browser?.predecessor,
      forced ? browser?.predecessor : undefined);
    const state: AuthRequestState = {
      version: 1, principal, endpoint: this.options.endpoint, connector: id, tool,
      ...(typeof args.address === "string" ? { address: args.address } : {}),
      digest: requestDigest ?? await digest(tool, args),
      round: (previous?.round ?? 0) + 1,
      expiresAt: previous?.expiresAt ?? Date.now() + TTL_MS,
      browserNonces: [...(previous?.browserNonces ?? []), link.nonce],
      reads: [...new Map([...(previous?.reads ?? []), ...facts.reads].map(read => [read.address, read])).values()],
    };
    const wire = await (await this.stateCodec()).mint(state, context);
    if (wire.length > 8192) {
      const structuredContent = { ...result.structuredContent, error: {
        ...(result.structuredContent?.error as Record<string, unknown>), authorizationUrl: link.url,
      } };
      return { ...result, structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
    }
    return inputRequired({
      inputRequests: { [INPUT_KEY]: inputRequired.elicitUrl({
        message: MESSAGE,
        url: link.url,
      }) },
      requestState: wire,
    });
  }
}
