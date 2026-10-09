// Maintainer tooling, network-only: compile a provider's pinned OpenAPI
// document into the compact operation index its REST connector ships.
//
// A provider opts in with `src/providers/<name>/openapi.source.json`:
//
//   { "url": "https://…/<pin>/openapi.json", "revision": "<pin>",
//     "digest": "sha256:…", "latest": "https://…/openapi.json",
//     "options": { "depth": 2, "descriptions": 160, "maxEnum": 50 } }
//
// `npm run providers:spec` fetches `url`, refuses bytes whose digest differs
// from the pin, and writes `openapi.generated.ts` beside it: every
// non-deprecated operation as a search row, plus request-side details (path
// and query parameters, the request body) with local `$ref`s expanded to a
// fixed depth and repeated subtrees shared. Nothing is fetched at runtime:
// Cloudflare's document alone is 27 MB, past every transport cap a Worker has.
//
// `--record` accepts a new pin: it computes the digest of whatever `url` now
// serves and writes it to openapi.source.json. `--file <path>` reads the
// document from disk instead of the network (tests, offline review).
//
// `check:providers-generated` stays offline: it compares each generated
// header with its source record (`checkOpenApiOutputs`). `providers:check`
// compares the pinned digest with `latest` and reports drift.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverProviders, repositoryRoot } from "./providers.mjs";

/** Bump when the generated shape changes, so every output reads as stale. */
export const OPENAPI_FORMAT = 2;
const SOURCE = "openapi.source.json";
const OUTPUT = "openapi.generated.ts";
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

/** Read and validate one provider's source record; undefined when it has none. */
export async function readOpenApiSource(directory) {
  let text;
  try {
    text = await readFile(join(directory, SOURCE), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  const source = JSON.parse(text);
  const nonempty = (value) => typeof value === "string" && value.trim() !== "";
  if (!nonempty(source?.url) || !nonempty(source.revision) || !/^sha256:[0-9a-f]{64}$/.test(source.digest ?? "")) {
    throw new Error(`${join(directory, SOURCE)} requires url, revision, and a sha256 digest`);
  }
  if (source.latest !== undefined && !nonempty(source.latest)) {
    throw new Error(`${join(directory, SOURCE)} latest must be a non-empty URL when set`);
  }
  return source;
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
function mergeSchemas(a, b) {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (key === "properties" && value && typeof value === "object") {
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
  if (union && (node.properties || node.required || node.additionalProperties !== undefined)) {
    const { anyOf: _anyOf, oneOf: _oneOf, description, ...base } = node;
    node = {
      ...(description !== undefined ? { description } : {}),
      anyOf: union.map((branch) => mergeSchemas(base, normalized(document, branch, depth + 1))),
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
  if (Array.isArray(node.enum) && node.enum.length <= shape.maxEnum) out.e = node.enum;
  if (node.format === "binary") out.f = "binary";
  if (node.nullable === true) out.n = 1;
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
  if (node.additionalProperties === true) out.m = {};
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
  };
  const defaultServer = serverOf(document.servers);
  const servers = defaultServer ? [defaultServer] : [];
  const tags = [];
  const ops = [];
  const details = [];
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
        typeof operation.operationId === "string" ? operation.operationId : `${verb}${path}`,
        plainText(operation.summary ?? operation.description, 120) ?? "",
        tags.indexOf(tag),
      ];
      const server = serverOf(operation.servers ?? item.servers);
      if (server && server !== defaultServer) {
        if (!servers.includes(server)) servers.push(server);
        row.push(servers.indexOf(server));
      }
      ops.push(row);
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
        if (contentType && !empty)
          body = requestBody.required === true ? [contentType, schema, 1] : [contentType, schema];
      }
      details.push(params.length || body ? [params, body] : 0);
    }
  }
  return {
    source: source.url,
    revision: source.revision,
    digest: source.digest,
    version: typeof document.info?.version === "string" ? document.info.version : "",
    servers,
    tags,
    ops,
    details: JSON.stringify(share(details)),
  };
}

/** The source record's generation options, as the header states them. */
function optionsText(source) {
  return JSON.stringify(source.options ?? {});
}

export function renderOpenApiModule(data, source) {
  const header = [
    "// Generated by scripts/generate-openapi.mjs from openapi.source.json; do not edit.",
    `// source: ${data.source}`,
    `// revision: ${data.revision}`,
    `// digest: ${data.digest}`,
    `// options: ${optionsText(source)}`,
    `// format: ${OPENAPI_FORMAT}`,
  ].join("\n");
  const rows = data.ops.map((row) => `    ${JSON.stringify(row)},`).join("\n");
  return `${header}
import type { OpenApiData } from "../_shared/rest/operation-index.js";

export const openapi: OpenApiData = {
  source: ${JSON.stringify(data.source)},
  revision: ${JSON.stringify(data.revision)},
  digest: ${JSON.stringify(data.digest)},
  version: ${JSON.stringify(data.version)},
  servers: ${JSON.stringify(data.servers)},
  tags: ${JSON.stringify(data.tags)},
  ops: [
${rows}
  ],
  details: ${JSON.stringify(data.details)},
};
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
    options: read("options"),
    format: Number(format),
  };
}

/**
 * Offline freshness: each provider with a source record has a generated
 * module whose header names the same URL, revision, digest, options, and
 * format.
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
      if (text !== undefined) stale.push(`${output.slice(root.length + 1)} (no ${SOURCE})`);
      continue;
    }
    const header = text === undefined ? undefined : generatedHeader(text);
    if (
      header?.source !== source.url ||
      header.revision !== source.revision ||
      header.digest !== source.digest ||
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
    const source = await readOpenApiSource(provider.directory);
    if (!source) {
      if (selected.includes(provider.name)) throw new Error(`providers/${provider.name} has no ${SOURCE}`);
      continue;
    }
    const bytes = file ? new Uint8Array(await readFile(resolve(file))) : await fetchDocument(source.url);
    const digest = sha256(bytes);
    if (digest !== source.digest) {
      if (!record) {
        throw new Error(
          `providers/${provider.name}: ${source.url} digest ${digest} does not match the pinned ${source.digest}. ` +
            "Review the change, then run with --record to accept the new pin.",
        );
      }
      source.digest = digest;
      await writeFile(join(provider.directory, SOURCE), `${JSON.stringify(source, null, 2)}\n`);
    }
    const data = buildOperationIndex(JSON.parse(new TextDecoder().decode(bytes)), source);
    await writeFile(join(provider.directory, OUTPUT), renderOpenApiModule(data, source));
    console.log(
      `providers/${provider.name}: ${data.ops.length} operations at ${source.revision} (API ${data.version || "unversioned"})`,
    );
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`providers:spec: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
