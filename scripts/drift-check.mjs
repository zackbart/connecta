import { canonicalDiscovery, discoveryRefs, discoveryMethods } from "./google-discovery.mjs";
import { contractDigest } from "./drift-contract.mjs";
// Credential-free maintainer tooling. Provider folders own vendor evidence in
// versioned drift.json records; no deployment module reads these records.
// Version 2 (decision 0011, D; scripts/drift-record.mjs) reads
// endpoint rows keyed by an `operation` from `generated.operations`. Version 1
// stays readable for providers that have not landed their step 1.
// Reports are advisory (exit 0), including parser/network failures and required
// manual reviews. --strict exits 1 for findings; invocation errors exit 2.
// Only --record with an explicit --provider selection updates endpoint digests,
// revisions and latest-published evidence. It never changes pins, check config,
// or runtime code.
import { STALE_AFTER_DAYS, serializeDrift } from "./drift-record.mjs";
import {
  DRIFT_VERSION,
  EvidenceError,
  checkView as projectCheck,
  daysSince,
  parseOperation,
  productOf,
  validateCheck,
  validateRecord,
  supplementalDocument,
  validSupplementalPin,
} from "./drift-validate.mjs";
import { openApiEvidence, readOpenApiSource, sha256 } from "./generate-openapi.mjs";
import { discoverProviders } from "./providers.mjs";
import { readFile, readdir, writeFile, realpath } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const defaultProviderDirectory = resolvePath(repositoryRoot, "src/providers");

/**
 * @typedef {{type: "endpoints", specification: object, endpoints: object[], scopes?: string[]} |
 * {type: "versioned-endpoints", specifications: object, endpoints: object[]} |
 * {type: "manual", source: string, rationale: string, evidence?: object} |
 * {type: "openapi-index", source: "openapi.source.json"}} DriftCheck
 * @typedef {{version: 1, provider: string, checks: DriftCheck[]}} DriftRecord
 *
 * Version 2 changes these, and every checker reads a v2 check through
 * `checkView` in the version-1 shape above: `manual` names `reason` and a
 * `lastVerified` day; endpoint rows carry `operation` (and
 * `page` for ReadMe operation pages) in place of `method` and `path`;
 * `openapi-index` reads `evidence/openapi.json`.
 * @typedef {{version: 2, provider: string, generated: {operations: string[], evidence: Record<string, string>}, checks: object[]}} DriftRecordV2
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

function usage(message) {
  if (message) console.error(`drift:check: ${message}`);
  console.error(
    [
      "usage: pnpm run drift:check [options]",
      "",
      "  --specs                  only compare touched endpoints with published specs",
      "  --provider <id>          limit to one provider (repeatable)",
      "  --spec <id>=<file|url>   read a provider's published spec from here",
      "                           (planning-center: --spec planning-center/<app>=…)",
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
    manual: false,
    strict: false,
    providers: [],
    specSources: new Map(),
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
    else if (argument === "--manual") options.manual = true;
    else if (argument === "--strict") options.strict = true;
    else if (argument === "--record") options.record = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--provider") options.providers.push(next());
    else if (argument === "--provider-dir" || argument === "--manifest-dir")
      options.providerDirectory = resolvePath(next());
    else if (argument === "--spec") {
      const value = next();
      const separator = value.indexOf("=");
      if (separator < 1 || separator === value.length - 1) usage(`${argument} expects <provider>=<file or url>`);
      options.specSources.set(value.slice(0, separator), value.slice(separator + 1));
    } else usage(`unknown argument: ${argument}`);
  }
  if (!options.specs && !options.manual) {
    options.specs = true;
    options.manual = true;
  }
  if (options.specSources.size > 0 && !options.specs) {
    usage("--spec requires --specs when a check mode is selected explicitly");
  }
  if (options.record && options.providers.length === 0) {
    usage("--record requires an explicit --provider selection; baselines are never updated implicitly");
  }
  return options;
}

class UnavailableError extends Error {}
class ParserError extends Error {}

function errorFinding(error) {
  return {
    kind:
      error instanceof EvidenceError
        ? "evidence-invalid"
        : error instanceof UnavailableError
          ? "unavailable"
          : "parser-error",
    detail: error instanceof Error ? error.message : String(error),
  };
}

function checkMode(type) {
  if (type === "endpoints" || type === "versioned-endpoints" || type === "openapi-index") return "specs";
  if (type === "manual") return "manual";
  return "records";
}

/** Discover only direct provider folders carrying drift.json; shared code is absent. */
async function discoverRecords(directory) {
  const providers = [];
  const entries =
    directory === defaultProviderDirectory
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
      providers.push({
        provider: entry.name,
        path,
        error: new UnavailableError(`could not read ${path}: ${error.message}`),
      });
      continue;
    }
    try {
      const record = JSON.parse(text);
      validateRecord(record, entry.name);
      providers.push({ provider: entry.name, path, record });
    } catch (error) {
      providers.push({
        provider: entry.name,
        path,
        error: new EvidenceError(`invalid drift record at ${path}: ${error.message}`),
      });
    }
  }
  return providers;
}

function validateSelection(options, providers) {
  const known = new Map(providers.map((entry) => [entry.provider, entry]));
  const requested = [...options.providers, ...[...options.specSources.keys()].map((key) => key.split("/")[0])];
  for (const provider of requested) {
    const entry = known.get(provider);
    if (!entry) usage(`unknown provider: ${provider}`);
    if (entry.error) continue; // Invalid evidence must still get a structured report.
    const modes = new Set(entry.record.checks.map((check) => checkMode(check?.type)));
    // --specs reports a version-2 manifest's unrecorded operations even without an endpoint check.
    if (entry.record.version === DRIFT_VERSION && entry.record.generated.operations.length > 0) modes.add("specs");
    if (modes.has("records")) continue;
    if (![...modes].some((mode) => options[mode])) {
      usage(
        `${provider} is only checked by ${[...modes].map((mode) => `--${mode}`).join(" or ")}, which this run did not select. That combination would check nothing.`,
      );
    }
  }
  for (const key of options.specSources.keys()) {
    const [provider, app, extra] = key.split("/");
    const entry = known.get(provider);
    if (entry.error) continue;
    const check = entry.record.checks.find(
      (item) => item?.type === "endpoints" || item?.type === "versioned-endpoints" || item?.type === "openapi-index",
    );
    if (!check && entry.record.checks.some((item) => checkMode(item?.type) === "records")) continue;
    if (!check) usage(`${provider} has no endpoint specification check`);
    if (check.type === "versioned-endpoints") {
      if (!app || extra)
        usage(`${provider} publishes one specification per product; name it --spec ${provider}/<app>=<file|url>`);
      if (!Object.hasOwn(check.specifications ?? {}, app)) usage(`unknown ${provider} product: ${app}`);
    } else if (app) usage(`${provider} publishes one specification; name it --spec ${provider}=<file|url>`);
  }
  if (options.record) {
    for (const provider of requested) {
      if (!options.providers.includes(provider))
        usage(`--record source overrides must name an explicitly selected --provider: ${provider}`);
    }
  }
}

/** A recorded endpoint row in its version-2 spelling. */
function operationRow({ method, path, page, specRevision, deprecated, contract, ...rest }) {
  return {
    operation: `${method} ${path}`,
    ...(page === undefined ? {} : { page }),
    ...rest,
    specRevision,
    ...(deprecated ? { deprecated } : {}),
    ...(contract === undefined ? {} : { contract }),
  };
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
      throw new ParserError(`${provider}'s reference page ${source} no longer embeds an OpenAPI definition`);
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
  if (manifest.specification.pin !== undefined) {
    const document = supplementalDocument(manifest.specification.pin);
    if (!document) throw new EvidenceError("Supplemental pin must be a simple non-reserved evidence filename");
    const directory = resolvePath(options.providerDirectory, provider, "evidence");
    const ownDirectory = await realpath(directory);
    for (const name of [manifest.specification.pin, document]) {
      if (dirname(await realpath(resolvePath(directory, name))) !== ownDirectory)
        throw new EvidenceError("Supplemental evidence must stay in its provider's evidence directory");
    }
    const pin = await loadJson(`${provider}'s supplemental pin`, resolvePath(directory, manifest.specification.pin));
    if (!validSupplementalPin(pin))
      throw new EvidenceError(
        "Supplemental pin requires https url/documentation, vendored: true and a document digest",
      );
    const bytes = await readFile(resolvePath(directory, document));
    if (sha256(bytes) !== pin.digest) throw new EvidenceError("Supplemental document digest does not match its pin");
    return { source: pin.documentation, document: validateOpenApi(provider, JSON.parse(bytes.toString("utf8"))) };
  }
  const source = options.specSources.get(provider) ?? manifest.specification.url;
  // A provider documented page by page reads a page base, URL or directory; a
  // `.json` override is a combined document like any other provider's.
  if (manifest.specification.format === "readme-operation-pages" && !source.endsWith(".json")) {
    const base = /^https?:\/\//.test(source) || source.endsWith("/") ? source : `${source}/`;
    return {
      source,
      document: await loadOperationPages(provider, base, manifest.specification.pages ?? []),
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
    throw new ParserError(`${provider}'s published specification is not a Google Discovery document`);
  }
  const servicePath = discovery.servicePath ?? "";
  const paths = {};
  const json = (ref) => ({
    content: { "application/json": { schema: discoveryRefs({ $ref: ref }) } },
  });
  for (const method of discoveryMethods(discovery)) {
    const path = `/${servicePath}${method.flatPath ?? method.path}`.replace(/\/{2,}/g, "/");
    const verb = String(method.httpMethod).toLowerCase();
    paths[path] ??= {};
    if (paths[path][verb]) {
      throw new ParserError(`${provider}'s Discovery document defines ${verb.toUpperCase()} ${path} twice`);
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
    if (document === null || typeof document !== "object" || Array.isArray(document))
      throw new Error("expected a JSON object");
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

function operationFor(document, endpoint) {
  const item = document.paths?.[endpoint.path];
  if (!item) return { missing: "path" };
  const operation = item[endpoint.method.toLowerCase()];
  if (!operation) return { missing: "operation" };
  return { operation };
}

/**
 * Compare a pinned operation index with the vendor's current document. The
 * pin is a digest of exact bytes, so any change is drift to review; accepting
 * it is `providers:spec -- --provider <name> --record` after moving the pin.
 */
async function checkOpenApiIndex(provider, check, options) {
  let source;
  const directory = resolvePath(options.providerDirectory, provider);
  try {
    if ((await openApiEvidence(directory))?.pin !== check.source) {
      throw new Error(`${provider} declares an OpenAPI index check without ${check.source}`);
    }
    source = await readOpenApiSource(directory);
  } catch (error) {
    throw new EvidenceError(error instanceof Error ? error.message : String(error));
  }
  if (source.documents) {
    if (options.specSources.has(provider))
      throw new EvidenceError("A composed index cannot use one source override for multiple documents");
    const findings = [];
    for (const entry of source.documents) {
      const pin = await loadJson(`${provider}'s supplemental pin`, resolvePath(directory, "evidence", entry.pin));
      const text = await loadPublished(
        provider,
        "published specification",
        options.specSources.get(`${provider}/${entry.pin.slice(0, -5)}`) ?? pin.url,
      );
      const digest = sha256(new TextEncoder().encode(text));
      if (digest !== pin.digest)
        findings.push({
          kind: "spec-drift",
          detail: `${entry.pin}: pinned ${pin.digest} differs from ${pin.url} (${digest}). Review the supplemental pin and document together, then run providers:spec.`,
        });
    }
    return { provider, specification: source.url, revision: source.revision, findings };
  }
  const live = options.specSources.get(provider) ?? source.latest ?? source.url;
  const text = await loadPublished(provider, "published specification", live);
  if (source.discovery) {
    let published;
    try {
      published = JSON.parse(text);
    } catch {
      throw new ParserError(`${provider}'s Discovery specification at ${live} is not JSON`);
    }
    const archived = JSON.parse(await readFile(resolvePath(directory, "evidence/discovery.document.json"), "utf8"));
    const digest = sha256(JSON.stringify(canonicalDiscovery(published)));
    const pinned = sha256(JSON.stringify(canonicalDiscovery(archived)));
    return {
      provider,
      specification: live,
      revision: source.revision,
      findings:
        digest === pinned && String(published.revision) === source.revision
          ? []
          : [
              {
                kind: "spec-drift",
                detail: `Discovery canonical digest/revision changed: pinned ${source.revision} (${pinned}), published ${published.revision} (${digest}). Review the original bytes and conversion together; ${check.source}.`,
              },
            ],
    };
  }
  let version;
  // A vendored pin (decision 0011, E) digests a document only published in
  // another format; the reviewed JSON conversion lives beside it.
  if (source.vendored !== true) {
    try {
      version = JSON.parse(text)?.info?.version;
    } catch {
      throw new ParserError(`${provider}'s published specification at ${live} is not JSON`);
    }
  }
  const digest = sha256(new TextEncoder().encode(text));
  return {
    provider,
    specification: live,
    revision: source.revision,
    findings:
      digest === source.digest
        ? []
        : [
            {
              kind: "spec-drift",
              detail:
                `pinned ${source.revision} (${source.digest}) differs from ${live} (${digest}` +
                `${typeof version === "string" ? `, info.version ${version}` : ""}). Review it, move the pin in ` +
                `${check.source}, then run providers:spec -- --provider ${provider} --record.`,
            },
          ],
  };
}

function checkSpecProvider(provider, manifest, specification) {
  const revision = specification.document.info?.version ?? "unknown";
  const { findings, recorded } = checkEndpoints(manifest.endpoints, () => ({
    document: specification.document,
    revision,
    contractAlgorithm: manifest.specification?.contractAlgorithm,
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
    const { document, path = endpoint.path, revision, contractAlgorithm } = documentFor(endpoint);
    if (!document) {
      recorded.push(endpoint);
      continue;
    } // Failed product already has a finding.
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
    const digest = contractDigest(document, operation, contractAlgorithm);
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

/** Non-beta versions a Planning Center documentation graph lists, newest first. */
function publishedVersions(index) {
  const versions = index?.data?.relationships?.versions?.data;
  if (!Array.isArray(versions)) throw new ParserError("documentation graph has no versions array");
  return versions
    .filter((version) => typeof version?.id === "string" && version.attributes?.beta !== true)
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
  const touched = new Set(manifest.endpoints.map((endpoint) => productOf(endpoint.path)));
  for (const [app, specification] of Object.entries(manifest.specifications)) {
    specifications[app] = { ...specification };
    try {
      const index = await loadJson(`${provider}'s ${app} documentation graph`, specification.documentation);
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
        findings.push({
          app,
          kind: "version-mismatch",
          detail: `the ${app} specification describes ${document.info?.version ?? "no version"}, not pinned ${specification.version}`,
        });
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
      const response = await fetch(source, {
        signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "connecta-drift-check (+https://github.com/zackbart/connecta)" },
      });
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
    const subject = finding.method ? `${finding.method} ${finding.path}` : (finding.app ?? "check");
    console.log(`  ${finding.kind.padEnd(16)} ${subject} — ${finding.detail}`);
  }
  if (recorded) console.log(`  recorded     ${recorded}`);
}

function findingCount(report) {
  let total = 0;
  for (const result of [...report.specs, ...report.manual, ...report.records]) {
    total += result.findings.length + (result.added?.length ?? 0) + (result.removed?.length ?? 0);
  }
  return total;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const providers = await discoverRecords(options.providerDirectory);
  validateSelection(options, providers);
  if (providers.length === 0) usage(`no drift records found in ${options.providerDirectory}`);
  const report = { specs: [], manual: [], records: [] };
  for (const entry of providers) {
    const { provider, path, record } = entry;
    if (options.providers.length > 0 && !options.providers.includes(provider)) continue;
    if (entry.error) {
      report.records.push({ provider, findings: [errorFinding(entry.error)] });
      continue;
    }
    let changed = false;
    const v2 = record.version === DRIFT_VERSION;
    const endpointChecks = record.checks.filter(
      (check) => check?.type === "endpoints" || check?.type === "versioned-endpoints",
    );
    // A manifest operation no endpoint row records is a finding (D4) at the
    // provider's level: it holds with no endpoint check, or one that fails.
    const covered = new Set(
      endpointChecks
        .flatMap((check) => (Array.isArray(check?.endpoints) ? check.endpoints : []))
        .map((row) => row?.operation),
    );
    const unrecorded = v2 ? record.generated.operations.filter((key) => !covered.has(key)) : [];
    if (options.specs && unrecorded.length > 0) {
      report.specs.push({
        provider,
        findings: unrecorded.map((key) => ({
          ...parseOperation(key),
          kind: "operation-unrecorded",
          detail: `${key}: the provider sends this operation, but no endpoint row records its contract`,
        })),
      });
    }
    for (const [index, raw] of record.checks.entries()) {
      const mode = checkMode(raw?.type);
      if (mode !== "records" && !options[mode]) continue;
      try {
        const check = projectCheck(record, raw);
        validateCheck(check, options.record, record.version);
        if (check.type === "openapi-index") {
          report.specs.push({ ...(await checkOpenApiIndex(provider, check, options)), check: index, index: true });
        } else if (mode === "specs") {
          const versioned = check.type === "versioned-endpoints";
          const specification = versioned
            ? { source: "per-product OpenAPI documents" }
            : await loadSpecification(provider, check, options);
          const result = versioned
            ? await checkVersionedProvider(provider, check, options)
            : checkSpecProvider(provider, check, specification);
          // Failed parsing/network checks never write partial evidence or erase pins.
          const recordable = !result.findings.some((finding) =>
            ["parser-error", "unavailable", "version-mismatch"].includes(finding.kind),
          );
          if (options.record && recordable) {
            record.checks[index] = {
              ...(v2 ? raw : check),
              ...(result.specifications ? { specifications: result.specifications } : {}),
              endpoints: v2 ? result.recorded.map(operationRow) : result.recorded,
            };
            changed = true;
          }
          report.specs.push({
            provider,
            check: index,
            specification: specification.source,
            revision: result.revision,
            endpoints: check.endpoints.length,
            findings: result.findings,
            ...(options.record && recordable ? { recordedTo: path } : {}),
          });
        } else {
          const age = v2 ? daysSince(check.lastVerified) : 0;
          report.manual.push({
            provider,
            check: index,
            source: check.source,
            evidence: check.evidence,
            ...(v2 ? { lastVerified: check.lastVerified } : {}),
            findings: [
              { kind: "manual-required", detail: check.rationale },
              // Advisory only: a gate that failed as the calendar moved would break main with no change.
              ...(age > STALE_AFTER_DAYS
                ? [
                    {
                      kind: "manual-stale",
                      detail: `last verified ${check.lastVerified}, ${age} days ago; verify it again and move lastVerified`,
                    },
                  ]
                : []),
            ],
          });
        }
      } catch (error) {
        report[mode].push({ provider, check: index, findings: [errorFinding(error)] });
      }
    }
    if (changed) {
      try {
        await writeFile(path, v2 ? serializeDrift(record) : `${JSON.stringify(record, null, 2)}\n`);
      } catch (error) {
        report.records.push({
          provider,
          findings: [errorFinding(new UnavailableError(`could not record ${path}: ${error.message}`))],
        });
      }
    }
  }
  const findings = findingCount(report);
  if (options.json) console.log(JSON.stringify({ ...report, findings }, null, 2));
  else {
    for (const result of report.specs) {
      if (result.index) {
        console.log(
          `${result.provider} OpenAPI index — ${result.findings.length ? `${result.findings.length} finding(s)` : "no drift"} against pin ${result.revision}`,
        );
        for (const finding of result.findings) console.log(`  ${finding.kind.padEnd(16)} ${finding.detail}`);
      } else if (result.endpoints !== undefined) printSpec(result, result.recordedTo);
      else printFailure(result);
    }
    for (const result of [...report.manual, ...report.records]) printFailure(result);
    console.log(
      findings === 0
        ? "\nNo drift against the reviewed evidence."
        : `\n${findings} finding(s). Review them manually; this command never files issues.`,
    );
    console.log(
      options.strict
        ? "Strict drift gate: findings exit 1."
        : "Advisory report: findings exit 0. Use --strict for a drift gate.",
    );
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
