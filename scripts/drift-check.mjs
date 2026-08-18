// Maintainer tooling, not deployment runtime. Nothing here ships: `scripts/`
// is outside the package `files`, and no runtime module imports it.
//
// Two halves, both release-time and both human-triggered:
//
// - **Hosted-MCP catalogs.** The runtime check (#343) rides a refresh a
//   deployment already asked for and produces four counts *by construction* —
//   it has nowhere to put a tool name, so no surface it reaches has to remember
//   to strip one. That guarantee is worth keeping, so the names live here
//   instead: a maintainer with local credentials in front of a live workspace
//   is the one audience that can act on them. This half compares against the
//   same `vettedCatalog()` manifest the connector classifies from, and then
//   cross-checks its own totals against `detectCatalogDrift()` — two readings
//   of one manifest that disagree would mean one of them is lying.
// - **Touched endpoints.** Hand-written HTTP providers are written against a
//   published OpenAPI document, and only against the handful of operations they
//   actually call. The committed manifests in `scripts/drift/` record that
//   handful — method, path, the spec revision a release reviewed it at, and a
//   digest of the request/response contract at that revision — so a check can
//   report the endpoints connecta touches without reading the other 2,000.
//
// Published specifications are drift evidence and nothing else. Nothing here
// generates a tool, and no runtime module reads a spec — schema ingestion stays
// refused (ethos.md).
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { hostedAuthorizationHeader } from "./drift/hosted-auth.mjs";

const repositoryRoot = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultManifestDirectory = resolvePath(repositoryRoot, "scripts/drift");

/** Hosted-MCP proxies: a live catalog, read with the maintainer's own key. */
const HOSTED_PROVIDERS = ["linear", "stripe", "mixpanel", "revenuecat"];
/** Hand-written HTTP providers: a published specification, read as evidence. */
const SPEC_PROVIDERS = ["cloudflare", "notion"];

/** Where each hosted provider's credential comes from, and what it is. */
const HOSTED_CREDENTIALS = {
  linear: {
    variable: "CONNECTA_DRIFT_LINEAR_KEY",
    hint: "a Linear personal API key",
  },
  stripe: {
    variable: "CONNECTA_DRIFT_STRIPE_KEY",
    hint: "a Stripe restricted API key",
  },
  mixpanel: {
    variable: "CONNECTA_DRIFT_MIXPANEL_KEY",
    hint: "a Mixpanel service account as user:secret",
  },
  revenuecat: {
    variable: "CONNECTA_DRIFT_REVENUECAT_KEY",
    hint: "a RevenueCat API v2 secret key",
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
      "  --hosted                 only diff hosted-MCP catalogs (needs credentials)",
      "  --specs                  only compare touched endpoints with published specs",
      "  --provider <id>          limit to one provider (repeatable)",
      "  --spec <id>=<file|url>   read a provider's published spec from here",
      "  --manifest-dir <path>    touched-endpoint manifests (default scripts/drift)",
      "  --record                 rewrite the touched-endpoint manifests from the",
      "                           specs on hand, and print hosted schema digests",
      "  --json                   print the report as JSON",
      "",
      "Credentials are read from the environment, one per hosted provider:",
      ...Object.entries(HOSTED_CREDENTIALS).map(
        ([provider, { variable, hint }]) =>
          `  ${variable}  ${hint} (${provider})`,
      ),
      "",
      "A value containing a space is sent as the Authorization header verbatim,",
      "one containing a colon as Basic credentials (Mixpanel: Bearer Basic),",
      "and anything else as a Bearer token.",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArguments(argv) {
  const options = {
    hosted: false,
    specs: false,
    providers: [],
    specSources: new Map(),
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
    if (argument === "--hosted") options.hosted = true;
    else if (argument === "--specs") options.specs = true;
    else if (argument === "--record") options.record = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--provider") options.providers.push(next());
    else if (argument === "--manifest-dir")
      options.manifestDirectory = resolvePath(next());
    else if (argument === "--spec") {
      const value = next();
      const separator = value.indexOf("=");
      if (separator < 1) usage("--spec expects <provider>=<file or url>");
      options.specSources.set(
        value.slice(0, separator),
        value.slice(separator + 1),
      );
    } else usage(`unknown argument: ${argument}`);
  }
  // Neither half named means both — a release checks the whole surface.
  if (!options.hosted && !options.specs) {
    options.hosted = true;
    options.specs = true;
  }
  const known = new Set([...HOSTED_PROVIDERS, ...SPEC_PROVIDERS]);
  // A provider only one half checks, named alongside the other half, would
  // narrow the run to nothing — and a check whose whole value is its exit code
  // must not print "no drift" for a run that looked at nothing.
  const selectable = new Set([
    ...(options.hosted ? HOSTED_PROVIDERS : []),
    ...(options.specs ? SPEC_PROVIDERS : []),
  ]);
  for (const provider of [...options.providers, ...options.specSources.keys()]) {
    if (!known.has(provider)) usage(`unknown provider: ${provider}`);
    if (!selectable.has(provider)) {
      const half = HOSTED_PROVIDERS.includes(provider) ? "--hosted" : "--specs";
      usage(
        `${provider} is only checked by ${half}, which this run did not select — ` +
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
// Hosted-MCP catalogs
// ---------------------------------------------------------------------------

function maintainerContext() {
  const store = new Map();
  return {
    baseUrl: "https://drift-check.invalid",
    storage: {
      async get(key) {
        return store.get(key) ?? null;
      },
      async set(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        store.delete(key);
      },
      async list(prefix) {
        return [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
      },
    },
    logger: {
      debug() {},
      info() {},
      warn(...args) {
        console.warn(...args);
      },
      error(...args) {
        console.error(...args);
      },
    },
  };
}

/**
 * Load the provider modules from source.
 *
 * They are TypeScript, so this half runs under `tsx` — which is what
 * `npm run drift:check` does. The import is lazy so the specification half
 * still runs on plain `node`, and the failure says which of the two happened.
 */
async function loadHostedProviders() {
  try {
    const [drift, remote, linear, stripe, mixpanel, revenuecat] =
      await Promise.all([
        import("../src/catalog-drift.ts"),
        import("../src/connectors/remote-mcp.ts"),
        import("../src/providers/linear.ts"),
        import("../src/providers/stripe.ts"),
        import("../src/providers/mixpanel.ts"),
        import("../src/providers/revenuecat.ts"),
      ]);
    return {
      detectCatalogDrift: drift.detectCatalogDrift,
      vettedSchemaDigest: drift.vettedSchemaDigest,
      remoteMcp: remote.remoteMcp,
      endpoints: {
        // The manifest classifies the whole catalog, so the check reads the
        // whole catalog: Linear's read-only endpoint would report every write
        // it deliberately cannot serve as a name no longer served.
        linear: linear.LINEAR_MCP_ENDPOINTS["read-write"],
        stripe: stripe.STRIPE_MCP_ENDPOINT,
        // Region shapes residency, not the catalog; US is the provider default.
        mixpanel: mixpanel.MIXPANEL_MCP_ENDPOINTS.us,
        revenuecat: revenuecat.REVENUECAT_MCP_ENDPOINT,
      },
      catalogs: {
        linear: linear.LINEAR_VETTED_CATALOG,
        stripe: stripe.STRIPE_VETTED_CATALOG,
        mixpanel: mixpanel.MIXPANEL_VETTED_CATALOG,
        // Names and verdicts only: no release has read a live RevenueCat
        // schema, so this manifest records no digests and the check honestly
        // counts zero schema changes rather than reporting an invented one.
        revenuecat: revenuecat.REVENUECAT_VETTED_CATALOG,
      },
    };
  } catch (error) {
    throw new UnavailableError(
      "could not load the provider manifests from TypeScript source — run " +
        "this half through `npm run drift:check`, which uses tsx " +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** The downstream's own annotation, as the report prints it. */
function downstreamClaim(tool) {
  const annotations = tool.annotations ?? {};
  const claims = [];
  if (annotations.readOnlyHint !== undefined)
    claims.push(`readOnlyHint: ${annotations.readOnlyHint}`);
  if (annotations.destructiveHint !== undefined)
    claims.push(`destructiveHint: ${annotations.destructiveHint}`);
  return claims.length ? claims.join(", ") : "no annotations";
}

/**
 * Whether the downstream explicitly contradicts a vetted verdict.
 *
 * The same rule `detectCatalogDrift()` counts with, restated here because the
 * runtime one deliberately cannot return a name. The totals are compared
 * afterwards, which is what keeps this restatement from drifting on its own.
 */
function contradicts(verdict, tool) {
  const annotations = tool.annotations ?? {};
  if (verdict === "read-only") {
    return (
      annotations.readOnlyHint === false || annotations.destructiveHint === true
    );
  }
  return annotations.readOnlyHint === true;
}

async function checkHostedProvider(provider, runtime, options) {
  const credential = HOSTED_CREDENTIALS[provider];
  const secret = process.env[credential.variable];
  if (!secret || !secret.trim()) {
    throw new UnavailableError(
      `${credential.variable} is not set — this check needs ${credential.hint}. ` +
        "Narrow the run with --provider or --specs if that is deliberate.",
    );
  }
  const connector = runtime.remoteMcp(`drift-${provider}`, {
    url: runtime.endpoints[provider],
    auth: {
      type: "headers",
      headers: { Authorization: hostedAuthorizationHeader(provider, secret) },
    },
    requireHttps: true,
  });
  const ctx = maintainerContext();
  let tools;
  try {
    tools = await connector.listTools(ctx);
  } catch (error) {
    throw new UnavailableError(
      `could not list ${provider}'s catalog with ${credential.variable}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    await connector.closeScope?.(ctx);
  }

  const catalog = runtime.catalogs[provider];
  const served = new Set(tools.map((tool) => tool.name));
  const added = [];
  const annotationConflicts = [];
  const schemaChanges = [];
  const digests = {};
  for (const tool of [...tools].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const record = catalog.tools.get(tool.name);
    if (!record) {
      added.push({ tool: tool.name, downstream: downstreamClaim(tool) });
      continue;
    }
    if (contradicts(record.verdict, tool)) {
      annotationConflicts.push({
        tool: tool.name,
        vetted: record.verdict,
        downstream: downstreamClaim(tool),
      });
    }
    const digest = await runtime.vettedSchemaDigest(tool);
    digests[tool.name] = digest;
    if (record.schemaDigest !== undefined && record.schemaDigest !== digest) {
      schemaChanges.push({ tool: tool.name, recorded: record.schemaDigest });
    }
  }
  const removed = [...catalog.tools.keys()]
    .filter((name) => !served.has(name))
    .sort();

  // Two readings of one manifest. If they disagree, one of them is wrong, and
  // finding that out here is cheaper than trusting either.
  const counts = await runtime.detectCatalogDrift(catalog, tools);
  const mine = {
    unclassifiedTools: added.length,
    unservedTools: removed.length,
    annotationConflicts: annotationConflicts.length,
    schemaChanges: schemaChanges.length,
  };
  const disagreement = Object.keys(mine).filter(
    (key) => mine[key] !== counts[key],
  );

  const recorded = [...catalog.tools.values()].some(
    (record) => record.schemaDigest !== undefined,
  );
  return {
    provider,
    endpoint: runtime.endpoints[provider],
    tools: tools.length,
    added,
    removed,
    annotationConflicts,
    schemaChanges,
    schemaDigestsRecorded: recorded,
    disagreement,
    ...(options.record ? { digests } : {}),
  };
}

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
// Reporting
// ---------------------------------------------------------------------------

function printHosted(result) {
  const header = `${result.provider} — ${result.tools} tools at ${result.endpoint}`;
  console.log(header);
  for (const { tool, downstream } of result.added) {
    console.log(`  added        ${tool} (${downstream})`);
  }
  for (const tool of result.removed) {
    console.log(`  removed      ${tool}`);
  }
  for (const { tool, vetted, downstream } of result.annotationConflicts) {
    console.log(`  conflict     ${tool} — vetted ${vetted}, downstream ${downstream}`);
  }
  for (const { tool, recorded } of result.schemaChanges) {
    console.log(`  schema       ${tool} — no longer ${recorded}`);
  }
  if (!result.schemaDigestsRecorded) {
    console.log(
      "  schema       not comparable — this manifest records no digests; " +
        "rerun with --record to print the block to paste into vettedCatalog()",
    );
  }
  if (result.disagreement.length > 0) {
    console.log(
      `  BUG          this check and detectCatalogDrift() disagree on: ${result.disagreement.join(", ")}`,
    );
  }
  if (result.digests) {
    console.log(`  schemaDigests: ${JSON.stringify(result.digests, null, 2)}`);
  }
  if (
    result.added.length +
      result.removed.length +
      result.annotationConflicts.length +
      result.schemaChanges.length ===
    0
  ) {
    console.log("  no drift");
  }
}

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

function findingCount(report) {
  let total = 0;
  for (const result of report.hosted) {
    total +=
      result.added.length +
      result.removed.length +
      result.annotationConflicts.length +
      result.schemaChanges.length +
      result.disagreement.length;
  }
  for (const result of report.specs) total += result.findings.length;
  return total;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = { hosted: [], specs: [] };

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

  if (options.hosted) {
    const providers = selected(options, HOSTED_PROVIDERS);
    if (providers.length > 0) {
      const missing = providers.filter(
        (provider) => !process.env[HOSTED_CREDENTIALS[provider].variable]?.trim(),
      );
      if (missing.length === providers.length && missing.length > 1) {
        // All of them at once is a maintainer who exported nothing, not one
        // stale key. Say so in a single message rather than one per provider.
        throw new UnavailableError(
          `no hosted credentials are set (${missing
            .map((provider) => HOSTED_CREDENTIALS[provider].variable)
            .join(", ")}). Run with --specs to check published specifications alone.`,
        );
      }
      const runtime = await loadHostedProviders();
      for (const provider of providers) {
        report.hosted.push(
          await checkHostedProvider(provider, runtime, options),
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
    for (const result of report.hosted) printHosted(result);
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
