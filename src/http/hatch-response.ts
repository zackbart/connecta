// Internal kit hatch. Unreachable from src/index.ts.
//
// The response contract `*_api_details` returns beside the request contract:
// the success response's declared property paths, written exactly as the
// read and write tools' `fields` argument takes them, so a program can narrow
// or reduce a result without a sampling call. The pinned index carries names
// only, never types or example values, so nothing here can echo vendor data.
//
// A path is listed as readable only when two independent checks agree, and
// withheld otherwise; anything inconclusive withholds.
//
// 1. The connection's own rules, read as a classifier (`ResultSafety.transforms`):
//    the same reviewed table its redaction applies, every reviewed path tried
//    at every depth, every resource rule for every type, every key-name rule
//    without exemptions, and the sensitive-field choice. A reviewed redaction
//    that declares no classifier transforms every path.
// 2. Probes through the connection's own redaction: one skeleton body per
//    value shape (strings, a placeholder-carrying string, numbers, booleans, a
//    populated map, a list of strings, a list of records), each shape placed at
//    every declared leaf at once. A leaf must come back exactly as it went in
//    for every scalar shape; a container shape may only be dropped by its own
//    key, never changed. A container is readable only if every declared path
//    beneath it is, and its whole subtree survives each scalar shape.
//
// Content rules still apply inside any value read: a URL carrying credentials,
// a sent secret echoed back, or a credential-named key nested in an undeclared
// structure is redacted wherever it appears.
import { canonicalJson } from "../canonical-json.js";
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

const TEXT = "connecta-probe";
const SCALARS: readonly unknown[] = [TEXT, `${TEXT}${REDACTED}`, 7, true];
const CONTAINERS: readonly unknown[] = [
  { probe_key: TEXT, probe_list: [TEXT], probe_map: { probe_key: TEXT } },
  [TEXT],
  [{ probe_key: TEXT }],
];

/** `a[].b` → `["a", "b"]`; the tree says where lists are. */
function names(path: string): string[] {
  return path.split(".").map((part) => part.replace(/\[\]$/, ""));
}

function skeleton(node: Node, leaf: unknown): unknown {
  const value =
    node.children.size === 0
      ? structuredClone(leaf)
      : Object.fromEntries([...node.children].map(([name, child]) => [name, skeleton(child, leaf)]));
  return node.array ? [value] : value;
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * What came back at `path`: `present` with its value, `dropped` when only its
 * own key is missing from an intact parent record, or `lost` otherwise.
 */
function at(root: unknown, tree: Node, path: string) {
  let value = root;
  let node = tree;
  const parts = names(path);
  for (const [index, name] of parts.entries()) {
    if (!plainObject(value)) return { state: "lost" as const };
    if (!Object.hasOwn(value, name)) return { state: index === parts.length - 1 ? "dropped" : "lost" } as const;
    value = value[name];
    node = node.children.get(name)!;
    if (node.array) {
      if (!Array.isArray(value) || value.length !== 1) return { state: "lost" as const };
      value = value[0];
    }
  }
  return { state: "present" as const, value };
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
  const tree: Node = { array: false, children: new Map() };
  for (const path of paths) {
    let node = tree;
    for (const part of path.split(".")) {
      const name = part.replace(/\[\]$/, "");
      let child = node.children.get(name);
      if (!child) node.children.set(name, (child = { array: false, children: new Map() }));
      child.array ||= part.endsWith("[]");
      node = child;
    }
  }
  // Every root `fields` accepts is listed, including one the index names only beneath it.
  const spelled = new Map<string, string>();
  for (const path of [...tree.children.keys(), ...paths]) {
    const key = names(path).join(".");
    if (!spelled.has(key)) spelled.set(key, path);
  }
  const all = [...spelled.values()];
  const depth = (path: string) => path.split(".").length;
  const ordered = all.map((path, at) => ({ path, at })).sort((a, b) => depth(a.path) - depth(b.path) || a.at - b.at);

  const operation = { method: op.method, template: op.path };
  let transforms: (path: readonly string[]) => boolean;
  try {
    transforms = safety.transforms(operation);
  } catch {
    transforms = () => true;
  }
  const probe = (leaf: unknown) => {
    const item = skeleton(tree, leaf);
    try {
      const out = safety.redact(anchor === "data[]" ? [structuredClone(item)] : structuredClone(item), operation);
      return { item, out: anchor === "data[]" ? (Array.isArray(out) && out.length === 1 ? out[0] : undefined) : out };
    } catch {
      return undefined;
    }
  };
  const scalars = SCALARS.map((leaf) => ({ leaf, run: probe(leaf) }));
  const containers = CONTAINERS.map((leaf) => ({ leaf, run: probe(leaf) }));
  const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
  const verdicts = new Map<string, boolean>();
  const readable = (path: string): boolean => {
    const key = names(path).join(".");
    const known = verdicts.get(key);
    if (known !== undefined) return known;
    const node = names(path).reduce((parent, name) => parent.children.get(name)!, tree);
    const verdict =
      !transforms(names(path)) &&
      (node.children.size === 0
        ? scalars.every(({ leaf, run }) => {
            const found = run && at(run.out, tree, path);
            return found?.state === "present" && same(found.value, leaf);
          }) &&
          containers.every(({ leaf, run }) => {
            const found = run && at(run.out, tree, path);
            return found?.state === "dropped" || (found?.state === "present" && same(found.value, leaf));
          })
        : [...node.children].every(([child, below]) => readable(`${key}.${child}${below.array ? "[]" : ""}`)) &&
          scalars.every(({ run }) => {
            if (!run) return false;
            const found = at(run.out, tree, path);
            const sent = at(run.item, tree, path);
            return found.state === "present" && sent.state === "present" && same(found.value, sent.value);
          }));
    verdicts.set(key, verdict);
    return verdict;
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
