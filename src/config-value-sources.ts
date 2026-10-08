import type { ConnectaConfig } from "./config.js";
import type { ConfigValueSource, ConnectaConfigDescription } from "./describe-config.js";

/** Walk only serialized keys. Stable connector/pool keys survive viewer filtering. */
export function configValuePaths(value: unknown, path = "config"): string[] {
  if (value === null || typeof value !== "object") return [path];
  const entries = Object.entries(value);
  if (!entries.length) return [path];
  if ("value" in value && "source" in value && entries.length === 2) return [path];
  return entries.flatMap(([key, item]) => {
    const stableKey = Array.isArray(value) && (path === "config.connectors" || path === "config.pools") && item && typeof item === "object"
      ? String(path === "config.connectors" ? item.id : item.name) : key;
    return configValuePaths(item, `${path}.${stableKey}`);
  });
}

/** Read only provenance literals; custom describe hooks may throw or return unknown data. */
function factorySources(factory: { describe?(): unknown } | undefined): Readonly<Record<string, ConfigValueSource>> {
  try {
    const description = factory?.describe?.();
    if (!description || typeof description !== "object" || !("optionSources" in description)) return {};
    const sources = description.optionSources;
    if (!sources || typeof sources !== "object") return {};
    return Object.fromEntries(Object.entries(sources).filter((entry): entry is [string, ConfigValueSource] =>
      entry[1] === "default" || entry[1] === "config"));
  } catch { return {}; }
}

function factorySource(sources: Readonly<Record<string, ConfigValueSource>>, parts: string[]): ConfigValueSource | undefined {
  for (let length = parts.length; length > 0; length--) {
    const source = sources[parts.slice(0, length).join(".")];
    if (source === "default" || source === "config") return source;
  }
  return undefined;
}

/** Provenance is presence in code, not equality to a default value. No raw value leaves this function. */
export function describeConfigSources(snapshot: ConnectaConfigDescription, raw: ConnectaConfig): Record<string, ConfigValueSource> {
  const sources: Record<string, ConfigValueSource> = {};
  const connectorSources = new Map(raw.connectors.map(connector => [connector.id, factorySources(connector)]));
  const moduleSources = { accessTokens: factorySources(raw.accessTokens), artifacts: factorySources(raw.artifacts) };
  const provided = (value: unknown): ConfigValueSource => value === undefined ? "default" : "config";
  for (const path of configValuePaths(snapshot)) {
    const parts = path.split(".").slice(1);
    const [group, key, field] = parts;
    let source: ConfigValueSource = "config";
    if (group === "schemaVersion" || group === "connectaVersion") source = "default";
    else if (group === "server") source = provided(raw.serverInfo?.[key as keyof NonNullable<ConnectaConfig["serverInfo"]>]);
    else if (group === "urls") source = key === "mcpPath" ? "default" : provided(raw[key as "publicUrl" | "artifactOrigin" | "allowedOrigins"]);
    else if (group === "trust") source = provided(raw.trust);
    else if (group === "identity") source = provided(raw.identity?.[key as keyof NonNullable<ConnectaConfig["identity"]>]);
    else if (group === "storage") source = provided(raw.storage);
    else if (group === "deploymentInfo") source = provided(raw.deploymentInfo);
    else if (group === "classification") source = provided(raw.classification);
    else if (group === "pools") source = field === "trust" ? provided(raw.pools?.[key!]?.trust) : provided(raw.pools);
    else if (group === "modules") {
      const module = key === "ui" ? raw.ui : key === "vault" ? raw.vault : key === "activity" ? raw.activity : key === "accessTokens" ? raw.accessTokens : raw.artifacts;
      const factory = moduleSources[key as keyof typeof moduleSources];
      source = (factory ? factorySource(factory, parts.slice(2)) : undefined) ?? provided(module);
    } else if (group === "branding") {
      const brand = raw.ui?.branding;
      const brandKey = key === "faviconHref" ? "favicon" : key;
      source = key === "theme" ? provided(brand?.theme?.[field as keyof NonNullable<typeof brand>["theme"]]) : provided(brand?.[brandKey as keyof NonNullable<typeof brand>]);
    } else if (group === "connectors") {
      const connector = raw.connectors.find(c => c.id === key);
      source = factorySource(connectorSources.get(key!) ?? {}, parts.slice(2)) ?? source;
      if (field === "authScope") source = provided(connector?.authScope);
      else if (field === "maxResultBytes") source = provided(connector?.maxResultBytes ?? raw.calls?.maxResultBytes);
    } else if (group === "limits" || (group === "executor" && key === "admission")) {
      let limit: unknown = snapshot;
      for (const part of parts) limit = limit && typeof limit === "object" ? (limit as Record<string, unknown>)[part] : undefined;
      source = limit && typeof limit === "object" && "source" in limit && limit.source === "default" ? "default" : "config";
    }
    sources[path] = source;
  }
  return sources;
}
