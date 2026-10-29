import { toolError } from "./tool-error.js";
import { RequestScope, requestOwner } from "./runtime/request-scope.js";
import { upwardStep } from "./upward.js";
import type { CatalogResolution } from "./catalog-service.js";
import {
  authAwait,
  authCall,
  authInvoke,
  authFlow,
  authMethod,
  registerAuthMethod,
  authOwnMethod,
} from "./auth/native.js";
import { registryProgram } from "./runtime/registry.js";
import { enableAuthorizationHandoffs } from "./authorization-handoff.js";
import {
  createRequestStateCodec,
  inputRequired,
  ProtocolError,
  INVALID_PARAMS,
  PROTOCOL_VERSION_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { CredentialVault } from "./credential-contract.js";
import type { ToolResult } from "./meta-tools.js";
import type { RegistryView } from "./registry.js";
import { Effect } from "effect";
import { runEdge, withDeadlineEffect } from "./runtime/run.js";
import { closeScope } from "./runtime/connector-scope.js";
import type { DeferredWork } from "./connector-scope.js";
import { storedCredentialShape } from "./credential-rules.js";
import { isWriteLike } from "./tool-safety.js";
import { authRecoveryFacts, bindReplayReads, classificationDigest, type ReplayRead } from "./invocation-auth.js";
import { CatalogService } from "./catalog-service.js";
import { sentSecretsForRequest } from "./sent-secrets.js";
import {
  DownstreamElicitation,
  MAX_RELAY_STATE_CHARS,
  type DownstreamRequestState,
  type SealedDownstreamState,
} from "./downstream-input.js";
import {
  canonicalState as canonical,
  requestDigest as digest,
  stateObject as object,
  invalidRequestState as invalidState,
  REQUEST_STATE_TTL_MS as TTL_MS,
  MAX_INPUT_ROUNDS as MAX_ROUNDS,
} from "./request-state.js";

const INPUT_KEY = "connecta_auth";
const MESSAGE = "Connect this service in your browser, then retry the request.";

interface AuthRequestState {
  version: 1;
  principal: string;
  endpoint: string;
  pool: string | null;
  connector: string;
  tool: string;
  address?: string;
  wireTool: string;
  digest: string;
  round: number;
  expiresAt: number;
  browserNonces: string[];
  reads: ReplayRead[];
}

function failure(
  code: "invalid_request_state" | "auth_declined" | "auth_cancelled" | "auth_round_limit",
  message: string,
): ToolResult {
  return toolError({ code, message, retryable: false }, { ok: false });
}

/** Request-local auth recovery at the MCP boundary, never inside a guest provider. */
export class AuthElicitation {
  private codec: Effect.Effect<RequestStateCodec<AuthRequestState | SealedDownstreamState>, unknown> | undefined;
  private readonly downstream: DownstreamElicitation;

  private stateCodec(): Promise<RequestStateCodec<AuthRequestState | SealedDownstreamState>> {
    return runEdge(
      authOwnMethod<RequestStateCodec<AuthRequestState | SealedDownstreamState>>(
        AuthElicitation.prototype,
        this,
        "stateCodec",
        [],
      ),
    );
  }

  constructor(
    private readonly options: {
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
    },
  ) {
    this.downstream = new DownstreamElicitation({
      ...options,
      mint: authMethod((state: SealedDownstreamState, context: ServerContext) =>
        Effect.gen({ self: this }, function* () {
          const codec = yield* authInvoke<RequestStateCodec<AuthRequestState | SealedDownstreamState>>(
            this,
            "stateCodec",
            [],
          );
          return yield* authInvoke<string>(codec, "mint", [state, context]);
        }),
      ),
    });
  }

  /** The SDK runs this before any tool handler, including non-auth tools. */
  verify(wire: string, context: ServerContext): Promise<AuthRequestState | DownstreamRequestState> {
    return runEdge(
      authOwnMethod<AuthRequestState | DownstreamRequestState>(AuthElicitation.prototype, this, "verify", [
        wire,
        context,
      ]),
    );
  }

  private browserProgress(state: AuthRequestState): Promise<{ predecessor?: string; completed: boolean }> {
    return runEdge(
      authOwnMethod<{ predecessor?: string; completed: boolean }>(AuthElicitation.prototype, this, "browserProgress", [
        state,
      ]),
    );
  }

  private connected(id: string, context: ServerContext): Promise<boolean> {
    return runEdge(authOwnMethod<boolean>(AuthElicitation.prototype, this, "connected", [id, context]));
  }

  bind(context: ServerContext): void {
    this.downstream.bind(context);
  }

  run(
    tool: string,
    args: Record<string, unknown>,
    context: ServerContext,
    operation: () => Promise<ToolResult>,
  ): Promise<ToolResult | InputRequiredResult> {
    return runEdge(
      authOwnMethod<InputRequiredResult | ToolResult>(AuthElicitation.prototype, this, "run", [
        tool,
        args,
        context,
        operation,
      ]),
    );
  }
  static {
    registerAuthMethod(
      this.prototype,
      "stateCodec",
      function () {
        const self = this as AuthElicitation;
        return authAwait(
          Effect.gen(function* () {
            const key = self.options.vault?.requestStateKey;
            if (!key) return invalidState();
            self.codec ??= yield* Effect.cached(
              authCall<Uint8Array>(key, [], self.options.vault).pipe(
                Effect.map((bytes) =>
                  createRequestStateCodec<AuthRequestState | SealedDownstreamState>({
                    key: bytes,
                    ttlSeconds: TTL_MS / 1000,
                    bind: () =>
                      canonical({
                        principal: self.options.principal,
                        endpoint: self.options.endpoint,
                        pool: self.options.registry.resultIdentity().pool,
                      }),
                  }),
                ),
              ),
            );
            return yield* self.codec;
          }),
          (this as AuthElicitation).options.requestSignal,
        ).pipe(Effect.provideService(RequestScope, requestOwner((this as AuthElicitation).options.requestScope)));
      },
      this.prototype.stateCodec,
    );

    registerAuthMethod(
      AuthElicitation.prototype,
      "run",
      function (
        tool: string,
        args: Record<string, unknown>,
        context: ServerContext,
        operation: () => Promise<ToolResult>,
      ) {
        const self = this as AuthElicitation;
        return authAwait(
          authFlow<InputRequiredResult | ToolResult>(function* () {
            self.bind(context);
            const prior = context.mcpReq.requestState<AuthRequestState | DownstreamRequestState>();
            if (prior?.version === 2)
              return yield* upwardStep(
                authInvoke<InputRequiredResult | ToolResult>(self.downstream, "resume", [
                  prior,
                  tool,
                  args,
                  context,
                  operation,
                ]),
              );
            const previous = prior;
            const requestDigest = previous ? yield* upwardStep(authCall<string>(digest, [tool, args])) : undefined;
            if (
              previous &&
              (previous.wireTool !== context.http?.req?.headers.get("Mcp-Name") ||
                previous.tool !== tool ||
                previous.digest !== requestDigest ||
                previous.address !== args.address)
            )
              return failure("invalid_request_state", "Invalid or expired requestState");
            const response = context.mcpReq.inputResponses?.[INPUT_KEY];
            if (previous && object(response) && !["accept", "decline", "cancel"].includes(String(response.action))) {
              throw new ProtocolError(INVALID_PARAMS, "Invalid auth elicitation response", {
                reason: "invalid_input_response",
              });
            }
            if (
              previous &&
              !(yield* upwardStep(
                authInvoke<boolean>(self.options, "claimRetry", [previous.connector, previous.browserNonces.at(-1)!]),
              ))
            ) {
              return failure("invalid_request_state", "Invalid or expired requestState");
            }
            if (previous && object(response)) {
              if (response.action === "decline")
                return failure("auth_declined", "Connection was declined. The request was not retried.");
              if (response.action === "cancel")
                return failure("auth_cancelled", "Connection was cancelled. The request was not retried.");
            }
            if (previous?.reads.length) {
              const catalog = new CatalogService(self.options.registry, self.options.publicUrl!, {
                requestScope: self.options.requestScope,
                requestSignal: AbortSignal.any([context.mcpReq.signal, self.options.requestSignal]),
              });
              // Recheck every entered read before restarting any part of a program.
              // A writable endpoint cannot authorize replay of a newly classified write.
              for (const read of previous.reads) {
                const current = yield* upwardStep(
                  authInvoke<CatalogResolution>(catalog, "resolveTool", [
                    read.address,
                    { signal: context.mcpReq.signal },
                  ]),
                );
                if (
                  !current.ok ||
                  current.resolved.classificationFresh !== true ||
                  isWriteLike(current.resolved.definition) ||
                  (yield* upwardStep(authCall<string>(classificationDigest, [current.resolved.definition]))) !==
                    read.digest
                ) {
                  const structuredContent = {
                    ok: false,
                    error: {
                      code: "auth_replay_refused",
                      retryable: false,
                      reconciliationRequired: true,
                      message:
                        "An entered read no longer has the same fresh classification. Reconcile its target before starting a new request.",
                      authorizationUrl: (yield* upwardStep(
                        authInvoke<{ url: string; nonce: string }>(self.options, "connectLink", [previous.connector]),
                      )).url,
                    },
                  };
                  return {
                    isError: true,
                    structuredContent,
                    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
                  };
                }
              }
              bindReplayReads(self.options.requestScope, previous.reads);
            }
            const browser =
              previous && tool === "authorize_connector"
                ? yield* upwardStep(
                    authInvoke<{ predecessor?: string; completed: boolean }>(self, "browserProgress", [previous]),
                  )
                : undefined;
            if (browser?.completed && previous) {
              // Retire unspent links before the status read. A browser claim racing
              // these CASes either wins and is observed as pending, or is refused.
              yield* upwardStep(
                authInvoke<void>(self.options, "closeLinks", [previous.connector, previous.browserNonces]),
              );
              if (
                (yield* upwardStep(
                  authInvoke<{ predecessor?: string; completed: boolean }>(self, "browserProgress", [previous]),
                )).completed &&
                (yield* upwardStep(authInvoke<boolean>(self, "connected", [previous.connector, context])))
              ) {
                const structuredContent = { connector: previous.connector, status: "ok" };
                return { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
              }
            }
            const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined;
            const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY];
            const elicitation = object(capabilities) ? capabilities.elicitation : undefined;
            const capable =
              envelope?.[PROTOCOL_VERSION_META_KEY] === "2026-07-28" &&
              object(elicitation) &&
              Object.hasOwn(elicitation, "url") &&
              object(elicitation.url);
            enableAuthorizationHandoffs(self.options.requestScope, !capable);
            let result = yield* upwardStep(authCall<ToolResult>(operation, []));
            const relayed = yield* upwardStep(
              authInvoke<InputRequiredResult | ToolResult>(self.downstream, "finish", [
                tool,
                args,
                context,
                result,
                previous,
              ]),
            );
            if (relayed !== result) return relayed;
            const error = result.structuredContent?.error;
            const authFailure =
              result.isError &&
              object(error) &&
              (error.code === "auth_required" || error.code === "downstream_oauth_required");
            const explicit =
              tool === "authorize_connector" &&
              ["oauth", "operator_config"].includes(String(result.structuredContent?.recovery));
            if (!authFailure && !explicit) return result;
            const id = authFailure ? error.connector : explicit ? args.connector : undefined;
            // Every accepted retry owns new request-local facts. Handler-authored
            // errors and program write summaries cannot establish replay eligibility.
            const facts = yield* upwardStep(
              authCall<{ writeEntered: boolean; unsafeEntered: boolean; eligible: boolean; reads: ReplayRead[] }>(
                authRecoveryFacts,
                [self.options.requestScope, String(id)],
              ),
            );
            const blocked = !explicit && (!facts.eligible || facts.writeEntered);
            if (authFailure && (facts.unsafeEntered || (tool !== "call_tool" && !facts.eligible))) {
              const structuredContent = {
                ...result.structuredContent,
                error: {
                  ...error,
                  retryable: false,
                  reconciliationRequired: true,
                  retry:
                    "This call may have partially run. Reconcile its target before retrying after the operator completes recovery.",
                },
              };
              result = {
                ...result,
                structuredContent,
                content: [{ type: "text", text: JSON.stringify(structuredContent) }],
              };
            }
            const { registry, vault, principal, publicUrl, canManage, unavailable } = self.options;
            const connector = typeof id === "string" ? registry.getConnector(id) : undefined;
            const recoverable = connector?.startAuth || (connector?.credential && self.options.credentialUi);
            if (
              typeof id !== "string" ||
              !/^[a-z0-9_-]+$/.test(id) ||
              !recoverable ||
              !principal ||
              !publicUrl ||
              unavailable ||
              !canManage(id)
            )
              return result;
            // Incapable hosts already received the shared explicit-authorization handoff.
            if (!capable) return result;
            if (blocked || !vault?.requestStateKey || !vault.seal || !vault.open) {
              if (!authFailure) return result;
              const structuredContent = {
                ...result.structuredContent,
                error: {
                  ...(result.structuredContent?.error as Record<string, unknown>),
                  authorizationUrl:
                    error.authorizationUrl ??
                    (yield* upwardStep(authInvoke<{ url: string; nonce: string }>(self.options, "connectLink", [id])))
                      .url,
                },
              };
              return {
                ...result,
                structuredContent,
                content: [{ type: "text", text: JSON.stringify(structuredContent) }],
              };
            }
            if (previous && previous.round >= MAX_ROUNDS)
              return failure(
                "auth_round_limit",
                "Connection is still required after three prompts. Connect explicitly, then start a new request.",
              );
            // Once a verified browser has started this attempt, retries continue it.
            // A pending consent must never be reset by another force=true prompt.
            const forced = explicit && args.force === true;
            const link = yield* upwardStep(
              authInvoke<{ url: string; nonce: string }>(self.options, "connectLink", [
                id,
                forced && !browser?.predecessor,
                forced ? browser?.predecessor : undefined,
              ]),
            );
            const state: AuthRequestState = {
              version: 1,
              principal,
              endpoint: self.options.endpoint,
              pool: self.options.registry.resultIdentity().pool,
              connector: id,
              tool,
              ...(typeof args.address === "string" ? { address: args.address } : {}),
              wireTool: context.http?.req?.headers.get("Mcp-Name") ?? tool,
              digest: requestDigest ?? (yield* upwardStep(authCall<string>(digest, [tool, args]))),
              round: (previous?.round ?? 0) + 1,
              expiresAt: previous?.expiresAt ?? Date.now() + TTL_MS,
              browserNonces: [...(previous?.browserNonces ?? []), link.nonce],
              reads: [
                ...new Map([...(previous?.reads ?? []), ...facts.reads].map((read) => [read.address, read])).values(),
              ],
            };
            const wire = yield* upwardStep(
              authInvoke<string>(
                yield* upwardStep(
                  authInvoke<RequestStateCodec<AuthRequestState | SealedDownstreamState>>(self, "stateCodec", []),
                ),
                "mint",
                [state, context],
              ),
            );
            // Signed state and its connect link carry only Connecta's facts: a coincidental match must
            // not corrupt them.
            sentSecretsForRequest(self.options.requestScope).mintedState(wire);
            sentSecretsForRequest(self.options.requestScope).mintedState(link.url);
            if (wire.length > 8192) {
              const structuredContent = {
                ...result.structuredContent,
                error: {
                  ...(result.structuredContent?.error as Record<string, unknown>),
                  authorizationUrl: link.url,
                },
              };
              return {
                ...result,
                structuredContent,
                content: [{ type: "text", text: JSON.stringify(structuredContent) }],
              };
            }
            return inputRequired({
              inputRequests: {
                [INPUT_KEY]: inputRequired.elicitUrl({
                  message: MESSAGE,
                  url: link.url,
                }),
              },
              requestState: wire,
            });
          }),
          (this as AuthElicitation).options.requestSignal,
        ).pipe(Effect.provideService(RequestScope, requestOwner((this as AuthElicitation).options.requestScope)));
      },
      AuthElicitation.prototype.run,
    );
    registerAuthMethod(
      AuthElicitation.prototype,
      "connected",
      function (id: string, context: ServerContext) {
        const self = this as AuthElicitation;
        return authAwait(
          authFlow<boolean>(function* () {
            const { registry, publicUrl, vault, principal, defer } = self.options;
            const connector = registry.getConnector(id)!;
            const scope = {};
            const signal = AbortSignal.any([context.mcpReq.signal, self.options.requestSignal]);
            try {
              return yield* upwardStep(
                withDeadlineEffect(
                  (deadline) =>
                    Effect.gen(function* () {
                      const ctx = registry.contextFor(id, publicUrl!, scope, { signal: deadline });
                      yield* upwardStep(Effect.addFinalizer(() => closeScope(connector, ctx, defer)));
                      if (connector.credential) {
                        const metadata = yield* upwardStep(
                          Effect.promise(() =>
                            vault!.metadata(id, connector.authScope === "personal" ? principal : undefined),
                          ),
                        );
                        if (storedCredentialShape(connector.credential, metadata?.fields ?? null).state !== "valid")
                          return false;
                      }
                      if (!connector.status) return Boolean(connector.credential);
                      return (
                        (yield* upwardStep(
                          registryProgram(registry, "statusFor", id, publicUrl!, scope, { signal: deadline }),
                        )).state === "ok"
                      );
                    }).pipe(Effect.scoped),
                  { signal, timeoutMs: 5000, timeoutError: new Error("Auth status check timed out") },
                ),
              );
            } catch {
              return false;
            }
          }),
          (this as AuthElicitation).options.requestSignal,
        ).pipe(Effect.provideService(RequestScope, requestOwner((this as AuthElicitation).options.requestScope)));
      },
      AuthElicitation.prototype.connected,
    );
    registerAuthMethod(
      AuthElicitation.prototype,
      "browserProgress",
      function (state: AuthRequestState) {
        const self = this as AuthElicitation;
        return authAwait(
          authFlow<{ predecessor?: string; completed: boolean }>(function* () {
            let started: string | undefined;
            let claimed: string | undefined;
            let completed = false;
            let pending = false;
            for (const nonce of state.browserNonces) {
              const progress = yield* upwardStep(
                authInvoke<"claimed" | "started" | "failed" | undefined>(self.options, "linkProgress", [
                  state.connector,
                  nonce,
                ]),
              );
              if (progress === "started") started = nonce;
              if (progress === "claimed") claimed = nonce;
              completed ||= progress === "started";
              pending ||= progress === "claimed";
            }
            const predecessor = started ?? claimed;
            return { ...(predecessor ? { predecessor } : {}), completed: completed && !pending };
          }),
          (this as AuthElicitation).options.requestSignal,
        ).pipe(Effect.provideService(RequestScope, requestOwner((this as AuthElicitation).options.requestScope)));
      },
      AuthElicitation.prototype.browserProgress,
    );
    registerAuthMethod(
      AuthElicitation.prototype,
      "verify",
      function (wire: string, context: ServerContext) {
        const self = this as AuthElicitation;
        return authAwait(
          authFlow<AuthRequestState | DownstreamRequestState>(function* () {
            const { vault, endpoint, principal, registry, canManage } = self.options;
            if (!vault?.requestStateKey || wire.length > MAX_RELAY_STATE_CHARS) return invalidState();
            const state: unknown = yield* upwardStep(
              authInvoke<AuthRequestState | SealedDownstreamState>(
                yield* upwardStep(
                  authInvoke<RequestStateCodec<AuthRequestState | SealedDownstreamState>>(self, "stateCodec", []),
                ),
                "verify",
                [wire, context],
              ),
            );
            if (object(state) && state.version === 2 && state.kind === "downstream")
              return yield* upwardStep(authInvoke<DownstreamRequestState>(self.downstream, "verify", [state, context]));
            if (wire.length > 8192) return invalidState();
            if (
              !object(state) ||
              state.version !== 1 ||
              !principal ||
              state.principal !== principal ||
              state.endpoint !== endpoint ||
              state.pool !== registry.resultIdentity().pool ||
              typeof state.connector !== "string" ||
              !registry.getConnector(state.connector) ||
              !canManage(state.connector) ||
              !Number.isSafeInteger(state.expiresAt) ||
              (state.expiresAt as number) <= Date.now() ||
              (state.expiresAt as number) > Date.now() + TTL_MS ||
              !Number.isInteger(state.round) ||
              (state.round as number) < 1 ||
              (state.round as number) > MAX_ROUNDS ||
              !["call_tool", "call_destructive_tool", "execute_code", "authorize_connector"].includes(
                String(state.tool),
              ) ||
              typeof state.wireTool !== "string" ||
              typeof state.digest !== "string" ||
              !/^[a-f0-9]{64}$/.test(state.digest) ||
              !Array.isArray(state.browserNonces) ||
              state.browserNonces.length !== state.round ||
              !state.browserNonces.every((nonce) => typeof nonce === "string" && /^[a-f0-9-]{36}$/.test(nonce)) ||
              !Array.isArray(state.reads) ||
              !state.reads.every(
                (read) =>
                  object(read) &&
                  typeof read.address === "string" &&
                  typeof read.digest === "string" &&
                  /^[a-f0-9]{64}$/.test(read.digest),
              ) ||
              (state.address !== undefined && typeof state.address !== "string")
            )
              return invalidState();
            if (context.mcpReq.method !== "tools/call" || context.http?.req?.headers.get("Mcp-Name") !== state.wireTool)
              return invalidState();
            return state as unknown as AuthRequestState;
          }),
          (this as AuthElicitation).options.requestSignal,
        ).pipe(Effect.provideService(RequestScope, requestOwner((this as AuthElicitation).options.requestScope)));
      },
      AuthElicitation.prototype.verify,
    );
  }
}
