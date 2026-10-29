// Internal kit hatch. Unreachable from src/index.ts.
//
// The response contract `*_api_details` returns beside the request contract:
// the success response's declared property paths, written exactly as the
// read and write tools' `fields` argument takes them, so a program can narrow
// or reduce a result without a sampling call. The pinned index carries names
// only, never types or example values, so nothing here can echo vendor data.
//
// It states where values are, not that they are readable. Value safety runs on
// every read, and what it withholds or redacts can depend on the values a
// vendor returns (a resource type, a record's label, an expanded object, a
// URL), which no index can know in advance. `withheld` is only a hint: the
// listed paths the connection's own rules always withhold or redact
// (`ResultSafety.withholds`), plus any container above one. An unlisted path
// may still be withheld or redacted.
import type { Operation, OperationIndex } from "../providers/_shared/rest/operation-index.js";
import type { ResultSafety } from "./safety.js";

/**
 * At most 100 paths and 4 KiB of path JSON, `withheld` included, an eighth of
 * the 32 KiB details budget. That holds every path of nine in ten operations
 * in each maintained index; larger responses keep their shallowest paths,
 * roots first. A path over 200 characters, longer than one `fields` entry may
 * be, is never listed.
 */
export const RESPONSE_BUDGET = { paths: 100, chars: 4096, pathChars: 200 } as const;

export interface ResponseContract {
  readonly anchor: "data" | "data[]";
  readonly fields: readonly string[];
  readonly withheld?: readonly string[];
  readonly omitted?: number;
}

/** `a[].b` → `["a", "b"]`. */
function names(path: string): string[] {
  return path.split(".").map((part) => part.replace(/\[\]$/, ""));
}

/**
 * The capped response contract for one operation, or undefined when it
 * declares no response properties (`fields` is then refused). Deterministic:
 * paths keep the index's order within each depth.
 */
export function responseContract(
  index: OperationIndex,
  op: Operation,
  safety: ResultSafety,
): ResponseContract | undefined {
  const declared = index.fields(op).filter((field) => field.in === "response");
  if (declared.length === 0) return undefined;
  const anchor = declared.some((field) => field.path.startsWith("[]")) ? "data[]" : "data";
  // The coordinates `fields` validates: an item path of a list body drops its leading `[].`.
  const paths = [
    ...new Set(declared.map((field) => field.path.replace(/^\[\]\.?/, "")).filter((path) => /^[^.[]/.test(path))),
  ];
  // Every root `fields` accepts is listed, including one the index names only beneath it.
  const spelled = new Map<string, string>();
  for (const path of [...paths.map((path) => names(path)[0]!), ...paths]) {
    const key = names(path).join(".");
    if (!spelled.has(key)) spelled.set(key, path);
  }
  const keys = [...spelled.keys()];
  let withholds: (path: readonly string[]) => boolean;
  try {
    withholds = safety.withholds({ method: op.method, template: op.path });
  } catch {
    withholds = () => false;
  }
  // A container holds what is withheld beneath it, so a read of it is never whole either.
  const known = new Set(keys.filter((key) => withholds(key.split("."))));
  for (const key of keys) if ([...known].some((inner) => inner.startsWith(`${key}.`))) known.add(key);
  const depth = (path: string) => path.split(".").length;
  const ordered = [...spelled.values()]
    .map((path, at) => ({ path, at }))
    .sort((a, b) => depth(a.path) - depth(b.path) || a.at - b.at);
  const fields: string[] = [];
  const withheld: string[] = [];
  let chars = 0;
  let kept = 0;
  for (const { path } of ordered) {
    // A path longer than a fields input can be is counted, never listed.
    if (path.length > RESPONSE_BUDGET.pathChars) continue;
    const hinted = known.has(names(path).join("."));
    const cost = (JSON.stringify(path).length + 1) * (hinted ? 2 : 1);
    if (kept >= RESPONSE_BUDGET.paths || chars + cost > RESPONSE_BUDGET.chars) break;
    fields.push(path);
    if (hinted) withheld.push(path);
    chars += cost;
    kept += 1;
  }
  return {
    anchor,
    fields,
    ...(withheld.length ? { withheld } : {}),
    ...(kept < ordered.length ? { omitted: ordered.length - kept } : {}),
  };
}
