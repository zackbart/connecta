// Internal kit hatch. Unreachable from src/index.ts.
//
// The response contract `*_api_details` returns beside the request contract:
// the success response's declared property paths, written exactly as the
// read and write tools' `fields` argument takes them, so a program can narrow
// or reduce a result without a sampling call. The pinned index carries names
// only, never types or example values, so nothing here can echo vendor data.
//
// Value safety decides what is advertised as readable. Each operation's paths
// are built into two skeleton bodies, one of neutral strings and one whose
// every value carries the redaction placeholder (so each value-dependent rule,
// such as a type discriminator or a record's label, takes its most protective
// outcome), and both pass through the connection's own result-safety
// boundary: reviewed paths, resource rules, the key-name heuristic, closed
// projections and the deployment's sensitive-field choice. A path that does
// not come back unchanged from both is listed as withheld, never as a field.
import { REDACTED } from "../redaction-marker.js";
import type { Operation, OperationIndex } from "../providers/_shared/rest/operation-index.js";
import type { ResultSafety } from "./safety.js";

/**
 * At most 100 paths and 4 KiB of path JSON, an eighth of the 32 KiB details
 * budget. That holds every path of nine in ten operations in each maintained
 * index; larger responses keep their shallowest paths, roots first. A path
 * over 200 characters, longer than one `fields` entry may be, is never listed.
 */
export const RESPONSE_BUDGET = { paths: 100, chars: 4096, pathChars: 200 } as const;

export interface ResponseContract {
  readonly anchor: "data" | "data[]";
  readonly fields: readonly string[];
  readonly withheld?: readonly string[];
  readonly omitted?: number;
}

interface Node {
  array: boolean;
  readonly children: Map<string, Node>;
}

const NEUTRAL = "connecta-probe";
const ALTERED = `connecta-probe${REDACTED}`;

/** `a[].b` → `[["a", true], ["b", false]]`. */
function segments(path: string): [string, boolean][] {
  return path.split(".").map((part) => (part.endsWith("[]") ? [part.slice(0, -2), true] : [part, false]));
}

function skeleton(node: Node, leaf: string): unknown {
  const value =
    node.children.size === 0
      ? leaf
      : Object.fromEntries([...node.children].map(([name, child]) => [name, skeleton(child, leaf)]));
  return node.array ? [value] : value;
}

/** The value at `path`, if present; the tree, not the path's spelling, says where lists are. */
function valueAt(root: unknown, tree: Node, path: string): { readonly value: unknown } | undefined {
  let value = root;
  let node = tree;
  for (const [name] of segments(path)) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, name))
      return undefined;
    value = (value as Record<string, unknown>)[name];
    node = node.children.get(name)!;
    if (node.array) {
      if (!Array.isArray(value) || value.length !== 1) return undefined;
      value = value[0];
    }
  }
  return { value };
}

function place(root: unknown, tree: Node, path: string, value: unknown): void {
  let at = root as Record<string, unknown>;
  let node = tree;
  const parts = segments(path);
  for (const [index, [name]] of parts.entries()) {
    node = node.children.get(name)!;
    if (index === parts.length - 1) at[name] = node.array ? [value] : value;
    else at = (node.array ? (at[name] as unknown[])[0] : at[name]) as Record<string, unknown>;
  }
}

const plainObject = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);

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
  const tree: Node = { array: false, children: new Map() };
  for (const path of paths) {
    let node = tree;
    for (const [name, array] of segments(path)) {
      let child = node.children.get(name);
      if (!child) node.children.set(name, (child = { array, children: new Map() }));
      child.array ||= array;
      node = child;
    }
  }
  // Every root `fields` accepts is listed, including one the index names only beneath it.
  const spelled = new Map<string, string>();
  for (const path of [...tree.children.keys(), ...paths]) {
    const key = path.replace(/\[\](?=\.|$)/g, "");
    if (!spelled.has(key)) spelled.set(key, path);
  }
  const all = [...spelled.values()];
  const depth = (path: string) => path.split(".").length;
  const ordered = all.map((path, at) => ({ path, at })).sort((a, b) => depth(a.path) - depth(b.path) || a.at - b.at);
  const operation = { method: op.method, template: op.path };
  const run = (leaf: string, override?: { readonly path: string; readonly value: unknown }) => {
    const item = skeleton(tree, leaf);
    if (override) place(item, tree, override.path, override.value);
    try {
      const out = safety.redact(anchor === "data[]" ? [item] : item, operation);
      return anchor === "data[]" ? (Array.isArray(out) && out.length === 1 ? out[0] : undefined) : out;
    } catch {
      return undefined;
    }
  };
  const wholes = new Map([NEUTRAL, ALTERED].map((leaf) => [leaf, run(leaf)] as const));
  // Readable only if it survives both probes. The altered probe re-checks a value alone in its
  // neutral spelling, so a rule that withholds only an altered value of its own (a URL whose
  // scheme redaction may have taken) is not mistaken for a field rule; a sibling's altered
  // discriminator, label or type still selects every rule. A value a closed projection keeps
  // only as a record or a list of records is re-checked as one, unless a rule wrote over it.
  const readable = (path: string) => {
    const leaf = [...segments(path)].reduce((node, [name]) => node.children.get(name)!, tree).children.size === 0;
    return [NEUTRAL, ALTERED].every((base) => {
      let found = valueAt(wholes.get(base), tree, path);
      if (!leaf) return found !== undefined && plainObject(found.value);
      if (found?.value === base) return true;
      if (base === ALTERED) {
        found = valueAt(run(base, { path, value: NEUTRAL }), tree, path);
        if (found?.value === NEUTRAL) return true;
      }
      if (typeof found?.value === "string") return false;
      return [{}, [{}]].some((value) => {
        const shaped = valueAt(run(base, { path, value }), tree, path);
        return shaped !== undefined && (Array.isArray(value) ? Array.isArray(shaped.value) : plainObject(shaped.value));
      });
    });
  };
  const fields: string[] = [];
  const withheld: string[] = [];
  let chars = 0;
  let kept = 0;
  for (const { path } of ordered) {
    // A path longer than a fields input can be is counted, never listed.
    if (path.length > RESPONSE_BUDGET.pathChars) continue;
    const cost = JSON.stringify(path).length + 1;
    if (kept >= RESPONSE_BUDGET.paths || chars + cost > RESPONSE_BUDGET.chars) break;
    (readable(path) ? fields : withheld).push(path);
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
