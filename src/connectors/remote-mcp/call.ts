// tools/call: classification, write-once dispatch and the write's outcome
// when it fails.
import { authView } from "../../auth/native-call.js";
import { authFlow, authCall, authInvoke, authMethod, authCatch } from "../../auth/native.js";
import {
  Client,
  ProtocolError,
  isInputRequiredResult,
  fromJsonSchema,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type { JsonSchemaType, CallToolResult, StandardSchemaV1, Tool } from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { requestSentSecrets } from "../../sent-secrets.js";
import { ConnectorCallError } from "../../errors.js";
import { carryFailureFacts, failureRecord } from "../../operator-record.js";
import { assertDownstreamOutputSafe } from "../../downstream-input-context.js";
import { callClassification } from "../../call-classification.js";
import { sourceClassification } from "../../tool-safety.js";
import {
  enterProviderBoundary,
  knownProviderFailure,
  providerRequest,
  vendorRefusal,
  type ProviderRequest,
} from "../../provider-call.js";
import { providerCallFailure, unsentAfterUnauthorized } from "../../write-outcome.js";
import type { ConnectorContext, ToolDef } from "../../types.js";
import type { RemoteMcpRuntime, RemoteMcpShared } from "./runtime.js";
import type { ConnectionState } from "./connection.js";
import { type CallDispatch, newDispatch, withDispatch } from "./transport.js";
import { downstreamCallError, hasSdkPayload, ownAbortReason, requiresAuthorization } from "./errors.js";

/** One connector's callTool operation, before the entry's wrappers. */
export function remoteMcpCall(rt: RemoteMcpRuntime): Pick<RemoteMcpShared, "callToolOperation"> {
  const { isOauth, id } = rt;

  const callToolOperation = authMethod(
    (
      name: string,
      args: unknown,
      ctx: ConnectorContext,
      options:
        | {
            definition?: ToolDef;
            input?:
              | {
                  requestState?: string;
                  inputResponses: Record<string, unknown>;
                }
              | undefined;
          }
        | undefined,
    ) =>
      authFlow<CallToolResult>(function* () {
        enterProviderBoundary(ctx, rt.connector);
        let active:
          | {
              state: ConnectionState;
              client: Client;
              dispatch: CallDispatch;
              write: boolean;
            }
          | undefined;
        try {
          return (yield authView(
            ctx,
            authMethod(() =>
              authFlow<CallToolResult>(function* () {
                const state = rt.stateFor(ctx);
                const client = (yield authCatch(authCall(rt.ensureConnected, [ctx, state]), (error: unknown) => {
                  throw knownProviderFailure(error);
                })) as Client;
                if (isOauth)
                  (yield authCatch(authCall(rt.renewBeforeDispatch, [ctx, state, client]), (error: unknown) => {
                    throw knownProviderFailure(error);
                  })) as void;
                const definition = options?.definition;
                const facts = definition ?? state.toolDefinitions.get(name) ?? { name };
                const sourceFacts = definition ?? {
                  name,
                  ...(facts.annotations
                    ? { annotations: facts.annotations as NonNullable<ToolDef["annotations"]> }
                    : {}),
                };
                const source = sourceClassification(sourceFacts);
                const serverWrite = source === "write";
                const write =
                  serverWrite || (callClassification(ctx) ?? definition?.classification ?? source) === "write";
                const dispatch = newDispatch(write, serverWrite);
                dispatch.request = {
                  entry: providerRequest(ctx, !write, `Connector "${id}"'s MCP server`, { method: "POST" }),
                  ctx,
                };
                active = { state, client, dispatch, write };
                state.dispatches.set(dispatch, name);
                const toolDefinition = definition
                  ? {
                      ...definition,
                      inputSchema: (definition.inputSchema ?? { type: "object" }) as Tool["inputSchema"],
                    }
                  : state.toolDefinitions.get(name);
                if (toolDefinition?.execution?.taskSupport === "required") {
                  throw new ConnectorCallError(
                    "connector_call_failed",
                    `Tool "${name}" requires task-based execution, which Connecta does not support.`,
                  );
                }
                let output: StandardSchemaV1 | undefined;
                const outputError = (code: number, message: string): unknown =>
                  rt.atMcpBoundary(ctx, new ProtocolError(code, message), "tools/call", client.transport, [ctx.signal]);
                if (toolDefinition?.outputSchema) {
                  try {
                    output = fromJsonSchema(toolDefinition.outputSchema as JsonSchemaType);
                  } catch {
                    throw outputError(
                      -32602,
                      `Tool '${name}' has an invalid outputSchema: schema could not be compiled`,
                    );
                  }
                }
                const result = (yield authCatch(
                  authInvoke(client, "callTool", [
                    withDispatch(
                      {
                        name,
                        arguments: (args ?? {}) as Record<string, unknown>,
                        ...options?.input,
                      },
                      dispatch,
                    ),
                    {
                      ...rt.requestOptions(ctx),
                      allowInputRequired: true,
                      ...(toolDefinition
                        ? { toolDefinition: { ...toolDefinition, outputSchema: undefined } }
                        : write
                          ? { toolDefinition: { name, inputSchema: { type: "object" } as Tool["inputSchema"] } }
                          : {}),
                    },
                  ]),
                  (err: unknown) => {
                    assertDownstreamOutputSafe(ctx.requestScope ?? ctx, err);
                    throw rt.atMcpBoundary(ctx, err, "tools/call", client.transport, [ctx.signal]);
                  },
                )) as CallToolResult;
                if (isInputRequiredResult(result)) {
                  return result;
                }
                assertDownstreamOutputSafe(ctx.requestScope ?? ctx, result);
                if (output && !result.isError) {
                  if (result.structuredContent === undefined)
                    throw outputError(
                      -32600,
                      `Tool ${name} has an output schema but did not return structured content`,
                    );
                  const validation = (yield authInvoke(output["~standard"], "validate", [
                    result.structuredContent,
                  ])) as StandardSchemaV1.Result<unknown>;
                  if (validation.issues)
                    throw outputError(
                      -32602,
                      "Structured content does not match the tool's output schema: validation failed",
                    );
                }
                return result;
              }),
            ),
          )) as CallToolResult;
        } catch (err) {
          if (!active) throw knownProviderFailure(err);
          const { state, client, dispatch, write } = active;
          const direct = write && callClassification(ctx) === undefined;
          const ownAbort = ownAbortReason(err, [ctx.signal]) && !hasSdkPayload(err);
          // The SDK can reject its wait synchronously from the abort event,
          // before the physical response's Promise observer records its facts.
          // Yield only settlement; no closed caller regains live authority.
          if (ownAbort) yield Effect.yieldNow;
          if (ownAbort && !direct) throw err;
          if (requiresAuthorization(err) && state.client === client) state.authRequired = true;
          const failure = ownAbort
            ? err
            : err instanceof UnauthorizedError
              ? carryFailureFacts(err, rt.authRequiredError(ctx))
              : downstreamCallError(err, undefined, undefined, undefined, requestSentSecrets(ctx));
          if (!write) throw failure;
          const renewal = dispatch.request?.entry.renewed
            ? undefined
            : dispatch.resendRefused
              ? rt.authRequiredError(ctx)
              : failure;
          const unsent = (entry: ProviderRequest | undefined) => {
            const verdict = unsentAfterUnauthorized(
              `Connector "${id}"'s MCP server`,
              renewal,
              isOauth ? "downstream_oauth_required" : "auth_required",
            );
            return entry ? vendorRefusal(verdict, entry) : verdict;
          };
          const verdict = dispatch.unauthorized
            ? unsent(dispatch.request?.entry)
            : dispatch.redirected || dispatch.resendRefused
              ? new ConnectorCallError(
                  "connector_call_failed",
                  `Connector "${id}"'s MCP server ` +
                    (dispatch.redirected
                      ? "answered this write with a redirect, and the write was not sent again, "
                      : "was sent this write, and a second send of it was stopped, ") +
                    "so whether it took effect is unknown: check the target before repeating it.",
                  { retryable: false, writeOutcome: "unknown" },
                )
              : dispatch.ambiguous && failure instanceof ConnectorCallError
                ? new ConnectorCallError(
                    failure.code,
                    `${failure.message} Connector "${id}"'s MCP server answered this write with an HTTP error ` +
                      "and no MCP error, so whether it took effect is unknown: check the target before repeating it.",
                    { retryable: false, writeOutcome: "unknown" },
                  )
                : failure;
          const vendor = { title: `connector "${id}"` };
          const status = failureRecord({}, err).httpStatus;
          const settled = providerCallFailure(ctx, vendor, verdict, {
            dispatched: dispatch.sent,
            ...(status === undefined ? {} : { status }),
            fallback: "write",
            request: dispatch.request?.entry,
          });
          throw settled === failure ? failure : carryFailureFacts(failure, settled);
        } finally {
          if (active) active.state.dispatches.delete(active.dispatch);
        }
      }),
  );
  return { callToolOperation };
}
