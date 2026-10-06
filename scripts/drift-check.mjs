// Maintainer tooling, not deployment runtime. Nothing here ships: `scripts/`
// is outside the package `files`, and no runtime module imports it.
//
// Two parts, both credential-free, release-time, and human-triggered:
//
// - **Touched endpoints.** Hand-written HTTP providers are written against a
//   published OpenAPI document, and only against the handful of operations they
//   actually call. The committed manifests in `scripts/drift/` record that
//   handful — method, path, the spec revision a release reviewed it at, and a
//   digest of the request/response contract at that revision — so a check can
//   report the endpoints connecta touches without reading the other 2,000.
// - **Published MCP references.** When a provider publishes a tool reference,
//   compare its documented inventory and public connection metadata with the
//   maintained wrapper without needing account credentials. This catches an
//   unclassified tool before a live workspace is available. A provider that
//   publishes neither a setup page nor an inventory (Basecamp) is checked
//   against the OAuth discovery metadata it serves instead. Remote MCP schemas
//   are never vendored here: the provider's live `tools/list` response remains
//   the runtime authority, and tests pin that passthrough.
//
// Planning Center is the one touched-endpoint provider with more than one
// document. It publishes an OpenAPI document per product *and dated API
// version*, and connecta pins one version per product, so its manifest names a
// specification per product and the check asks one question the others do
// not: has Planning Center published a newer version of a pinned product? That
// answer comes from the credential-free documentation graph
// (`/<app>/v2/documentation`), and like a deprecation it is reported as a
// transition, so a reviewed publication stops being news once recorded.
//
// Published specifications are drift evidence and nothing else. Nothing here
// generates a tool, and no runtime module reads a spec — schema ingestion stays
// refused (ethos.md).
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultManifestDirectory = resolvePath(repositoryRoot, "scripts/drift");

/** Hand-written HTTP providers: a published specification, read as evidence. */
/**
 * Hand-written HTTP providers: a published specification, read as evidence.
 *
 * Overflow publishes its OpenAPI document only on staging
 * (server.stage.overflow.co/api/docs/openapi.json); production's equivalent
 * answers 404. The check therefore reads staging's contract and relies on
 * Overflow documenting one v3 API at two base URLs. Its manifest records all
 * thirty-eight operations, because the maintained guide routes agents to
 * every one of them, named tool or hatch.
 */
const SPEC_PROVIDERS = [
  "cloudflare",
  "notion",
  "vercel",
  "planning-center",
  "overflow",
  "tithely",
  "ccb",
];
/** Providers whose manifest names one specification per product and version. */
const VERSIONED_SPEC_PROVIDERS = new Set(["planning-center"]);
/** Hosted MCP providers with official public documentation we can read. */
const DOCS_PROVIDERS = [
  "cloudflare",
  "linear",
  "stripe",
  "mixpanel",
  "notion",
  "revenuecat",
  "vercel",
  "basecamp",
];

const DOCUMENTED_MCP = {
  cloudflare: {
    setup:
      "https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/index.md",
    inventory: {
      url: "https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/index.md",
      format: "inline-calls",
      start: "## Cloudflare API MCP server",
      end: "### Connect to the Cloudflare API MCP server",
    },
  },
  linear: {
    setup: "https://linear.app/docs/mcp.md",
    inventory: undefined,
  },
  stripe: {
    setup: "https://docs.stripe.com/mcp.md",
    inventory: {
      url: "https://docs.stripe.com/mcp.md",
      format: "table",
      start: "## Tools",
      end: "### Supported API methods",
    },
  },
  mixpanel: {
    setup: "https://docs.mixpanel.com/docs/features/mcp.md",
    inventory: {
      url: "https://docs.mixpanel.com/docs/features/mcp.md",
      format: "table",
      start: "## Available Tools",
      end: "## MCP Server URLs",
    },
  },
  notion: {
    setup:
      "https://developers.notion.com/guides/mcp/get-started-with-mcp.md",
    inventory: {
      url: "https://developers.notion.com/guides/mcp/mcp-supported-tools.md",
      format: "inline",
      prefix: "notion-",
    },
  },
  revenuecat: {
    setup: "https://www.revenuecat.com/docs/tools/mcp/setup.md",
    inventory: {
      url: "https://www.revenuecat.com/docs/tools/mcp/tools-reference.md",
      format: "table",
      // The reference publishes this name with a blank Access column. A
      // release cannot infer read or write from its verb, so it stays closed.
      acknowledgedUnclassified: new Set(["render-paywall-screenshot"]),
    },
  },
  vercel: {
    setup: "https://vercel.com/docs/agent-resources/vercel-mcp.md",
    inventory: {
      url: "https://vercel.com/docs/agent-resources/vercel-mcp/tools.md",
      format: "headings",
    },
  },
  basecamp: {
    // 37signals publishes no setup page and no tool inventory for this server:
    // basecamp.com/agents, where its own 401 points, covers the CLI and SDKs
    // and never names it. What the server does publish is its OAuth
    // discovery, and `basecamp()` depends on two facts there — that the
    // protected resource is the endpoint connecta calls, and that the
    // authorization server still accepts a Client ID Metadata Document, which
    // the constructor requires because Basecamp restricts dynamic registration
    // for HTTPS callbacks. So the setup reference is that metadata, read as
    // JSON rather than prose, and catalog drift stays runtime-only.
    setup: "https://mcp.basecamp.com/.well-known/oauth-protected-resource/mcp",
    setupFormat: "oauth-discovery",
    inventory: undefined,
  },
};

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
      "  --manifest-dir <path>    touched-endpoint manifests (default scripts/drift)",
      "  --record                 rewrite touched-endpoint manifests from the specs",
      "  --json                   print the report as JSON",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArguments(argv) {
  const options = {
    specs: false,
    docs: false,
    providers: [],
    specSources: new Map(),
    toolReferenceSources: new Map(),
    setupReferenceSources: new Map(),
    manifestDirectory: defaultManifestDirectory,
    record: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) usage(`${argument} requires a value`);
      index += 1;
      return value;
    };
    if (argument === "--specs") options.specs = true;
    else if (argument === "--docs") options.docs = true;
    else if (argument === "--record") options.record = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--provider") options.providers.push(next());
    else if (argument === "--manifest-dir")
      options.manifestDirectory = resolvePath(next());
    else if (
      argument === "--spec" ||
      argument === "--tool-reference" ||
      argument === "--setup-reference"
    ) {
      const value = next();
      const separator = value.indexOf("=");
      if (separator < 1) usage(`${argument} expects <provider>=<file or url>`);
      const target =
        argument === "--spec"
          ? options.specSources
          : argument === "--tool-reference"
            ? options.toolReferenceSources
            : options.setupReferenceSources;
      target.set(value.slice(0, separator), value.slice(separator + 1));
    } else usage(`unknown argument: ${argument}`);
  }
  // No part named means both: a release checks the whole provider surface.
  if (!options.specs && !options.docs) {
    options.specs = true;
    options.docs = true;
  }
  if (options.specSources.size > 0 && !options.specs) {
    usage("--spec requires --specs when a check mode is selected explicitly");
  }
  if (
    (options.toolReferenceSources.size > 0 ||
      options.setupReferenceSources.size > 0) &&
    !options.docs
  ) {
    usage(
      "--tool-reference and --setup-reference require --docs when a check mode is selected explicitly",
    );
  }
  const known = new Set([...SPEC_PROVIDERS, ...DOCS_PROVIDERS]);
  // A provider only one half checks, named alongside the other half, would
  // narrow the run to nothing — and a check whose whole value is its exit code
  // must not print "no drift" for a run that looked at nothing.
  const selectable = new Set([
    ...(options.specs ? SPEC_PROVIDERS : []),
    ...(options.docs ? DOCS_PROVIDERS : []),
  ]);
  for (const key of options.specSources.keys()) {
    const [provider, app] = key.split("/");
    if (VERSIONED_SPEC_PROVIDERS.has(provider) !== (app !== undefined)) {
      usage(
        VERSIONED_SPEC_PROVIDERS.has(provider)
          ? `${provider} publishes one specification per product; name it --spec ${provider}/<app>=<file|url>`
          : `${provider} publishes one specification; name it --spec ${provider}=<file|url>`,
      );
    }
  }
  const requestedProviders = [
    ...options.providers,
    ...[...options.specSources.keys()].map((key) => key.split("/")[0]),
    ...options.toolReferenceSources.keys(),
    ...options.setupReferenceSources.keys(),
  ];
  for (const provider of requestedProviders) {
    if (!known.has(provider)) usage(`unknown provider: ${provider}`);
    if (!selectable.has(provider)) {
      const modes = [
        ...(SPEC_PROVIDERS.includes(provider) ? ["--specs"] : []),
        ...(DOCS_PROVIDERS.includes(provider) ? ["--docs"] : []),
      ];
      const availability =
        modes.length === 1
          ? `only checked by ${modes[0]}`
          : `checked by ${modes.join(" or ")}`;
      usage(
        `${provider} is ${availability}, which this run did not select. ` +
          "that combination would check nothing.",
      );
    }
  }
  return options;
}

function selected(options, providers) {
  if (options.providers.length === 0) return providers;
  return providers.filter((provider) => options.providers.includes(provider));
}

/** A fatal condition a maintainer can fix, reported without a stack trace. */
class UnavailableError extends Error {}

// ---------------------------------------------------------------------------
// Touched endpoints
// ---------------------------------------------------------------------------

async function loadManifest(provider, options) {
  const path = resolvePath(
    options.manifestDirectory,
    `${provider}-endpoints.json`,
  );
  try {
    return { path, manifest: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    throw new UnavailableError(
      `could not read ${provider}'s touched-endpoint manifest at ${path}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
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
    throw new UnavailableError(`${provider}'s manifest lists no reference pages`);
  }
  const paths = {};
  const versions = new Set();
  for (const page of pages) {
    const source = `${base}${page}.md`;
    const markdown = await loadPublished(provider, "API reference page", source);
    const fence = markdown.match(/# OpenAPI definition\s+```json\n([\s\S]*?)\n```/);
    if (!fence) {
      throw new UnavailableError(
        `${provider}'s reference page ${source} no longer embeds an OpenAPI definition`,
      );
    }
    let snippet;
    try {
      snippet = JSON.parse(fence[1]);
    } catch (error) {
      throw new UnavailableError(
        `${provider}'s reference page ${source} embeds malformed OpenAPI JSON: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    if (JSON.stringify(snippet.paths ?? {}).includes('"$ref"')) {
      throw new UnavailableError(
        `${provider}'s reference page ${source} now uses $ref; the page assembler cannot resolve references across snippets`,
      );
    }
    versions.add(String(snippet.info?.version ?? "unknown"));
    for (const [path, item] of Object.entries(snippet.paths ?? {})) {
      for (const [method, operation] of Object.entries(item ?? {})) {
        paths[path] ??= {};
        if (paths[path][method]) {
          throw new UnavailableError(
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
  return {
    source,
    document: await loadJson(`${provider}'s published specification`, source),
  };
}

async function loadJson(label, source) {
  if (/^https?:\/\//.test(source)) {
    let response;
    try {
      // Planning Center refuses a request without a descriptive User-Agent,
      // and naming the caller costs every other provider nothing.
      response = await fetch(source, {
        headers: {
          "User-Agent": "connecta-drift-check (+https://github.com/zackbart/connecta)",
        },
      });
    } catch (error) {
      throw new UnavailableError(
        `could not fetch ${label} from ${source}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    if (!response.ok) {
      throw new UnavailableError(
        `could not fetch ${label} from ${source}: HTTP ${response.status}`,
      );
    }
    return await response.json();
  }
  try {
    return JSON.parse(await readFile(resolvePath(source), "utf8"));
  } catch (error) {
    throw new UnavailableError(
      `could not read ${label} from ${source}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
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
  return { provider, revision, findings, recorded };
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
    recorded.push({
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
  return (index?.data?.relationships?.versions?.data ?? [])
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
    if (!touched.has(app)) continue;
    const source =
      options.specSources.get(`${provider}/${app}`) ?? specification.url;
    const document = await loadJson(
      `${provider}'s ${app} specification`,
      source,
    );
    if (document.info?.version !== specification.version) {
      findings.push({
        app,
        kind: "version-mismatch",
        detail: `the ${app} specification describes ${document.info?.version ?? "no version"}, not pinned ${specification.version}`,
      });
    }
    documents.set(app, document);
  }
  const unknown = [...touched].filter((app) => !documents.has(app));
  if (unknown.length > 0) {
    throw new UnavailableError(
      `${provider}'s manifest touches endpoints in ${unknown.join(", ")} without naming a specification for them`,
    );
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

async function recordManifest(path, manifest, recorded, specifications) {
  const next = {
    ...manifest,
    ...(specifications ? { specifications } : {}),
    endpoints: recorded,
  };
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Published MCP references
// ---------------------------------------------------------------------------

async function loadPublished(provider, label, source) {
  let text;
  try {
    if (/^https?:\/\//.test(source)) {
      const response = await fetch(source);
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

async function loadDocumentedProviders() {
  try {
    const [cloudflare, linear, stripe, mixpanel, notion, revenuecat, vercel, basecamp] = await Promise.all([
      import("../src/providers/cloudflare.ts"),
      import("../src/providers/linear.ts"),
      import("../src/providers/stripe.ts"),
      import("../src/providers/mixpanel.ts"),
      import("../src/providers/notion.ts"),
      import("../src/providers/revenuecat.ts"),
      import("../src/providers/vercel.ts"),
      import("../src/providers/basecamp.ts"),
    ]);
    return {
      cloudflare: {
        endpoints: [cloudflare.CLOUDFLARE_MCP_ENDPOINT],
        catalog: cloudflare.CLOUDFLARE_MCP_VETTED_CATALOG,
      },
      linear: {
        endpoints: [linear.LINEAR_MCP_ENDPOINTS["read-write"]],
        catalog: linear.LINEAR_VETTED_CATALOG,
      },
      stripe: {
        endpoints: [stripe.STRIPE_MCP_ENDPOINT],
        catalog: stripe.STRIPE_VETTED_CATALOG,
      },
      mixpanel: {
        endpoints: Object.values(mixpanel.MIXPANEL_MCP_ENDPOINTS),
        catalog: mixpanel.MIXPANEL_VETTED_CATALOG,
      },
      notion: {
        endpoints: [notion.NOTION_MCP_ENDPOINT],
        catalog: notion.NOTION_MCP_VETTED_CATALOG,
      },
      revenuecat: {
        endpoints: [revenuecat.REVENUECAT_MCP_ENDPOINT],
        catalog: revenuecat.REVENUECAT_VETTED_CATALOG,
      },
      vercel: {
        endpoints: [vercel.VERCEL_MCP_ENDPOINT],
        catalog: vercel.VERCEL_MCP_VETTED_CATALOG,
      },
      basecamp: {
        endpoints: [basecamp.BASECAMP_MCP_ENDPOINT],
        catalog: basecamp.BASECAMP_VETTED_CATALOG,
      },
    };
  } catch (error) {
    throw new UnavailableError(
      "could not load documented provider contracts from TypeScript source; " +
        "run this through `npm run drift:check`, which uses tsx " +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function documentedSection(markdown, inventory) {
  const start = inventory.start ? markdown.indexOf(inventory.start) : 0;
  if (start < 0) return "";
  const afterStart = markdown.slice(start + (inventory.start?.length ?? 0));
  if (!inventory.end) return afterStart;
  const end = afterStart.indexOf(inventory.end);
  return end < 0 ? afterStart : afterStart.slice(0, end);
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
  throw new UnavailableError(`${provider}'s ${label} is not a JSON object`);
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

async function checkDocumentedProvider(provider, runtime, options) {
  const defaults = DOCUMENTED_MCP[provider];
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
    throw new UnavailableError(
      `${provider}'s MCP tool reference contained no recognizable tool names`,
    );
  }
  const reviewed = [...runtime.catalog.tools.keys()].sort();
  const reviewedSet = new Set(reviewed);
  const documentedSet = new Set(documented ?? []);
  const acknowledged = defaults.inventory?.acknowledgedUnclassified ?? new Set();
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

  if (defaults.setupFormat === "oauth-discovery") {
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
      : finding.app;
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
  for (const result of report.specs) total += result.findings.length;
  for (const result of report.docs) {
    total += result.added.length + result.findings.length;
  }
  return total;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = { specs: [], docs: [] };

  if (options.specs) {
    for (const provider of selected(options, SPEC_PROVIDERS)) {
      const { path, manifest } = await loadManifest(provider, options);
      const versioned = VERSIONED_SPEC_PROVIDERS.has(provider);
      const specification = versioned
        ? { source: "per-product OpenAPI documents" }
        : await loadSpecification(provider, manifest, options);
      const result = versioned
        ? await checkVersionedProvider(provider, manifest, options)
        : checkSpecProvider(provider, manifest, specification);
      if (options.record) {
        await recordManifest(
          path,
          manifest,
          result.recorded,
          result.specifications,
        );
      }
      report.specs.push({
        provider,
        specification: specification.source,
        revision: result.revision,
        endpoints: manifest.endpoints.length,
        findings: result.findings,
        ...(options.record ? { recordedTo: path } : {}),
      });
    }
  }

  if (options.docs) {
    const providers = selected(options, DOCS_PROVIDERS);
    if (providers.length > 0) {
      const runtimes = await loadDocumentedProviders();
      for (const provider of providers) {
        report.docs.push(
          await checkDocumentedProvider(provider, runtimes[provider], options),
        );
      }
    }
  }

  const findings = findingCount(report);
  if (options.json) {
    console.log(JSON.stringify({ ...report, findings }, null, 2));
  } else {
    for (const result of report.specs) {
      printSpec(result, result.recordedTo);
    }
    for (const result of report.docs) printDocs(result);
    console.log(
      findings === 0
        ? "\nNo drift against the reviewed manifests."
        : `\n${findings} finding(s). Each one is a manually reviewed issue, not an automatic filing.`,
    );
  }
  process.exit(findings === 0 ? 0 : 1);
}

main().catch((error) => {
  if (error instanceof UnavailableError) {
    console.error(`drift:check: ${error.message}`);
    process.exit(2);
  }
  throw error;
});
