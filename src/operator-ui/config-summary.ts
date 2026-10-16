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
export type ValueFormat = "bytes" | "ms" | "seconds" | "days" | "count" | "toggle" | "text";

/** Icon names the tiles draw; app/icons.tsx defines each one. */
type ConfigIcon =
  | "monitor"
  | "lock"
  | "activity"
  | "key"
  | "shield"
  | "box"
  | "plug"
  | "globe"
  | "user"
  | "users"
  | "book";

/** A value with a short label. `set` means deployment code set it; otherwise it is a default. */
export interface StatTile {
  id: string;
  label: string;
  value: string;
  set: boolean;
}

/** An optional module or switch: on or off. */
export interface FeatureTile {
  id: string;
  label: string;
  icon: ConfigIcon;
  on: boolean;
}

/** One inbound sign-in method, in the order the deployment tries them. */
export interface SignInTile {
  id: string;
  label: string;
  mark: "clerk" | "access" | "tokens" | "other";
  /** People sign in with it; otherwise it admits machines. */
  interactive: boolean;
}

/** A deployment fact: version, storage, URL. */
export interface FactChip {
  id: string;
  label: string;
  value: string;
  mono?: boolean;
}

/** A tool whose read/write verdict deployment code overrides. */
export interface OverrideChip {
  address: string;
  classification: "read" | "write";
}

export interface ConfigSummary {
  deployment: FactChip[];
  /** The product name; its chip draws the accent as a swatch. */
  brand: string;
  signIn: SignInTile[];
  agents: string[];
  features: FeatureTile[];
  /** Headline limits, then every limit set in code. */
  limits: StatTile[];
  /** The remaining limits, all defaults, drawn smaller. */
  moreLimits: StatTile[];
  overrides: OverrideChip[];
  /** Snapshot keys this file does not map, with labels made from their names. */
  other: StatTile[];
}

export interface ConnectorBadge {
  id: string;
  label: string;
  icon?: ConfigIcon;
  mono?: boolean;
}

export interface ConnectorSummary {
  badges: ConnectorBadge[];
  tiles: StatTile[];
}

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** Bytes in the unit that reads round: binary when the value is a whole MiB or KiB, else decimal. */
function formatBytes(bytes: number): string {
  for (const [unit, power] of [
    ["GB", 3],
    ["MB", 2],
    ["KB", 1],
  ] as const) {
    if (bytes >= 1024 ** power && bytes % 1024 ** power === 0) return `${NUMBER.format(bytes / 1024 ** power)} ${unit}`;
    if (bytes >= 1000 ** power) return `${NUMBER.format(bytes / 1000 ** power)} ${unit}`;
  }
  return `${NUMBER.format(bytes)} B`;
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
export function formatValue(value: unknown, format: ValueFormat): string {
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
export function inferFormat(key: string, value: unknown): ValueFormat {
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
export function humanizeKey(key: string): string {
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

/** Labels for every limit the snapshot carries today, by `group.key`. Headline limits draw large. */
const LIMITS: Record<string, { label: string; headline?: number }> = {
  "calls.defaultTimeoutMs": { label: "Tool timeout", headline: 1 },
  "calls.maxResultBytes": { label: "Result cap", headline: 2 },
  "execute.watchdogMs": { label: "Program timeout", headline: 3 },
  "execute.maxHostCalls": { label: "Calls per program", headline: 6 },
  "execute.maxWrites": { label: "Writes per program", headline: 7 },
  "requests.concurrency": { label: "Concurrent requests", headline: 8 },
  "discovery.catalogTtlSeconds": { label: "Catalog refresh", headline: 4 },
  "discovery.concurrency": { label: "Probe concurrency" },
  "discovery.catalogMinTtlSeconds": { label: "Min refresh" },
  "discovery.catalogMaxTtlSeconds": { label: "Max refresh" },
  "discovery.probeTimeoutMs": { label: "Probe timeout" },
  "results.maxStashBytes": { label: "Stash size" },
  "results.maxStashEntries": { label: "Stash entries" },
  "execute.maxEmittedBytes": { label: "Program output" },
  "execute.maxEmittedBlocks": { label: "Output blocks" },
  "execute.hostCallTimeoutMs": { label: "Host call timeout" },
  "requests.maxQueueSize": { label: "Request queue" },
  "requests.queueTimeoutMs": { label: "Queue wait" },
  "requests.retryAfterMs": { label: "Retry after" },
  "requests.maxDurationMs": { label: "Request lifetime" },
  "admission.concurrency": { label: "Concurrent programs" },
  "admission.maxQueueSize": { label: "Program queue" },
  "admission.queueTimeoutMs": { label: "Program queue wait" },
  "admission.retryAfterMs": { label: "Program retry after" },
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

function limitTile(path: string, key: string, limit: DescribedLimit<unknown>, sources: Sources, label?: string) {
  const id = `config.${path}`;
  return {
    id,
    label: label ?? humanizeKey(key),
    value: limit.value === null ? "No limit" : formatValue(limit.value, inferFormat(key, limit.value)),
    set: (sources[id] ?? limit.source) === "config",
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
  ui: { label: "Operator UI", icon: "monitor" },
  vault: { label: "Vault", icon: "lock" },
  activity: { label: "Activity", icon: "activity" },
  accessTokens: { label: "Agent tokens", icon: "key" },
};

/** Paths this file draws (or deliberately leaves to another page). Everything else is "other". */
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
  "storage",
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

/** A tile for a key nobody mapped: its own name, or its parent's and its own when the name alone is vague. */
function otherTile(path: string, value: unknown, sources: Sources, prefix: string): StatTile {
  const parts = path.split(".");
  const key = parts.at(-1)!;
  const parent = parts.length > 1 ? parts.at(-2)! : undefined;
  const inner = isLimit(value) ? value : null;
  const raw = inner ? inner.value : value;
  return {
    id: `${prefix}.${path}`,
    label:
      parent && /^(enabled|value|kind|mode|name)$/.test(key)
        ? `${humanizeKey(parent)} ${humanizeKey(key).toLowerCase()}`
        : humanizeKey(key),
    value: formatValue(raw, inferFormat(key, raw)),
    set: (sources[`${prefix}.${path}`] ?? inner?.source) === "config",
  };
}

function endpointText(endpoint: { origin: string; path: string } | undefined): string | undefined {
  if (!endpoint) return undefined;
  const host = endpoint.origin.replace(/^https?:\/\//, "");
  return endpoint.path && endpoint.path !== "/" ? `${host}${endpoint.path}` : host;
}

/** Settings, as tiles. */
export function configSummary(config: ConnectaConfigDescription, sources: Sources = {}): ConfigSummary {
  const deployment: FactChip[] = [
    { id: "name", label: "Name", value: config.server.title ?? config.server.name },
    { id: "version", label: "Version", value: config.server.version, mono: true },
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
            ? origins[0]!.replace(/^https?:\/\//, "")
            : `${origins.length}`,
    mono: Array.isArray(origins) && origins.length === 1,
  });
  if (config.executor.name) deployment.push({ id: "sandbox", label: "Sandbox", value: config.executor.name });
  deployment.push({ id: "storage", label: "Storage", value: STORE[config.storage.kind] ?? config.storage.kind });
  if (config.modules.activity.enabled && config.modules.activity.store)
    deployment.push({
      id: "history",
      label: "History",
      value: STORE[config.modules.activity.store.kind] ?? config.modules.activity.store.kind,
    });
  if (config.modules.activity.deploymentId)
    deployment.push({ id: "deploymentId", label: "ID", value: config.modules.activity.deploymentId, mono: true });
  const website = endpointText(config.server.websiteUrl);
  if (website) deployment.push({ id: "website", label: "Website", value: website, mono: true });
  if (config.server.icons > 0)
    deployment.push({ id: "icons", label: "Icons", value: formatValue(config.server.icons, "count") });
  deployment.push(
    { id: "connectors", label: "Connectors", value: formatValue(config.connectors.length, "count") },
    { id: "pools", label: "Pools", value: formatValue(config.pools.length, "count") },
  );
  if (config.deploymentInfo.length)
    deployment.push({ id: "info", label: "Info", value: config.deploymentInfo.join(", "), mono: true });

  const signIn = config.auth.map((provider, index): SignInTile => {
    const knownProvider = SIGN_IN[provider.kind];
    return {
      id: `${provider.kind}-${index}`,
      label: knownProvider?.label ?? humanizeKey(provider.kind),
      mark: knownProvider?.mark ?? "other",
      interactive: provider.interactive,
    };
  });

  const features: FeatureTile[] = [];
  for (const [name, module] of Object.entries(config.modules) as Array<[string, { enabled?: unknown }]>) {
    if (typeof module?.enabled !== "boolean") continue;
    const meta = MODULES[name] ?? { label: humanizeKey(name), icon: "box" as const };
    features.push({ id: name, label: meta.label, icon: meta.icon, on: module.enabled });
  }
  features.push({ id: "readOnly", label: "Read-only", icon: "shield", on: config.readOnly });

  const all: Array<StatTile & { headline: number }> = [];
  for (const [group, values] of Object.entries(config.limits) as Array<[string, Record<string, unknown>]>)
    for (const [key, limit] of Object.entries(values)) {
      if (!isLimit(limit)) continue;
      const meta = LIMITS[`${group}.${key}`];
      all.push({
        ...limitTile(`limits.${group}.${key}`, key, limit, sources, meta?.label),
        headline: meta?.headline ?? 0,
      });
    }
  if (config.executor.admission !== "executor")
    for (const [key, limit] of Object.entries(config.executor.admission) as Array<[string, unknown]>) {
      if (!isLimit(limit)) continue;
      all.push({
        ...limitTile(`executor.admission.${key}`, key, limit, sources, LIMITS[`admission.${key}`]?.label),
        headline: 0,
      });
    }
  const retention = config.modules.activity.enabled ? config.modules.activity.store?.retentionDays : undefined;
  if (retention !== undefined) {
    const id = "config.modules.activity.store.retentionDays";
    all.push({
      id,
      label: "Activity kept",
      value: formatValue(retention, "days"),
      set: sources[id] === "config",
      headline: 5,
    });
  }
  const strip = ({ headline: _, ...tile }: StatTile & { headline: number }): StatTile => tile;
  // Headline limits in a fixed order, then any other limit code set.
  const limits = [
    ...all.filter((tile) => tile.headline).sort((a, b) => a.headline - b.headline),
    ...all.filter((tile) => !tile.headline && tile.set),
  ].map(strip);
  const moreLimits = all.filter((tile) => !tile.headline && !tile.set).map(strip);

  const overrides = Object.entries(config.classification).flatMap(([connector, tools]) =>
    Object.entries(tools).map(([tool, classification]) => ({ address: `${connector}.${tool}`, classification })),
  );

  const other = leaves(config, "")
    .filter(([path]) => !known(path, KNOWN) && !/^modules\.[^.]+\.enabled$/.test(path))
    .map(([path, value]) => otherTile(path, value, sources, "config"));

  return {
    deployment,
    brand: config.branding.productName,
    signIn,
    agents: [...config.agents],
    features,
    limits,
    moreLimits,
    overrides,
    other,
  };
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

/** Connector fields this file draws, or leaves to the Tools and Connection tabs. */
const CONNECTOR_KNOWN = [
  "id",
  "title",
  "description",
  "authScope",
  "source",
  "endpoint",
  "auth",
  "transport",
  "credential",
  "maxResultBytes",
  "callAdmission",
  "usageGuide",
  "tools",
];

/** A connector's Configuration card: what it is as badges, its limits as tiles. */
export function connectorSummary(connector: DescribedConnector, sources: Sources = {}): ConnectorSummary {
  const base = `config.connectors.${connector.id}`;
  const kind = SOURCE_KIND[connector.source.kind] ?? SOURCE_KIND.custom!;
  const badges: ConnectorBadge[] = [{ id: "kind", label: kind.label, icon: kind.icon }];
  if (connector.source.provider) badges.push({ id: "provider", label: connector.source.provider, icon: "box" });
  badges.push(
    connector.authScope === "personal"
      ? { id: "scope", label: "Per person", icon: "user" }
      : { id: "scope", label: "Shared account", icon: "users" },
  );
  const mode = connector.auth?.mode ?? (connector.credential ? "credential" : undefined);
  if (mode)
    badges.push({
      id: "auth",
      label:
        mode === "credential" && (connector.credential?.fields?.length ?? 0) > 1 ? "Credentials" : AUTH_MODE[mode]!,
      icon: mode === "oauth" ? "lock" : "key",
    });
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
    .map(([path, value]) => otherTile(path, value, sources, base));
  return { badges, tiles: [...tiles, ...other] };
}
