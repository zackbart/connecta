// Internal provider kit. Unreachable from src/index.ts.
import { routePhrases, routesOf } from "../agent-routes.js";
import { credentialFailureClass } from "../credential-verification.js";
import { Context, Effect, Option } from "effect";
import { api } from "../connectors/api.js";
import { API_OPTIONS, apiConnector, type ApiOptions } from "../connectors/api-connector.js";
import { assertKnownOptions } from "../config-schema.js";
import { staticOAuth, type SharedOAuthGrant } from "../auth/static-oauth.js";
import { tagAccountRestriction } from "../oauth-account.js";
import { tagGrantOwner } from "../oauth-grant-owner.js";
import { OAUTH_CHALLENGE_MAX_BYTES } from "../auth/renewable-grant.js";
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
import { unsentAfterUnauthorized } from "../write-outcome.js";
import { Operation } from "../runtime/call.js";
import { runEdge } from "../runtime/run.js";
import type {
  Connector,
  ConnectorContext,
  ConnectorCredentialConfig,
  ConnectorCredentialValues,
  ConnectorUsageGuide,
  CredentialTestResult,
} from "../types.js";
import { guardedClient, type GuardedOptions } from "./client.js";
import {
  errorMeanings,
  Refusal,
  toConnectorCallError,
  withheldDefect,
  type HttpFailure,
  type VendorErrors,
} from "./errors.js";
import { hatch, type HatchBinding, type HatchDeclaration } from "./hatch.js";
import { takesIdempotencyKey } from "./tools.js";
import { registerSearchSynonyms } from "../operation-vocabulary.js";
import { Grant, grantFromOAuth, refreshOnce, type GrantRenewal } from "./oauth.js";
import { resultSafety, type SafetyOptions } from "./safety.js";
import {
  Classification,
  Dispatches,
  Signal,
  WriteCapacity,
  fromConnectorContext,
  type CallServices,
} from "./services.js";
import { connect, operations, type Connection, type ConnectOptions, type Vendor } from "./vendor.js";

type ProbeOperation = Parameters<Connection["send"]>[0];

interface ApiProviderDefinition<O extends ProviderOptions> extends Omit<ProviderDefinition<O>, "kind" | "create"> {
  /**
   * Groups of interchangeable search words, each a single lowercase token,
   * such as `[["household", "family"]]` where the vendor names a record
   * differently from its users. Search consults them lexically for this
   * provider's catalog and operation vocabulary only. Declare a group only
   * where the guide or vendor contract establishes the equivalence.
   */
  readonly searchSynonyms?: readonly (readonly string[])[];
  /** Connection defaults; an explicit options.title still wins. */
  readonly displayTitle?: (options: Readonly<O>) => string;
  readonly description?: (options: Readonly<O>) => string;
  /** Deployment mode fixes grant ownership; tool arguments cannot select it. */
  readonly authScope?: (options: Readonly<O>) => "shared" | "personal" | undefined;
  readonly vendor: Vendor;
  readonly baseUrl: (options: Readonly<O>) => string;
  readonly maxResponseBytes: number;
  readonly timeoutMs?: number;
  readonly headers?: GuardedOptions["headers"];
  readonly admit?: GuardedOptions["admit"];
  /** Connection-specific transport settings, built outside every caller context. */
  readonly transport?: (options: Readonly<O>) => Pick<GuardedOptions, "headers" | "admit">;
  readonly defaultCallAdmission?:
    | import("../types.js").ConnectorCallAdmissionPolicy
    | ((options: Readonly<O>) => import("../types.js").ConnectorCallAdmissionPolicy);
  readonly pageSize?: { readonly default: number; readonly max: number };
  /**
   * Whether a write takes an idempotency key the vendor honors. When declared,
   * construction checks it against the kit write builders' `idempotency`
   * declarations, and the generated Writes convention states it.
   */
  readonly idempotencyKey?: boolean;
  readonly credential?: ConnectorCredentialConfig | ((options: Readonly<O>) => ConnectorCredentialConfig);
  /**
   * Static OAuth for a connection. A provider that also declares `grant`
   * answers `undefined` for a connection whose options select the machine
   * grant; a connection never selects both.
   */
  readonly oauth?: (options: Readonly<O>) => ApiOAuthConfig | undefined;
  /** Preserve the static OAuth grant's write-401 diagnostic. */
  readonly oauthWrite401?: "grant";
  /**
   * Renewable machine login, constructed outside every caller context. A
   * provider that also declares `oauth` answers `undefined` for a connection
   * whose options select static OAuth.
   */
  readonly grant?: (
    options: Readonly<O>,
  ) => Effect.Effect<Context.Service.Shape<typeof Grant>, HttpFailure, CallServices> | undefined;
  /** Opt-in machine-grant renewal modes (see GrantRenewal); defaults renew as B.2 describes. */
  readonly grantRenewal?: GrantRenewal;
  readonly authenticate:
    | Effect.Effect<Readonly<Record<string, string>>, HttpFailure, CallServices | Grant>
    | ((options: Readonly<O>) => Effect.Effect<Readonly<Record<string, string>>, HttpFailure, CallServices | Grant>);
  /**
   * `authenticate` headers the vendor documents as a public identifier, not proof of identity.
   * Lowercase names, cited in the provider's evidence. See {@link GuardedOptions}.
   */
  readonly publicIdentifierHeaders?: GuardedOptions["publicIdentifierHeaders"];
  readonly errors: VendorErrors<any>;
  /**
   * Connection-specific wording of `errors`, such as advice that depends on
   * the connection's authentication mode. It must keep `errors`' provider and
   * meanings, which the generated conventions state for every connection.
   */
  readonly connectionErrors?: (options: Readonly<O>) => VendorErrors<any>;
  readonly safety: (options: Readonly<O>) => SafetyOptions;
  readonly result?: ConnectOptions["result"];
  readonly inBandRefusals?: ConnectOptions["inBandRefusals"];
  readonly probe: {
    /** A candidate problem returned before authentication or dispatch. */
    readonly check?: (values: ConnectorCredentialValues, options: Readonly<O>) => string | undefined;
    readonly describe: (reply: unknown, options: Readonly<O>) => string | CredentialTestResult;
    readonly failure?: (error: ConnectorCallError, options: Readonly<O>) => CredentialTestResult | undefined;
  } & (
    | {
        /** Auth-dependent read-only programs use the same candidate services and failure edge. */
        readonly run: (
          connection: Connection,
          options: Readonly<O>,
        ) => Effect.Effect<unknown, HttpFailure, CallServices>;
        readonly operation?: never;
        readonly request?: never;
      }
    | {
        readonly run?: never;
        readonly operation: ProbeOperation;
        readonly request: unknown | ((options: Readonly<O>) => unknown);
      }
  );
  /** Connection context rendered with the maintained guide and selected when-blocks. */
  readonly guide: (options: Readonly<O>) => ProviderGuideInput;
  /** Pure construction-owned adjustment after the normal guide renderer; absent preserves its exact result. */
  readonly transformGuide?: (guide: ConnectorUsageGuide, options: Readonly<O>) => ConnectorUsageGuide;
  /** The standard hatch (decision 0011 S1); `notes` adds connection-dependent description sentences. */
  readonly hatch?: Omit<HatchDeclaration, "binding" | "writeEnabled"> & {
    /** Pure deployment-config selector; absent keeps every reviewed write available. */
    readonly writeEnabled?: (options: Readonly<O>) => boolean;
    readonly binding?: (kit: { connection: Connection; options: Readonly<O> }) => HatchBinding;
    readonly notes?: (options: Readonly<O>) => { readonly read?: string; readonly write?: string };
  };
  readonly tools: (kit: {
    /** The connector id, for a secondary connection's own wording. */
    id: string;
    connection: Connection;
    pageSize: number;
    options: Readonly<O>;
  }) => ApiTool[];
  /**
   * Record construction facts about the built connector, such as whose
   * Workspace account it acts as. Runs once, before anything can serve it;
   * its return value is ignored, so it can neither replace nor wrap it.
   */
  readonly tagConnector?: (connector: Connector, options: Readonly<O>) => void;
}

/** A declared hatch for one connection: its notes resolved from that connection's options. */
function hatchDeclaration<O extends ProviderOptions>(
  declared: NonNullable<ApiProviderDefinition<O>["hatch"]>,
  options: Readonly<O>,
  connection: Connection,
): HatchDeclaration & { readonly notes?: { readonly read?: string; readonly write?: string } } {
  const { notes, binding, writeEnabled, ...rest } = declared;
  return {
    ...rest,
    ...(notes ? { notes: notes(options) } : {}),
    ...(writeEnabled ? { writeEnabled: writeEnabled(options) } : {}),
    ...(binding ? { binding: binding({ connection, options }) } : {}),
  };
}

/**
 * Bind the Promise OAuth facade belonging to this call, never a connection-wide
 * grant. Exported for a provider's secondary connection to the same API.
 */
export const callGrant = Effect.gen(function* () {
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

/**
 * The static OAuth grant's write-401 diagnostic for connector `id`: a write a
 * renewal did not rescue keeps the downstream authorization handoff. Exported
 * for a provider's secondary connection to the same API.
 */
export function oauthGrantRenewal(id: string): NonNullable<Parameters<typeof refreshOnce>[1]> {
  return {
    challengeMaxBytes: OAUTH_CHALLENGE_MAX_BYTES,
    writeUnauthorized: (renewal, routes) =>
      unsentAfterUnauthorized(
        `Connector "${id}"'s API`,
        renewal._tag === "Renewed"
          ? undefined
          : renewal._tag === "Failed"
            ? renewal.failure
            : // Configured with the connection, worded during the call it refuses.
              new ConnectorCallError(
                "downstream_oauth_required",
                `Connector "${id}" requires authorization — ${routePhrases(routes).authorizeAndOpen(id)}.`,
              ),
        "downstream_oauth_required",
      ),
  };
}

/**
 * An `api()` OAuth connector on a grant several connectors share: the one
 * whose id is `grant.owner` holds it, and every other reads and renews it.
 * Each keeps its own `oauth` settings for its calls; their client, endpoints
 * and scope must match the owner's, which the grant's consent requested.
 */
export function apiUsingGrant(id: string, opts: ApiOptions, grant: SharedOAuthGrant): Connector {
  opts = assertKnownOptions(opts, `api(${JSON.stringify(id)})`, API_OPTIONS);
  if (opts.oauth === undefined) throw new Error(`api() connector "${id}" shares an OAuth grant but declares no oauth.`);
  const hooks = staticOAuth(id, opts.oauth, opts.authScope ?? "shared", grant);
  const connector = tagGrantOwner(apiConnector(id, opts, hooks), grant.owner);
  return hooks.account ? tagAccountRestriction(connector, hooks.account) : connector;
}

/** The grant a construction shares, and the OAuth settings its consent requested. */
interface ConstructionGrant {
  readonly grant: SharedOAuthGrant;
  readonly oauth: ApiOAuthConfig;
}

let constructionGrant: ConstructionGrant | undefined;

/**
 * Build connectors whose OAuth-mode connections use `grant` instead of a
 * grant of their own. Construction is synchronous, so the grant reaches only
 * the connectors `build` constructs.
 */
export function constructOnGrant<A>(grant: SharedOAuthGrant, oauth: ApiOAuthConfig, build: () => A): A {
  const outer = constructionGrant;
  constructionGrant = { grant, oauth };
  try {
    return build();
  } finally {
    constructionGrant = outer;
  }
}

/** A product's own OAuth settings on the shared grant: same client and endpoints, the grant's whole scope. */
function onSharedGrant(id: string, own: ApiOAuthConfig, shared: ApiOAuthConfig): ApiOAuthConfig {
  const same: readonly (keyof ApiOAuthConfig)[] = [
    "authorizationEndpoint",
    "tokenEndpoint",
    "issuer",
    "clientId",
    "clientSecret",
    "tokenEndpointAuthMethod",
  ];
  const granted = new Set(shared.scope?.split(" "));
  if (same.some((key) => own[key] !== shared[key]) || own.scope?.split(" ").some((scope) => !granted.has(scope)))
    throw new Error(`Connection "${id}" cannot use a shared OAuth grant whose client, endpoints or scopes differ.`);
  return { ...own, ...(shared.scope !== undefined ? { scope: shared.scope } : {}) };
}

/** An ordinary Promise connector factory; Effect remains inside the kit. */
export function defineApiProvider<O extends ProviderOptions>(definition: ApiProviderDefinition<O>): ProviderFactory<O> {
  const {
    displayTitle,
    description,
    authScope,
    vendor,
    baseUrl,
    maxResponseBytes,
    timeoutMs,
    headers,
    admit,
    transport,
    defaultCallAdmission,
    pageSize: declaredPageSize,
    idempotencyKey,
    credential,
    oauth,
    oauthWrite401,
    grant,
    grantRenewal,
    authenticate,
    publicIdentifierHeaders,
    errors,
    connectionErrors,
    safety,
    result,
    inBandRefusals,
    probe,
    guide,
    transformGuide,
    hatch: declaredHatch,
    tools,
    tagConnector,
    searchSynonyms,
    ...metadata
  } = definition;
  if (
    searchSynonyms !== undefined &&
    !(
      Array.isArray(searchSynonyms) &&
      searchSynonyms.length > 0 &&
      searchSynonyms.length <= 32 &&
      searchSynonyms.every(
        (group) =>
          Array.isArray(group) &&
          group.length > 1 &&
          group.length <= 8 &&
          new Set(group).size === group.length &&
          group.every((word) => /^[a-z][a-z0-9]{0,31}$/.test(word)),
      )
    )
  ) {
    throw new Error(`${metadata.title} searchSynonyms must be 1–32 groups of 2–8 distinct lowercase words.`);
  }
  const synonyms = searchSynonyms?.map((group) => [...group]);
  if (credential !== undefined && oauth !== undefined) {
    throw new Error(`${metadata.title} declares both credential and oauth; declare one authentication method.`);
  }
  if (oauthWrite401 && !oauth) throw new Error("oauthWrite401 requires a static OAuth declaration.");
  if (grantRenewal && !grant) throw new Error("grantRenewal requires a machine grant declaration.");
  const renewalModes = grantRenewal ? { ...grantRenewal } : undefined;
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
  const meanings = errorMeanings(errors);
  if (idempotencyKey !== undefined && typeof idempotencyKey !== "boolean")
    throw new Error(`${metadata.title} idempotencyKey must be true or false when declared.`);
  const hatchOptions = declaredHatch
    ? {
        ...declaredHatch,
        verdicts: { ...declaredHatch.verdicts },
        ...(declaredHatch.named ? { named: { ...declaredHatch.named } } : {}),
      }
    : undefined;

  return defineProvider({
    ...metadata,
    kind: "api",
    kit: {
      operations: operations(vendor),
      ...(hatchOptions
        ? {
            hatch: {
              name: hatchOptions.name,
              verdicts: hatchOptions.verdicts,
              ...(hatchOptions.fieldsRoot ? { fieldsRoot: hatchOptions.fieldsRoot } : {}),
            },
          }
        : {}),
      ...(meanings ? { errors: meanings } : {}),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
    create(id, options, provider) {
      const connectionCredential = typeof credential === "function" ? credential(options) : credential;
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
      const shared = constructionGrant;
      const configured = transport?.(options);
      const machineGrant = grant?.(options);
      const connectionBaseUrl = baseUrl(options);
      // Each connection selects one authentication; the options decide which.
      const oauthConfig = oauth?.(options);
      if (machineGrant && oauthConfig)
        throw new Error(
          `${metadata.title} connection "${id}" selects both a machine grant and static OAuth; its options must choose one.`,
        );
      const oauthWrite401Diagnostic = oauthConfig !== undefined && oauthWrite401 !== undefined;
      const vendorErrors = connectionErrors ? connectionErrors(options) : errors;
      if (
        vendorErrors !== errors &&
        (vendorErrors.provider !== errors.provider ||
          JSON.stringify(errorMeanings(vendorErrors)) !== JSON.stringify(meanings))
      )
        throw new Error(`${metadata.title} connectionErrors must keep the provider name and meanings of errors.`);
      const guarded = guardedClient({
        provider: vendorErrors.provider,
        baseUrl: connectionBaseUrl,
        maxResponseBytes,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(oauthWrite401Diagnostic ? { maxUnauthorizedResponseBytes: OAUTH_CHALLENGE_MAX_BYTES } : {}),
        ...(headers === undefined ? {} : { headers }),
        ...(admit === undefined ? {} : { admit }),
        authenticate: typeof authenticate === "function" ? authenticate(options) : authenticate,
        ...(publicIdentifierHeaders === undefined ? {} : { publicIdentifierHeaders }),
        ...configured,
      });
      const connected = connect(
        vendor,
        oauthConfig || machineGrant
          ? refreshOnce(
              guarded,
              oauthConfig ? (oauthWrite401Diagnostic ? oauthGrantRenewal(id) : undefined) : renewalModes,
            )
          : guarded,
        {
          errors: vendorErrors,
          safety: resultSafety(safety(options)),
          ...(inBandRefusals ? { inBandRefusals } : {}),
          ...(result ? { result } : {}),
        },
      );
      const authorize = <A>(
        work: Effect.Effect<A, HttpFailure, CallServices | Grant>,
      ): Effect.Effect<A, HttpFailure, CallServices> =>
        work.pipe(
          Effect.provideServiceEffect(Grant, machineGrant ?? (oauthConfig ? callGrant : Effect.succeed(missingGrant))),
        );
      const connection: Connection = {
        ...connected,
        send: (...args) => authorize(connected.send(...args)),
        sendPath: (...args) => authorize(connected.sendPath(...args)),
        sendItem: (...args) => authorize(connected.sendItem(...args)),
      };
      // Construct programs outside every caller context; only execution receives candidate services.
      const probeProgram = probe.run
        ? probe.run(connection, options)
        : connection
            .send(
              probe.operation,
              (typeof probe.request === "function" ? probe.request(options) : probe.request) as Parameters<
                Connection["send"]
              >[1],
            )
            .pipe(Effect.map(({ data }) => data));
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
          routes: routesOf(ctx),
        };
        return runEdge(
          probeProgram.pipe(
            Effect.provideService(WriteCapacity, new Map()),
            Effect.flatMap((data) =>
              Effect.try({
                try: () => {
                  const described = probe.describe(data, options);
                  return typeof described === "string" ? { ok: true, message: described } : described;
                },
                catch: (error) => error,
              }).pipe(
                Effect.catch((error) =>
                  error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
                ),
              ),
            ),
            Effect.catch((failure) =>
              Effect.sync(() => {
                const error = toConnectorCallError(failure, vendorErrors, map);
                const described = probe.failure?.(error, options);
                // A provider's own verdict wins; a failure it leaves
                // unclassified takes the class of the typed error behind it.
                if (described?.ok || described?.failure) return described;
                return {
                  ok: false,
                  message: described?.message ?? error.message,
                  failure: credentialFailureClass(error),
                };
              }),
            ),
            Effect.catchDefect((defect) => Effect.die(withheldDefect(defect, map, !!probe.run))),
            Effect.provideContext(lease.services),
            Effect.ensuring(Effect.sync(lease.close)),
          ),
          { signal: ctx.signal },
        );
      };
      const builtTools = tools({
        id,
        connection,
        options,
        get pageSize() {
          if (!pageSize) throw new Error("Declare pageSize before using the kit's pageSize.");
          return typeof override === "number" ? override : pageSize.default;
        },
      });
      const hatchTools = hatchOptions
        ? hatch({ ...hatchDeclaration(hatchOptions, options, connection), connection })
        : [];
      // The declared fact the Writes convention states must match what the write builders send.
      if (idempotencyKey !== undefined && [...builtTools, ...hatchTools].some(takesIdempotencyKey) !== idempotencyKey)
        throw new Error(
          `${metadata.title} declares idempotencyKey: ${idempotencyKey}, but its write tools ${idempotencyKey ? "send no" : "send an"} idempotency key.`,
        );
      const renderedGuide = provider.usageGuide(guide(options));
      const connectionScope = authScope?.(options);
      const build = (apiOptions: Parameters<typeof api>[1]) =>
        shared && oauthConfig
          ? apiUsingGrant(id, { ...apiOptions, oauth: onSharedGrant(id, oauthConfig, shared.oauth) }, shared.grant)
          : api(id, apiOptions);
      const connector = tracksEveryRequest(
        build({
          ...(defaultCallAdmission
            ? {
                callAdmission:
                  typeof defaultCallAdmission === "function" ? defaultCallAdmission(options) : defaultCallAdmission,
              }
            : {}),
          ...provider.connectorOptions,
          ...(connectionScope ? { authScope: connectionScope } : {}),
          title: options.title ?? displayTitle?.(options) ?? metadata.title,
          ...(description ? { description: description(options) } : {}),
          usageGuide: transformGuide ? transformGuide(renderedGuide, options) : renderedGuide,
          ...(connectionCredential
            ? {
                credential: connectionCredential,
                testCredential: (value, ctx) => test({ value }, ctx),
                testCredentials: (values, ctx) => test(values, ctx),
              }
            : {}),
          ...(oauthConfig ? { oauth: oauthConfig } : {}),
          tools: [...builtTools, ...hatchTools],
        }),
      );
      tagConnector?.(connector, options);
      if (synonyms) registerSearchSynonyms(connector, synonyms);
      return connector;
    },
  });
}
