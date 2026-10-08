import { Effect } from "effect";
import { classifyCallError, ConnectorCallError } from "./errors.js";
import { InvocationFailure, timed } from "./invocation.js";
import type { RegistryView } from "./registry.js";
import { withDeadlineEffect } from "./runtime/run.js";
import { sentSecretsFor, type SentSecrets } from "./sent-secrets.js";
import { hasControlCharacters } from "./tool-name.js";
import type { Connector } from "./types.js";

const encoder = new TextEncoder();
const URI_HINT = "Use resource://<connectorId>/<encodeURIComponent(downstreamUri)> with a whole-connector grant.";

/** Parse once without URL normalization or interpreting the downstream URI. */
function resourceTarget(registry: RegistryView, raw: unknown): { connector: Connector; uri: string } {
  const invalid = () => new ConnectorCallError("invalid_args", `Invalid resource URI. ${URI_HINT}`);
  if (typeof raw !== "string" || raw.length > 8192 || encoder.encode(raw).length > 8192) throw invalid();
  const match = /^resource:\/\/([a-z0-9_-]+)\/(.+)$/.exec(raw);
  if (!match) throw invalid();
  let uri: string;
  try { uri = decodeURIComponent(match[2]!); }
  catch { throw invalid(); }
  if (encodeURIComponent(uri) !== match[2] || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri) || hasControlCharacters(uri)) throw invalid();
  const connector = registry.getResourceConnector(match[1]!);
  if (!connector?.readResource) {
    throw new InvocationFailure({ code: "unknown_address", message: `No resource reader is available for this address. ${URI_HINT}`, retryable: false });
  }
  return { connector, uri };
}

/** A protocol read, under the same request scope, call permit and deadline as tools. */
export function readResource(
  registry: RegistryView,
  raw: unknown,
  options: {
    baseUrl: string;
    requestScope: object;
    sentSecrets: SentSecrets;
    timeoutMs: number;
    signal?: AbortSignal;
    onConnectorTime?: (elapsed: number) => void;
  },
): Effect.Effect<unknown, InvocationFailure> {
  let connector: Connector | undefined;
  return withDeadlineEffect(signal => Effect.scoped(Effect.gen(function* () {
    const target = yield* Effect.try({ try: () => resourceTarget(registry, raw), catch: error => error });
    connector = target.connector;
    // Await this Promise in the reader's request context, as invocation.ts does.
    yield* Effect.acquireRelease(
      Effect.suspend(() => {
        const pending = registry.admitCall(target.connector.id, { toolName: "resources/read", args: { uri: target.uri }, signal });
        return Effect.tryPromise({ try: () => pending, catch: error => error }).pipe(
          Effect.onInterrupt(() => Effect.sync(() => { pending.then(permit => permit.release(), () => {}); })),
        );
      }),
      permit => Effect.sync(() => permit.release()),
      { interruptible: true },
    );
    return yield* timed(elapsed => options.onConnectorTime?.(elapsed), Effect.tryPromise({
      try: () => {
        if (signal.aborted) throw signal.reason;
        const ctx = registry.contextFor(target.connector.id, options.baseUrl, options.requestScope, { signal, timeoutMs: options.timeoutMs });
        options.sentSecrets.include(sentSecretsFor(ctx));
        if (target.connector.credential && !ctx.credential) {
          throw new ConnectorCallError("auth_required", "Operator-managed credential storage is not configured.");
        }
        return target.connector.readResource!(target.uri, ctx);
      },
      catch: error => error,
    }));
  })), {
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutError: new ConnectorCallError("timeout", `Resource read timed out after ${options.timeoutMs}ms.`),
  }).pipe(Effect.catch(error => {
    let details = options.signal?.aborted
      ? { code: "cancelled", message: "Resource read was cancelled because the run ended.", retryable: false }
      : error instanceof InvocationFailure ? error.details : classifyCallError(options.sentSecrets.redact(error));
    if (connector && (details.code === "auth_required" || details.code === "downstream_oauth_required")) {
      details = {
        ...details,
        connector: connector.id,
        recovery: connector.startAuth ? "oauth" : registry.credentialUiAvailable() && connector.credential &&
          registry.contextFor(connector.id, options.baseUrl, options.requestScope).credential ? "operator_config" : "unavailable",
        nextAction: { tool: "authorize_connector", arguments: { connector: connector.id }, operatorHandoff: "Give the URL and instructions it returns to the operator." },
        retry: "Retry connecta.read with the same resource URI after the operator completes recovery.",
      };
    }
    return Effect.fail(new InvocationFailure(options.sentSecrets.redact(details)));
  }));
}
