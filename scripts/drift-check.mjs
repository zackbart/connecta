// Credential-free maintainer tooling. Provider folders own vendor evidence in
// versioned drift.json records; no deployment module reads these records.
// Reports are advisory (exit 0), including parser/network failures and required
// manual reviews. --strict exits 1 for findings; invocation errors exit 2.
// Only --record with an explicit --provider selection updates endpoint digests,
// revisions and latest-published evidence. It never changes pins, check config,
// hosted reviewed names, or runtime code. MCP schemas remain live tools/list.
import { createHash } from "node:crypto";
import { discoverProviders } from "./providers.mjs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultProviderDirectory = resolvePath(repositoryRoot, "src/providers");

/**
 * @typedef {{type: "endpoints", specification: object, endpoints: object[], scopes?: string[]} |
 * {type: "versioned-endpoints", specifications: object, endpoints: object[]} |
 * {type: "mcp-docs", setup: string, inventory?: object, endpoints: string[], reviewed: string[]} |
 * {type: "oauth-discovery", setup: string, endpoints: string[], reviewed: string[]} |
 * {type: "manual", source: string, rationale: string, evidence?: object}} DriftCheck
 * @typedef {{version: 1, provider: string, checks: DriftCheck[]}} DriftRecord
 */

/**
 * Prose and vendor extensions, dropped before a contract is digested.
 *
 * A reworded description is P1's business and a churning `x-fern-*` hint is
 * nobody's. What survives is the part a hand-written provider is written
 * against: what it may send and what it gets back. `deprecated` is stripped
 * here too, but not ignored: it is recorded as its own field on the manifest
 * row so the check can report the transition rather than the state.
 */
const PROSE_KEYS = new Set([
  "description",
  "summary",
  "example",
  "examples",
  "externalDocs",
  "title",
  "deprecated",
]);

function usage(message) {
  if (message) console.error(`drift:check: ${message}`);
  console.error(
    [
      "usage: npm run drift:check -- [options]",
      "",
      "  --specs                  only compare touched endpoints with published specs",
      "  --docs                   only compare public MCP docs and connection metadata",
      "  --provider <id>          limit to one provider (repeatable)",
      "  --spec <id>=<file|url>   read a provider's published spec from here",
      "                           (planning-center: --spec planning-center/<app>=…)",
      "  --tool-reference <id>=<file|url>",
      "                           read its published MCP tool reference here",
      "  --setup-reference <id>=<file|url>",
      "                           read its official MCP setup documentation here",
      "  --manual                 only report required manual vendor reviews",
      "  --provider-dir <path>    provider folders (default src/providers)",
      "  --manifest-dir <path>    alias for --provider-dir",
      "  --record                 update endpoint evidence for explicit --provider(s)",
      "  --strict                 exit 1 for findings (default: advisory exit 0)",
      "  --json                   print the report as JSON",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArguments(argv) {
  const options = {
    specs: false,
    docs: false,
    manual: false,
    strict: false,
    providers: [],
    specSources: new Map(),
    toolReferenceSources: new Map(),
    setupReferenceSources: new Map(),
    providerDirectory: defaultProviderDirectory,
    record: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) usage(`${argument} requires a value`);
      index += 1;
      return value;
    };
    if (argument === "--specs") options.specs = true;
    else if (argument === "--docs") options.docs = true;
    else if (argument === "--manual") options.manual = true;
    else if (argument === "--strict") options.strict = true;
    else if (argument === "--record") options.record = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--provider") options.providers.push(next());
    else if (argument === "--provider-dir" || argument === "--manifest-dir")
      options.providerDirectory = resolvePath(next());
    else if (
      argument === "--spec" ||
      argument === "--tool-reference" ||
      argument === "--setup-reference"
    ) {
      const value = next();
      const separator = value.indexOf("=");
      if (separator < 1 || separator === value.length - 1) usage(`${argument} expects <provider>=<file or url>`);
      const target =
        argument === "--spec"
          ? options.specSources
          : argument === "--tool-reference"
            ? options.toolReferenceSources
            : options.setupReferenceSources;
      target.set(value.slice(0, separator), value.slice(separator + 1));
    } else usage(`unknown argument: ${argument}`);
  }
  if (!options.specs && !options.docs && !options.manual) {
    options.specs = true;
    options.docs = true;
    options.manual = true;
  }
  // The providers:check alias selects both automated modes; include manual reviews there too.
  if (options.specs && options.docs) options.manual = true;
  if (options.specSources.size > 0 && !options.specs) {
    usage("--spec requires --specs when a check mode is selected explicitly");
  }
  if ((options.toolReferenceSources.size > 0 || options.setupReferenceSources.size > 0) && !options.docs) {
    usage("--tool-reference and --setup-reference require --docs when a check mode is selected explicitly");
  }
  if (options.record && options.providers.length === 0) {
    usage("--record requires an explicit --provider selection; baselines are never updated implicitly");
  }
  return options;
}

class UnavailableError extends Error {}
class ParserError extends Error {}
class EvidenceError extends Error {}

function errorFinding(error) {
  return {
    kind: error instanceof EvidenceError ? "evidence-invalid"
      : error instanceof UnavailableError ? "unavailable" : "parser-error",
    detail: error instanceof Error ? error.message : String(error),
  };
}

function checkMode(type) {
  if (type === "endpoints" || type === "versioned-endpoints") return "specs";
  if (type === "manual") return "manual";
  return "docs";
}

/** Discover only direct provider folders carrying drift.json; shared code is absent. */
async function discoverRecords(directory) {
  const providers = [];
  const entries = directory === defaultProviderDirectory
    ? (await discoverProviders(repositoryRoot)).map(({ name }) => ({ name, isDirectory: () => true }))
    : await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const path = resolvePath(directory, entry.name, "drift.json");
    let text;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      providers.push({ provider: entry.name, path, error: new UnavailableError(`could not read ${path}: ${error.message}`) });
      continue;
    }
    try {
      const record = JSON.parse(text);
      if (record?.version !== 1 || record.provider !== entry.name || !Array.isArray(record.checks) || record.checks.length === 0) {
        throw new EvidenceError(`${entry.name}'s drift record requires version 1, matching provider, and non-empty checks`);
      }
      providers.push({ provider: entry.name, path, record });
    } catch (error) {
      providers.push({ provider: entry.name, path, error: new EvidenceError(`invalid drift record at ${path}: ${error.message}`) });
    }
  }
  return providers;
}

function validateSelection(options, providers) {
  const known = new Map(providers.map((entry) => [entry.provider, entry]));
  const requested = [...options.providers, ...[...options.specSources.keys()].map((key) => key.split("/")[0]),
    ...options.toolReferenceSources.keys(), ...options.setupReferenceSources.keys()];
  for (const provider of requested) {
    const entry = known.get(provider);
    if (!entry) usage(`unknown provider: ${provider}`);
    if (entry.error) continue; // Invalid evidence must still get a structured report.
    const modes = new Set(entry.record.checks.map((check) => checkMode(check?.type)));
    if (![...modes].some((mode) => options[mode])) {
      usage(`${provider} is only checked by ${[...modes].map((mode) => `--${mode}`).join(" or ")}, which this run did not select. That combination would check nothing.`);
    }
  }
  for (const key of options.specSources.keys()) {
    const [provider, app, extra] = key.split("/");
    const entry = known.get(provider);
    if (entry.error) continue;
    const check = entry.record.checks.find((item) => item.type === "endpoints" || item.type === "versioned-endpoints");
    if (!check) usage(`${provider} has no endpoint specification check`);
    if (check.type === "versioned-endpoints") {
      if (!app || extra) usage(`${provider} publishes one specification per product; name it --spec ${provider}/<app>=<file|url>`);
      if (!Object.hasOwn(check.specifications ?? {}, app)) usage(`unknown ${provider} product: ${app}`);
    } else if (app) usage(`${provider} publishes one specification; name it --spec ${provider}=<file|url>`);
  }
  for (const provider of new Set([...options.toolReferenceSources.keys(), ...options.setupReferenceSources.keys()])) {
    const entry = known.get(provider);
    if (entry.error) continue;
    const check = entry.record.checks.find((item) => item.type === "mcp-docs" || item.type === "oauth-discovery");
    if (!check) usage(`${provider} has no MCP reference check`);
    if (options.toolReferenceSources.has(provider) && !check.inventory) usage(`${provider} has no public tool inventory`);
  }
  if (options.record) {
    for (const provider of requested) {
      if (!options.providers.includes(provider)) usage(`--record source overrides must name an explicitly selected --provider: ${provider}`);
    }
  }
}

/** Reject missing vendor evidence before network access; config is never guessed. */
function validateCheck(check, allowUnrecorded) {
  const require = (condition, detail) => { if (!condition) throw new EvidenceError(detail); };
  const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
  const strings = (value) => Array.isArray(value) && value.length > 0 && value.every(nonempty) && new Set(value).size === value.length;
  require(check && typeof check === "object", "check must be an object");
  if (check.type === "manual") {
    require(nonempty(check.source) && nonempty(check.rationale), "manual check requires source and rationale");
    return;
  }
  if (check.type === "mcp-docs" || check.type === "oauth-discovery") {
    require(nonempty(check.setup) && strings(check.endpoints) && strings(check.reviewed), "MCP check requires setup, endpoints, and reviewed vendor names");
    if (check.type === "oauth-discovery") require(check.inventory === undefined, "OAuth discovery checks have no tool inventory");
    if (check.inventory !== undefined) {
      const inventory = check.inventory;
      require(nonempty(inventory.url) && ["headings", "inline", "inline-calls", "table"].includes(inventory.format), "inventory requires URL and supported parser format");
      for (const key of ["start", "end", "prefix"]) require(inventory[key] === undefined || nonempty(inventory[key]), `inventory ${key} must be non-empty`);
      require(inventory.acknowledgedUnclassified === undefined || strings(inventory.acknowledgedUnclassified), "acknowledged unclassified names must be unique non-empty strings");
    }
    return;
  }
  require(check.type === "endpoints" || check.type === "versioned-endpoints", `unknown check type: ${String(check.type)}`);
  require(Array.isArray(check.endpoints) && check.endpoints.length > 0, "endpoint check requires touched endpoints");
  const seen = new Set();
  for (const endpoint of check.endpoints) {
    require(endpoint && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(endpoint.method) && nonempty(endpoint.path) && endpoint.path.startsWith("/") && nonempty(endpoint.specRevision), "endpoint requires method, path, and reviewed revision");
    const key = `${endpoint.method} ${endpoint.path}`;
    require(!seen.has(key), `duplicate endpoint: ${key}`);
    seen.add(key);
    require((allowUnrecorded && endpoint.contract === undefined) || /^sha256:[0-9a-f]{64}$/.test(endpoint.contract), `invalid contract digest: ${key}`);
    require(endpoint.deprecated === undefined || typeof endpoint.deprecated === "boolean", `invalid deprecation evidence: ${key}`);
  }
  if (check.type === "endpoints") {
    require(nonempty(check.specification?.url), "endpoint check requires specification URL");
    require(check.specification.format === undefined || ["openapi", "google-discovery", "readme-operation-pages"].includes(check.specification.format), "unknown specification format");
    if (check.specification.format === "readme-operation-pages") require(strings(check.specification.pages), "operation-page check requires reference pages");
    if (check.specification.format === "google-discovery") require(strings(check.scopes), "Google Discovery check requires requested scopes");
  } else {
    require(check.specifications && typeof check.specifications === "object" && !Array.isArray(check.specifications) && Object.keys(check.specifications).length > 0, "versioned check requires per-product specifications");
    for (const [app, spec] of Object.entries(check.specifications)) {
      require(nonempty(spec?.url) && nonempty(spec.documentation) && nonempty(spec.version), `product ${app} requires URL, documentation, and pin`);
      require(spec.latestPublished === undefined || nonempty(spec.latestPublished), `product ${app} has invalid reviewed publication`);
    }
    for (const endpoint of check.endpoints) require(Object.hasOwn(check.specifications, productOf(endpoint.path)), `no product specification for ${endpoint.path}`);
  }
}

/**
 * Assemble one document for a provider that publishes no combined spec.
 *
 * Tithe.ly's reference is a ReadMe site: each operation page, served as `.md`,
 * embeds a one-operation OpenAPI 3.1 snippet under "# OpenAPI definition". The
 * manifest lists those pages, and their `paths` merge here into the shape
 * every other provider's document already has, so the comparison below needs
 * no special case. A snippet that uses `$ref` is refused rather than digested:
 * its components would not survive the merge, and a reference digested as an
 * unresolved pointer would go blind to the change it exists to catch.
 */
async function loadOperationPages(provider, base, pages) {
  if (pages.length === 0) {
    throw new ParserError(`${provider}'s manifest lists no reference pages`);
  }
  const paths = {};
  const versions = new Set();
  for (const page of pages) {
    const source = `${base}${page}.md`;
    const markdown = await loadPublished(provider, "API reference page", source);
    const fence = markdown.match(/# OpenAPI definition\s+```json\n([\s\S]*?)\n```/);
    if (!fence) {
      throw new ParserError(
        `${provider}'s reference page ${source} no longer embeds an OpenAPI definition`,
      );
    }
    let snippet;
    try {
      snippet = JSON.parse(fence[1]);
    } catch (error) {
      throw new ParserError(
        `${provider}'s reference page ${source} embeds malformed OpenAPI JSON: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    if (JSON.stringify(snippet.paths ?? {}).includes('"$ref"')) {
      throw new ParserError(
        `${provider}'s reference page ${source} now uses $ref; the page assembler cannot resolve references across snippets`,
      );
    }
    versions.add(String(snippet.info?.version ?? "unknown"));
    for (const [path, item] of Object.entries(snippet.paths ?? {})) {
      for (const [method, operation] of Object.entries(item ?? {})) {
        paths[path] ??= {};
        if (paths[path][method]) {
          throw new ParserError(
            `${provider}'s reference documents ${method.toUpperCase()} ${path} on more than one page`,
          );
        }
        paths[path][method] = operation;
      }
    }
  }
  return {
    openapi: "3.1.0",
    info: { version: [...versions].sort().join("+") },
    paths,
  };
}

async function loadSpecification(provider, manifest, options) {
  const source = options.specSources.get(provider) ?? manifest.specification.url;
  // A provider documented page by page reads a page base, URL or directory; a
  // `.json` override is a combined document like any other provider's.
  if (
    manifest.specification.format === "readme-operation-pages" &&
    !source.endsWith(".json")
  ) {
    const base =
      /^https?:\/\//.test(source) || source.endsWith("/") ? source : `${source}/`;
    return {
      source,
      document: await loadOperationPages(
        provider,
        base,
        manifest.specification.pages ?? [],
      ),
    };
  }
  const document = await loadJson(`${provider}'s published specification`, source);
  return {
    source,
    document:
      manifest.specification.format === "google-discovery"
        ? discoveryDocument(provider, document)
        : validateOpenApi(provider, document),
  };
}

/** Discovery's bare `$ref: "Draft"` as a pointer into the document's schemas. */
function discoveryRefs(value) {
  if (Array.isArray(value)) return value.map(discoveryRefs);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    // Prose like `description`, which `inline` already drops wherever it sits.
    if (key === "enumDescriptions") continue;
    out[key] =
      key === "$ref" && typeof item === "string" && !item.startsWith("#")
        ? `#/schemas/${item}`
        : discoveryRefs(item);
  }
  return out;
}

/**
 * A Google Discovery document in the shape the comparison reads: `paths`
 * keyed by `/<servicePath><flatPath>` and lower-case method, each operation's
 * parameters sorted by name, its request and response as JSON content, and
 * the document's `revision` as the version. The method's accepted OAuth scopes
 * ride along as `x-scopes`, which the digest ignores like every extension and
 * the scope check reads.
 */
function discoveryDocument(provider, discovery) {
  if (
    discovery === null ||
    typeof discovery !== "object" ||
    discovery.kind !== "discovery#restDescription" ||
    typeof discovery.resources !== "object"
  ) {
    throw new ParserError(
      `${provider}'s published specification is not a Google Discovery document`,
    );
  }
  const servicePath = discovery.servicePath ?? "";
  const paths = {};
  const json = (ref) => ({
    content: { "application/json": { schema: discoveryRefs({ $ref: ref }) } },
  });
  const visit = (resource) => {
    for (const method of Object.values(resource.methods ?? {})) {
      const path = `/${servicePath}${method.flatPath ?? method.path}`.replace(/\/{2,}/g, "/");
      const verb = String(method.httpMethod).toLowerCase();
      paths[path] ??= {};
      if (paths[path][verb]) {
        throw new ParserError(
          `${provider}'s Discovery document defines ${verb.toUpperCase()} ${path} twice`,
        );
      }
      paths[path][verb] = {
        ...(method.deprecated === true ? { deprecated: true } : {}),
        "x-scopes": Array.isArray(method.scopes) ? method.scopes : [],
        parameters: Object.entries(method.parameters ?? {})
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, parameter]) => ({ name, ...discoveryRefs(parameter) })),
        ...(method.request?.$ref ? { requestBody: json(method.request.$ref) } : {}),
        responses: { 200: method.response?.$ref ? json(method.response.$ref) : {} },
      };
    }
    for (const child of Object.values(resource.resources ?? {})) visit(child);
  };
  visit(discovery);
  return {
    openapi: "3.1.0",
    info: { version: String(discovery.revision ?? "unknown") },
    paths,
    schemas: discoveryRefs(discovery.schemas ?? {}),
  };
}

/**
 * Under domain-wide delegation the provider's scopes are a grant an admin made
 * once, so a touched method that stops accepting all of them fails for every
 * user at once. The finding is the state, not a transition: unlike a
 * deprecation, there is nothing to acknowledge — the provider has to change.
 */
function scopeFindings(manifest, document) {
  if (!Array.isArray(manifest.scopes)) return [];
  const findings = [];
  for (const endpoint of manifest.endpoints) {
    const operation = document.paths?.[endpoint.path]?.[endpoint.method.toLowerCase()];
    if (!operation) continue;
    const accepted = operation["x-scopes"] ?? [];
    if (!manifest.scopes.some((scope) => accepted.includes(scope))) {
      findings.push({
        method: endpoint.method,
        path: endpoint.path,
        specRevision: endpoint.specRevision,
        kind: "scope-dropped",
        detail: `the method no longer accepts any scope the provider requests (${manifest.scopes.join(", ")})`,
      });
    }
  }
  return findings;
}

async function loadJson(label, source) {
  const text = await loadPublished(label, "published specification", source);
  try {
    const document = JSON.parse(text);
    if (document === null || typeof document !== "object" || Array.isArray(document)) throw new Error("expected a JSON object");
    return document;
  } catch {
    throw new ParserError(`${label} at ${source} is not a JSON object`);
  }
}

function validateOpenApi(provider, document) {
  if (!document?.openapi || !document.paths || typeof document.paths !== "object" || Array.isArray(document.paths)) {
    throw new ParserError(`${provider}'s published specification is not an OpenAPI document with paths`);
  }
  return document;
}

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
function contractDigest(document, operation) {
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
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(contract))
    .digest("hex")}`;
}

function operationFor(document, endpoint) {
  const item = document.paths?.[endpoint.path];
  if (!item) return { missing: "path" };
  const operation = item[endpoint.method.toLowerCase()];
  if (!operation) return { missing: "operation" };
  return { operation };
}

function checkSpecProvider(provider, manifest, specification) {
  const revision = specification.document.info?.version ?? "unknown";
  const { findings, recorded } = checkEndpoints(manifest.endpoints, () => ({
    document: specification.document,
    revision,
  }));
  return {
    provider,
    revision,
    findings: [...findings, ...scopeFindings(manifest, specification.document)],
    recorded,
  };
}

/**
 * The touched-endpoint comparison itself. `documentFor` names the document,
 * the path within it, and the revision each row is checked against — one for
 * every row of a single-document provider, one per product for Planning Center.
 */
function checkEndpoints(endpoints, documentFor) {
  const findings = [];
  const recorded = [];
  for (const endpoint of endpoints) {
    const row = {
      method: endpoint.method,
      path: endpoint.path,
      specRevision: endpoint.specRevision,
    };
    const { document, path = endpoint.path, revision } = documentFor(endpoint);
    if (!document) { recorded.push(endpoint); continue; } // Failed product already has a finding.
    const { missing, operation } = operationFor(document, { ...endpoint, path });
    if (missing) {
      findings.push({
        ...row,
        kind: missing === "path" ? "path-gone" : "method-gone",
        detail:
          missing === "path"
            ? "the published specification no longer documents this path"
            : "the published specification no longer documents this method on this path",
      });
      // Keep the row: a maintainer decides whether the provider moved the
      // endpoint or connecta has to stop calling it. Recording its absence
      // would delete the only evidence the check has.
      recorded.push(endpoint);
      continue;
    }
    const digest = contractDigest(document, operation);
    // The finding is the *transition*, not the state. A deprecation a
    // maintainer has already read and recorded is not news on every subsequent
    // release, and a check that can never reach its own "no drift" state is a
    // check nobody reads. `--record` stores the flag; both directions report.
    const deprecated = operation.deprecated === true;
    if (deprecated !== (endpoint.deprecated === true)) {
      findings.push({
        ...row,
        kind: deprecated ? "deprecated" : "undeprecated",
        detail: deprecated
          ? "the published operation is newly marked deprecated"
          : "the published operation is no longer marked deprecated",
      });
    }
    if (endpoint.contract !== undefined && endpoint.contract !== digest) {
      findings.push({
        ...row,
        kind: "contract-changed",
        detail: `parameters, request body, or success responses changed since revision ${endpoint.specRevision}`,
      });
    }
    const evidence = { ...endpoint };
    delete evidence.deprecated;
    recorded.push({
      ...evidence,
      method: endpoint.method,
      path: endpoint.path,
      specRevision: revision,
      ...(deprecated ? { deprecated: true } : {}),
      contract: digest,
    });
  }
  return { findings, recorded };
}

/** `/people/v2/people/{person_id}` → `people`; the version segment is fixed. */
function productOf(path) {
  return /^\/([a-z-]+)\/v2(?:\/|$)/.exec(path)?.[1];
}

/** Non-beta versions a Planning Center documentation graph lists, newest first. */
function publishedVersions(index) {
  const versions = index?.data?.relationships?.versions?.data;
  if (!Array.isArray(versions)) throw new ParserError("documentation graph has no versions array");
  return versions
    .filter(
      (version) =>
        typeof version?.id === "string" && version.attributes?.beta !== true,
    )
    .map((version) => version.id)
    .sort()
    .reverse();
}

/**
 * Planning Center: every pinned product is checked for a newer published
 * version, and every touched endpoint against the OpenAPI document of the
 * version its product is pinned to. Only products a named tool touches are
 * downloaded; the rest are version-checked alone, because the hatches send
 * their pins too.
 */
async function checkVersionedProvider(provider, manifest, options) {
  const findings = [];
  const specifications = {};
  const documents = new Map();
  const touched = new Set(
    manifest.endpoints.map((endpoint) => productOf(endpoint.path)),
  );
  for (const [app, specification] of Object.entries(manifest.specifications)) {
    specifications[app] = { ...specification };
    try {
      const index = await loadJson(
        `${provider}'s ${app} documentation graph`,
        specification.documentation,
      );
      const versions = publishedVersions(index);
      const latest = versions[0];
      const reviewed = specification.latestPublished ?? specification.version;
      if (!versions.includes(specification.version)) {
        findings.push({
          app,
          kind: "version-gone",
          detail: `the documentation graph no longer lists pinned version ${specification.version}`,
        });
      }
      if (latest !== undefined && latest !== reviewed) {
        findings.push({
          app,
          kind: "version-published",
          detail: `${latest} is published (pinned ${specification.version}, last reviewed ${reviewed}); read its changes before moving the pin`,
        });
      }
      specifications[app] = {
        ...specification,
        ...(latest === undefined ? {} : { latestPublished: latest }),
      };
    } catch (error) {
      findings.push({ app, ...errorFinding(error) });
    }
    if (!touched.has(app)) continue;
    try {
      const source = options.specSources.get(`${provider}/${app}`) ?? specification.url;
      const document = validateOpenApi(provider, await loadJson(`${provider}'s ${app} specification`, source));
      if (document.info?.version !== specification.version) {
        findings.push({ app, kind: "version-mismatch",
          detail: `the ${app} specification describes ${document.info?.version ?? "no version"}, not pinned ${specification.version}` });
      }
      documents.set(app, document);
    } catch (error) {
      findings.push({ app, ...errorFinding(error) });
    }
  }
  const endpoints = checkEndpoints(manifest.endpoints, (endpoint) => {
    const app = productOf(endpoint.path);
    return {
      document: documents.get(app),
      // The document's server is `/<app>/v2`, so its paths start below it.
      path: endpoint.path.slice(`/${app}/v2`.length),
      revision: manifest.specifications[app].version,
    };
  });
  return {
    provider,
    revision: "per-product pins",
    findings: [...findings, ...endpoints.findings],
    recorded: endpoints.recorded,
    specifications,
  };
}

// ---------------------------------------------------------------------------
// Published MCP references
// ---------------------------------------------------------------------------

async function loadPublished(provider, label, source) {
  let text;
  try {
    if (/^https?:\/\//.test(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "connecta-drift-check (+https://github.com/zackbart/connecta)" } });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      text = await response.text();
    } else {
      text = await readFile(resolvePath(source), "utf8");
    }
  } catch (error) {
    throw new UnavailableError(
      `could not read ${provider}'s ${label} from ${source}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  return text;
}

function documentedSection(markdown, inventory) {
  const start = inventory.start ? markdown.indexOf(inventory.start) : 0;
  if (start < 0) throw new ParserError(`tool reference no longer contains section ${inventory.start}`);
  const afterStart = markdown.slice(start + (inventory.start?.length ?? 0));
  if (!inventory.end) return afterStart;
  const end = afterStart.indexOf(inventory.end);
  if (end < 0) throw new ParserError(`tool reference no longer contains section ${inventory.end}`);
  return afterStart.slice(0, end);
}

/** Exact tool names from a provider's documented inventory section. */
function documentedToolNames(markdown, inventory) {
  const section = documentedSection(markdown, inventory);
  const candidate = /^[A-Za-z](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;
  if (inventory.format === "headings") {
    return [...section.matchAll(/^### ([^\r\n]+)$/gm)]
      .map((match) => match[1].replaceAll("\\_", "_").trim())
      .filter((name) => candidate.test(name))
      .sort();
  }
  if (inventory.format === "inline" || inventory.format === "inline-calls") {
    const names = [...section.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1].trim())
      .map((name) =>
        inventory.format === "inline-calls" ? name.replace(/\(\)$/, "") : name,
      )
      .filter((name) => candidate.test(name))
      .filter((name) =>
        inventory.prefix === undefined ? true : name.startsWith(inventory.prefix),
      );
    return [...new Set(names)].sort();
  }
  const names = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const name = [...line.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1])
      .find((value) => candidate.test(value));
    if (name !== undefined) names.push(name);
  }
  return [...new Set(names)].sort();
}

/** RFC 8414 metadata location for an issuer, path inserted after the host. */
function authorizationServerMetadataUrl(issuer) {
  const url = new URL(issuer);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/oauth-authorization-server${path}`;
}

function parseMetadata(provider, label, text) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // Reported below without echoing the body.
  }
  throw new ParserError(`${provider}'s ${label} is not a JSON object`);
}

/**
 * A provider with no public setup page: read its OAuth discovery instead.
 *
 * Only the facts the wrapper depends on become findings. The scopes the
 * resource advertises are reported for the reader and never judged, because
 * the MCP client requests whatever the server's own challenge names.
 */
async function checkOAuthDiscovery(provider, runtime, resource) {
  const findings = [];
  const advertised = Array.isArray(resource.scopes_supported)
    ? resource.scopes_supported.filter((scope) => typeof scope === "string")
    : [];
  if (!runtime.endpoints.includes(resource.resource)) {
    findings.push({
      kind: "mcp-endpoint",
      detail: `protected-resource metadata names ${String(resource.resource)}, not Connecta's endpoint ${runtime.endpoints.join(", ")}`,
    });
  }
  const issuer = Array.isArray(resource.authorization_servers)
    ? resource.authorization_servers.find((value) => typeof value === "string")
    : undefined;
  if (issuer === undefined) {
    findings.push({
      kind: "mcp-auth",
      detail: "protected-resource metadata names no authorization server",
    });
    return { findings, authorizationServer: undefined, advertisedScopes: advertised };
  }
  const server = parseMetadata(
    provider,
    "authorization-server metadata",
    await loadPublished(
      provider,
      "authorization-server metadata",
      authorizationServerMetadataUrl(issuer),
    ),
  );
  if (server.client_id_metadata_document_supported !== true) {
    findings.push({
      kind: "mcp-auth",
      detail: `${issuer} no longer advertises Client ID Metadata Document support, which ${provider}() requires`,
    });
  }
  if (
    !Array.isArray(server.code_challenge_methods_supported) ||
    !server.code_challenge_methods_supported.includes("S256")
  ) {
    findings.push({
      kind: "mcp-auth",
      detail: `${issuer} no longer advertises PKCE S256, which the MCP client requires`,
    });
  }
  return { findings, authorizationServer: issuer, advertisedScopes: advertised };
}

async function checkDocumentedProvider(provider, defaults, options) {
  const runtime = defaults;
  const sources = {
    setup: options.setupReferenceSources.get(provider) ?? defaults.setup,
    tools:
      options.toolReferenceSources.get(provider) ?? defaults.inventory?.url,
  };
  const [setup, markdown] = await Promise.all([
    loadPublished(provider, "official MCP setup reference", sources.setup),
    sources.tools === undefined
      ? Promise.resolve(undefined)
      : loadPublished(provider, "MCP tool reference", sources.tools),
  ]);
  const documented =
    markdown === undefined
      ? undefined
      : documentedToolNames(markdown, defaults.inventory);
  if (documented !== undefined && documented.length === 0) {
    throw new ParserError(
      `${provider}'s MCP tool reference contained no recognizable tool names`,
    );
  }
  const reviewed = [...runtime.reviewed].sort();
  const reviewedSet = new Set(reviewed);
  const documentedSet = new Set(documented ?? []);
  const acknowledged = new Set(defaults.inventory?.acknowledgedUnclassified ?? []);
  const added = (documented ?? []).filter(
    (name) => !reviewedSet.has(name) && !acknowledged.has(name),
  );
  const intentionallyUnclassified = (documented ?? []).filter(
    (name) => !reviewedSet.has(name) && acknowledged.has(name),
  );
  const removed =
    documented === undefined
      ? []
      : reviewed.filter((name) => !documentedSet.has(name));

  if (defaults.type === "oauth-discovery") {
    const discovery = await checkOAuthDiscovery(
      provider,
      runtime,
      parseMetadata(provider, "protected-resource metadata", setup),
    );
    return {
      provider,
      toolReference: undefined,
      setupReference: sources.setup,
      setupKind: "oauth-discovery",
      inventoryChecked: false,
      documentedTools: undefined,
      added: [],
      removed: [],
      intentionallyUnclassified: [],
      findings: discovery.findings,
      authorizationServer: discovery.authorizationServer,
      advertisedScopes: discovery.advertisedScopes,
      schemaAuthority: "live-tools-list",
      schemasVendored: false,
    };
  }

  const findings = [];
  for (const endpoint of runtime.endpoints) {
    if (
      !setup.includes(endpoint) &&
      !setup.includes(endpoint.replace(/\/$/, ""))
    ) {
      findings.push({
        kind: "mcp-endpoint",
        detail: `official setup documentation does not name Connecta's endpoint ${endpoint}`,
      });
    }
  }
  if (!setup.toLowerCase().includes("oauth")) {
    findings.push({
      kind: "mcp-auth",
      detail: "official setup documentation does not mention OAuth",
    });
  }

  return {
    provider,
    toolReference: sources.tools,
    setupReference: sources.setup,
    inventoryChecked: documented !== undefined,
    documentedTools: documented?.length,
    added,
    removed,
    intentionallyUnclassified,
    findings,
    schemaAuthority: "live-tools-list",
    schemasVendored: false,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printSpec(result, recorded) {
  console.log(
    `${result.provider} — ${result.findings.length ? `${result.findings.length} finding(s)` : "no drift"} across ${
      result.endpoints
    } touched endpoints at revision ${result.revision}`,
  );
  for (const finding of result.findings) {
    const subject = finding.method
      ? `${finding.method} ${finding.path}`
      : (finding.app ?? "check");
    console.log(`  ${finding.kind.padEnd(16)} ${subject} — ${finding.detail}`);
  }
  if (recorded) console.log(`  recorded     ${recorded}`);
}

function printDocs(result) {
  console.log(
    result.inventoryChecked
      ? `${result.provider} MCP docs: ${result.documentedTools} documented tools`
      : result.setupKind === "oauth-discovery"
        ? `${result.provider} MCP: OAuth discovery metadata only; no public setup page or tool inventory`
        : `${result.provider} MCP docs: setup metadata only; no official tool inventory`,
  );
  if (result.setupKind === "oauth-discovery") {
    console.log(
      `  oauth        ${result.authorizationServer ?? "no authorization server"}; resource scopes ${
        result.advertisedScopes.length ? result.advertisedScopes.join(" ") : "none advertised"
      }`,
    );
  }
  for (const tool of result.added) {
    console.log(`  unclassified ${tool}`);
  }
  for (const tool of result.removed) {
    console.log(`  not documented ${tool} (kept from release review)`);
  }
  for (const tool of result.intentionallyUnclassified) {
    console.log(`  fail-closed   ${tool} (official access class is blank)`);
  }
  for (const finding of result.findings) {
    console.log(`  ${finding.kind.padEnd(16)} ${finding.detail}`);
  }
  if (
    result.added.length + result.findings.length === 0
  ) {
    console.log(
      result.inventoryChecked
        ? "  documented additions are classified; connection metadata matches"
        : "  connection metadata matches",
    );
  }
  console.log(
    "  schemas      live tools/list remains authoritative; no MCP schema is vendored",
  );
}

function findingCount(report) {
  let total = 0;
  for (const result of [...report.specs, ...report.docs, ...report.manual, ...report.records]) {
    total += result.findings.length + (result.added?.length ?? 0);
  }
  return total;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const providers = await discoverRecords(options.providerDirectory);
  validateSelection(options, providers);
  if (providers.length === 0) usage(`no drift records found in ${options.providerDirectory}`);
  const report = { specs: [], docs: [], manual: [], records: [] };
  for (const entry of providers) {
    const { provider, path, record } = entry;
    if (options.providers.length > 0 && !options.providers.includes(provider)) continue;
    if (entry.error) {
      report.records.push({ provider, findings: [errorFinding(entry.error)] });
      continue;
    }
    let changed = false;
    for (const [index, check] of record.checks.entries()) {
      const mode = checkMode(check?.type);
      if (!options[mode]) continue;
      try {
        validateCheck(check, options.record);
        if (mode === "specs") {
          const versioned = check.type === "versioned-endpoints";
          const specification = versioned ? { source: "per-product OpenAPI documents" } : await loadSpecification(provider, check, options);
          const result = versioned ? await checkVersionedProvider(provider, check, options) : checkSpecProvider(provider, check, specification);
          // Failed parsing/network checks never write partial evidence or erase pins.
          const recordable = !result.findings.some((finding) => ["parser-error", "unavailable", "version-mismatch"].includes(finding.kind));
          if (options.record && recordable) {
            record.checks[index] = { ...check, ...(result.specifications ? { specifications: result.specifications } : {}), endpoints: result.recorded };
            changed = true;
          }
          report.specs.push({ provider, check: index, specification: specification.source, revision: result.revision,
            endpoints: check.endpoints.length, findings: result.findings,
            ...(options.record && recordable ? { recordedTo: path } : {}) });
        } else if (mode === "docs") {
          report.docs.push({ ...await checkDocumentedProvider(provider, check, options), check: index });
        } else {
          report.manual.push({ provider, check: index, source: check.source, evidence: check.evidence,
            findings: [{ kind: "manual-required", detail: check.rationale }] });
        }
      } catch (error) {
        report[mode].push({ provider, check: index, findings: [errorFinding(error)] });
      }
    }
    if (changed) {
      try { await writeFile(path, `${JSON.stringify(record, null, 2)}\n`); }
      catch (error) { report.records.push({ provider, findings: [errorFinding(new UnavailableError(`could not record ${path}: ${error.message}`))] }); }
    }
  }
  const findings = findingCount(report);
  if (options.json) console.log(JSON.stringify({ ...report, findings }, null, 2));
  else {
    for (const result of report.specs) {
      if (result.endpoints !== undefined) printSpec(result, result.recordedTo);
      else printFailure(result);
    }
    for (const result of report.docs) {
      if (result.added) printDocs(result);
      else printFailure(result);
    }
    for (const result of [...report.manual, ...report.records]) printFailure(result);
    console.log(findings === 0 ? "\nNo drift against the reviewed evidence."
      : `\n${findings} finding(s). Review them manually; this command never files issues.`);
    console.log(options.strict ? "Strict drift gate: findings exit 1." : "Advisory report: findings exit 0. Use --strict for a drift gate.");
  }
  process.exitCode = options.strict && findings > 0 ? 1 : 0;
}

function printFailure(result) {
  console.log(`${result.provider} — ${result.findings.length} finding(s)`);
  if (result.source) console.log(`  source       ${result.source}`);
  for (const finding of result.findings) console.log(`  ${finding.kind.padEnd(16)} ${finding.detail}`);
}

main().catch((error) => {
  console.error(`drift:check: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
