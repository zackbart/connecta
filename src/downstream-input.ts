import { RequestScope, requestOwner } from "./runtime/request-scope.js";
import { Effect } from "effect";
import { upwardStep } from "./upward.js";
import {
  authAwait,
  authCall,
  authInvoke,
  authFlow,
  authStorage,
  registerAuth,
  registerAuthMethod,
  authOwnMethod,
} from "./auth/native.js";

import { runEdge } from "./runtime/run.js";
import {
  inputRequired,
  specTypeSchemas,
  ProtocolError,
  INVALID_PARAMS,
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type InputRequests,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { CredentialVault } from "./credential-contract.js";
import type { ToolResult } from "./meta-tools.js";
import type { RegistryView } from "./registry.js";
import { ConnectorCallError } from "./errors.js";
import { sentSecretsForRequest, type SentSecrets } from "./sent-secrets.js";
import { inputRetryKeys } from "./storage/keys.js";
import {
  REQUEST_STATE_TTL_MS,
  MAX_INPUT_ROUNDS,
  invalidRequestState,
  requestDigest,
  stateObject,
} from "./request-state.js";
import {
  bindDownstreamCapabilities,
  downstreamInputCapabilities,
  bindDownstreamContinuation,
  clearDownstreamContinuation,
  downstreamArgumentEcho,
  assertNoPrivateStateEchoes,
  assertDownstreamOutputSafe,
} from "./downstream-input-context.js";

const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_RELAY_STATE_CHARS = 128 * 1024;
const MAX_REQUESTS = 16;
const PURPOSE = "connecta:downstream-input:v1";
type InputMode = "form" | "url";
type InputBindings = Record<string, { key: string; mode: InputMode }>;

export interface SealedDownstreamState {
  version: 2;
  kind: "downstream";
  connector: string;
  sealed: string;
}

export interface DownstreamRequestState {
  version: 2;
  kind: "downstream";
  principal: string;
  endpoint: string;
  connector: string;
  address: string;
  target: string;
  tool: "call_tool" | "call_destructive_tool";
  wireTool: string;
  digest: string;
  round: number;
  expiresAt: number;
  nonce: string;
  requestState?: string;
  previousStates: string[];
  inputs: InputBindings;
}

interface PendingInput {
  connector: string;
  address: string;
  /** The suspended call was a write, so it may already have applied. */
  write: boolean;
  requestState?: string;
  inputRequests: InputRequests;
  inputs: InputBindings;
}

const pendingInputs = new WeakMap<object, PendingInput>();
const modernRequests = new WeakSet<object>();

function withinBudget(value: unknown): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

function namespace(connector: string, index: number): string {
  return `downstream/${connector}/${index}`;
}

function invalidInput(): never {
  throw new ConnectorCallError("input_required_invalid", "The downstream returned malformed or unsafe input requests.");
}

/** Capture opaque state before any result redaction or unwrapping can alter it. */
export function captureDownstreamInput(
  scope: object,
  connector: string,
  address: string,
  raw: unknown,
  secrets: SentSecrets,
  write: boolean,
): Promise<void> {
  return runEdge(captureDownstreamInputNative(scope, connector, address, raw, secrets, write));
}
const captureDownstreamInputNative = /* @__PURE__ */ registerAuth(
  captureDownstreamInput,
  function (scope: object, connector: string, address: string, raw: unknown, secrets: SentSecrets, write: boolean) {
    return authFlow<void>(function* () {
      if (!withinBudget(raw))
        throw new ConnectorCallError("input_required_limit", "The downstream input payload exceeds 64 KiB.");
      if (
        !stateObject(raw) ||
        (raw.requestState !== undefined && typeof raw.requestState !== "string") ||
        (raw.inputRequests !== undefined && !stateObject(raw.inputRequests)) ||
        (raw.requestState === undefined && raw.inputRequests === undefined)
      )
        return invalidInput();
      const entries = Object.entries(raw.inputRequests ?? {});
      if (!entries.length && raw.requestState === undefined) return invalidInput();
      if (entries.length > MAX_REQUESTS)
        throw new ConnectorCallError("input_required_limit", "The downstream requested more than 16 inputs.");
      const inputRequests: InputRequests = Object.create(null);
      const inputs: InputBindings = Object.create(null);
      const elicitation = downstreamInputCapabilities(scope).elicitation;
      for (const [index, [key, request]] of entries.entries()) {
        if (!key || key.length > 256 || !stateObject(request)) return invalidInput();
        if (request.method !== "elicitation/create") {
          throw new ConnectorCallError(
            "input_required_unsupported",
            "Connecta relays downstream form and URL elicitation only.",
          );
        }
        if (!stateObject(request.params)) return invalidInput();
        const params = request.params;
        const mode = params.mode ?? "form";
        if (mode !== "form" && mode !== "url") return invalidInput();
        if (!elicitation?.[mode])
          throw new ConnectorCallError(
            "input_required_unsupported",
            "The client did not declare support for the downstream elicitation kind.",
          );
        if (mode === "url") {
          if (typeof params.message !== "string" || typeof params.url !== "string") return invalidInput();
          try {
            const url = new URL(params.url);
            // An opaque downstream nonce is retained. Credentials are never put
            // in browser URLs; refusal preserves semantics instead of rewriting it.
            if (
              url.protocol !== "https:" ||
              url.username ||
              url.password ||
              [...params.url].some((char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f) ||
              secrets.containsUrl(params.url) ||
              secrets.redact(params.url) !== params.url
            )
              return invalidInput();
          } catch {
            return invalidInput();
          }
          inputRequests[namespace(connector, index)] = inputRequired.elicitUrl({
            message: `Downstream ${connector}: ${params.message}`,
            url: params.url,
          });
        } else {
          const parsed = yield* upwardStep(
            authInvoke<Awaited<ReturnType<(typeof specTypeSchemas.ElicitRequestFormParams)["~standard"]["validate"]>>>(
              specTypeSchemas.ElicitRequestFormParams["~standard"],
              "validate",
              [params],
            ),
          );
          if (parsed.issues) return invalidInput();
          // A schema controls the accepted answer. Refuse redaction changes rather
          // than asking the host to submit different field names or enum values.
          if (secrets.changes(parsed.value.requestedSchema)) return invalidInput();
          inputRequests[namespace(connector, index)] = inputRequired.elicit({
            message: `Downstream ${connector}: ${parsed.value.message}`,
            requestedSchema: parsed.value.requestedSchema,
          });
        }
        inputs[namespace(connector, index)] = { key, mode };
      }
      // Opaque state is private even when a downstream echoes it in a prompt,
      // URL, or schema. Keep the continuation intact and refuse the public prompt.
      assertDownstreamOutputSafe(scope, inputRequests);
      assertNoPrivateStateEchoes(inputRequests, raw.requestState !== undefined ? [raw.requestState as string] : []);
      if (pendingInputs.has(scope)) return invalidInput();
      pendingInputs.set(scope, {
        connector,
        address,
        write,
        ...(raw.requestState !== undefined ? { requestState: raw.requestState as string } : {}),
        inputRequests,
        inputs,
      });
    });
  },
);

function failure(code: string, message: string, write = false): ToolResult {
  // A handler asks for input from inside its run: a suspended write may
  // already have applied, so it is never told to start over (INV-9).
  const error = write
    ? {
        code,
        message: `${message} Whether the write took effect is unknown; check its target before any fresh call.`,
        retryable: false,
        writeOutcome: "unknown",
      }
    : { code, message, retryable: false };
  const structuredContent = { ok: false, error };
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError: true };
}

/** MCP-only continuation coordination. No downstream prompt enters operator records. */
export class DownstreamElicitation {
  constructor(
    private readonly options: {
      vault: CredentialVault | undefined;
      principal: string | undefined;
      endpoint: string;
      registry: RegistryView;
      requestScope: object;
      mint: (state: SealedDownstreamState, context: ServerContext) => Promise<string>;
    },
  ) {}

  bind(context: ServerContext): void {
    const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined;
    const declared = envelope?.[CLIENT_CAPABILITIES_META_KEY];
    const elicitation = stateObject(declared) ? declared.elicitation : undefined;
    const modern = envelope?.[PROTOCOL_VERSION_META_KEY] === "2026-07-28";
    if (modern) modernRequests.add(this.options.requestScope);
    else modernRequests.delete(this.options.requestScope);
    bindDownstreamCapabilities(
      this.options.requestScope,
      modern && stateObject(elicitation)
        ? {
            elicitation: {
              ...(stateObject(elicitation.form) || Object.keys(elicitation).length === 0 ? { form: {} } : {}),
              ...(stateObject(elicitation.url) ? { url: {} } : {}),
            },
          }
        : {},
    );
  }

  verify(wrapper: Record<string, unknown>, context: ServerContext): Promise<DownstreamRequestState> {
    return runEdge(
      authOwnMethod<DownstreamRequestState>(DownstreamElicitation.prototype, this, "verify", [wrapper, context]),
    );
  }

  resume(
    state: DownstreamRequestState,
    tool: string,
    args: Record<string, unknown>,
    context: ServerContext,
    operation: () => Promise<ToolResult>,
  ): Promise<ToolResult | InputRequiredResult> {
    return runEdge(
      authOwnMethod<InputRequiredResult | ToolResult>(DownstreamElicitation.prototype, this, "resume", [
        state,
        tool,
        args,
        context,
        operation,
      ]),
    );
  }

  finish(
    tool: string,
    args: Record<string, unknown>,
    context: ServerContext,
    result: ToolResult,
    previous?: { round: number; expiresAt: number; requestState?: string; previousStates?: string[] },
  ): Promise<ToolResult | InputRequiredResult> {
    return runEdge(
      authOwnMethod<InputRequiredResult | ToolResult>(DownstreamElicitation.prototype, this, "finish", [
        tool,
        args,
        context,
        result,
        previous,
      ]),
    );
  }
  static {
    registerAuthMethod(
      DownstreamElicitation.prototype,
      "finish",
      function (
        tool: string,
        args: Record<string, unknown>,
        context: ServerContext,
        result: ToolResult,
        previous?: { round: number; expiresAt: number; requestState?: string; previousStates?: string[] },
      ) {
        const self = this as DownstreamElicitation;
        return authAwait(
          authFlow<InputRequiredResult | ToolResult>(function* () {
            const scope = self.options.requestScope;
            const pending = pendingInputs.get(scope);
            pendingInputs.delete(scope);
            if (!pending) return result;
            const { vault, principal, endpoint } = self.options;
            if (
              !modernRequests.has(scope) ||
              !vault?.requestStateKey ||
              !vault.seal ||
              !vault.open ||
              !principal ||
              !["call_tool", "call_destructive_tool"].includes(tool)
            )
              return failure(
                "input_required_unsupported",
                "Downstream input requires an authenticated direct call and a sealing vault.",
                pending.write,
              );
            if ((previous?.round ?? 0) >= MAX_INPUT_ROUNDS)
              return failure(
                "input_required_round_limit",
                `The downstream still requires input after three rounds.${pending.write ? "" : " Start a new direct request."}`,
                pending.write,
              );
            const previousStates = [
              ...new Set([
                ...(previous?.previousStates ?? []),
                ...(previous?.requestState !== undefined ? [previous.requestState] : []),
              ]),
            ].filter((value) => value !== pending.requestState);
            if (
              !withinBudget([...previousStates, ...(pending.requestState !== undefined ? [pending.requestState] : [])])
            ) {
              return failure(
                "input_required_limit",
                "The downstream private state history exceeds 64 KiB.",
                pending.write,
              );
            }
            const state: DownstreamRequestState = {
              version: 2,
              kind: "downstream",
              principal,
              endpoint,
              connector: pending.connector,
              address: String(args.address),
              target: pending.address,
              tool: tool as DownstreamRequestState["tool"],
              wireTool: context.http?.req?.headers.get("Mcp-Name") ?? tool,
              digest: yield* upwardStep(authCall<string>(requestDigest, [tool, args])),
              round: (previous?.round ?? 0) + 1,
              expiresAt: previous?.expiresAt ?? Date.now() + REQUEST_STATE_TTL_MS,
              nonce: crypto.randomUUID(),
              ...(pending.requestState !== undefined ? { requestState: pending.requestState } : {}),
              previousStates,
              inputs: pending.inputs,
            };
            const requestState = yield* upwardStep(
              authInvoke<string>(self.options, "mint", [
                {
                  version: 2,
                  kind: "downstream",
                  connector: pending.connector,
                  sealed: yield* upwardStep(
                    authInvoke<string>(vault, "seal", [pending.connector, PURPOSE, JSON.stringify(state)]),
                  ),
                },
                context,
              ]),
            );
            if (requestState.length > MAX_RELAY_STATE_CHARS)
              return failure("input_required_limit", "The sealed downstream state exceeds 128 KiB.", pending.write);
            // Authenticated, encrypted Connecta state, never the vendor's plaintext
            // state: a coincidental match must not corrupt it.
            sentSecretsForRequest(scope).mintedState(requestState);
            // Opaque echoes and mutable schemas/URLs were refused during capture.
            // Downstream prompt messages are prose under the payload rules.
            return sentSecretsForRequest(scope).redact(
              inputRequired({
                ...(Object.keys(pending.inputRequests).length ? { inputRequests: pending.inputRequests } : {}),
                requestState,
              }),
            );
          }),
          context.mcpReq.signal,
        ).pipe(Effect.provideService(RequestScope, requestOwner((this as DownstreamElicitation).options.requestScope)));
      },
      DownstreamElicitation.prototype.finish,
    );
    registerAuthMethod(
      DownstreamElicitation.prototype,
      "resume",
      function (
        state: DownstreamRequestState,
        tool: string,
        args: Record<string, unknown>,
        context: ServerContext,
        operation: () => Promise<ToolResult>,
      ) {
        const self = this as DownstreamElicitation;
        return authAwait(
          authFlow<InputRequiredResult | ToolResult>(function* () {
            if (
              state.wireTool !== context.http?.req?.headers.get("Mcp-Name") ||
              state.tool !== tool ||
              state.address !== args.address ||
              state.digest !== (yield* upwardStep(authCall<string>(requestDigest, [tool, args])))
            )
              return failure("invalid_request_state", "Invalid or expired requestState");
            const responses: Record<string, unknown> = Object.create(null);
            const elicitation = downstreamInputCapabilities(self.options.requestScope).elicitation;
            for (const [wireKey, { key, mode }] of Object.entries(state.inputs)) {
              if (!elicitation?.[mode])
                return failure(
                  "input_required_unsupported",
                  "The client did not declare support for this continuation's input kind.",
                );
              const response = context.mcpReq.inputResponses?.[wireKey];
              if (response === undefined) continue;
              const parsed = yield* upwardStep(
                authInvoke<Awaited<ReturnType<(typeof specTypeSchemas.ElicitResult)["~standard"]["validate"]>>>(
                  specTypeSchemas.ElicitResult["~standard"],
                  "validate",
                  [response],
                ),
              );
              if (parsed.issues)
                throw new ProtocolError(INVALID_PARAMS, "Invalid downstream input response", {
                  reason: "invalid_input_response",
                });
              // URL acknowledgements and decline/cancel never carry form data.
              responses[key] =
                mode === "url" || parsed.value.action !== "accept" ? { action: parsed.value.action } : parsed.value;
            }
            if (!withinBudget(responses))
              throw new ProtocolError(INVALID_PARAMS, "Input responses exceed 64 KiB", {
                reason: "invalid_input_response",
              });
            const storage = self.options.registry.contextFor(
              state.connector,
              self.options.endpoint,
              self.options.requestScope,
            ).storage;
            // Claim before any downstream dispatch, including decline/cancel. A failed
            // or ambiguous continuation must not leave a reusable write permission.
            if (
              !(yield* upwardStep(
                authStorage<boolean>(storage, "compareAndSet", [
                  inputRetryKeys.used(state.nonce),
                  null,
                  "used",
                  {
                    ttlSeconds: REQUEST_STATE_TTL_MS / 1000,
                  },
                ]),
              ))
            )
              return invalidRequestState();
            bindDownstreamContinuation(self.options.requestScope, {
              connector: state.connector,
              address: state.target,
              write: state.tool === "call_destructive_tool",
              privateStates: [
                ...state.previousStates,
                ...(state.requestState !== undefined ? [state.requestState] : []),
              ],
              input: {
                ...(state.requestState !== undefined ? { requestState: state.requestState } : {}),
                inputResponses: responses,
              },
            });
            try {
              const result = yield* upwardStep(
                authInvoke<InputRequiredResult | ToolResult>(self, "finish", [
                  tool,
                  args,
                  context,
                  yield* upwardStep(authCall<ToolResult>(operation, [])),
                  state,
                ]),
              );
              if (!result.isError || !stateObject(result.structuredContent)) return result;
              const error = result.structuredContent.error;
              if (!stateObject(error)) return result;
              // The nonce is spent even when the downstream failure would normally
              // allow a retry. Preserve write reconciliation and auth prerequisites.
              const echoed = downstreamArgumentEcho(self.options.requestScope);
              const structuredContent = {
                ...result.structuredContent,
                error: {
                  ...error,
                  retryable: false,
                  ...(state.tool === "call_tool" && error.nextAction === undefined && error.retry === undefined
                    ? {
                        nextAction: {
                          tool: state.tool,
                          arguments: { address: state.address, ...echoed },
                          purpose:
                            "Re-issue the original direct call without requestState or inputResponses to start a fresh input round. Do not resend this continuation." +
                            (echoed.argsRedacted
                              ? " Re-send the original arguments; sensitive fields are omitted."
                              : args.args !== undefined && !("args" in echoed)
                                ? " Use the exact arguments you sent; they could not be echoed safely."
                                : ""),
                        },
                      }
                    : {}),
                },
              };
              return {
                ...result,
                structuredContent,
                content: [{ type: "text", text: JSON.stringify(structuredContent) }],
              };
            } finally {
              clearDownstreamContinuation(self.options.requestScope);
            }
          }),
          context.mcpReq.signal,
        ).pipe(Effect.provideService(RequestScope, requestOwner((this as DownstreamElicitation).options.requestScope)));
      },
      DownstreamElicitation.prototype.resume,
    );
    registerAuthMethod(
      DownstreamElicitation.prototype,
      "verify",
      function (wrapper: Record<string, unknown>, context: ServerContext) {
        const self = this as DownstreamElicitation;
        return authAwait(
          authFlow<DownstreamRequestState>(function* () {
            const { vault, registry, principal, endpoint } = self.options;
            if (
              !vault?.open ||
              !principal ||
              typeof wrapper.connector !== "string" ||
              !registry.getConnector(wrapper.connector) ||
              typeof wrapper.sealed !== "string" ||
              wrapper.sealed.length > MAX_RELAY_STATE_CHARS
            )
              return invalidRequestState();
            let state: unknown;
            try {
              state = JSON.parse(
                yield* upwardStep(authInvoke<string>(vault, "open", [wrapper.connector, PURPOSE, wrapper.sealed])),
              );
            } catch {
              return invalidRequestState();
            }
            if (
              !stateObject(state) ||
              state.version !== 2 ||
              state.kind !== "downstream" ||
              state.principal !== principal ||
              state.endpoint !== endpoint ||
              state.connector !== wrapper.connector ||
              typeof state.address !== "string" ||
              typeof state.target !== "string" ||
              !state.target.startsWith(`${state.connector}.`) ||
              !["call_tool", "call_destructive_tool"].includes(String(state.tool)) ||
              typeof state.wireTool !== "string" ||
              typeof state.digest !== "string" ||
              !/^[a-f0-9]{64}$/.test(state.digest) ||
              !Number.isSafeInteger(state.expiresAt) ||
              (state.expiresAt as number) <= Date.now() ||
              (state.expiresAt as number) > Date.now() + REQUEST_STATE_TTL_MS ||
              !Number.isInteger(state.round) ||
              (state.round as number) < 1 ||
              (state.round as number) > MAX_INPUT_ROUNDS ||
              typeof state.nonce !== "string" ||
              !/^[a-f0-9-]{36}$/.test(state.nonce) ||
              (state.requestState !== undefined && typeof state.requestState !== "string") ||
              !Array.isArray(state.previousStates) ||
              state.previousStates.length >= (state.round as number) ||
              !state.previousStates.every((value) => typeof value === "string") ||
              !withinBudget([
                ...state.previousStates,
                ...(state.requestState !== undefined ? [state.requestState] : []),
              ]) ||
              !stateObject(state.inputs) ||
              Object.keys(state.inputs).length > MAX_REQUESTS ||
              !Object.entries(state.inputs).every(
                ([wireKey, binding], index) =>
                  wireKey === namespace(wrapper.connector as string, index) &&
                  stateObject(binding) &&
                  typeof binding.key === "string" &&
                  binding.key.length > 0 &&
                  binding.key.length <= 256 &&
                  (binding.mode === "url" || binding.mode === "form"),
              ) ||
              context.mcpReq.method !== "tools/call" ||
              context.http?.req?.headers.get("Mcp-Name") !== state.wireTool
            )
              return invalidRequestState();
            return state as unknown as DownstreamRequestState;
          }),
          context.mcpReq.signal,
        ).pipe(Effect.provideService(RequestScope, requestOwner((this as DownstreamElicitation).options.requestScope)));
      },
      DownstreamElicitation.prototype.verify,
    );
  }
}
