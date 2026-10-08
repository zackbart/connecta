// The one shape every maintained provider takes. Deliberately transport-free:
// it imports neither `remoteMcp()` nor `api()`, so an `api()` provider does not
// acquire the MCP client, OAuth, or Effect graph by using it, and a hosted
// provider does not acquire `api()`. Its runtime imports validate plain
// options and reviewed classification, with no I/O.
import { array, assertKnownOptions, keys, optionsOf, type Field } from "./config-schema.js";
import { reviewedClassification } from "./catalog-drift.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
  ConnectorCallAdmissionRule,
  ConnectorDescription,
  ConnectorRollingWindowBudget,
  ConnectorUsageGuide,
  ToolClassification,
} from "./types.js";

/**
 * How a provider reaches its vendor: the vendor's hosted MCP server, an
 * `api()` connector over the vendor's HTTP API, or one connector composing
 * both with an explicit operation ownership map.
 */
export type ProviderKind = "mcp" | "api" | "composed";

/** Options every provider accepts, validated before `create` runs. */
export interface ProviderOptions {
  /** What this connection is for and which decisions it answers. Required. */
  purpose: string;
  /** Display name; each provider chooses its own default. */
  title?: string;
  /** Deployment conventions, appended after the maintained guide. */
  instructions?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Optional per-runtime downstream call-admission policy. */
  callAdmission?: ConnectorCallAdmissionPolicy;
}

const budget = optionsOf<ConnectorRollingWindowBudget>()(keys("kind", "maxCalls", "windowMs"));

const admissionRule = optionsOf<ConnectorCallAdmissionRule>()({
  ...keys("maxConcurrency", "maxQueueSize", "queueTimeoutMs", "retryAfterMs", "partitionKey"),
  budget,
});

export const CALL_ADMISSION = optionsOf<ConnectorCallAdmissionPolicy>()({
  ...keys("maxPartitions"),
  rules: array(admissionRule),
});

/** Options every maintained provider shares. */
export const PROVIDER_COMMON = {
  ...keys("title", "authScope", "purpose", "instructions", "maxResultBytes"),
  callAdmission: CALL_ADMISSION,
};

/** The provider's maintained, connection-independent usage guide. */
export interface ProviderSkill {
  /**
   * Markdown rendered after the heading and the connection context. It states
   * conventions the vendor's schemas cannot carry, and never varies by
   * deployment.
   */
  content: string;
  /** Heading for deployment instructions, such as `"Workspace instructions"`. */
  instructionsHeading: string;
  /** Exact generated guide fragments used by existing renderers. */
  fragments?: Readonly<Record<string, string>>;
}

/** Connection facts a provider renders around its maintained guide. */
export interface ProviderGuideInput {
  /**
   * Paragraphs that lead the guide: access mode, purpose, region, account
   * scope. The first is what discovery summarizes when `summary` is omitted.
   */
  context: readonly string[];
  /** Replaces the default `<title> usage` heading. */
  heading?: string;
  /** Discovery summary; see `ConnectorUsageGuide.summary`. */
  summary?: string;
  /** See `ConnectorUsageGuide.required`. */
  required?: boolean;
}

/** What `defineProvider()` hands `create` after validating its options. */
export interface ProviderContext {
  /** The definition's reviewed classification, for `remoteMcp({ classify })`. */
  readonly classify?: ToolClassification;
  /**
   * Common connector options the deployment set, and only those, ready to
   * spread into `remoteMcp()` or `api()` options.
   */
  readonly connectorOptions: Readonly<Pick<ProviderOptions, "authScope" | "maxResultBytes" | "callAdmission">>;
  /**
   * Render the maintained skill with this connection's context and the
   * deployment's instructions. Instructions are appended; they never replace
   * the maintained text.
   */
  usageGuide(input: ProviderGuideInput): ConnectorUsageGuide;
}

export interface ProviderDefinition<O extends ProviderOptions> {
  /**
   * Stable lowercase name: the `providers/<name>` subpath and the default
   * factory name in construction errors.
   */
  name: string;
  /** Vendor display name, and the default guide heading. */
  title: string;
  kind: ProviderKind;
  skill: ProviderSkill;
  /** Maintained display name in the generated README inventory. */
  readme?: string;
  /** Reviewed build facts; generation never raises an observed cap. */
  bundle?: { baselineGzip: number; maxGzip: number; note?: string };
  /** Closed factory options, declared with `optionsOf<O>()` for key parity. */
  options: Field<unknown, unknown>;
  /**
   * Reviewed classification of the vendor's hosted MCP catalog. Hosted and
   * composed providers pass it to `remoteMcp({ classify })` through
   * `ProviderContext.classify`, so the verdicts that classify live tools and
   * the record a drift check reads cannot disagree. `api()` providers annotate
   * each tool they author and must omit it.
   */
  classify?: ToolClassification;
  /**
   * Build the connector. Runs synchronously at construction after its closed
   * options and common values are validated. Throw here for provider-specific
   * mistakes.
   */
  create(id: string, options: Readonly<O>, provider: ProviderContext): Connector;
}

/** A provider's factory, carrying the definition build and check tools read. */
export interface ProviderFactory<O extends ProviderOptions> {
  (id: string, options: O): Connector;
  readonly definition: Readonly<ProviderDefinition<O>>;
}

const PROVIDER_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const KINDS: ReadonlySet<string> = new Set(["mcp", "api", "composed"]);

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Define a maintained provider: one validated description and one factory.
 *
 * Definition mistakes throw when the provider module loads. Closed-option
 * and common-value mistakes throw before `create` runs,
 * so a deployment never boots in the wrong shape (INV-11).
 */
export function defineProvider<O extends ProviderOptions>(definition: ProviderDefinition<O>): ProviderFactory<O> {
  const label = `defineProvider("${String(definition?.name)}")`;
  if (!nonEmpty(definition?.name) || !PROVIDER_NAME.test(definition.name)) {
    throw new Error(`${label} name must be lowercase words joined by hyphens.`);
  }
  if (!nonEmpty(definition.title)) {
    throw new Error(`${label} requires a non-empty title.`);
  }
  if (!KINDS.has(definition.kind)) {
    throw new Error(`${label} kind must be "mcp", "api", or "composed".`);
  }
  if (!nonEmpty(definition.skill?.content) || !nonEmpty(definition.skill.instructionsHeading)) {
    throw new Error(`${label} skill requires non-empty content and instructionsHeading.`);
  }
  if (definition.classify !== undefined && definition.kind === "api") {
    throw new Error(
      `${label} is an api() provider; annotate each authored tool instead of classifying a hosted catalog.`,
    );
  }
  if (!definition.options?.shape && !definition.options?.variants) {
    throw new Error(`${label} requires a closed options shape from optionsOf().`);
  }
  // A validated, deep-frozen copy. The definition is what build and check
  // tools read and what every later connector classifies with, so nothing
  // reachable from it may change a verdict after review: neither the
  // caller's original object nor a write through `factory.definition`.
  const classify = definition.classify === undefined ? undefined : reviewedClassification(definition.classify, label);
  if (typeof definition.create !== "function") {
    throw new Error(`${label} requires a create function.`);
  }
  const frozen: Readonly<ProviderDefinition<O>> = Object.freeze({
    ...definition,
    skill: Object.freeze({
      ...definition.skill,
      ...(definition.skill.fragments ? { fragments: Object.freeze(definition.skill.fragments) } : {}),
    }),
    ...(definition.bundle ? { bundle: Object.freeze({ ...definition.bundle }) } : {}),
    ...(classify !== undefined ? { classify } : {}),
  });
  const factoryName = `${frozen.name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())}()`;

  const factory = (id: string, options: O): Connector =>
    asProvider(frozen.name, frozen.options, id, options, (id, options) => {
      const at = `${factoryName.slice(0, -2)}(${JSON.stringify(id)})`;
      if (typeof options !== "object" || options === null) {
        throw new Error(`${factoryName} requires an options object.`);
      }
      if (!nonEmpty(options.purpose)) {
        throw new Error(
          `${at} requires a non-empty purpose: what this connection is for and which decisions it answers.`,
        );
      }
      if (options.title !== undefined && !nonEmpty(options.title)) {
        throw new Error(`${at} title must be a non-empty string when set.`);
      }
      if (options.instructions !== undefined && typeof options.instructions !== "string") {
        throw new Error(`${at} instructions must be a string when set.`);
      }
      if (options.authScope !== undefined && options.authScope !== "shared" && options.authScope !== "personal") {
        throw new Error(`${at} authScope must be "shared" or "personal".`);
      }
      const resolved: Readonly<O> = { ...options, purpose: options.purpose.trim() };
      const instructions = options.instructions?.trim();
      const connector = frozen.create(id, resolved, {
        ...(frozen.classify !== undefined ? { classify: frozen.classify } : {}),
        connectorOptions: {
          ...(options.authScope !== undefined ? { authScope: options.authScope } : {}),
          ...(options.maxResultBytes !== undefined ? { maxResultBytes: options.maxResultBytes } : {}),
          ...(options.callAdmission !== undefined ? { callAdmission: options.callAdmission } : {}),
        },
        usageGuide(input) {
          const heading = input.heading ?? `${frozen.title} usage`;
          const body = [...input.context, frozen.skill.content.trim()].join("\n\n");
          return {
            content:
              `# ${heading}\n\n${body}\n` +
              (instructions ? `\n## ${frozen.skill.instructionsHeading}\n\n${instructions}\n` : ""),
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
            ...(input.required === true ? { required: true } : {}),
          };
        },
      });
      if (connector?.id !== id) {
        throw new Error(`${at} create() must return a connector with id "${id}".`);
      }
      return connector;
    });
  // Frozen whole: build and check tools read `definition` to learn what the
  // factory classifies, so neither replacing nor deleting it may take effect.
  return Object.freeze(Object.assign(factory, { definition: frozen }));
}

/**
 * Attach the same validated definition to an existing provider constructor.
 * Its option policy stays in its builder during the mechanical folder move;
 * adopting defineProvider's common-value policy is a separate conversion.
 */
export function asProviderFactory<O extends ProviderOptions>(
  definition: Omit<ProviderDefinition<O>, "create"> & {
    create(id: string, options: Readonly<O>): Connector;
  },
): ProviderFactory<O> {
  const frozen = defineProvider(definition).definition;
  const create = definition.create;
  const factory = (id: string, options: O): Connector => asProvider(frozen.name, frozen.options, id, options, create);
  Object.defineProperty(factory, "name", {
    value: frozen.name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
  });
  return Object.freeze(Object.assign(factory, { definition: frozen }));
}

/**
 * Build a maintained provider's connector: refuse unknown options and
 * accessors by path before the builder reads any of them, then stamp the
 * provider onto its description, so the operator surface can say "Linear"
 * rather than "remote MCP". This is the same construction path defineProvider
 * uses; existing constructors retain their provider-specific option policy.
 */
function asProvider<O, C extends { describe?(): ConnectorDescription }>(
  provider: string,
  shape: Field<unknown, unknown>,
  id: string,
  options: O,
  build: (id: string, options: O) => C,
): C {
  // The factory a deployment called: "planning-center" is planningCenter().
  const factory = provider.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  let connector: C;
  try {
    options = assertKnownOptions(options, `${factory}(${JSON.stringify(id)})`, shape);
    connector = build(id, options);
  } catch (error) {
    throw providerConstructionError(factory, id, error);
  }
  const describe = connector.describe?.bind(connector);
  const ownDescribe = Object.getOwnPropertyDescriptor(connector, "describe");
  // Keep the receiver of prototype methods (including private fields). When
  // the description cannot be replaced, inherit the whole connector instead
  // of copying it: decorators may inherit their id, methods, and review.
  const stamped =
    Object.isExtensible(connector) && (!ownDescribe || ownDescribe.configurable)
      ? connector
      : (Object.create(connector) as C);
  Object.defineProperty(stamped, "describe", {
    configurable: true,
    enumerable: false,
    value: (): ConnectorDescription => {
      const base = describe?.() ?? { source: { kind: "custom" as const } };
      return { ...base, source: { ...base.source, provider } };
    },
  });
  return stamped;
}

/** Keep vendor-specific refusals in one construction-error format. */
function providerConstructionError(provider: string, id: string, error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const at = `${provider}(${JSON.stringify(id)})`;
  // The same helper handles legacy provider validation and shared config
  // validation. Retain the original error class and the actionable detail.
  const prefix = error.message.startsWith(at) ? at : error.message.startsWith(`${provider}()`) ? `${provider}()` : "";
  const detail = error.message
    .slice(prefix.length)
    .trimStart()
    .replace(/^\./, "")
    .replace(/^requires\s+/, "")
    .replace(/^must be /, "")
    .replace(/^(.+) must be /, "$1 to be ")
    .replace(/^declares /, "a consistent declaration of ")
    .replace(/^with headers or credential auth requires /, "headers or credential auth to declare ");
  error.message = `${at} requires ${detail}`;
  return error;
}
