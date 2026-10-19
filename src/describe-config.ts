// `Connecta.describeConfig()`: a secret-free snapshot of what a deployment
// runs with, built once at construction for the operator UI and
// `connecta doctor --config`.
//
// It is an allowlist serializer. Every value is copied field by field from a
// known type, and nothing is spread: a config object, a module, a connector,
// or a connector's own `describe()` result can carry a secret beside the
// fields named here, and spreading it would publish that secret the day
// someone adds one. Functions become "custom"/"default" or a boolean and are
// never called or stringified; every URL, absolute or root-relative, passes
// through one sanitizer in src/described.ts and keeps origin and path at most;
// headers keep their names. test/describe-config.test.ts plants a sentinel secret in every
// secret-bearing position and asserts none survives.

import { resolveBranding } from "./branding.js";
import { CONFIG_DEFAULTS } from "./config-defaults.js";
import type { ConnectaConfig, ResolvedConfig } from "./config.js";
import { describedEndpoint, describedHref, describedOrigin, describedTools, describedUrl } from "./described.js";
import { connectorGuideRequired, connectorGuideSummary } from "./skills.js";
import type { ResolvedPool } from "./membership.js";
import type {
  Connector,
  ConnectorAuthDescription,
  ConnectorDescription,
  ConnectorToolDescription,
  DescribedEndpoint,
  IdentityReference,
} from "./types.js";
import { CONNECTA_VERSION } from "./version.js";

/** Where a limit's value came from. */
export type ConfigValueSource = "default" | "config";

/** One limit and where its value came from. `null` means unset (no bound). */
export interface DescribedLimit<T = number> {
  value: T | null;
  source: ConfigValueSource;
}

/** A resolved pool member: a principal, or a declared agent by name. */
export type DescribedMember = { kind: "human"; namespace: string; id: string } | { kind: "agent"; name: string };

/** One connector as `describeConfig()` reports it. */
export interface DescribedConnector {
  /** Connector policy, independent of endpoint policy; omitted when false. */
  readOnly?: boolean;
  id: string;
  title?: string;
  description?: string;
  authScope: "shared" | "personal";
  source: ConnectorDescription["source"];
  endpoint?: DescribedEndpoint;
  auth?: ConnectorAuthDescription;
  transport?: ConnectorDescription["transport"];
  /** The operator-managed credential slot: labels and field names, never values. */
  credential?: {
    label: string;
    description?: string;
    fields?: Array<{ name: string; label: string; description?: string }>;
  };
  maxResultBytes: { value: number; source: "connector" | "deployment" };
  /** Call admission as numbers; a partition-key function is `partitioned: true`. */
  callAdmission?: {
    maxPartitions?: number;
    rules: Array<{
      maxConcurrency?: number;
      maxQueueSize?: number;
      queueTimeoutMs?: number;
      retryAfterMs?: number;
      budget?: { maxCalls: number; windowMs: number };
      partitioned: boolean;
    }>;
  };
  usageGuide?: { summary?: string; required: boolean };
  tools?: ConnectorToolDescription[];
}

/** The secret-free deployment snapshot returned by `Connecta.describeConfig()`. */
export interface ConnectaConfigDescription {
  schemaVersion: 1;
  /** The connecta package version running, never the configurable serverInfo.version. */
  connectaVersion: string;
  server: { name: string; version: string; title?: string; websiteUrl?: DescribedEndpoint; icons: number };
  urls: {
    publicUrl?: DescribedEndpoint;
    mcpPath: "/mcp";
    /** Configured exact origins, `"*"`, or the default (publicUrl plus loopback). */
    allowedOrigins: string[] | "*" | "default";
  };
  executor: {
    name?: string;
    /** The fallback pool core wraps around the executor, or the executor's own. */
    admission: "executor" | Record<keyof typeof CONFIG_DEFAULTS.admission.code, DescribedLimit>;
  };
  limits: {
    discovery: Record<keyof typeof CONFIG_DEFAULTS.discovery, DescribedLimit<number | boolean>>;
    calls: { defaultTimeoutMs: DescribedLimit; maxResultBytes: DescribedLimit };
    results: Record<keyof typeof CONFIG_DEFAULTS.results, DescribedLimit>;
    execute: Record<keyof typeof CONFIG_DEFAULTS.execute, DescribedLimit>;
    requests: Record<keyof typeof CONFIG_DEFAULTS.admission.requests, DescribedLimit>;
  };
  /** Whether the default /mcp endpoint refuses every write, and exact classification overrides from deployment code. */
  readOnly: boolean;
  /** The principals plain `/mcp` admits, resolved, in declaration order. Empty on an open deployment. */
  maintainers: Array<{ namespace: string; id: string }>;
  classification: Record<string, Record<string, "read" | "write">>;
  /** Inbound auth providers in the order they are tried. */
  auth: Array<{ kind: string; interactive: boolean; ui?: string }>;
  /** Agents declared in code, by name, in declaration order. Never token state. */
  agents: string[];
  /**
   * `readOnly` is resolved: the pool's own value, else the deployment's.
   * `members` are resolved references in declaration order. `owner` is the
   * Workspace address agents act as, or null. `description` is the trimmed
   * text the pool's endpoints add to their MCP instructions, or null.
   */
  pools: Array<{
    name: string;
    path: string;
    tools: string[];
    members: DescribedMember[];
    readOnly: boolean;
    owner: string | null;
    description: string | null;
  }>;
  modules: {
    ui: { enabled: boolean };
    vault: { enabled: boolean; sealsOAuth?: boolean };
    activity: {
      enabled: boolean;
      readable?: boolean;
      deploymentId?: string;
      store?: { kind: DescribedStoreKind; retentionDays?: number };
    };
    accessTokens: { enabled: boolean };
  };
  /** Every accepted store implements `list` and `compareAndSet`, so only its kind is told. */
  storage: { configured: boolean; kind: DescribedStoreKind };
  branding: {
    productName: string;
    productUrl?: string;
    ownerName?: string;
    ownerUrl?: string;
    description: string;
    faviconHref: string;
    themeColor: string;
    theme: { accent?: string; radius?: string; fontFamily?: string; monoFamily?: string; colorScheme: string };
  };
  /** Names of `deploymentInfo` keys; their values are served by /health only. */
  deploymentInfo: string[];
  connectors: DescribedConnector[];
}

export interface DescribeConfigInput {
  registry: import("./registry.js").Registry;
  raw: ConnectaConfig;
  config: ResolvedConfig;
  /** Resolved `maintainers`. */
  maintainers: readonly IdentityReference[];
  /** Resolved pools; members are read from here, never from raw references. */
  pools: ReadonlyMap<string, ResolvedPool>;
  executorName: string | undefined;
  /** True when the executor owns admission, so `admission.code` is unused. */
  executorAdmits: boolean;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Copy only the named keys whose values are strings or numbers. */
function pick<K extends string>(
  value: unknown,
  keys: readonly K[],
  read: (item: unknown) => string | number | undefined,
): Partial<Record<K, string | number>> {
  const out: Partial<Record<K, string | number>> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const key of keys) {
    const item = read((value as Record<string, unknown>)[key]);
    if (item !== undefined) out[key] = item;
  }
  return out;
}

function ownValue(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Each resolved value, with "config" where the deployment set it explicitly. */
function limitGroup<K extends string>(
  resolved: Readonly<Record<K, unknown>>,
  raw: unknown,
  keys: readonly K[],
): Record<K, DescribedLimit<number | boolean>> {
  const out = {} as Record<K, DescribedLimit<number | boolean>>;
  for (const key of keys) {
    const value = resolved[key];
    out[key] = {
      value: typeof value === "number" || typeof value === "boolean" ? value : null,
      source: ownValue(raw, key) !== undefined ? "config" : "default",
    };
  }
  return out;
}

/** An endpoint from a string or an `{ origin, path }` pair, re-parsed so only origin and path survive. */
function endpointOf(value: unknown): DescribedEndpoint | undefined {
  if (typeof value === "object" && value !== null && !(value instanceof URL)) {
    const { origin, path } = value as Record<string, unknown>;
    return typeof origin === "string"
      ? describedEndpoint(`${origin}${typeof path === "string" ? path : ""}`)
      : undefined;
  }
  return describedEndpoint(value);
}

const AUTH_MODES = new Set(["none", "headers", "credential", "oauth", "request"]);
const SOURCE_KINDS = new Set(["remote-mcp", "api", "custom"]);

/** Re-validate a connector's own description: a custom describe() may return anything. */
function copyAuth(value: unknown): ConnectorAuthDescription | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const auth = value as Record<string, unknown>;
  if (typeof auth.mode !== "string" || !AUTH_MODES.has(auth.mode)) return undefined;
  const names = (item: unknown) =>
    Array.isArray(item) ? item.filter((name): name is string => typeof name === "string") : undefined;
  const authorizationEndpoint = endpointOf(auth.authorizationEndpoint);
  const tokenEndpoint = endpointOf(auth.tokenEndpoint);
  const clientMetadataUrl = describedUrl(auth.clientMetadataUrl);
  const headerNames = names(auth.headerNames);
  const apiOrigins = names(auth.apiOrigins)?.flatMap((origin) => describedOrigin(origin) ?? []);
  const authorizationParamNames = names(auth.authorizationParamNames);
  const tokenRequestHeaderNames = names(auth.tokenRequestHeaderNames);
  return {
    mode: auth.mode as ConnectorAuthDescription["mode"],
    ...(headerNames ? { headerNames } : {}),
    ...(str(auth.header) !== undefined ? { header: str(auth.header)! } : {}),
    ...(auth.scheme === null || typeof auth.scheme === "string" ? { scheme: auth.scheme } : {}),
    ...(str(auth.scope) !== undefined ? { scope: str(auth.scope)! } : {}),
    ...(clientMetadataUrl ? { clientMetadataUrl } : {}),
    ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
    ...(apiOrigins ? { apiOrigins } : {}),
    ...(str(auth.tokenEndpointAuthMethod) !== undefined
      ? { tokenEndpointAuthMethod: str(auth.tokenEndpointAuthMethod)! }
      : {}),
    ...(typeof auth.confidentialClient === "boolean" ? { confidentialClient: auth.confidentialClient } : {}),
    ...(typeof auth.pkce === "boolean" ? { pkce: auth.pkce } : {}),
    ...(authorizationParamNames ? { authorizationParamNames } : {}),
    ...(tokenRequestHeaderNames ? { tokenRequestHeaderNames } : {}),
  };
}

function ownDescription(connector: Connector): ConnectorDescription {
  let described: unknown;
  try {
    described = typeof connector.describe === "function" ? connector.describe() : undefined;
  } catch {
    described = undefined;
  }
  const value = (typeof described === "object" && described !== null ? described : {}) as Record<string, unknown>;
  const source = (typeof value.source === "object" && value.source !== null ? value.source : {}) as Record<
    string,
    unknown
  >;
  const kind =
    typeof source.kind === "string" && SOURCE_KINDS.has(source.kind)
      ? (source.kind as ConnectorDescription["source"]["kind"])
      : "custom";
  const endpoint = endpointOf(value.endpoint);
  const auth = copyAuth(value.auth);
  const transportValue = value.transport;
  const transport: ConnectorDescription["transport"] =
    typeof transportValue === "object" && transportValue !== null
      ? (() => {
          const { versionNegotiation, redirects, requireHttps } = transportValue as Record<string, unknown>;
          return {
            ...(versionNegotiation === "auto" || versionNegotiation === "legacy" ? { versionNegotiation } : {}),
            ...(redirects === "none" || redirects === "same-origin" ? { redirects } : {}),
            ...(typeof requireHttps === "boolean" ? { requireHttps } : {}),
          };
        })()
      : undefined;
  return {
    source: { kind, ...(str(source.provider) !== undefined ? { provider: str(source.provider)! } : {}) },
    ...(endpoint ? { endpoint } : {}),
    ...(auth ? { auth } : {}),
    ...(transport ? { transport } : {}),
  };
}

function describeConnector(
  connector: Connector,
  deploymentCap: number,
  registry: import("./registry.js").Registry,
): DescribedConnector {
  const own = ownDescription(connector);
  const credential = connector.credential;
  const admission = connector.callAdmission;
  const guideSummary = connectorGuideSummary(connector);
  const guided = connector.usageGuide !== undefined;
  return {
    ...(connector.readOnly === true ? { readOnly: true } : {}),
    id: connector.id,
    ...(str(connector.title) !== undefined ? { title: connector.title! } : {}),
    ...(str(connector.description) !== undefined ? { description: connector.description! } : {}),
    authScope: connector.authScope === "personal" ? "personal" : "shared",
    ...own,
    ...(credential && typeof credential === "object"
      ? {
          credential: {
            label: String(credential.label),
            ...(str(credential.description) !== undefined ? { description: credential.description! } : {}),
            ...(Array.isArray(credential.fields)
              ? {
                  fields: credential.fields.map((field) => ({
                    name: String(field.name),
                    label: String(field.label),
                    ...(str(field.description) !== undefined ? { description: field.description! } : {}),
                  })),
                }
              : {}),
          },
        }
      : {}),
    maxResultBytes:
      num(connector.maxResultBytes) !== undefined
        ? { value: connector.maxResultBytes!, source: "connector" }
        : { value: deploymentCap, source: "deployment" },
    ...(admission && Array.isArray(admission.rules)
      ? {
          callAdmission: {
            ...(num(admission.maxPartitions) !== undefined ? { maxPartitions: admission.maxPartitions! } : {}),
            rules: admission.rules.map((rule) => ({
              ...pick(rule, ["maxConcurrency", "maxQueueSize", "queueTimeoutMs", "retryAfterMs"] as const, num),
              ...(rule.budget && num(rule.budget.maxCalls) !== undefined && num(rule.budget.windowMs) !== undefined
                ? { budget: { maxCalls: rule.budget.maxCalls, windowMs: rule.budget.windowMs } }
                : {}),
              partitioned: typeof rule.partitionKey === "function",
            })),
          },
        }
      : {}),
    ...(guided
      ? {
          usageGuide: {
            ...(guideSummary !== undefined ? { summary: guideSummary } : {}),
            required: connectorGuideRequired(connector),
          },
        }
      : {}),
    ...(connector.staticTools ? { tools: describedTools(registry.describeStaticTools(connector.id) ?? []) } : {}),
  } as DescribedConnector;
}

/** A shipped adapter's own kind; anything else is `"custom"`, so a description carries no free text. */
type DescribedStoreKind = "memory" | "d1" | "sqlite" | "custom";
const STORE_KINDS: ReadonlySet<string> = new Set(["memory", "d1", "sqlite"]);
const storeKind = (described: { kind?: unknown } | undefined): DescribedStoreKind =>
  typeof described?.kind === "string" && STORE_KINDS.has(described.kind)
    ? (described.kind as DescribedStoreKind)
    : "custom";

/** Build the snapshot. Pure: it reads configuration and calls only describe hooks. */
export function describeConfig(input: DescribeConfigInput): ConnectaConfigDescription {
  const { raw, config } = input;
  const brand = resolveBranding(config.ui?.branding);
  const storage = config.storage;
  const activityStore = config.activity?.store.describe?.();
  const D = CONFIG_DEFAULTS;
  const websiteUrl = describedEndpoint(config.serverInfo.websiteUrl);
  const publicUrl = describedEndpoint(config.publicUrl);
  const productUrl = describedUrl(brand.productUrl);
  const ownerUrl = describedUrl(brand.ownerUrl);
  const codeLimits = limitGroup(
    config.admission.code,
    ownValue(ownValue(raw, "admission"), "code"),
    Object.keys(D.admission.code) as Array<keyof typeof D.admission.code>,
  ) as Record<keyof typeof D.admission.code, DescribedLimit>;
  const description: ConnectaConfigDescription = {
    schemaVersion: 1,
    connectaVersion: CONNECTA_VERSION,
    server: {
      name: config.serverInfo.name,
      version: config.serverInfo.version,
      ...(config.serverInfo.title !== undefined ? { title: config.serverInfo.title } : {}),
      ...(websiteUrl ? { websiteUrl } : {}),
      icons: config.serverInfo.icons?.length ?? 0,
    },
    urls: {
      ...(publicUrl ? { publicUrl } : {}),
      mcpPath: "/mcp",
      allowedOrigins:
        config.allowedOrigins === undefined
          ? "default"
          : config.allowedOrigins === "*"
            ? "*"
            : config.allowedOrigins.flatMap((origin) => describedOrigin(origin) ?? []),
    },
    executor: {
      ...(input.executorName !== undefined ? { name: input.executorName } : {}),
      admission: input.executorAdmits ? "executor" : codeLimits,
    },
    limits: {
      discovery: limitGroup(
        config.discovery,
        ownValue(raw, "discovery"),
        Object.keys(D.discovery) as Array<keyof typeof D.discovery>,
      ),
      calls: limitGroup(config.calls, ownValue(raw, "calls"), [
        "defaultTimeoutMs",
        "maxResultBytes",
      ] as const) as ConnectaConfigDescription["limits"]["calls"],
      results: limitGroup(
        config.results,
        ownValue(raw, "results"),
        Object.keys(D.results) as Array<keyof typeof D.results>,
      ) as ConnectaConfigDescription["limits"]["results"],
      execute: limitGroup(
        config.execute,
        ownValue(raw, "execute"),
        Object.keys(D.execute) as Array<keyof typeof D.execute>,
      ) as ConnectaConfigDescription["limits"]["execute"],
      requests: limitGroup(
        config.admission.requests,
        ownValue(ownValue(raw, "admission"), "requests"),
        Object.keys(D.admission.requests) as Array<keyof typeof D.admission.requests>,
      ) as ConnectaConfigDescription["limits"]["requests"],
    },
    readOnly: config.readOnly,
    maintainers: input.maintainers.map(({ namespace, id }) => ({ namespace: String(namespace), id: String(id) })),
    classification: structuredClone(config.classification ?? {}),
    auth: config.auth.map((provider) => ({
      kind: String(provider.kind),
      interactive: provider.interactiveOperator === true,
      ...(str(provider.uiAuth?.kind) !== undefined ? { ui: provider.uiAuth!.kind } : {}),
    })),
    agents: [...config.agents],
    pools: Object.entries(config.pools ?? {}).map(([name, pool]) => ({
      readOnly: pool.readOnly ?? config.readOnly,
      name,
      path: `/mcp/${name}`,
      tools: pool.tools.map(String),
      members: (input.pools.get(name)?.members ?? []).map((member): DescribedMember =>
        member.kind === "agent"
          ? { kind: "agent", name: member.name }
          : { kind: "human", namespace: member.namespace, id: member.id },
      ),
      owner: input.pools.get(name)?.owner ?? null,
      description: input.pools.get(name)?.description ?? null,
    })),
    modules: {
      ui: { enabled: config.ui !== undefined },
      vault: config.vault
        ? {
            enabled: true,
            sealsOAuth: typeof config.vault.seal === "function" && typeof config.vault.open === "function",
          }
        : { enabled: false },
      activity: config.activity
        ? {
            enabled: true,
            readable: typeof config.activity.store.list === "function",
            ...(str(config.activity.deploymentId) !== undefined ? { deploymentId: config.activity.deploymentId! } : {}),
            store: {
              kind: storeKind(activityStore),
              ...(num(activityStore?.retentionDays) !== undefined
                ? { retentionDays: activityStore!.retentionDays! }
                : {}),
            },
          }
        : { enabled: false },
      accessTokens: { enabled: config.accessTokens !== undefined },
    },
    storage: {
      configured: raw.storage !== undefined,
      kind: storeKind(storage.describe?.()),
    },
    branding: {
      productName: brand.productName,
      ...(productUrl !== undefined ? { productUrl } : {}),
      ...(brand.ownerName !== undefined ? { ownerName: brand.ownerName } : {}),
      ...(ownerUrl !== undefined ? { ownerUrl } : {}),
      description: brand.description,
      faviconHref: describedHref(brand.faviconHref) ?? "/favicon.svg",
      themeColor: brand.themeColor,
      theme: {
        ...(pick(brand.theme, ["accent", "radius", "fontFamily", "monoFamily"] as const, str) as Partial<
          Record<"accent" | "radius" | "fontFamily" | "monoFamily", string>
        >),
        colorScheme: brand.theme.colorScheme,
      },
    },
    deploymentInfo: Object.keys(config.deploymentInfo ?? {}),
    connectors: config.connectors.map((connector) =>
      describeConnector(connector, config.calls.maxResultBytes, input.registry),
    ),
  };
  return deepFreeze(description);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
