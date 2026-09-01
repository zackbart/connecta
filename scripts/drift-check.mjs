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
//   unclassified tool before a live workspace is available. Remote MCP schemas
//   are never vendored here: the provider's live `tools/list` response remains
//   the runtime authority, and tests pin that passthrough.
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
const SPEC_PROVIDERS = ["cloudflare", "notion", "vercel"];
/** Hosted MCP providers with official public documentation we can read. */
const DOCS_PROVIDERS = [
  "cloudflare",
  "linear",
  "stripe",
  "mixpanel",
  "notion",
  "revenuecat",
  "vercel",
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
  const requestedProviders = [
    ...options.providers,
    ...options.specSources.keys(),
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

async function loadSpecification(provider, manifest, options) {
  const source = options.specSources.get(provider) ?? manifest.specification.url;
  if (/^https?:\/\//.test(source)) {
    let response;
    try {
      response = await fetch(source);
    } catch (error) {
      throw new UnavailableError(
        `could not fetch ${provider}'s published specification from ${source}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    if (!response.ok) {
      throw new UnavailableError(
        `could not fetch ${provider}'s published specification from ${source}: ` +
          `HTTP ${response.status}`,
      );
    }
    return { source, document: await response.json() };
  }
  try {
    const document = JSON.parse(
      await readFile(resolvePath(source), "utf8"),
    );
    return { source, document };
  } catch (error) {
    throw new UnavailableError(
      `could not read ${provider}'s published specification from ${source}: ` +
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
  const findings = [];
  const recorded = [];
  for (const endpoint of manifest.endpoints) {
    const row = {
      method: endpoint.method,
      path: endpoint.path,
      specRevision: endpoint.specRevision,
    };
    const { missing, operation } = operationFor(specification.document, endpoint);
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
    const digest = contractDigest(specification.document, operation);
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
  return { provider, revision, findings, recorded };
}

async function recordManifest(path, manifest, recorded) {
  const next = { ...manifest, endpoints: recorded };
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
    const [cloudflare, linear, stripe, mixpanel, notion, revenuecat, vercel] = await Promise.all([
      import("../src/providers/cloudflare.ts"),
      import("../src/providers/linear.ts"),
      import("../src/providers/stripe.ts"),
      import("../src/providers/mixpanel.ts"),
      import("../src/providers/notion.ts"),
      import("../src/providers/revenuecat.ts"),
      import("../src/providers/vercel.ts"),
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
    console.log(
      `  ${finding.kind.padEnd(16)} ${finding.method} ${finding.path} — ${finding.detail}`,
    );
  }
  if (recorded) console.log(`  recorded     ${recorded}`);
}

function printDocs(result) {
  console.log(
    result.inventoryChecked
      ? `${result.provider} MCP docs: ${result.documentedTools} documented tools`
      : `${result.provider} MCP docs: setup metadata only; no official tool inventory`,
  );
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
      const specification = await loadSpecification(provider, manifest, options);
      const result = checkSpecProvider(provider, manifest, specification);
      if (options.record) await recordManifest(path, manifest, result.recorded);
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
