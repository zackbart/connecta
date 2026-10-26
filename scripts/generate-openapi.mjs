import { normalizeDiscovery, GOOGLE_DISCOVERY_FORMAT } from "./google-discovery.mjs";
import { compactIndex } from "./compact-index.mjs";
// Maintainer tooling: compile a provider's pinned OpenAPI
// document into the compact operation index its REST connector ships.
//
// A provider opts in with its pin, `evidence/openapi.json` under decision
// 0011's evidence names (`openapi.source.json` in a folder that has not
// landed its step 1):
//
//   { "url": "https://…/<pin>/openapi.json", "revision": "<pin>",
//     "digest": "sha256:…", "latest": "https://…/openapi.json",
//     "options": { "depth": 2, "descriptions": 160, "maxEnum": 50 } }
//
// `"vendored": true` pins a document the vendor publishes only in another
// format (for example, YAML): `digest` is still of the vendor's bytes, which
// `providers:check` compares, and the index is compiled offline from the
// reviewed JSON conversion in `evidence/openapi.document.json`, or derived
// in memory from pinned Discovery originals. A vendored pin moves by review,
// never by `--record`.
//
// `options.versionHeader` names a header parameter (for example, `Api-Version`)
// whose single value is the API version, for documents whose `info.version`
// is not the version a request sends. `options.valueSafety` (`true`, or the
// detector's options) also writes the candidates file
// (`evidence/value-safety.json`, or `value-safety.candidates.json` beside a
// legacy pin), the operations the vendor's reviewed value-safety table must
// cover; every REST vendor sets it.
// `options.numericBounds: true` keeps numeric minimum/maximum constraints for
// pre-dispatch validation (including integer-valued query strings).
//
// `pnpm run providers:spec` fetches `url`, refuses bytes whose digest differs
// from the pin, and writes `openapi.generated.ts` beside it: every
// non-deprecated operation as a search row, plus request-side details (path
// and query parameters, the request body) with local `$ref`s expanded to a
// fixed depth and repeated subtrees shared. Nothing is fetched at runtime:
// Cloudflare's document alone is 27 MB, past every transport cap a Worker has.
//
// `--record` accepts a new pin: it computes the digest of whatever `url` now
// serves and writes it to the pin. A document served from an
// unversioned URL is pinned by content: its revision is the digest's first 12
// hex digits (`sha256:32399b3ed273`), and `--record` moves it with the digest. `--file <path>` reads the
// document from disk instead of the network (tests, offline review).
//
// `check:providers-generated` stays offline: it compares each generated
// header with its source record (`checkOpenApiOutputs`), and a vendored
// module's `document` line with the digest of the conversion it compiled.
// `providers:check` compares the pinned digest with `latest` and reports drift.
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverProviders, repositoryRoot } from "./providers.mjs";
import { renderValueSafety, reviewedTable } from "./value-safety.mjs";
import { supplementalDocument, validSupplementalPin, validOpenApiComposition } from "./drift-validate.mjs";

/** Bump when the required generated shape changes, so every output reads as stale.
 * Response fields are optional additive metadata; existing v4 indexes remain valid. */
export const OPENAPI_FORMAT = 5;
const OUTPUT = "openapi.generated.ts";
const STANDARD = {
  pin: "evidence/openapi.json",
  document: "evidence/openapi.document.json",
  candidates: "evidence/value-safety.json",
};
const LEGACY = { pin: "openapi.source.json", candidates: "value-safety.candidates.json" };
const VERBS = ["get", "head", "post", "put", "patch", "delete"];
const DEFAULT_DEPTH = 2;
/** Characters kept from a top-level property or parameter description; nested ones are dropped. */
const DEFAULT_DESCRIPTION = 160;
/**
 * Longest enum kept. Country, currency, and payment-method lists run to
 * hundreds of values and repeat across operations; past this they are dropped
 * (the field stays typed, unvalidated) and the vendor validates the value.
 */
const DEFAULT_MAX_ENUM = 50;
/** Subtrees whose serialized form is at least this long are shared when repeated. */
const SHARE_THRESHOLD = 64;

export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a provider keeps its OpenAPI evidence, relative to its folder: the
 * standard names (decision 0011, E) or, until its step 1, the legacy ones.
 * Undefined when it pins no document; a folder with both pins is refused.
 */
export async function openApiEvidence(directory) {
  const [standard, legacy] = await Promise.all([
    exists(join(directory, STANDARD.pin)),
    exists(join(directory, LEGACY.pin)),
  ]);
  if (standard && legacy) throw new Error(`${directory} pins OpenAPI twice: keep ${STANDARD.pin} only`);
  return standard ? STANDARD : legacy ? LEGACY : undefined;
}

/** Read and validate one provider's source record; undefined when it has none. */
export async function readOpenApiSource(directory) {
  const names = await openApiEvidence(directory);
  if (!names) return undefined;
  const path = join(directory, names.pin);
  const source = JSON.parse(await readFile(path, "utf8"));
  if (source.documents !== undefined) {
    if (names === LEGACY || !validOpenApiComposition(source))
      throw new Error(
        `${path} needs a revision and unique supplemental document pins with literal prefixes; no combined url`,
      );
    const composed = await composeOpenApi(directory, source);
    return { ...source, url: composed.sources.map((pin) => pin.url).join(" ; "), digest: composed.digest };
  }
  const nonempty = (value) => typeof value === "string" && value.trim() !== "";
  if (!nonempty(source?.url) || !nonempty(source.revision) || !/^sha256:[0-9a-f]{64}$/.test(source.digest ?? "")) {
    throw new Error(`${path} requires url, revision, and a sha256 digest`);
  }
  if (source.latest !== undefined && !nonempty(source.latest)) {
    throw new Error(`${path} latest must be a non-empty URL when set`);
  }
  if (source.vendored !== undefined && (source.vendored !== true || names === LEGACY)) {
    throw new Error(`${path} vendored is true, beside ${STANDARD.document}, or absent`);
  }
  if (source.discovery !== undefined) await discoveryConversion(directory, source);
  else if (source.vendored === true && !(await exists(join(directory, STANDARD.document)))) {
    throw new Error(`${path} is vendored but ${STANDARD.document} is missing`);
  }
  return source;
}

/** Verify the original pin AND reproduce the normalized document offline. */
export async function discoveryConversion(directory, source) {
  const relation = source.discovery;
  if (source.vendored !== true || relation?.format !== GOOGLE_DISCOVERY_FORMAT || relation.pin !== "discovery.json")
    throw new Error("A Discovery conversion needs vendored: true and google-discovery-v1 discovery.json evidence.");
  const pin = JSON.parse(await readFile(join(directory, "evidence/discovery.json"), "utf8"));
  const bytes = await readFile(join(directory, "evidence/discovery.document.json"));
  if (
    !validSupplementalPin(pin) ||
    sha256(bytes) !== pin.digest ||
    source.digest !== pin.digest ||
    source.url !== pin.url ||
    source.revision !== pin.revision
  )
    throw new Error("Discovery source bytes or primary pin do not match discovery.json.");
  const document = normalizeDiscovery(JSON.parse(bytes), { summaries: relation.summaries ?? {} });
  const normalized = JSON.stringify(document, null, 2) + "\n";
  return { document, sourceDigest: pin.digest, documentDigest: sha256(normalized), format: GOOGLE_DISCOVERY_FORMAT };
}

/**
 * Compose byte-pinned documents without changing any source file. References
 * are namespaced before merge; paths are prefixed explicitly and must agree
 * with each document's one server. Source URLs remain the actual vendor URLs.
 */
export async function composeOpenApi(directory, source) {
  const paths = {},
    components = {},
    sources = [],
    evidence = [];
  let origin;
  for (const entry of source.documents) {
    const filename = supplementalDocument(entry.pin);
    if (!filename) throw new Error("A composition needs simple supplemental pins.");
    const pinBytes = await readFile(join(directory, "evidence", entry.pin));
    const pin = JSON.parse(pinBytes);
    if (!validSupplementalPin(pin)) throw new Error(`${entry.pin} is not a valid supplemental pin`);
    const bytes = await readFile(join(directory, "evidence", filename));
    if (sha256(bytes) !== pin.digest) throw new Error(`${filename} does not match the pinned ${pin.digest}`);
    const document = JSON.parse(bytes);
    const servers = document.servers;
    let server;
    try {
      server = new URL(servers?.length === 1 ? servers[0].url : "");
    } catch {
      /* refused below */
    }
    if (
      !server ||
      server.protocol !== "https:" ||
      server.username ||
      server.password ||
      server.search ||
      server.hash ||
      server.pathname.replace(/\/$/, "") !== entry.prefix ||
      (origin !== undefined && server.origin !== origin)
    )
      throw new Error(`${entry.pin} needs one same-origin server matching ${entry.prefix}`);
    origin = server.origin;
    const namespace = entry.pin.slice(0, -5);
    const rewrite = (value) => {
      if (Array.isArray(value)) return value.map(rewrite);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => {
          if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/")) {
            const match = /^#\/components\/([^/]+)\/(.+)$/.exec(child);
            if (match) return [key, `#/components/${match[1]}/${namespace}_${match[2]}`];
          }
          return [key, rewrite(child)];
        }),
      );
    };
    const renamed = rewrite(document);
    for (const [kind, definitions] of Object.entries(renamed.components ?? {})) {
      components[kind] ??= {};
      for (const [name, value] of Object.entries(definitions)) components[kind][`${namespace}_${name}`] = value;
    }
    for (const [path, item] of Object.entries(renamed.paths ?? {})) {
      // An empty source path establishes no route. Prefixing it would invent
      // a callable product root (Planning Center's send_verification artifact).
      if (path === "") continue;
      if (!path.startsWith("/")) throw new Error(`${entry.pin} has an invalid path ${path}`);
      const full = `${entry.prefix}${path}`;
      if (Object.hasOwn(paths, full)) throw new Error(`Composed OpenAPI path collision: ${full}`);
      // Resource prose is on path items in APIs such as Planning Center.
      // Put a useful summary on each operation, without generating tools.
      for (const verb of VERBS) {
        const operation = item[verb];
        if (!operation || typeof operation !== "object") continue;
        if (!operation.summary && !operation.description) {
          const resource = item.summary ?? path.split("/").at(-1) ?? "resource";
          const noun = String(resource)
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replaceAll("_", " ");
          const action =
            verb === "get"
              ? path.includes("{") && path.endsWith("}")
                ? "Get"
                : "List"
              : { post: "Create or run", patch: "Update", put: "Replace", delete: "Delete", head: "Inspect" }[verb];
          operation.summary = `${action} ${noun} — ${document.info?.title ?? namespace}`;
          if (item.description) operation.description = item.description;
        }
      }
      paths[full] = item;
    }
    sources.push(pin);
    evidence.push([entry.pin, entry.prefix, sha256(pinBytes), sha256(bytes)]);
  }
  const digest = sha256(JSON.stringify(evidence));
  return {
    sources,
    digest,
    document: {
      openapi: "3.1.0",
      info: { title: source.title ?? "Composed vendor API", version: source.revision },
      servers: [{ url: origin }],
      paths,
      components,
    },
  };
}

function plainText(text, limit) {
  if (typeof text !== "string" || limit <= 0) return undefined;
  let value = text
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(value);
  if (sentence) value = sentence[1];
  if (!value) return undefined;
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function pointer(document, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  let node = document;
  for (const raw of ref.slice(2).split("/")) {
    const key = decodeURIComponent(raw.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (node === null || typeof node !== "object") return undefined;
    node = node[key];
  }
  return node;
}

function resolveRef(document, value, seen = new Set()) {
  let node = value;
  while (node && typeof node === "object" && typeof node.$ref === "string") {
    if (seen.has(node.$ref)) return {};
    seen.add(node.$ref);
    node = pointer(document, node.$ref) ?? {};
  }
  return node && typeof node === "object" ? node : {};
}

/** Longest cross product of two unions merged under one `allOf`. */
const MAX_UNION = 64;

/**
 * Merge two schemas that must both hold (`allOf`): properties union (a
 * property both declare must satisfy both), required union, the first type,
 * description, and enum, and unions combined branch by branch.
 */
/** The values both enum constraints admit; `const` is a one-value enum. */
function allowedValues(schema) {
  if (Array.isArray(schema.enum)) return schema.enum;
  return schema.const !== undefined ? [schema.const] : undefined;
}

/** JSON types both sides admit; `integer` is a `number`, so it survives their meeting. */
function sharedTypes(a, b) {
  const left = Array.isArray(a) ? a : [a];
  const right = Array.isArray(b) ? b : [b];
  const both = left.flatMap((type) =>
    right.includes(type) ? [type] : type === "integer" && right.includes("number") ? ["integer"] : [],
  );
  for (const type of right) if (type === "integer" && left.includes("number") && !both.includes(type)) both.push(type);
  return both;
}

function mergeSchemas(a, b) {
  const out = { ...a };
  // Both enums must hold, so only values in both survive; disjoint enums admit
  // nothing (an empty enum the runtime refuses for every value).
  const leftValues = allowedValues(a);
  const rightValues = allowedValues(b);
  if (leftValues || rightValues) {
    out.enum =
      leftValues && rightValues
        ? leftValues.filter((value) => rightValues.some((other) => JSON.stringify(other) === JSON.stringify(value)))
        : (leftValues ?? rightValues);
    delete out.const;
  }
  if (a.type !== undefined && b.type !== undefined) {
    const types = sharedTypes(a.type, b.type);
    if (types.length === 0) out.enum = [];
    else out.type = types.length === 1 ? types[0] : types;
  }
  for (const [key, value] of Object.entries(b)) {
    if (key === "enum" || key === "const" || key === "type") {
      if (!(key in out) && key === "type") out.type = value;
      continue;
    }
    if ((key === "minimum" || key === "maximum") && Number.isFinite(value)) {
      out[key] = Number.isFinite(out[key])
        ? key === "minimum"
          ? Math.max(out[key], value)
          : Math.min(out[key], value)
        : value;
    } else if (key === "properties" && value && typeof value === "object") {
      const properties = { ...a.properties };
      for (const [name, schema] of Object.entries(value)) {
        properties[name] = properties[name] === undefined ? schema : { allOf: [properties[name], schema] };
      }
      out.properties = properties;
    } else if (key === "required" && Array.isArray(value)) {
      out.required = [...new Set([...(Array.isArray(a.required) ? a.required : []), ...value])];
    } else if ((key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      const existing = out.anyOf ?? out.oneOf;
      delete out.oneOf;
      out.anyOf =
        existing && existing.length * value.length <= MAX_UNION
          ? existing.flatMap((left) => value.map((right) => ({ allOf: [left, right] })))
          : (existing ?? value);
    } else if (key === "additionalProperties") {
      // Either side closing the object, or typing its extra members, wins over silence.
      if (out.additionalProperties === undefined || out.additionalProperties === true) out.additionalProperties = value;
    } else if (!(key in out)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Resolve references and fold `allOf` into one schema, then distribute what
 * the schema itself requires into each `anyOf`/`oneOf` branch, so a branch is
 * a complete alternative: Cloudflare's DNS records are `oneOf` of `allOf`
 * (shared fields plus a per-type `type` and `content`).
 */
function normalized(document, schema, depth = 0) {
  let node = resolveRef(document, schema);
  if (depth > 16) return node;
  if (Array.isArray(node.allOf)) {
    const { allOf, ...base } = node;
    node = allOf.reduce((merged, branch) => mergeSchemas(merged, normalized(document, branch, depth + 1)), base);
  }
  const union = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
  const constrained =
    node.properties ||
    node.required ||
    node.additionalProperties !== undefined ||
    node.enum !== undefined ||
    node.const !== undefined ||
    node.type !== undefined;
  if (union && constrained) {
    const { anyOf: _anyOf, oneOf: _oneOf, description, ...base } = node;
    // Every outer constraint holds in every branch; a branch it empties
    // (a disjoint enum or type) is no alternative at all.
    const branches = union
      .map((branch) => mergeSchemas(base, normalized(document, branch, depth + 1)))
      .filter((branch) => !(Array.isArray(branch.enum) && branch.enum.length === 0));
    node = {
      ...(description !== undefined ? { description } : {}),
      ...(branches.length > 0 ? { anyOf: branches } : { enum: [] }),
    };
  }
  return node;
}

/**
 * One request-side schema in the compact form the runtime reads
 * (`src/providers/_shared/rest/operation-index.ts`). Below `depth` an object,
 * array, or union keeps its type and is marked truncated (`x: 1`). An
 * explicit `additionalProperties: true` stays open (`m: {}`); a schema that
 * declares properties and says nothing else is read as closed, so a
 * misspelled name is refused before it is sent.
 */
function compactSchema(document, schema, shape, level) {
  const node = normalized(document, schema);
  const out = {};
  if (node.type !== undefined) out.t = node.type;
  const values = allowedValues(node);
  if (values && values.length <= shape.maxEnum) out.e = values;
  if (node.format === "binary" || (shape.formats && typeof node.format === "string")) out.f = node.format;
  if (shape.deprecations && node.deprecated === true) out.deprecated = true;
  if (node.nullable === true) out.n = 1;
  if (shape.numericBounds && ["integer", "number"].includes(node.type)) {
    if (Number.isFinite(node.minimum)) out.l = node.minimum;
    if (Number.isFinite(node.maximum)) out.u = node.maximum;
  }
  const description = level === 1 ? plainText(node.description, shape.describe) : undefined;
  if (description) out.d = description;
  const union = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
  const nested =
    union !== undefined ||
    (node.properties && typeof node.properties === "object") ||
    node.items !== undefined ||
    (node.additionalProperties && typeof node.additionalProperties === "object");
  if (nested && level >= shape.depth) {
    out.x = 1;
    return out;
  }
  if (union) out.a = union.map((branch) => compactSchema(document, branch, shape, level));
  if (node.properties && typeof node.properties === "object") {
    out.p = Object.fromEntries(
      Object.entries(node.properties).map(([key, value]) => [key, compactSchema(document, value, shape, level + 1)]),
    );
  }
  if (Array.isArray(node.required) && node.required.length > 0) out.r = node.required;
  if (node.items !== undefined) out.i = compactSchema(document, node.items, shape, level + 1);
  // Some reviewed documents use an explicitly empty properties map for a
  // vendor-defined filter bag. Preserve the default typo guard elsewhere.
  if (
    node.additionalProperties === true ||
    (shape.emptyObjectsOpen &&
      node.type === "object" &&
      node.properties &&
      Object.keys(node.properties).length === 0 &&
      node.additionalProperties === undefined)
  )
    out.m = {};
  else if (node.additionalProperties && typeof node.additionalProperties === "object") {
    out.m = compactSchema(document, node.additionalProperties, shape, level + 1);
  }
  return out;
}

function tagOf(operation, path) {
  if (Array.isArray(operation.tags) && typeof operation.tags[0] === "string") return operation.tags[0];
  const segments = path.split("/").filter(Boolean);
  return segments.find((segment, index) => index > 0 && !segment.startsWith("{")) ?? segments[0] ?? "";
}

/**
 * The API version a vendor sends in a request header rather than in
 * `info.version`: a document may say `1.0.0` and declares the real version
 * as the single enum value of a required `Api-Version` header parameter.
 * Read from `components.parameters` and every operation, it must name exactly
 * one value, so a document offering two versions fails generation instead of
 * pinning one silently.
 */
function headerVersion(document, header) {
  const wanted = header.toLowerCase();
  const values = new Set();
  const visit = (raw) => {
    const parameter = resolveRef(document, raw);
    if (parameter.in !== "header" || String(parameter.name).toLowerCase() !== wanted) return;
    const schema = resolveRef(document, parameter.schema ?? {});
    for (const value of Array.isArray(schema.enum) ? schema.enum : []) values.add(String(value));
    if (typeof schema.default === "string") values.add(schema.default);
  };
  for (const parameter of Object.values(document.components?.parameters ?? {})) visit(parameter);
  for (const item of Object.values(document.paths)) {
    const resolved = resolveRef(document, item);
    for (const parameter of resolved.parameters ?? []) visit(parameter);
    for (const verb of VERBS) for (const parameter of resolved[verb]?.parameters ?? []) visit(parameter);
  }
  if (values.size !== 1) {
    throw new Error(`expected one ${header} header value in the document, found ${values.size}`);
  }
  return [...values][0];
}

function serverOf(servers) {
  const url = Array.isArray(servers) ? servers[0]?.url : undefined;
  return typeof url === "string" ? url.replace(/\/+$/, "") : undefined;
}

/** Visit a compact schema node and every node below it. */
function eachNode(node, visit) {
  visit(node);
  for (const branch of node.a ?? []) eachNode(branch, visit);
  for (const child of Object.values(node.p ?? {})) eachNode(child, visit);
  if (node.i) eachNode(node.i, visit);
  if (node.m) eachNode(node.m, visit);
}

/**
 * Share repeated schema nodes: each becomes one `d` entry referenced as
 * `{ $: n }`. Only nodes are shared, never a properties map or a row, so a
 * reader dereferences exactly where it reads a schema.
 */
function share(rows) {
  const roots = rows.flatMap((row) =>
    row === 0 ? [] : [...row[0].map((parameter) => parameter[3]), ...(row[1] === 0 ? [] : [row[1][1]])],
  );
  const counts = new Map();
  for (const root of roots) {
    eachNode(root, (node) => {
      const key = JSON.stringify(node);
      if (key.length >= SHARE_THRESHOLD) counts.set(key, (counts.get(key) ?? 0) + 1);
    });
  }
  const shared = new Map();
  for (const [key, uses] of counts) if (uses > 1) shared.set(key, shared.size);
  const replace = (node, definition = false) => {
    const key = JSON.stringify(node);
    if (!definition && shared.has(key)) return { $: shared.get(key) };
    const out = { ...node };
    if (node.a) out.a = node.a.map((branch) => replace(branch));
    if (node.p) out.p = Object.fromEntries(Object.entries(node.p).map(([name, child]) => [name, replace(child)]));
    if (node.i) out.i = replace(node.i);
    if (node.m) out.m = replace(node.m);
    return out;
  };
  const defs = Array.from({ length: shared.size });
  for (const [key, index] of shared) defs[index] = replace(JSON.parse(key), true);
  return {
    d: defs,
    o: rows.map((row) =>
      row === 0
        ? 0
        : [
            row[0].map(([name, at, required, schema, ...description]) => [
              name,
              at,
              required,
              replace(schema),
              ...description,
            ]),
            row[1] === 0 ? 0 : [row[1][0], replace(row[1][1]), ...row[1].slice(2)],
          ],
    ),
  };
}

/**
 * Response names only, independent of request shrinking and contract digests.
 * Keep root properties and properties of root/list-envelope array items. Local
 * refs and composition are bounded; overflow drops the whole response contract
 * so fields validation never mistakes an incomplete set for a complete one.
 */
function responseFields(document, operation, additionalMediaTypes = [], allSuccessResponses = false) {
  const paths = new Set();
  let remaining = 1024;
  let overflow = false;
  const visit = (raw, prefix = "", level = 0, refs = new Set(), arraysOnly = false) => {
    if (!raw || typeof raw !== "object") return;
    if (--remaining < 0 || level > 24) {
      overflow = true;
      return;
    }
    if (raw.$ref) {
      if (refs.has(raw.$ref)) return;
      const target = pointer(document, raw.$ref);
      if (!target) {
        overflow = true;
        return;
      }
      return visit(target, prefix, level + 1, new Set([...refs, raw.$ref]), arraysOnly);
    }
    // Explicitly open response roots cannot establish an exhaustive set for
    // first-segment validation (including root-array item properties).
    if (
      !arraysOnly &&
      (prefix === "" || prefix === "[]") &&
      raw.additionalProperties !== undefined &&
      raw.additionalProperties !== false
    ) {
      overflow = true;
      return;
    }
    for (const branch of [...(raw.allOf ?? []), ...(raw.anyOf ?? []), ...(raw.oneOf ?? [])]) {
      visit(branch, prefix, level + 1, refs, arraysOnly);
    }
    if (raw.items && !prefix.includes("[]")) visit(raw.items, `${prefix}[]`, level + 1, refs);
    if (arraysOnly) return;
    for (const name of Object.keys(raw.properties ?? {}).sort()) {
      // Dot-path selection cannot address literal dots or array syntax in keys.
      if (!name || /[.[\]]/.test(name)) continue;
      const path = prefix ? `${prefix}.${name}` : name;
      if (path.length > 200 || paths.size >= 256) {
        overflow = true;
        return;
      }
      paths.add(path);
      // Inspect an envelope's immediate properties only for list items;
      // never enumerate a resource's nested records or expansions.
      if (!prefix) visit(raw.properties[name], path, level + 1, refs, true);
    }
  };
  // Unioning every JSON success is opt-in; existing indexes retain their
  // first successful JSON contract until a separately reviewed regeneration.
  for (const status of Object.keys(operation.responses ?? {})
    .filter((code) => /^2(?:\d\d|XX)$/i.test(code))
    .sort()) {
    const response = resolveRef(document, operation.responses[status]);
    const content = response.content ?? {};
    const type =
      Object.keys(content)
        .filter((type) => /^application\/(?:[^/]+\+)?json$/i.test(type))
        .sort()[0] ?? additionalMediaTypes.find((type) => content[type]?.schema);
    if (!type || !content[type]?.schema) continue;
    visit(content[type].schema);
    if (!allSuccessResponses) break;
  }
  return overflow ? [] : [...paths].sort();
}

/** Share paths and complete rows; one lazy JSON string avoids thousands of JS objects. */
function shareFields(rows) {
  const p = [...new Set(rows.flat())].sort();
  const ids = new Map(p.map((path, i) => [path, i]));
  const d = [];
  const seen = new Map();
  const o = rows.map((paths) => {
    const row = paths.map((path) => ids.get(path));
    const key = JSON.stringify(row);
    if (!seen.has(key)) {
      seen.set(key, d.length);
      d.push(row);
    }
    return seen.get(key);
  });
  return JSON.stringify({ p, d, o });
}

/** Lossless request graph for large/recursive Discovery contracts, separately
 * from the deliberately bounded compact admission checker. No response prose. */
function requestGraph(document, bodies, descriptionLimit) {
  const definitions = Object.create(null);
  const copy = (raw) => {
    if (Array.isArray(raw)) return raw.map(copy);
    if (!raw || typeof raw !== "object") return raw;
    if (typeof raw.$ref === "string") {
      const name = raw.$ref.split("/").at(-1);
      if (!Object.hasOwn(definitions, name)) {
        definitions[name] = {};
        definitions[name] = copy(pointer(document, raw.$ref) ?? {});
      }
      const siblings = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "$ref"));
      return { ...copy(siblings), $ref: `#/$defs/${name}` };
    }
    return Object.fromEntries(
      Object.entries(raw).flatMap(([key, value]) => {
        if (key === "description" && typeof value === "string") {
          const text = plainText(value, descriptionLimit);
          return text ? [[key, text]] : [];
        }
        return [[key, copy(value)]];
      }),
    );
  };
  const roots = bodies.map((body) => (body ? copy(body) : null));
  return JSON.stringify({ definitions, roots });
}

/**
 * Compile an OpenAPI 3 document into the shipped index. Deprecated operations
 * are dropped: the index is the contract an agent may call, and Connecta does
 * not offer what the vendor has retired.
 */
export function buildOperationIndex(document, source) {
  if (!document?.openapi || !document.paths || typeof document.paths !== "object") {
    throw new Error("expected an OpenAPI 3 document with paths");
  }
  const shape = {
    depth: source.options?.depth ?? DEFAULT_DEPTH,
    describe: source.options?.descriptions ?? DEFAULT_DESCRIPTION,
    maxEnum: source.options?.maxEnum ?? DEFAULT_MAX_ENUM,
    numericBounds: source.options?.numericBounds === true,
    formats: source.options?.formats === true,
    deprecations: source.options?.deprecations === true,
    emptyObjectsOpen: source.options?.emptyObjectsOpen === true,
  };
  // Opt-in shrinking for very large documents (Cloudflare's is 27 MB):
  // `operationIds: false` drops ids that only restate the summary,
  // `pathParams: "typed"` drops path parameters that are plain strings (the
  // template names them; `OperationIndex.contract` lists them again), and
  // `opBudget` caps one operation's serialized details by lowering its depth.
  const keepIds = source.options?.operationIds !== false;
  const typedPathParams = source.options?.pathParams === "typed";
  const opBudget = source.options?.opBudget;
  const defaultServer = serverOf(document.servers);
  const servers = defaultServer ? [defaultServer] : [];
  const tags = [];
  const ops = [];
  const details = [];
  const fields = [];
  const requestBodies = [];
  for (const path of Object.keys(document.paths).sort()) {
    const item = resolveRef(document, document.paths[path]);
    for (const verb of VERBS) {
      const operation = item[verb];
      if (!operation || typeof operation !== "object" || operation.deprecated === true) continue;
      const tag = tagOf(operation, path);
      if (!tags.includes(tag)) tags.push(tag);
      const row = [
        verb.toUpperCase(),
        path,
        !keepIds ? "" : typeof operation.operationId === "string" ? operation.operationId : `${verb}${path}`,
        plainText(operation.summary ?? operation.description, 120) ?? "",
        tags.indexOf(tag),
      ];
      const server = serverOf(operation.servers ?? item.servers);
      if (server && server !== defaultServer) {
        if (!servers.includes(server)) servers.push(server);
        row.push(servers.indexOf(server));
      }
      ops.push(row);
      details.push(operationDetails(document, item, operation, verb, shape, typedPathParams, opBudget));
      fields.push(
        responseFields(
          document,
          operation,
          source.options?.additionalResponseMediaTypes,
          source.options?.allSuccessResponses === true,
        ),
      );
      const body = resolveRef(document, operation.requestBody);
      requestBodies.push(Object.values(body.content ?? {})[0]?.schema);
    }
  }
  return {
    source: source.url,
    revision: source.revision,
    digest: source.digest,
    version: source.options?.versionHeader
      ? headerVersion(document, source.options.versionHeader)
      : typeof document.info?.version === "string"
        ? document.info.version
        : "",
    servers,
    tags,
    ops,
    details: JSON.stringify(share(details)),
    ...(source.options?.requestGraph === true
      ? { requestSchemas: requestGraph(document, requestBodies, shape.describe) }
      : {}),
    ...(fields.some((paths) => paths.length) ? { fields: shareFields(fields) } : {}),
  };
}

/**
 * One operation's details row. Past `opBudget` serialized characters the
 * operation is rebuilt one level shallower, down to depth 0, so one sprawling
 * schema cannot dominate the shipped index.
 */
function operationDetails(document, item, operation, verb, shape, typedPathParams, opBudget) {
  let row = detailsAt(document, item, operation, verb, shape, typedPathParams);
  for (let depth = shape.depth - 1; opBudget && depth >= 0 && JSON.stringify(row).length > opBudget; depth -= 1) {
    row = detailsAt(document, item, operation, verb, { ...shape, depth }, typedPathParams);
  }
  return row;
}

function detailsAt(document, item, operation, verb, shape, typedPathParams) {
  const params = [];
  const seen = new Set();
  for (const raw of [...(operation.parameters ?? []), ...(item.parameters ?? [])]) {
    const parameter = resolveRef(document, raw);
    if (!["path", "query"].includes(parameter.in) || typeof parameter.name !== "string") continue;
    const key = `${parameter.in}:${parameter.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A parameter is a top-level property; its own description is the one kept.
    const { d: _, ...schema } = compactSchema(document, parameter.schema ?? {}, shape, 1);
    const entry = [parameter.name, parameter.in, parameter.required === true ? 1 : 0, schema];
    const description = plainText(parameter.description, shape.describe);
    if (description) entry.push(description);
    if (typedPathParams && parameter.in === "path" && !description && JSON.stringify(schema) === '{"t":"string"}') {
      continue;
    }
    params.push(entry);
  }
  let body = 0;
  const requestBody = resolveRef(document, operation.requestBody);
  const content = requestBody.content;
  if (verb !== "get" && verb !== "head" && content && typeof content === "object") {
    const [contentType, media] = Object.entries(content)[0] ?? [];
    const schema = compactSchema(document, media?.schema ?? {}, shape, 0);
    // Stripe frames nearly every operation with an optional form body that
    // declares no fields. Only that is no body; an array, a binary or
    // unrestricted body, and any required body keep their contract.
    const empty =
      requestBody.required !== true &&
      /^application\/x-www-form-urlencoded\b/.test(contentType ?? "") &&
      schema.t === "object" &&
      schema.p !== undefined &&
      Object.keys(schema.p).length === 0 &&
      !schema.a &&
      !schema.m &&
      !schema.x &&
      !schema.r;
    if (contentType && !empty) body = requestBody.required === true ? [contentType, schema, 1] : [contentType, schema];
  }
  return params.length || body ? [params, body] : 0;
}

/** The source record's generation options, as the header states them. */
function optionsText(source) {
  return JSON.stringify(source.options ?? {});
}

/**
 * `document` is the digest of the vendored conversion the index was compiled
 * from. `digest` pins the vendor's published bytes, which the conversion is
 * not, so a vendored module states both.
 */
export function renderOpenApiModule(data, source, pin = LEGACY.pin, document) {
  const header = [
    `// Generated by scripts/generate-openapi.mjs from ${pin}; do not edit.`,
    `// source: ${data.source}`,
    `// revision: ${data.revision}`,
    `// digest: ${data.digest}`,
    ...(document === undefined ? [] : [`// document: ${document}`]),
    `// options: ${optionsText(source)}`,
    `// format: ${OPENAPI_FORMAT}`,
  ].join("\n");
  const rows = data.ops.map((row) => `    ${JSON.stringify(row)},`).join("\n");
  return `${header}
import type { OpenApiData } from "../_shared/rest/operation-index.js";
import { compactOpenApi } from "../_shared/rest/compact-index.js";

export const openapi: OpenApiData = compactOpenApi({
  source: ${JSON.stringify(data.source)},
  revision: ${JSON.stringify(data.revision)},
  digest: ${JSON.stringify(data.digest)},
  version: ${JSON.stringify(data.version)},
  servers: ${JSON.stringify(data.servers)},
  tags: ${JSON.stringify(data.tags)},
  ops: [
${rows}
  ],
${data.fields === undefined ? "" : `  fields: ${JSON.stringify(data.fields)},\n`}${data.requestSchemas === undefined ? "" : `  requestSchemas: ${JSON.stringify(data.requestSchemas)},\n`}
}, ${JSON.stringify(compactIndex(data))});
`;
}

/** Header facts of a generated module, or undefined when it has none. */
function generatedHeader(text) {
  const read = (name) => new RegExp(`^// ${name}: (.+)$`, "m").exec(text)?.[1];
  const format = read("format");
  return {
    source: read("source"),
    revision: read("revision"),
    digest: read("digest"),
    document: read("document"),
    options: read("options"),
    format: Number(format),
  };
}

/** The digest of a vendored pin's conversion document; undefined for any other pin. */
async function documentDigest(directory, source) {
  if (source.documents) return sha256(JSON.stringify((await composeOpenApi(directory, source)).document));
  if (source.discovery) return (await discoveryConversion(directory, source)).documentDigest;
  return source.vendored === true ? sha256(await readFile(join(directory, STANDARD.document))) : undefined;
}

/**
 * Offline freshness: each provider with a source record has a generated
 * module whose header names the same URL, revision, digest, options, and
 * format, and, when vendored, the digest of the conversion it compiled.
 * Returns the stale output paths, relative to `root`.
 */
export async function checkOpenApiOutputs(root, providers) {
  const stale = [];
  for (const provider of providers) {
    const source = await readOpenApiSource(provider.directory);
    const output = join(provider.directory, OUTPUT);
    let text;
    try {
      text = await readFile(output, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (source === undefined) {
      if (text !== undefined) stale.push(`${output.slice(root.length + 1)} (no OpenAPI pin)`);
      continue;
    }
    const header = text === undefined ? undefined : generatedHeader(text);
    if (
      header?.source !== source.url ||
      header.revision !== source.revision ||
      header.digest !== source.digest ||
      header.document !== (await documentDigest(provider.directory, source)) ||
      header.options !== optionsText(source) ||
      header.format !== OPENAPI_FORMAT
    ) {
      stale.push(output.slice(root.length + 1));
    }
  }
  return stale;
}

async function fetchDocument(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Compile one provider's pinned document into `openapi.generated.ts`, and
 * its value-safety candidates when the pin opts in. Returns a one-line
 * summary and the reviewed table paths that do not resolve (a failure).
 */
export async function specProvider(provider, { file, record = false } = {}) {
  const names = await openApiEvidence(provider.directory);
  const source = await readOpenApiSource(provider.directory);
  if (!names || !source) throw new Error(`providers/${provider.name} has no OpenAPI pin`);
  let bytes;
  if (source.documents) {
    if (record || file)
      throw new Error(
        `providers/${provider.name}: a composed pin moves by review; update its supplemental pins and documents together`,
      );
    bytes = new TextEncoder().encode(JSON.stringify((await composeOpenApi(provider.directory, source)).document));
  } else if (source.vendored === true) {
    if (record || file) {
      throw new Error(
        `providers/${provider.name}: a vendored pin moves by review; replace its source evidence and pin together`,
      );
    }
    bytes = source.discovery
      ? new TextEncoder().encode(
          JSON.stringify((await discoveryConversion(provider.directory, source)).document, null, 2) + "\n",
        )
      : new Uint8Array(await readFile(join(provider.directory, STANDARD.document)));
  } else {
    bytes = file ? new Uint8Array(await readFile(resolve(file))) : await fetchDocument(source.url);
    const digest = sha256(bytes);
    if (digest !== source.digest) {
      if (!record) {
        throw new Error(
          `providers/${provider.name}: ${source.url} digest ${digest} does not match the pinned ${source.digest}. ` +
            "Review the change, then run with --record to accept the new pin.",
        );
      }
      // An unversioned document (Vercel's) is pinned by its own content: a
      // revision spelled as the digest's prefix moves with the digest.
      if (source.revision === source.digest.slice(0, 19)) source.revision = digest.slice(0, 19);
      source.digest = digest;
      await writeFile(join(provider.directory, names.pin), `${JSON.stringify(source, null, 2)}\n`);
    }
  }
  const document = JSON.parse(new TextDecoder().decode(bytes));
  const data = buildOperationIndex(document, source);
  const conversion = source.vendored === true || source.documents ? sha256(bytes) : undefined;
  await writeFile(join(provider.directory, OUTPUT), renderOpenApiModule(data, source, names.pin, conversion));
  // The operations whose responses may carry credentials or secret values,
  // for the provider's reviewed value-safety table (value-safety.mjs and
  // src/providers/_shared/rest/value-safety.ts). Every REST vendor opts in.
  // The reviewed table's paths are checked against the pinned response
  // schemas too: a path that names nothing the operation returns fails here
  // unless the table's `absent` acknowledgements name it.
  let problems = [];
  if (source.options?.valueSafety) {
    const reviewed = await reviewedTable(provider.directory);
    const rendered = renderValueSafety(document, source, reviewed);
    problems = rendered.problems;
    await writeFile(join(provider.directory, names.candidates), rendered.text);
  }
  const rows = JSON.parse(data.details).o;
  const largest = rows.reduce(
    (best, row, at) => {
      const size = JSON.stringify(row).length;
      return size > best.size ? { size, at } : best;
    },
    { size: 0, at: -1 },
  );
  const op = data.ops[largest.at];
  return {
    problems,
    summary:
      `providers/${provider.name}: ${data.ops.length} operations at ${source.revision} (API ${data.version || "unversioned"}); ` +
      `largest details ${op ? `${op[0]} ${op[1]}` : "none"} at ${largest.size} characters after sharing`,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const selected = [];
  let file;
  let record = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--provider") selected.push(args[++index]);
    else if (argument === "--file") file = args[++index];
    else if (argument === "--record") record = true;
    else throw new Error("Usage: providers:spec [--provider <name>]... [--file <path>] [--record]");
  }
  if (file && selected.length !== 1) throw new Error("--file reads one document; select exactly one --provider");
  if (record && selected.length === 0) throw new Error("--record accepts a new pin only for an explicit --provider");
  const providers = (await discoverProviders(repositoryRoot)).filter(
    (provider) => selected.length === 0 || selected.includes(provider.name),
  );
  for (const name of selected) {
    if (!providers.some((provider) => provider.name === name)) throw new Error(`unknown provider: ${name}`);
  }
  for (const provider of providers) {
    if (!(await openApiEvidence(provider.directory))) {
      if (selected.includes(provider.name)) throw new Error(`providers/${provider.name} has no OpenAPI pin`);
      continue;
    }
    const { problems, summary } = await specProvider(provider, { file, record });
    if (problems.length > 0) {
      console.error(
        `providers/${provider.name}: reviewed value-safety paths that do not resolve:\n  ${problems.join("\n  ")}`,
      );
      process.exitCode = 1;
    }
    console.log(summary);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`providers:spec: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
