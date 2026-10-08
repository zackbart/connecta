import { Badge } from "./parts.js";

/** Render the allowlisted snapshot as text. Never interpret a catalog string as markup. */
export function SnapshotTree({ value, path = "config", source = "config" }: { value: unknown; path?: string; source?: "default" | "config" }) {
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if ("value" in object && "source" in object && Object.keys(object).length === 2) {
      return <SnapshotTree path={path} value={object.value} source={object.source === "default" ? "default" : "config"} />;
    }
    const entries = Object.entries(object);
    if (!entries.length) return <div className="snapshot-value"><code>{path.split(".").pop()}</code><span>{Array.isArray(value) ? "[]" : "{}"}</span><Badge>{source}</Badge></div>;
    return <div className="snapshot-tree">{entries.map(([key, item]) => item !== null && typeof item === "object" && !("value" in item && "source" in item) ? <details key={key} open={path === "config" || path === "connector"}><summary>{key}<span className="meta">{Array.isArray(item) ? `${item.length} entries` : ""}</span></summary><SnapshotTree path={`${path}.${key}`} value={item} source={source} /></details> : <SnapshotTree key={key} path={`${path}.${key}`} value={item} source={source} />)}</div>;
  }
  return <div className="snapshot-value"><code title={path}>{path.split(".").pop()}</code><span>{value === null ? "unset" : String(value)}</span><Badge>{source}</Badge></div>;
}
