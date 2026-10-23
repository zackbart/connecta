// Contributor drift digests. The default inline representation is unchanged.
// ref-graph-v1 hashes structural nodes once; strongly connected reference
// components are one deterministic unit, so recursive expansion stays bounded.
import { createHash } from "node:crypto";
const PROSE_KEYS = new Set(["description", "summary", "example", "examples", "externalDocs", "title", "deprecated"]);
/** Follow a local JSON pointer; anything else stays a reference. */
function pointer(document, ref) {
  if (!ref.startsWith("#/")) return undefined;
  let node = document;
  for (const raw of ref.slice(2).split("/")) {
    const key = decodeURIComponent(raw.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (node === null || typeof node !== "object") return undefined;
    node = node[key];
  }
  return node;
}

/**
 * Inline the operation's local `$ref`s and drop prose.
 *
 * Both providers keep their real request and response shapes in shared
 * components, so an unresolved reference would make the digest blind to exactly
 * the changes it exists to catch. A reference already on the resolution stack —
 * a block that contains blocks, a schema that contains itself — is left as a
 * reference: that is a cycle, not a contract, and the alternative is a
 * traversal that never ends.
 */
function inline(document, value, stack = []) {
  if (Array.isArray(value)) {
    return value.map((item) => inline(document, item, stack));
  }
  if (value === null || typeof value !== "object") return value;
  const ref = value.$ref;
  if (typeof ref === "string") {
    if (stack.includes(ref)) return { $ref: ref };
    const target = pointer(document, ref);
    if (target === undefined) return { $ref: ref };
    const rest = { ...value };
    delete rest.$ref;
    return {
      ...inline(document, target, [...stack, ref]),
      ...inline(document, rest, stack),
    };
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (PROSE_KEYS.has(key) || key.startsWith("x-")) continue;
    if (item === undefined) continue;
    out[key] = inline(document, item, stack);
  }
  return out;
}

/** Deterministic JSON: sorted keys, so key order is not a contract change. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

/**
 * Digest one operation's contract: what a caller may send, and what a
 * successful call returns. Failure responses are excluded — an error body is
 * H11's business, mapped from the status, not from a schema — and so is prose.
 *
 * Each response is inlined *before* its `content` is read. A whole response
 * object is frequently a reference — Cloudflare writes several of the ones
 * connecta touches as `{"$ref": "#/components/responses/…"}` — and a reference
 * has no `content` key of its own, so reading through it first would digest the
 * entire response contract as `null` and go blind to exactly what it watches.
 */
export function contractDigest(document, operation, algorithm) {
  if (algorithm === "ref-graph-v1") return referenceGraph(document)(operation);
  if (algorithm !== undefined) throw new Error(`Unknown contract digest algorithm: ${algorithm}`);
  const successes = Object.fromEntries(
    Object.entries(operation.responses ?? {})
      .filter(([status]) => status.startsWith("2"))
      .map(([status, response]) => {
        const resolved = inline(document, response ?? null);
        return [status, resolved?.content ?? null];
      }),
  );
  const contract = canonicalize({
    parameters: inline(document, operation.parameters ?? null),
    requestBody: inline(document, operation.requestBody ?? null),
    responses: successes,
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(contract)).digest("hex")}`;
}

const graphs = new WeakMap();
const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const entries = (value) =>
  Object.entries(value)
    .filter(([key, item]) => item !== undefined && !PROSE_KEYS.has(key) && !key.startsWith("x-"))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

function referenceGraph(document) {
  const previous = graphs.get(document);
  if (previous) return previous;
  const edges = new Map();
  const refsIn = (value, found = new Set()) => {
    if (Array.isArray(value)) value.forEach((item) => refsIn(item, found));
    else if (value && typeof value === "object") {
      if (typeof value.$ref === "string" && pointer(document, value.$ref) !== undefined) found.add(value.$ref);
      entries(value).forEach(([, item]) => refsIn(item, found));
    }
    return found;
  };
  const discover = (ref) => {
    if (edges.has(ref)) return;
    const children = refsIn(pointer(document, ref));
    edges.set(ref, children);
    [...children].sort().forEach(discover);
  };
  [...refsIn(document)].sort().forEach(discover);
  // Tarjan: every cycle is hashed once, independently of the operation that enters it.
  let ordinal = 0;
  const numbers = new Map(),
    low = new Map(),
    stack = [],
    active = new Set(),
    components = [],
    componentOf = new Map();
  const visit = (ref) => {
    numbers.set(ref, ordinal);
    low.set(ref, ordinal++);
    stack.push(ref);
    active.add(ref);
    for (const next of [...edges.get(ref)].sort()) {
      if (!numbers.has(next)) {
        visit(next);
        low.set(ref, Math.min(low.get(ref), low.get(next)));
      } else if (active.has(next)) low.set(ref, Math.min(low.get(ref), numbers.get(next)));
    }
    if (low.get(ref) === numbers.get(ref)) {
      const members = [];
      let next;
      do {
        next = stack.pop();
        active.delete(next);
        members.push(next);
      } while (next !== ref);
      const id = components.length;
      members.sort();
      members.forEach((member) => componentOf.set(member, id));
      components.push(members);
    }
  };
  [...edges.keys()].sort().forEach((ref) => {
    if (!numbers.has(ref)) visit(ref);
  });
  const componentHashes = new Map(),
    referenceHashes = new Map();
  const shallow = (value, seen = new Set()) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.$ref !== "string") return value;
    const target = pointer(document, value.$ref);
    if (target === undefined || seen.has(value.$ref)) return value;
    const next = new Set(seen);
    next.add(value.$ref);
    const rest = Object.fromEntries(entries(value).filter(([key]) => key !== "$ref"));
    return { ...shallow(target, next), ...rest };
  };
  const hashRef = (ref, inside) => {
    const id = componentOf.get(ref);
    if (id === inside) return sha(["cycle-ref", ref]);
    const cached = referenceHashes.get(ref);
    if (cached) return cached;
    const members = components[id];
    const cyclic = members.length > 1 || edges.get(ref).has(ref);
    if (!cyclic) {
      const digest = hashValue(pointer(document, ref));
      referenceHashes.set(ref, digest);
      return digest;
    }
    let digest = componentHashes.get(id);
    if (!digest) {
      digest = sha(["scc", members.map((member) => [member, hashValue(pointer(document, member), id)])]);
      componentHashes.set(id, digest);
    }
    const member = sha(["scc-member", digest, ref]);
    referenceHashes.set(ref, member);
    return member;
  };
  const nodeHashes = new WeakMap();
  const hashValue = (value, inside) => {
    if (value === null || typeof value !== "object") return sha(["value", value]);
    if (inside === undefined && nodeHashes.has(value)) return nodeHashes.get(value);
    let digest;
    if (Array.isArray(value)) digest = sha(["array", value.map((item) => hashValue(item, inside))]);
    else {
      const ref = value.$ref;
      const rest = entries(value).filter(([key]) => key !== "$ref");
      if (typeof ref === "string" && componentOf.has(ref)) {
        digest =
          rest.length === 0
            ? hashRef(ref, inside)
            : hashValue({ ...shallow(pointer(document, ref)), ...Object.fromEntries(rest) }, inside);
      } else digest = sha(["object", entries(value).map(([key, item]) => [key, hashValue(item, inside)])]);
    }
    if (inside === undefined) nodeHashes.set(value, digest);
    return digest;
  };
  const digest = (operation) => {
    const responses = Object.fromEntries(
      Object.entries(operation.responses ?? {})
        .filter(([status]) => status.startsWith("2"))
        .map(([status, response]) => [status, shallow(response ?? null)?.content ?? null]),
    );
    return (
      "sha256:" +
      sha([
        "ref-graph-v1",
        hashValue({ parameters: operation.parameters ?? null, requestBody: operation.requestBody ?? null, responses }),
      ])
    );
  };
  graphs.set(document, digest);
  return digest;
}
