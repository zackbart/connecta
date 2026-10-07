// The one shape every maintained provider takes. Deliberately transport-free:
// it imports neither `remoteMcp()` nor `api()`, so an `api()` provider does not
// acquire the MCP client, OAuth, or Effect graph by using it, and a hosted
// provider does not acquire `api()`. Its only runtime import validates a
// reviewed classification, which is Web-API code with no I/O.
import { reviewedCatalog } from "./catalog-drift.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
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

/** What `defineProvider()` hands `create` after validating common options. */
export interface ProviderContext {
  /** The definition's reviewed classification, for `remoteMcp({ classify })`. */
  readonly classify?: ToolClassification;
  /**
   * Common connector options the deployment set, and only those, ready to
   * spread into `remoteMcp()` or `api()` options.
   */
  readonly connectorOptions: Readonly<
    Pick<ProviderOptions, "authScope" | "maxResultBytes" | "callAdmission">
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
  kind: ProviderKind;
  skill: ProviderSkill;
  /**
   * Reviewed classification of the vendor's hosted MCP catalog. Hosted and
   * composed providers pass it to `remoteMcp({ classify })` through
   * `ProviderContext.classify`, so the verdicts that classify live tools and
   * the record a drift check reads cannot disagree. `api()` providers annotate
   * each tool they author and must omit it.
   */
  classify?: ToolClassification;
  /**
   * Build the connector. Runs synchronously at construction after common
   * options are validated; throw here for provider-specific mistakes.
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
 * Definition mistakes throw when the provider module loads. Common option
 * mistakes throw when a deployment calls the factory, before `create` runs,
 * so a deployment never boots in the wrong shape (INV-11).
 */
export function defineProvider<O extends ProviderOptions>(
  definition: ProviderDefinition<O>,
): ProviderFactory<O> {
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
  if (
    !nonEmpty(definition.skill?.content) ||
    !nonEmpty(definition.skill.instructionsHeading)
  ) {
    throw new Error(
      `${label} skill requires non-empty content and instructionsHeading.`,
    );
  }
  if (definition.classify !== undefined) {
    if (definition.kind === "api") {
      throw new Error(
        `${label} is an api() provider; annotate each authored tool instead of classifying a hosted catalog.`,
      );
    }
    reviewedCatalog(definition.classify, label);
  }
  if (typeof definition.create !== "function") {
    throw new Error(`${label} requires a create function.`);
  }
  const frozen: Readonly<ProviderDefinition<O>> = Object.freeze({
    ...definition,
    skill: Object.freeze({ ...definition.skill }),
  });
  const factoryName = `${frozen.name}()`;

  const factory = (id: string, options: O): Connector => {
    const at = `${frozen.name}("${id}")`;
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
    if (
      options.authScope !== undefined &&
      options.authScope !== "shared" &&
      options.authScope !== "personal"
    ) {
      throw new Error(`${at} authScope must be "shared" or "personal".`);
    }
    const resolved: Readonly<O> = { ...options, purpose: options.purpose.trim() };
    const instructions = options.instructions?.trim();
    const connector = frozen.create(id, resolved, {
      ...(frozen.classify !== undefined ? { classify: frozen.classify } : {}),
      connectorOptions: {
        ...(options.authScope !== undefined ? { authScope: options.authScope } : {}),
        ...(options.maxResultBytes !== undefined
          ? { maxResultBytes: options.maxResultBytes }
          : {}),
        ...(options.callAdmission !== undefined
          ? { callAdmission: options.callAdmission }
          : {}),
      },
      usageGuide(input) {
        const heading = input.heading ?? `${frozen.title} usage`;
        const body = [...input.context, frozen.skill.content.trim()].join("\n\n");
        return {
          content:
            `# ${heading}\n\n${body}\n` +
            (instructions
              ? `\n## ${frozen.skill.instructionsHeading}\n\n${instructions}\n`
              : ""),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.required === true ? { required: true } : {}),
        };
      },
    });
    if (connector?.id !== id) {
      throw new Error(`${at} create() must return a connector with id "${id}".`);
    }
    return connector;
  };
  return Object.assign(factory, { definition: frozen });
}
