// Transport-free maintained API provider definitions and construction validation.
import {
  array,
  assertKnownOptions,
  ConfigError,
  fn,
  keys,
  object,
  opaque,
  required,
  whole,
  type Field,
} from "./config-schema.js";
import { aliasCallIdentity } from "./provider-call-facts.js";
import { isConnectorCallErrorCode, type ConnectorCallErrorCode } from "./errors.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
  ConnectorCallAdmissionRule,
  ConnectorDescription,
  ConnectorRollingWindowBudget,
  ConnectorUsageGuide,
} from "./types.js";

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
  /** Serve only read-classified tools on every endpoint. Defaults to false. */
  readOnly?: boolean;
  /** Optional per-runtime downstream call-admission policy. */
  callAdmission?: ConnectorCallAdmissionPolicy;
}

const budget = {
  ...object({
    kind: required(
      opaque<ConnectorRollingWindowBudget["kind"]>({
        check(value, path) {
          if (value !== "rolling-window") throw new ConfigError(`${path} must be "rolling-window".`);
        },
      }),
    ),
    maxCalls: required(whole({ min: 1 })),
    windowMs: required(whole({ min: 1 })),
  }),
  absent: () => undefined,
};

const admissionRule = object({
  maxConcurrency: whole({ min: 1 }),
  maxQueueSize: whole({ min: 0 }),
  queueTimeoutMs: whole({ min: 1 }),
  retryAfterMs: whole({ min: 0 }),
  partitionKey: fn<NonNullable<ConnectorCallAdmissionRule["partitionKey"]>>(),
  budget,
});

const admissionPolicy = object({
  maxPartitions: whole({ min: 1 }),
  rules: required(array(admissionRule)),
});

export const CALL_ADMISSION: Omit<Field<unknown, ConnectorCallAdmissionPolicy | undefined, true>, "parse"> & {
  parse(value: unknown, path: string): ConnectorCallAdmissionPolicy;
  readonly shape: typeof admissionPolicy.shape;
} = {
  ...admissionPolicy,
  absent: () => undefined,
  parse(value: unknown, path: string): ConnectorCallAdmissionPolicy {
    const policy = admissionPolicy.parse(assertKnownOptions(value, path, admissionPolicy), path);
    if (policy.rules.length !== 1) {
      throw new ConfigError(`${path}.rules must contain exactly one rule in this release.`);
    }
    const rule = policy.rules[0]!;
    if (rule.maxConcurrency === undefined && rule.budget === undefined) {
      throw new ConfigError(`${path} rule must declare maxConcurrency or budget.`);
    }
    if (
      rule.maxConcurrency === undefined &&
      (rule.maxQueueSize !== undefined || rule.queueTimeoutMs !== undefined || rule.retryAfterMs !== undefined)
    ) {
      throw new ConfigError(`${path} queue settings require maxConcurrency.`);
    }
    // object() omits undefined children; its resolved type lists every key.
    return policy as ConnectorCallAdmissionPolicy;
  },
};

/** Validate the common connector policy before a deployment can serve. */
export const READ_ONLY = opaque<boolean>({
  check(value, path) {
    if (typeof value !== "boolean") throw new ConfigError(`${path} must be a boolean.`);
  },
});

/** Options every maintained provider shares. */
export const PROVIDER_COMMON = {
  ...keys("title", "authScope", "purpose", "instructions", "maxResultBytes"),
  readOnly: READ_ONLY,
  callAdmission: CALL_ADMISSION,
};

/** The provider's maintained, connection-independent usage guide. */
export interface ProviderSkill {
  /**
   * Markdown rendered after the heading and the connection context. It states
   * conventions the vendor's schemas cannot carry, and never varies by
   * deployment. A standard guide (decision 0011, G) is `SKILL.md`'s body
   * followed by its generated `## Conventions`; text that differs by
   * implementation or option stands in `<!-- when: <key> -->` …
   * `<!-- end -->` blocks the definition's `blocks` selects.
   */
  content: string;
  /** Heading for deployment instructions, such as `"Workspace instructions"`. */
  instructionsHeading: string;
  /** Exact generated guide fragments used by existing renderers. */
  fragments?: Readonly<Record<string, string>>;
}

/**
 * The closed key set of a guide's `<!-- when: <key> -->` blocks and the pure
 * selector that picks a connection's keys from its options (decision 0011,
 * G2). Select only the blocks this API configuration uses.
 */
export interface ProviderGuideBlocks<O> {
  readonly keys: readonly string[];
  /** The keys whose blocks this connection renders, in any order. */
  select(options: Readonly<O>): readonly string[];
}

/**
 * Facts the provider kit (decision 0010) declares for `providers:generate`:
 * `drift.json`'s `generated.operations` and the guide's Conventions. Plain
 * data, never read at runtime. The kit's `defineApiProvider` sets them.
 */
export interface ProviderKitFacts {
  /** `manifest(vendor)`: every operation the provider's tools send, as `"METHOD /path"`. */
  readonly operations: readonly string[];
  /** The `limit` default and maximum every paged read declares. */
  readonly pageSize?: { readonly default: number; readonly max: number };
  /** The hatch's tool prefix and its reviewed verdict per `"METHOD /path"`. */
  readonly hatch?: {
    readonly name: string;
    readonly verdicts: Readonly<Record<string, "read" | "write" | "destructive" | "refuse">>;
    /** Separate-cursor paging opts into the generated hatch paging convention. */
    readonly paging?: "argument" | "parameter";
    readonly fieldsRoot?: string;
  };
  /**
   * The vendor's declared error meanings, for the Errors convention: the code
   * an unknown id fails with, whether it proves absence, and each documented
   * conflict source.
   */
  readonly errors?: {
    readonly unknownId: ConnectorCallErrorCode;
    readonly provesAbsence: boolean;
    readonly conflicts: readonly string[];
  };
  /** Whether a write takes an idempotency key the vendor honors, checked against the built tools. */
  readonly idempotencyKey?: boolean;
  /**
   * Set only when the hatch refuses a write carrying a withheld placeholder
   * value; the Withheld values convention promises exactly that. The kit sets
   * it for its standard hatch; kit write builders refuse the same markers.
   */
  readonly refusesWithheld?: true;
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
  /**
   * Common connector options the deployment set, and only those, ready to
   * spread into `remoteMcp()` or `api()` options.
   */
  readonly connectorOptions: Readonly<
    Pick<ProviderOptions, "authScope" | "maxResultBytes" | "callAdmission" | "readOnly">
  >;
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
  kind: "api";
  skill: ProviderSkill;
  /** Maintained display name in the generated README inventory. */
  readme?: string;
  /** Reviewed build facts: the bundle report's baseline, never a cap. */
  bundle?: {
    baselineGzip: number;
    /** @deprecated Ignored: provider entries are reported, not capped. */
    maxGzip?: number;
    note?: string;
  };
  /** Closed factory options, declared with `optionsOf<O>()` for key parity. */
  options: Field<unknown, unknown>;
  /** Required when the guide holds `<!-- when: <key> -->` blocks. */
  blocks?: ProviderGuideBlocks<O>;
  /** Set by the provider kit; see `ProviderKitFacts`. */
  kit?: ProviderKitFacts;
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
const BLOCK_KEY = /^[a-z][a-z0-9:-]*$/;
/** A when-block marker, alone on its line. */
const BLOCK_MARKER = /^<!--\s*(?:when:\s*([a-z][a-z0-9:-]*)|end)\s*-->$/;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Render a guide's selected when-blocks, or, with no selection, check them
 * and return their keys. Markers stand alone on their lines and never nest.
 * Removing an unselected block also removes the blank line it leaves, so
 * paragraphs and tight lists keep their spacing.
 */
function guideBlocks(content: string, selected?: ReadonlySet<string>): { text: string; keys: Set<string> } {
  const keys = new Set<string>();
  const kept: string[] = [];
  let open: string | undefined;
  let seam = false;
  for (const line of content.split("\n")) {
    const marker = BLOCK_MARKER.exec(line.trim());
    if (marker) {
      if (marker[1] !== undefined ? open !== undefined : open === undefined) {
        throw new Error("when-blocks must open and close in turn, unnested");
      }
      if (marker[1] !== undefined) keys.add((open = marker[1]));
      else {
        seam = selected !== undefined && !selected.has(open!);
        open = undefined;
      }
      continue;
    }
    if (/<!--\s*(?:when:|end\s*-->)/.test(line)) throw new Error("a when-block marker stands alone on its line");
    if (open !== undefined && !selected?.has(open)) continue;
    if (seam && !line.trim() && (kept.length === 0 || !kept.at(-1)!.trim())) continue;
    seam = false;
    kept.push(line);
  }
  if (open !== undefined) throw new Error(`the when-block "${open}" is never closed`);
  return { text: kept.join("\n").trim(), keys };
}

/** A frozen copy: kit facts are review evidence `providers:generate` reads. */
function kitFacts(kit: ProviderKitFacts): ProviderKitFacts {
  if (kit.errors && !isConnectorCallErrorCode(kit.errors.unknownId)) {
    throw new Error("Provider kit errors.unknownId must be a ConnectorCallErrorCode.");
  }
  return Object.freeze({
    operations: Object.freeze([...kit.operations]),
    ...(kit.pageSize ? { pageSize: Object.freeze({ ...kit.pageSize }) } : {}),
    ...(kit.hatch
      ? {
          hatch: Object.freeze({
            name: kit.hatch.name,
            verdicts: Object.freeze({ ...kit.hatch.verdicts }),
            ...(kit.hatch.paging ? { paging: kit.hatch.paging } : {}),
            ...(kit.hatch.fieldsRoot ? { fieldsRoot: kit.hatch.fieldsRoot } : {}),
          }),
        }
      : {}),
    ...(kit.errors
      ? { errors: Object.freeze({ ...kit.errors, conflicts: Object.freeze([...kit.errors.conflicts]) }) }
      : {}),
    ...(kit.idempotencyKey !== undefined ? { idempotencyKey: kit.idempotencyKey } : {}),
    ...(kit.refusesWithheld ? { refusesWithheld: true as const } : {}),
  });
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
  if (definition.kind !== "api") throw new Error(`${label} kind must be "api".`);
  if (!nonEmpty(definition.skill?.content) || !nonEmpty(definition.skill.instructionsHeading)) {
    throw new Error(`${label} skill requires non-empty content and instructionsHeading.`);
  }
  if (Object.hasOwn(definition, "classify"))
    throw new Error(`${label} classify was removed; use ConnectaConfig.classification.`);
  if (!definition.options?.shape && !definition.options?.variants) {
    throw new Error(`${label} requires a closed options shape from optionsOf().`);
  }
  const blocks = definition.blocks;
  if (
    blocks !== undefined &&
    (!Array.isArray(blocks.keys) ||
      blocks.keys.length === 0 ||
      !blocks.keys.every((key) => typeof key === "string" && BLOCK_KEY.test(key)) ||
      new Set(blocks.keys).size !== blocks.keys.length ||
      typeof blocks.select !== "function")
  ) {
    throw new Error(`${label} blocks require unique lowercase keys and a select function.`);
  }
  let used: Set<string>;
  try {
    used = guideBlocks(definition.skill.content).keys;
  } catch (error) {
    throw new Error(`${label} skill: ${error instanceof Error ? error.message : String(error)}.`, { cause: error });
  }
  for (const key of used) {
    if (!blocks?.keys.includes(key)) throw new Error(`${label} skill uses the when-block "${key}" its blocks omit.`);
  }
  // Freeze definition facts consumed by construction, generation and checks.
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
    ...(blocks ? { blocks: Object.freeze({ keys: Object.freeze([...blocks.keys]), select: blocks.select }) } : {}),
    ...(definition.kit ? { kit: kitFacts(definition.kit) } : {}),
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
        connectorOptions: {
          ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
          ...(options.authScope !== undefined ? { authScope: options.authScope } : {}),
          ...(options.maxResultBytes !== undefined ? { maxResultBytes: options.maxResultBytes } : {}),
          ...(options.callAdmission !== undefined ? { callAdmission: options.callAdmission } : {}),
        },
        usageGuide(input) {
          const heading = input.heading ?? `${frozen.title} usage`;
          let guide = frozen.skill.content.trim();
          if (frozen.blocks) {
            const { keys, select } = frozen.blocks;
            const selected: unknown = select(resolved);
            if (!Array.isArray(selected)) throw new Error(`${at} requires blocks.select() to return an array of keys.`);
            for (const key of selected) {
              if (!keys.includes(key)) {
                throw new Error(`${at} requires blocks.select() to return declared keys; it returned ${String(key)}.`);
              }
            }
            guide = guideBlocks(frozen.skill.content, new Set(selected)).text;
          }
          const body = [...input.context, guide].join("\n\n");
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
  // Build and check tools rely on this definition remaining attached.
  return Object.freeze(Object.assign(factory, { definition: frozen }));
}

/**
 * Build a maintained provider's connector: refuse unknown options and
 * accessors by path before the builder reads any of them, then stamp the
 * provider onto its description, so the operator surface can say "Stripe"
 * rather than "remote MCP". This is the same construction path defineProvider
 * uses; existing constructors retain their provider-specific option policy.
 */
function asProvider<O extends ProviderOptions, C extends Connector>(
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
    if (options?.readOnly !== undefined)
      READ_ONLY.parse(options.readOnly, `${factory}(${JSON.stringify(id)}).readOnly`);
    const admission = options == null ? undefined : options.callAdmission;
    if (admission !== undefined) CALL_ADMISSION.parse(admission, `${factory}(${JSON.stringify(id)}).callAdmission`);
    connector = build(id, options);
  } catch (error) {
    throw providerConstructionError(factory, id, error);
  }
  const describe = connector.describe?.bind(connector);
  const ownDescribe = Object.getOwnPropertyDescriptor(connector, "describe");
  const ownReadOnly = Object.getOwnPropertyDescriptor(connector, "readOnly");
  // Keep the receiver of prototype methods (including private fields). When
  // the description cannot be replaced, inherit the whole connector instead
  // of copying it: decorators may inherit their id and methods.
  const stamped =
    Object.isExtensible(connector) &&
    (!ownDescribe || ownDescribe.configurable) &&
    (options.readOnly === undefined || !ownReadOnly || ownReadOnly.configurable)
      ? connector
      : (Object.create(connector) as C);
  // An inheriting stamp serves the connector itself, so it keeps its call identity.
  if (stamped !== connector) aliasCallIdentity(stamped, connector);
  if (options.readOnly !== undefined) {
    Object.defineProperty(stamped, "readOnly", { value: options.readOnly, enumerable: true, configurable: true });
  }
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
    .replace(/^declares /, "a consistent declaration of ");
  error.message = `${at} requires ${detail}`;
  return error;
}
