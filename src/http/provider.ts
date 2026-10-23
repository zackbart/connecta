// Internal provider kit (decision 0010, B.4). Unreachable from src/index.ts.
import { Context, Effect, Option } from "effect";
import { api } from "../connectors/api.js";
import type { ApiHandlerContext, ApiOAuthConfig, ApiTool } from "../connectors/api-connector.js";
import { ConnectorCallError } from "../errors.js";
import {
  defineProvider,
  type ProviderDefinition,
  type ProviderFactory,
  type ProviderGuideInput,
  type ProviderOptions,
} from "../provider.js";
import { tracksEveryRequest } from "../provider-call.js";
import { Operation } from "../runtime/call.js";
import { runEdge } from "../runtime/run.js";
import type {
  ConnectorContext,
  ConnectorCredentialConfig,
  ConnectorCredentialValues,
  ConnectorUsageGuide,
  CredentialTestResult,
} from "../types.js";
import { guardedClient, type GuardedOptions } from "./client.js";
import { Refusal, toConnectorCallError, type HttpFailure, type VendorErrors } from "./errors.js";
import { hatch } from "./hatch.js";
import { Grant, grantFromOAuth, refreshOnce } from "./oauth.js";
import { resultSafety, type SafetyOptions } from "./safety.js";
import { Classification, Dispatches, Signal, fromConnectorContext, type CallServices } from "./services.js";
import { connect, operations, type Connection, type ConnectOptions, type Vendor } from "./vendor.js";

type ProbeOperation = Parameters<Connection["send"]>[0];

interface ApiProviderDefinition<O extends ProviderOptions> extends Omit<ProviderDefinition<O>, "kind" | "create"> {
  /** Connection defaults; an explicit options.title still wins. */
  readonly displayTitle?: (options: Readonly<O>) => string;
  readonly description?: (options: Readonly<O>) => string;
  readonly vendor: Vendor;
  readonly baseUrl: (options: Readonly<O>) => string;
  readonly maxResponseBytes: number;
  readonly headers?: GuardedOptions["headers"];
  readonly admit?: GuardedOptions["admit"];
  readonly pageSize?: { readonly default: number; readonly max: number };
  readonly credential?: ConnectorCredentialConfig;
  readonly oauth?: (options: Readonly<O>) => ApiOAuthConfig;
  readonly authenticate: Effect.Effect<Readonly<Record<string, string>>, HttpFailure, CallServices | Grant>;
  readonly errors: VendorErrors;
  readonly safety: (options: Readonly<O>) => SafetyOptions;
  readonly result?: ConnectOptions["result"];
  readonly probe: {
    readonly operation: ProbeOperation;
    readonly request: unknown;
    /** A candidate problem returned before authentication or dispatch. */
    readonly check?: (values: ConnectorCredentialValues, options: Readonly<O>) => string | undefined;
    readonly describe: (reply: unknown, options: Readonly<O>) => string;
  };
  /** Complete guides preserve legacy fragments and option-dependent lines. */
  readonly guide: (options: Readonly<O>) => ProviderGuideInput | ConnectorUsageGuide;
  readonly hatch?: Omit<Parameters<typeof hatch>[0], "connection">;
  readonly tools: (kit: { connection: Connection; pageSize: number; options: Readonly<O> }) => ApiTool[];
}

/** Bind the Promise OAuth facade belonging to this call, never a connection-wide grant. */
const callGrant = Effect.gen(function* () {
  // Operation is bridge metadata, not a service a provider program supplies.
  const operation = yield* Effect.serviceOption(Operation);
  const oauth = Option.isSome(operation) ? (operation.value as ApiHandlerContext | undefined)?.oauth : undefined;
  return oauth ? grantFromOAuth(oauth) : missingGrant;
});
const noGrant = Effect.fail(
  new Refusal({
    error: new ConnectorCallError("auth_required", "This connection has no OAuth grant."),
  }),
);
const missingGrant: Context.Service.Shape<typeof Grant> = {
  token: noGrant,
  refresh: () => noGrant,
  rejected: noGrant,
};

/** An ordinary Promise connector factory; Effect remains inside the kit. */
export function defineApiProvider<O extends ProviderOptions>(definition: ApiProviderDefinition<O>): ProviderFactory<O> {
  const {
    displayTitle,
    description,
    vendor,
    baseUrl,
    maxResponseBytes,
    headers,
    admit,
    pageSize: declaredPageSize,
    credential,
    oauth,
    authenticate,
    errors,
    safety,
    result,
    probe,
    guide,
    hatch: declaredHatch,
    tools,
    ...metadata
  } = definition;
  if (credential !== undefined && oauth !== undefined) {
    throw new Error(`${metadata.title} declares both credential and oauth; declare one authentication method.`);
  }
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new Error(`${metadata.title} maxResponseBytes must be a whole number of bytes >= 1.`);
  }
  const pageSize = declaredPageSize === undefined ? undefined : { ...declaredPageSize };
  if (
    pageSize &&
    (!Number.isSafeInteger(pageSize.default) ||
      !Number.isSafeInteger(pageSize.max) ||
      pageSize.default < 1 ||
      pageSize.max < pageSize.default)
  ) {
    throw new Error(`${metadata.title} pageSize needs positive whole default and max values, with default <= max.`);
  }
  const hatchOptions = declaredHatch ? { ...declaredHatch, verdicts: { ...declaredHatch.verdicts } } : undefined;

  return defineProvider({
    ...metadata,
    kind: "api",
    kit: {
      operations: operations(vendor),
      ...(pageSize ? { pageSize } : {}),
      ...(hatchOptions ? { hatch: { name: hatchOptions.name, verdicts: hatchOptions.verdicts } } : {}),
    },
    create(id, options, provider) {
      const override = "defaultPageSize" in options ? options.defaultPageSize : undefined;
      if (
        override !== undefined &&
        (!pageSize ||
          typeof override !== "number" ||
          !Number.isSafeInteger(override) ||
          override < 1 ||
          override > pageSize.max)
      ) {
        throw new Error(
          `defaultPageSize must be a whole number from 1 to ${pageSize?.max ?? "a declared pageSize maximum"}.`,
        );
      }
      const guarded = guardedClient({
        provider: metadata.title,
        baseUrl: baseUrl(options),
        maxResponseBytes,
        ...(headers === undefined ? {} : { headers }),
        ...(admit === undefined ? {} : { admit }),
        authenticate,
      });
      const connected = connect(vendor, oauth ? refreshOnce(guarded) : guarded, {
        errors,
        safety: resultSafety(safety(options)),
        ...(result ? { result } : {}),
      });
      const authorize = <A>(
        work: Effect.Effect<A, HttpFailure, CallServices | Grant>,
      ): Effect.Effect<A, HttpFailure, CallServices> =>
        work.pipe(Effect.provideServiceEffect(Grant, oauth ? callGrant : Effect.succeed(missingGrant)));
      const connection: Connection = {
        ...connected,
        send: (...args) => authorize(connected.send(...args)),
        sendPath: (...args) => authorize(connected.sendPath(...args)),
        sendItem: (...args) => authorize(connected.sendItem(...args)),
      };
      const test = (values: ConnectorCredentialValues, ctx: ConnectorContext): Promise<CredentialTestResult> => {
        const problem = probe.check?.(values, options);
        if (problem !== undefined) return Promise.resolve({ ok: false, message: problem });
        // api() has already installed anonymous, uncharged candidate services.
        // Bridge those services directly; never copy the supplied context.
        const lease = fromConnectorContext(ctx, "read");
        const signal = Context.get(lease.services, Signal);
        const map = {
          classification: Context.get(lease.services, Classification),
          dispatches: Context.get(lease.services, Dispatches),
          withholds: connection.safety.withholdsErrors,
          signal,
        };
        return runEdge(
          connection.send(probe.operation, probe.request as Parameters<Connection["send"]>[1]).pipe(
            Effect.map(({ data }) => ({ ok: true, message: probe.describe(data, options) })),
            Effect.catch((failure) =>
              Effect.succeed({ ok: false, message: toConnectorCallError(failure, errors, map).message }),
            ),
            Effect.provideContext(lease.services),
            Effect.ensuring(Effect.sync(lease.close)),
          ),
          { signal: ctx.signal },
        );
      };
      const builtTools = tools({
        connection,
        options,
        get pageSize() {
          if (!pageSize) throw new Error("Declare pageSize before using the kit's pageSize.");
          return typeof override === "number" ? override : pageSize.default;
        },
      });
      const usageGuide = guide(options);
      return tracksEveryRequest(
        api(id, {
          ...provider.connectorOptions,
          title: options.title ?? displayTitle?.(options) ?? metadata.title,
          ...(description ? { description: description(options) } : {}),
          usageGuide: "content" in usageGuide ? usageGuide : provider.usageGuide(usageGuide),
          ...(credential
            ? {
                credential,
                testCredential: (value, ctx) => test({ value }, ctx),
                testCredentials: (values, ctx) => test(values, ctx),
              }
            : {}),
          ...(oauth ? { oauth: oauth(options) } : {}),
          tools: [...builtTools, ...(hatchOptions ? hatch({ ...hatchOptions, connection }) : [])],
        }),
      );
    },
  });
}
