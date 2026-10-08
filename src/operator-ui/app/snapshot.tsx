import { Badge } from "./parts.js";

/** Render the allowlisted snapshot as text. Never interpret a catalog string as markup. */
export function SnapshotTree({
  value,
  path = "config",
  source = "config",
  sources = {},
}: {
  value: unknown;
  path?: string;
  source?: "default" | "config";
  sources?: Record<string, "default" | "config"> | undefined;
}) {
  source = sources[path] ?? source;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if ("value" in object && "source" in object && Object.keys(object).length === 2) {
      return (
        <SnapshotTree
          path={path}
          value={object.value}
          sources={sources}
          source={sources[path] ?? (object.source === "default" ? "default" : "config")}
        />
      );
    }
    const entries = Object.entries(object).map(
      ([key, item]) =>
        [
          Array.isArray(value) &&
          (path === "config.connectors" || path === "config.pools") &&
          item &&
          typeof item === "object"
            ? String(
                path === "config.connectors"
                  ? (item as Record<string, unknown>).id
                  : (item as Record<string, unknown>).name,
              )
            : key,
          item,
        ] as const,
    );
    if (!entries.length)
      return (
        <div className="snapshot-value">
          <code>{path.split(".").pop()}</code>
          <span>{Array.isArray(value) ? "[]" : "{}"}</span>
          <Badge>{source}</Badge>
        </div>
      );
    return (
      <div className="snapshot-tree">
        {entries.map(([key, item]) =>
          item !== null && typeof item === "object" && !("value" in item && "source" in item) ? (
            <details key={key} open={path === "config" || path === "connector"}>
              <summary>
                {key}
                <span className="meta">{Array.isArray(item) ? `${item.length} entries` : ""}</span>
              </summary>
              <SnapshotTree path={`${path}.${key}`} value={item} source={source} sources={sources} />
            </details>
          ) : (
            <SnapshotTree key={key} path={`${path}.${key}`} value={item} source={source} sources={sources} />
          ),
        )}
      </div>
    );
  }
  return (
    <div className="snapshot-value">
      <code title={path}>{path.split(".").pop()}</code>
      <span>{value === null ? "unset" : String(value)}</span>
      <Badge>{source}</Badge>
    </div>
  );
}
