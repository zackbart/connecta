// The configuration snapshot as glanceable tiles for Settings and a
// connector's Configuration card. Pure: it maps `describeConfig()` and its
// provenance to labels and formatted values, and the components in
// app/config-tiles.tsx only draw them. A key this file does not know still
// becomes a tile with a label made from its name, so nothing in the snapshot
// disappears when the serializer grows a field.

import type { DescribedConnector, DescribedLimit } from "../describe-config.js";
import type { ConnectaConfigDescription } from "../describe-config.js";

type Sources = Readonly<Record<string, "default" | "config">>;

/** How a value reads: bytes as KB or MB, durations in their largest whole unit, counts with separators. */
type ValueFormat = "bytes" | "ms" | "seconds" | "days" | "count" | "toggle" | "text";

/** Icon names the tiles draw; app/icons.tsx defines each one. */
type ConfigIcon = "lock" | "activity" | "key" | "shield" | "box" | "plug" | "globe" | "user" | "users" | "book";

/** A value with a short label. `set` means deployment code set it; otherwise it is a default. */
export interface StatTile {
  id: string;
  label: string;
  value: string;
  set: boolean;
  /** The exact value when the label rounds it, such as a byte count. */
  title?: string;
}

/** A group of default limits, drawn as one small card. */
export interface DefaultGroup {
  id: string;
  title: string;
  tiles: StatTile[];
}

/** An optional module: on or off, and at most one short fact about it. */
export interface FeatureTile {
  id: string;
  label: string;
  icon: ConfigIcon;
  on: boolean;
  detail?: string;
}

/** One inbound sign-in method, in the order the deployment tries them. */
export interface SignInTile {
  id: string;
  label: string;
  mark: "clerk" | "access" | "tokens" | "other";
  /** People sign in with it; otherwise it admits machines. */
  interactive: boolean;
  /** A count chip, such as "3 agents" on the agent-token tile. */
  count?: string;
}

/** A deployment fact: version, storage, URL. */
export interface FactChip {
  id: string;
  label: string;
  value: string;
  mono?: boolean;
  /** `warn` marks a fact that loses data or exposes more than it should. */
  tone?: "warn";
  title?: string;
}

/** A tool whose read/write verdict deployment code overrides. */
export interface OverrideChip {
  address: string;
  classification: "read" | "write";
}

export interface ConfigSummary {
  deployment: FactChip[];
  signIn: SignInTile[];
  features: FeatureTile[];
  /** Headline limits, then every limit set in code. */
  limits: StatTile[];
  /** The remaining limits, all defaults, grouped for a disclosure. */
  defaults: DefaultGroup[];
  overrides: OverrideChip[];
  /** Snapshot keys this file does not map, with labels made from their names. */
  other: StatTile[];
}

export interface ConnectorBadge {
  id: string;
  label: string;
  icon?: ConfigIcon;
  mono?: boolean;
  /** A one-word key drawn muted before the value, such as "Scope". */
  prefix?: string;
  title?: string;
}

export interface ConnectorSummary {
  badges: ConnectorBadge[];
  /** How the connector authenticates: the mode, then its headers, origins and OAuth facts. */
  auth: ConnectorBadge[];
  tiles: StatTile[];
}

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** Bytes in decimal units throughout, so 24,000 reads "24 KB" and 8 MiB reads "8.4 MB". */
function formatBytes(bytes: number): string {
  for (const [unit, size] of [
    ["GB", 1e9],
    ["MB", 1e6],
    ["KB", 1e3],
  ] as const)
    if (bytes >= size) return `${NUMBER.format(bytes / size)} ${unit}`;
  return `${NUMBER.format(bytes)} B`;
}

/** The exact count behind a rounded size, for a tooltip. */
function exactBytes(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} bytes`;
}

const DURATIONS = [
  [86_400_000, "day", "days"],
  [3_600_000, "hr", "hr"],
  [60_000, "min", "min"],
  [1_000, "s", "s"],
] as const;

/** A duration in the largest unit it fills: 60000 is "1 min", 90000 is "90 s". */
function formatMs(ms: number): string {
  if (ms === 0) return "0 s";
  for (const [size, one, many] of DURATIONS)
    if (ms >= size && ms % size === 0) return `${NUMBER.format(ms / size)} ${ms === size ? one : many}`;
  for (const [size, , many] of DURATIONS) if (ms >= size) return `${NUMBER.format(ms / size)} ${many}`;
  return `${NUMBER.format(ms)} ms`;
}

/** Format one value. Booleans read On or Off, never true or false; null reads None. */
function formatValue(value: unknown, format: ValueFormat): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value))
    return value.length === 0
      ? "None"
      : value.every((item) => typeof item === "string" || typeof item === "number")
        ? value.join(", ")
        : `${NUMBER.format(value.length)} items`;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (format === "bytes") return formatBytes(value);
    if (format === "ms") return formatMs(value);
    if (format === "seconds") return formatMs(value * 1000);
    if (format === "days") return `${NUMBER.format(value)} ${value === 1 ? "day" : "days"}`;
    return NUMBER.format(value);
  }
  if (typeof value === "object") return `${NUMBER.format(Object.keys(value).length)} items`;
  return String(value);
}

const UNIT_SUFFIX = /(Ms|Seconds|Bytes|Days)$/;

/** The format a key's name implies: `probeTimeoutMs` is a duration, `maxStashBytes` a size. */
function inferFormat(key: string, value: unknown): ValueFormat {
  if (typeof value === "boolean") return "toggle";
  if (typeof value !== "number") return "text";
  const unit = UNIT_SUFFIX.exec(key)?.[1];
  return unit === "Ms"
    ? "ms"
    : unit === "Seconds"
      ? "seconds"
      : unit === "Bytes"
        ? "bytes"
        : unit === "Days"
          ? "days"
          : "count";
}

/** `maxStashEntries` reads "Max stash entries"; a unit suffix drops because the value carries it. */
function humanizeKey(key: string): string {
  // A word with two capitals is an acronym (OAuth, URL) and keeps its case.
  const words = key
    .replace(UNIT_SUFFIX, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((word) => (/[A-Z].*[A-Z]/.test(word) ? word : word.toLowerCase()))
    .join(" ");
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

/**
 * Labels for every limit the snapshot carries today, by `group.key`. Headline
 * limits draw large in this order; the rest fold into a group card under
 * `short`, a label the card's title makes unambiguous.
 */
const LIMITS: Record<string, { label: string; short?: string; headline?: number }> = {
  "calls.defaultTimeoutMs": { label: "Tool timeout", headline: 1 },
  "calls.maxResultBytes": { label: "Result cap", headline: 2 },
  "execute.watchdogMs": { label: "Program timeout", headline: 3 },
  "discovery.catalogTtlSeconds": { label: "Catalog refresh", headline: 4 },
  "execute.maxHostCalls": { label: "Calls per program", headline: 6 },
  "execute.maxWrites": { label: "Writes per program", headline: 7 },
  "requests.concurrency": { label: "Concurrent requests", headline: 8 },
  "discovery.concurrency": { label: "Probe concurrency", short: "Concurrency" },
  "discovery.catalogMinTtlSeconds": { label: "Min refresh" },
  "discovery.catalogMaxTtlSeconds": { label: "Max refresh" },
  "discovery.probeTimeoutMs": { label: "Probe timeout" },
  "results.maxStashBytes": { label: "Stash size" },
  "results.maxStashEntries": { label: "Stash entries" },
  "execute.maxEmittedBytes": { label: "Program output", short: "Output" },
  "execute.maxEmittedBlocks": { label: "Output blocks" },
  "execute.hostCallTimeoutMs": { label: "Host call timeout", short: "Call timeout" },
  "requests.maxQueueSize": { label: "Request queue", short: "Queue" },
  "requests.queueTimeoutMs": { label: "Request queue wait", short: "Queue wait" },
  "requests.retryAfterMs": { label: "Request retry after", short: "Retry after" },
  "requests.maxDurationMs": { label: "Request lifetime", short: "Lifetime" },
  "admission.concurrency": { label: "Concurrent programs", short: "Concurrency" },
  "admission.maxQueueSize": { label: "Program queue", short: "Queue" },
  "admission.queueTimeoutMs": { label: "Program queue wait", short: "Queue wait" },
  "admission.retryAfterMs": { label: "Program retry after", short: "Retry after" },
};

/** The card a default limit folds into, by its snapshot group. */
const DEFAULT_GROUPS: Record<string, string> = {
  discovery: "Discovery",
  calls: "Results",
  results: "Results",
  execute: "Programs",
  admission: "Programs",
  requests: "Requests",
};

function isLimit(value: unknown): value is DescribedLimit<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    "source" in value &&
    Object.keys(value).length === 2
  );
}

/** A limit's tile. A byte size carries its exact count as a title. */
function limitTile(path: string, key: string, limit: DescribedLimit<unknown>, sources: Sources, label?: string) {
  const id = `config.${path}`;
  const format = inferFormat(key, limit.value);
  return {
    id,
    label: label ?? humanizeKey(key),
    value: limit.value === null ? "No limit" : formatValue(limit.value, format),
    set: (sources[id] ?? limit.source) === "config",
    ...(format === "bytes" && typeof limit.value === "number" ? { title: exactBytes(limit.value) } : {}),
  } satisfies StatTile;
}

const SIGN_IN: Record<string, { label: string; mark: SignInTile["mark"] }> = {
  clerk: { label: "Clerk", mark: "clerk" },
  "cloudflare-access": { label: "Cloudflare Access", mark: "access" },
  access_token: { label: "Agent tokens", mark: "tokens" },
};

const STORE: Record<string, string> = { memory: "Memory", d1: "D1", sqlite: "SQLite", custom: "Custom" };

/** Known modules; any other `modules.<name>.enabled` becomes a tile named from its key. */
const MODULES: Record<string, { label: string; icon: ConfigIcon }> = {
  vault: { label: "Vault", icon: "lock" },
  activity: { label: "Activity", icon: "activity" },
  accessTokens: { label: "Agent tokens", icon: "key" },
};

/**
 * Snapshot paths Settings draws, or leaves to the page that owns them
 * (branding to the shell, pools to Endpoints, connectors to their pages,
 * activity reads to Activity). Everything else is "other".
 */
const KNOWN = [
  "schemaVersion",
  "connectaVersion",
  "server.name",
  "server.version",
  "server.title",
  "server.websiteUrl",
  "server.icons",
  "urls.publicUrl",
  "urls.mcpPath",
  "urls.allowedOrigins",
  "executor",
  "limits",
  "readOnly",
  "maintainers",
  "classification",
  "auth",
  "agents",
  "pools",
  "modules.vault.sealsOAuth",
  "modules.activity.readable",
  "modules.activity.deploymentId",
  "modules.activity.store",
  "storage.configured",
  "storage.kind",
  "branding",
  "deploymentInfo",
  "connectors",
];

function known(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`));
}

/** Leaves under `value`, a described limit counting as one leaf and an array as one value. */
function leaves(value: unknown, path: string): Array<[string, unknown]> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isLimit(value)) return [[path, value]];
  const entries = Object.entries(value);
  return entries.length ? entries.flatMap(([key, item]) => leaves(item, path ? `${path}.${key}` : key)) : [];
}

/**
 * A tile for a key nobody mapped: its own name, or its parent's and its own
 * when the name alone is vague. It reads as set only when the snapshot itself
 * says so: the server reports an unknown path as "config" by default.
 */
function otherTile(path: string, value: unknown, prefix: string): StatTile {
  const parts = path.split(".");
  const key = parts.at(-1)!;
  const parent = parts.length > 1 ? parts.at(-2)! : undefined;
  const inner = isLimit(value) ? value : null;
  const raw = inner ? inner.value : value;
  const format = inferFormat(key, raw);
  return {
    id: `${prefix}.${path}`,
    label:
      parent && /^(enabled|value|kind|mode|name)$/.test(key)
        ? `${humanizeKey(parent)} ${humanizeKey(key).toLowerCase()}`
        : humanizeKey(key),
    value: formatValue(raw, format),
    set: inner?.source === "config",
    ...(format === "bytes" && typeof raw === "number" ? { title: exactBytes(raw) } : {}),
  };
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function endpointText(endpoint: { origin: string; path: string } | undefined): string | undefined {
  if (!endpoint) return undefined;
  const host = hostOf(endpoint.origin);
  return endpoint.path && endpoint.path !== "/" ? `${host}${endpoint.path}` : host;
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${formatValue(count, "count")} ${count === 1 ? one : many}`;

/** Settings, as tiles. */
export function configSummary(config: ConnectaConfigDescription, sources: Sources = {}): ConfigSummary {
  const name = config.server.title ?? config.server.name;
  const version = config.server.version;
  const deployment: FactChip[] = [
    { id: "name", label: "Name", value: version ? `${name} · ${/^v/i.test(version) ? version : `v${version}`}` : name },
    { id: "mode", label: "Mode", value: config.readOnly ? "Read-only" : "Writes allowed" },
    { id: "connecta", label: "Connecta", value: config.connectaVersion, mono: true },
  ];
  const url = endpointText(config.urls.publicUrl);
  if (url) deployment.push({ id: "url", label: "URL", value: url, mono: true });
  const origins = config.urls.allowedOrigins;
  deployment.push({
    id: "origins",
    label: "Origins",
    value:
      origins === "default"
        ? "Default"
        : origins === "*"
          ? "Any"
          : origins.length === 1
            ? hostOf(origins[0]!)
            : `${origins.length}`,
    mono: Array.isArray(origins) && origins.length === 1,
  });
  if (config.executor.name) deployment.push({ id: "sandbox", label: "Sandbox", value: config.executor.name });
  // Unconfigured memory storage loses tokens, credentials and OAuth state on restart.
  const volatile = !config.storage.configured && config.storage.kind === "memory";
  deployment.push({
    id: "storage",
    label: "Storage",
    value: volatile ? "Memory · default" : (STORE[config.storage.kind] ?? config.storage.kind),
    ...(volatile ? { tone: "warn" as const, title: "Lost on restart" } : {}),
  });
  if (config.modules.activity.enabled && config.modules.activity.store)
    deployment.push({
      id: "history",
      label: "History",
      value: STORE[config.modules.activity.store.kind] ?? config.modules.activity.store.kind,
    });
  if (config.modules.activity.deploymentId)
    deployment.push({
      id: "deploymentId",
      label: "Deployment ID",
      value: config.modules.activity.deploymentId,
      mono: true,
    });
  const website = endpointText(config.server.websiteUrl);
  if (website) deployment.push({ id: "website", label: "Website", value: website, mono: true });
  if (config.server.icons > 0)
    deployment.push({ id: "icons", label: "Icons", value: formatValue(config.server.icons, "count") });
  if (config.deploymentInfo.length)
    deployment.push({ id: "info", label: "Info", value: config.deploymentInfo.join(", "), mono: true });

  const signIn = config.auth.map((provider, index): SignInTile => {
    const knownProvider = SIGN_IN[provider.kind];
    const mark = knownProvider?.mark ?? "other";
    return {
      id: `${provider.kind}-${index}`,
      label: knownProvider?.label ?? humanizeKey(provider.kind),
      mark,
      interactive: provider.interactive,
      ...(mark === "tokens" ? { count: plural(config.agents.length, "agent") } : {}),
    };
  });

  // The UI module is on whenever this page draws, so it has no tile.
  const features: FeatureTile[] = [];
  for (const [id, module] of Object.entries(config.modules) as Array<[string, { enabled?: unknown }]>) {
    if (id === "ui" || typeof module?.enabled !== "boolean") continue;
    const meta = MODULES[id] ?? { label: humanizeKey(id), icon: "box" as const };
    features.push({
      id,
      label: meta.label,
      icon: meta.icon,
      on: module.enabled,
      ...(id === "vault" && config.modules.vault.sealsOAuth ? { detail: "Seals OAuth" } : {}),
    });
  }

  const all: Array<StatTile & { headline: number; group: string; short: string | undefined }> = [];
  const hostCall = config.limits.execute.hostCallTimeoutMs;
  for (const [group, values] of Object.entries(config.limits) as Array<[string, Record<string, unknown>]>)
    for (const [key, value] of Object.entries(values)) {
      if (!isLimit(value)) continue;
      const meta = LIMITS[`${group}.${key}`];
      const path = `limits.${group}.${key}`;
      // A null tool timeout falls back to the host-call timeout at runtime.
      const fallback = group === "calls" && key === "defaultTimeoutMs" && value.value === null && hostCall;
      const tile = fallback
        ? { ...limitTile(path, key, { value: hostCall.value, source: "default" }, {}, meta?.label), set: false }
        : limitTile(path, key, value, sources, meta?.label);
      all.push({ ...tile, headline: meta?.headline ?? 0, group, short: meta?.short });
    }
  if (config.executor.admission !== "executor")
    for (const [key, limit] of Object.entries(config.executor.admission) as Array<[string, unknown]>) {
      if (!isLimit(limit)) continue;
      const meta = LIMITS[`admission.${key}`];
      all.push({
        ...limitTile(`executor.admission.${key}`, key, limit, sources, meta?.label),
        headline: 0,
        group: "admission",
        short: meta?.short,
      });
    }
  const retention = config.modules.activity.enabled ? config.modules.activity.store?.retentionDays : undefined;
  if (retention !== undefined) {
    // The source map reads "config" only when the store reports its own option as set.
    const id = "config.modules.activity.store.retentionDays";
    all.push({
      id,
      label: "Activity kept",
      value: formatValue(retention, "days"),
      set: sources[id] === "config",
      headline: 5,
      group: "activity",
      short: undefined,
    });
  }
  const strip = ({ headline: _, group: __, short: ___, ...tile }: (typeof all)[number]): StatTile => tile;
  // Headline limits in a fixed order, then any other limit code set.
  const limits = [
    ...all.filter((tile) => tile.headline).sort((a, b) => a.headline - b.headline),
    ...all.filter((tile) => !tile.headline && tile.set),
  ].map(strip);
  const defaults: DefaultGroup[] = [];
  for (const tile of all.filter((item) => !item.headline && !item.set)) {
    const title = DEFAULT_GROUPS[tile.group] ?? humanizeKey(tile.group);
    let group = defaults.find((item) => item.title === title);
    if (!group) defaults.push((group = { id: title.toLowerCase().replace(/\W+/g, "-"), title, tiles: [] }));
    group.tiles.push({ ...strip(tile), label: tile.short ?? tile.label });
  }

  const overrides = Object.entries(config.classification).flatMap(([connector, tools]) =>
    Object.entries(tools).map(([tool, classification]) => ({ address: `${connector}.${tool}`, classification })),
  );

  const other = leaves(config, "")
    .filter(([path]) => !known(path, KNOWN) && !/^modules\.[^.]+\.enabled$/.test(path))
    .map(([path, value]) => otherTile(path, value, "config"));

  return { deployment, signIn, features, limits, defaults, overrides, other };
}

const SOURCE_KIND: Record<string, { label: string; icon: ConfigIcon }> = {
  "remote-mcp": { label: "Remote MCP", icon: "plug" },
  api: { label: "HTTP API", icon: "globe" },
  custom: { label: "Custom", icon: "box" },
};

const AUTH_MODE: Record<string, string> = {
  none: "No auth",
  headers: "Headers",
  credential: "API key",
  oauth: "OAuth",
  request: "Request token",
};

/**
 * Connector leaves the card draws, plus those the page leaves to another tab:
 * prose (description, guide summary, credential help) and the Tools tab's
 * catalog. Anything else becomes a tile, so a new field is never hidden.
 */
const CONNECTOR_KNOWN = [
  "readOnly",
  "id",
  "title",
  "description",
  "authScope",
  "source.kind",
  "source.provider",
  "endpoint.origin",
  "endpoint.path",
  "auth.mode",
  "auth.headerNames",
  "auth.header",
  "auth.scheme",
  "auth.scope",
  "auth.clientMetadataUrl",
  "auth.authorizationEndpoint.origin",
  "auth.authorizationEndpoint.path",
  "auth.tokenEndpoint.origin",
  "auth.tokenEndpoint.path",
  "auth.apiOrigins",
  "auth.tokenEndpointAuthMethod",
  "auth.confidentialClient",
  "auth.pkce",
  "auth.authorizationParamNames",
  "auth.tokenRequestHeaderNames",
  "credential.label",
  "credential.description",
  "credential.fields",
  "transport.versionNegotiation",
  "transport.redirects",
  "transport.requireHttps",
  "maxResultBytes",
  "callAdmission",
  "usageGuide.summary",
  "usageGuide.required",
  "tools",
];

/** How a connector authenticates, as one mode badge and mono badges for its headers, origins and OAuth facts. */
function authBadges(connector: DescribedConnector): ConnectorBadge[] {
  const auth = connector.auth;
  const mode = auth?.mode ?? (connector.credential ? "credential" : undefined);
  if (!mode) return [];
  const badges: ConnectorBadge[] = [
    {
      id: "auth",
      label: connector.credential?.label ?? AUTH_MODE[mode] ?? humanizeKey(mode),
      ...(mode === "none" ? {} : { icon: mode === "oauth" ? ("lock" as const) : ("key" as const) }),
    },
  ];
  const mono = (id: string, label: string, extra: Partial<ConnectorBadge> = {}) =>
    badges.push({ id, label, mono: true, ...extra });
  const fields = connector.credential?.fields ?? [];
  if (fields.length > 1) for (const field of fields) mono(`field.${field.name}`, field.name, { title: field.label });
  if (auth?.header) mono("header", auth.scheme ? `${auth.header}: ${auth.scheme}` : auth.header);
  for (const name of auth?.headerNames ?? []) mono(`headerNames.${name}`, name);
  if (auth?.scope) mono("scope", auth.scope, { prefix: "Scope" });
  for (const origin of auth?.apiOrigins ?? []) mono(`apiOrigins.${origin}`, `→ ${hostOf(origin)}`, { title: origin });
  const authorize = endpointText(auth?.authorizationEndpoint);
  if (authorize) mono("authorize", authorize, { prefix: "Authorize" });
  const token = endpointText(auth?.tokenEndpoint);
  if (token) mono("token", token, { prefix: "Token" });
  if (auth?.clientMetadataUrl) mono("client", hostOf(auth.clientMetadataUrl), { prefix: "Client" });
  if (auth?.tokenEndpointAuthMethod) mono("clientAuth", auth.tokenEndpointAuthMethod);
  if (auth?.confidentialClient) badges.push({ id: "secret", label: "Client secret" });
  if (auth?.pkce) badges.push({ id: "pkce", label: "PKCE" });
  for (const name of auth?.authorizationParamNames ?? []) mono(`param.${name}`, `?${name}`);
  for (const name of auth?.tokenRequestHeaderNames ?? []) mono(`tokenHeader.${name}`, name);
  return badges;
}

/** A connector's Configuration card: what it is and how it signs in as badges, its limits as tiles. */
export function connectorSummary(connector: DescribedConnector, sources: Sources = {}): ConnectorSummary {
  const base = `config.connectors.${connector.id}`;
  const kind = SOURCE_KIND[connector.source.kind] ?? SOURCE_KIND.custom!;
  const badges: ConnectorBadge[] = [{ id: "kind", label: kind.label, icon: kind.icon }];
  if (connector.readOnly) badges.push({ id: "readOnly", label: "Read-only" });
  if (connector.source.provider) badges.push({ id: "provider", label: connector.source.provider, icon: "box" });
  badges.push(
    connector.authScope === "personal"
      ? { id: "scope", label: "Per person", icon: "user" }
      : { id: "scope", label: "Shared account", icon: "users" },
  );
  const endpoint = endpointText(connector.endpoint);
  if (endpoint) badges.push({ id: "endpoint", label: endpoint, mono: true });
  if (connector.usageGuide)
    badges.push({ id: "guide", label: connector.usageGuide.required ? "Guide required" : "Guide", icon: "book" });

  const set = (path: string, fallback: boolean) =>
    (sources[`${base}.${path}`] ?? (fallback ? "config" : "default")) === "config";
  const tiles: StatTile[] = [
    {
      id: `${base}.maxResultBytes`,
      label: "Result cap",
      value: formatValue(connector.maxResultBytes.value, "bytes"),
      set: set("maxResultBytes", connector.maxResultBytes.source === "connector"),
      title: exactBytes(connector.maxResultBytes.value),
    },
  ];
  const admission = connector.callAdmission;
  if (admission?.maxPartitions !== undefined)
    tiles.push({
      id: `${base}.callAdmission.maxPartitions`,
      label: "Partitions",
      value: formatValue(admission.maxPartitions, "count"),
      set: true,
    });
  admission?.rules.forEach((rule, index) => {
    const suffix = admission.rules.length > 1 ? ` ${index + 1}` : "";
    const id = `${base}.callAdmission.rules.${index}`;
    const add = (key: string, label: string, value: string) =>
      tiles.push({ id: `${id}.${key}`, label: `${label}${suffix}`, value, set: true });
    if (rule.maxConcurrency !== undefined)
      add("maxConcurrency", "Concurrency", formatValue(rule.maxConcurrency, "count"));
    if (rule.maxQueueSize !== undefined) add("maxQueueSize", "Queue", formatValue(rule.maxQueueSize, "count"));
    if (rule.queueTimeoutMs !== undefined) add("queueTimeoutMs", "Queue wait", formatValue(rule.queueTimeoutMs, "ms"));
    if (rule.retryAfterMs !== undefined) add("retryAfterMs", "Retry after", formatValue(rule.retryAfterMs, "ms"));
    if (rule.budget)
      add(
        "budget",
        "Call budget",
        `${formatValue(rule.budget.maxCalls, "count")} / ${formatValue(rule.budget.windowMs, "ms")}`,
      );
    if (rule.partitioned) add("partitioned", "Per caller", "On");
  });
  const transport = connector.transport;
  if (transport?.versionNegotiation)
    tiles.push({
      id: `${base}.transport.versionNegotiation`,
      label: "Protocol",
      value: transport.versionNegotiation === "auto" ? "Auto" : "Legacy",
      set: set("transport.versionNegotiation", false),
    });
  if (transport?.redirects)
    tiles.push({
      id: `${base}.transport.redirects`,
      label: "Redirects",
      value: transport.redirects === "none" ? "None" : "Same origin",
      set: set("transport.redirects", false),
    });
  if (transport?.requireHttps !== undefined)
    tiles.push({
      id: `${base}.transport.requireHttps`,
      label: "HTTPS only",
      value: formatValue(transport.requireHttps, "toggle"),
      set: set("transport.requireHttps", false),
    });
  const other = leaves(connector, "")
    .filter(([path]) => !known(path, CONNECTOR_KNOWN))
    .map(([path, value]) => otherTile(path, value, base));
  return { badges, auth: authBadges(connector), tiles: [...tiles, ...other] };
}
