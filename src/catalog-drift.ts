// Web-API only, like the rest of the core: a manifest comparison that ran on
// Node but not on Workers would leave half the deployments unable to tell a
// stale allowlist from a current one.
import { classifyTool } from "./tool-safety.js";
import { failureRecord, logFailure } from "./operator-record.js";
import type {
  CatalogDriftCounts,
  CatalogDriftReport,
  Connector,
  Logger,
  ReviewedTool,
  ToolAnnotations,
  ToolClassification,
  ToolDef,
  ToolVerdict,
} from "./types.js";

/** A count, or 0 when the seam returned something that is not one. */
function boundedCount(value: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

/** An ISO-8601 date-time with a zone, as `Date.parse` reads it on every runtime. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The report's time, re-serialized from the instant it names, so the string
 * that leaves is always connecta's own ISO-8601 UTC form, never the seam's.
 */
function observationTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/**
 * Rebuild a drift report as bounded counts and a canonical timestamp.
 *
 * `Connector.catalogDrift()` sits on the open plugin seam, and what it returns
 * lands in the body of unauthenticated `/health`, on connector status, in the
 * operator page, and in `connecta doctor`. TypeScript constrains neither an
 * extra enumerable property nor what `observedAt` holds at runtime, so "counts
 * and a time and nothing else" is *made* true here — at the boundary where
 * third-party output becomes a response — rather than trusted. A report whose
 * `observedAt` names no instant is no observation connecta can date, and is
 * dropped whole (INV-6): a plugin forwarding a downstream's report could
 * otherwise put any text there. The activity path reconstructs its five
 * fields for the same reason.
 */
export function boundedCatalogDrift(
  report: CatalogDriftReport | undefined,
): CatalogDriftReport | undefined {
  if (!report || typeof report !== "object") return undefined;
  const observedAt = observationTime(report.observedAt);
  if (observedAt === undefined) return undefined;
  return {
    observedAt,
    unclassifiedTools: boundedCount(report.unclassifiedTools),
    unservedTools: boundedCount(report.unservedTools),
    annotationConflicts: boundedCount(report.annotationConflicts),
    schemaChanges: boundedCount(report.schemaChanges),
    ...(boundedCount(report.droppedTools ?? 0) > 0
      ? { droppedTools: boundedCount(report.droppedTools ?? 0) }
      : {}),
  };
}

/**
 * What a release decided a tool does. `"read-only"` is observational;
 * `"destructive"` modifies or removes state that already exists; `"additive"`
 * only brings something new into being. Both writes leave the read-only path
 * — the distinction decides whether the connection asserts `destructiveHint`,
 * which shapes the approval copy a human reads.
 */
type VettedVerdict = "read-only" | "additive" | "destructive";

/** One tool as a release reviewed it. */
interface VettedToolRecord {
  verdict: VettedVerdict;
  /**
   * Digest of the input and output schemas that release read, or undefined
   * when no release has recorded them. Undefined is not "unchanged": a
   * manifest with no digest cannot report a schema change, and says so by
   * counting none. The credential-free provider check does not create or
   * update schema digests; the live `tools/list` response remains the schema
   * agents receive ([#351](https://github.com/zackbart/connecta/issues/351)).
   */
  schemaDigest?: string;
}

/**
 * The vetted manifest one hosted-MCP proxy ships: every tool name a release
 * reviewed, what it reviewed it as, and — where a release recorded them — the
 * schemas it read. This is the single per-provider source P13 asks for, so the
 * classification the connector applies and the classification a drift check
 * compares against cannot disagree.
 */
export interface VettedCatalog {
  /** Manifest format. Bumped when the comparison itself changes shape. */
  version: 1;
  tools: ReadonlyMap<string, VettedToolRecord>;
}

export interface VettedCatalogInput {
  /** Names whose contract is observational rather than mutating. */
  reads: ReadonlySet<string>;
  /** Names that write, with the verdict that shapes the approval copy. */
  writes: ReadonlyMap<string, "additive" | "destructive">;
  /**
   * Schemas this release reviewed, as `name` → digest from
   * {@link vettedSchemaDigest}. Omit entirely until a release has actually
   * read them; an invented digest reports drift that never happened.
   */
  schemaDigests?: Readonly<Record<string, string>>;
}

const encoder = new TextEncoder();

/**
 * Most JSON values one tool's schemas may hold before its digest refuses to
 * compute. A digest vouches for a whole schema or for nothing, so a schema
 * past the bound is not hashed in part: the computation throws, and the
 * caller serves every digested review unverified (INV-1).
 */
const MAX_SCHEMA_DIGEST_NODES = 100_000;

/** Object keys in the order `JSON.stringify` emits a key-sorted object. */
function canonicalKeys(value: object): [string, unknown][] {
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, item]) =>
      item !== undefined &&
      typeof item !== "function" &&
      typeof item !== "symbol",
  );
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // A plain object enumerates integer-like keys first, in numeric order.
  // Recorded digests were taken from a key-sorted object, so reproduce its
  // enumeration rather than the sort alone.
  const sorted = Object.fromEntries(entries);
  return Object.keys(sorted).map((key) => [key, sorted[key]]);
}

/**
 * Deterministic JSON with object keys sorted, so key order is not a schema
 * change. Iterative and complete: every leaf at every depth reaches the
 * digest, and a schema deeper than the host stack cannot exhaust it. Throws
 * past {@link MAX_SCHEMA_DIGEST_NODES}, and on any value JSON cannot carry.
 */
function canonicalJson(root: unknown): string {
  type Task = { readonly text: string } | { readonly value: unknown };
  const out: string[] = [];
  const stack: Task[] = [{ value: root }];
  let nodes = 0;
  while (stack.length > 0) {
    const task = stack.pop()!;
    if ("text" in task) {
      out.push(task.text);
      continue;
    }
    if (++nodes > MAX_SCHEMA_DIGEST_NODES) {
      throw new Error(
        `schema has more than ${MAX_SCHEMA_DIGEST_NODES} values; refusing to digest it in part.`,
      );
    }
    const value = task.value;
    if (value === null || value === undefined) {
      out.push("null");
    } else if (typeof value === "string" || typeof value === "boolean") {
      out.push(JSON.stringify(value));
    } else if (typeof value === "number") {
      out.push(Number.isFinite(value) ? JSON.stringify(value) : "null");
    } else if (typeof value === "function" || typeof value === "symbol") {
      // Only array items reach here; object keys holding these are dropped.
      out.push("null");
    } else if (typeof value !== "object") {
      throw new Error(`schema holds a ${typeof value}, which JSON cannot carry.`);
    } else if (Array.isArray(value)) {
      out.push("[");
      stack.push({ text: "]" });
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index] });
        if (index > 0) stack.push({ text: "," });
      }
    } else {
      out.push("{");
      stack.push({ text: "}" });
      const entries = canonicalKeys(value);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, item] = entries[index]!;
        stack.push({ value: item });
        stack.push({ text: `${index > 0 ? "," : ""}${JSON.stringify(key)}:` });
      }
    }
  }
  return out.join("");
}

/**
 * Digest the schemas of one downstream tool.
 *
 * Canonical rather than literal, unlike the catalog fingerprint in
 * `src/catalog-fingerprint.ts`: that one is deliberately conservative because a
 * spurious cache write is cheap, while a spurious drift finding spends a
 * maintainer's attention on a downstream that reordered its JSON keys.
 * Description and annotations are excluded — a reworded description is P1's
 * business, and an annotation change is already its own drift category.
 *
 * Rejects rather than digesting part of a schema: a digest that ignored some
 * leaf would let a reviewed read keep its verdict after that leaf changed.
 */
export async function vettedSchemaDigest(tool: ToolDef): Promise<string> {
  const bytes = encoder.encode(
    canonicalJson({
      inputSchema: tool.inputSchema ?? null,
      outputSchema: tool.outputSchema ?? null,
    }),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Build a provider's manifest from the lists it already maintains.
 *
 * Throws when a name is classified twice, because a tool that is both a read
 * and a write is a review mistake that must not boot: the annotation the
 * connector would apply depends on which branch runs first, and "safe by
 * default" cannot be decided by ordering.
 */
export function vettedCatalog(input: VettedCatalogInput): VettedCatalog {
  const tools = new Map<string, VettedToolRecord>();
  const digestFor = (name: string): string | undefined =>
    input.schemaDigests?.[name];
  for (const name of input.reads) {
    const digest = digestFor(name);
    tools.set(name, {
      verdict: "read-only",
      ...(digest !== undefined ? { schemaDigest: digest } : {}),
    });
  }
  for (const [name, verdict] of input.writes) {
    if (tools.has(name)) {
      throw new Error(
        `vettedCatalog() classified "${name}" as both a read and a write.`,
      );
    }
    const digest = digestFor(name);
    tools.set(name, {
      verdict,
      ...(digest !== undefined ? { schemaDigest: digest } : {}),
    });
  }
  for (const name of Object.keys(input.schemaDigests ?? {})) {
    if (!tools.has(name)) {
      throw new Error(
        `vettedCatalog() recorded a schema digest for unclassified tool "${name}".`,
      );
    }
  }
  return { version: 1, tools };
}

const VERDICTS: Readonly<Record<string, VettedVerdict>> = {
  read: "read-only",
  write: "additive",
  destructive: "destructive",
};
const PUBLIC_VERDICTS: Readonly<Record<VettedVerdict, ToolVerdict>> = {
  "read-only": "read",
  additive: "write",
  destructive: "destructive",
};
const SCHEMA_DIGEST = /^sha256:[0-9a-f]{64}$/;
const REVIEWED_TOOL_KEYS = new Set(["verdict", "reason", "schemaDigest"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a public {@link ToolClassification} once, reading every value a
 * single time, into the manifest the registry classifies with and a
 * deep-frozen copy of the record.
 *
 * Every structural mistake throws, naming `owner`, because a classification
 * that half-applies is worse than one that refuses to boot (INV-11). Unknown
 * keys throw too: a misspelled `verdict` must not quietly leave a write
 * unclassified.
 */
function parseClassification(
  classification: ToolClassification,
  owner: string,
): { catalog: VettedCatalog; frozen: ToolClassification } {
  function fail(detail: string): never {
    throw new Error(`[connecta] ${owner} classify ${detail}`);
  }
  if (!isRecord(classification)) fail("must be an object with a tools record.");
  for (const key of Object.keys(classification)) {
    if (key !== "tools") fail(`has unknown key "${key}"; only "tools" is accepted.`);
  }
  const input: unknown = classification.tools;
  if (!isRecord(input)) fail("tools must be a record of tool name to verdict.");
  const tools = new Map<string, VettedToolRecord>();
  const frozen: Record<string, ToolVerdict | ReviewedTool> = {};
  for (const [name, entry] of Object.entries(input)) {
    if (!name || name.trim() !== name) {
      fail(`tool name "${name}" is empty or has surrounding whitespace.`);
    }
    const record: Record<string, unknown> =
      typeof entry === "string" ? { verdict: entry } : isRecord(entry) ? { ...entry } : {};
    for (const key of Object.keys(record)) {
      if (!REVIEWED_TOOL_KEYS.has(key)) fail(`tool "${name}" has unknown key "${key}".`);
    }
    const { verdict: publicVerdict, reason, schemaDigest: digest } = record;
    const verdict =
      typeof publicVerdict === "string" && Object.hasOwn(VERDICTS, publicVerdict)
        ? VERDICTS[publicVerdict]
        : undefined;
    if (verdict === undefined) {
      fail(`tool "${name}" needs verdict "read", "write", or "destructive".`);
    }
    if (reason !== undefined && (typeof reason !== "string" || !reason.trim())) {
      fail(`tool "${name}" reason must be a non-empty string.`);
    }
    if (digest !== undefined && (typeof digest !== "string" || !SCHEMA_DIGEST.test(digest))) {
      fail(`tool "${name}" schemaDigest must be "sha256:" and 64 lowercase hex digits.`);
    }
    tools.set(name, {
      verdict,
      ...(typeof digest === "string" ? { schemaDigest: digest } : {}),
    });
    frozen[name] =
      typeof entry === "string"
        ? PUBLIC_VERDICTS[verdict]
        : Object.freeze({
            verdict: PUBLIC_VERDICTS[verdict],
            ...(typeof reason === "string" ? { reason } : {}),
            ...(typeof digest === "string" ? { schemaDigest: digest } : {}),
          });
  }
  return {
    catalog: { version: 1, tools },
    frozen: Object.freeze({ tools: Object.freeze(frozen) }),
  };
}

/** Validate a {@link ToolClassification} and build the manifest it describes. */
export function reviewedCatalog(
  classification: ToolClassification,
  owner: string,
): VettedCatalog {
  return parseClassification(classification, owner).catalog;
}

/**
 * Validate a {@link ToolClassification} and return a deep-frozen copy of it:
 * what a connector carries as `classification`, so neither the caller's
 * original object nor a write through the connector can change a verdict
 * after review.
 */
export function reviewedClassification(
  classification: ToolClassification,
  owner: string,
): ToolClassification {
  return parseClassification(classification, owner).frozen;
}

/** A legacy manifest in the public, deep-frozen form a connector carries. */
function classificationOf(catalog: VettedCatalog): ToolClassification {
  const tools: Record<string, ReviewedTool> = {};
  for (const [name, record] of catalog.tools) {
    tools[name] = Object.freeze({
      verdict: PUBLIC_VERDICTS[record.verdict],
      ...(record.schemaDigest !== undefined ? { schemaDigest: record.schemaDigest } : {}),
    });
  }
  return Object.freeze({ tools: Object.freeze(tools) });
}

/**
 * One reviewed tool as served: a fresh object, never one a connector, a
 * cache, or an earlier read holds.
 *
 * A listed read fills downstream silence, and an explicit write annotation on
 * it wins: `destructiveHint: true` or `readOnlyHint: false` on a classified
 * read is the downstream telling us the review is stale. A listed write or
 * destructive tool stays a write whatever the downstream claims; there
 * connecta knows what the tool does, and a claim to the contrary is a
 * downstream bug rather than news
 * ([#310](https://github.com/zackbart/connecta/issues/310),
 * [#315](https://github.com/zackbart/connecta/issues/315)). A tool no review
 * lists keeps only an explicit read annotation, the downstream's own word
 * being the only evidence there is. A reviewed tool whose recorded schema
 * digest the live tool no longer matches, or could not be checked against,
 * keeps no reviewed verdict and is a write.
 */
function servedTool(
  catalog: VettedCatalog,
  fact: ToolDef,
  lapsed: ReadonlySet<string>,
  override?: "read" | "write",
): ToolDef {
  const definition = structuredClone(fact);
  const reviewed = catalog.tools.get(fact.name);
  definition.classification = classifyTool(fact, override, reviewed ? {
    verdict: PUBLIC_VERDICTS[reviewed.verdict], stale: lapsed.has(fact.name),
  } : undefined);
  const downstream = definition.annotations ?? {};
  const record = catalog.tools.get(definition.name);
  const annotate = (annotations: ToolAnnotations): ToolDef => ({
    ...definition,
    annotations: override === undefined ? annotations : { ...annotations,
      readOnlyHint: override === "read", destructiveHint: override === "write",
    },
  });
  if (record?.verdict === "destructive") {
    return annotate({ ...downstream, readOnlyHint: false, destructiveHint: true });
  }
  if (record && lapsed.has(definition.name)) {
    // A review vouches for the schema it read. When the live schema no longer
    // matches that digest, or the digest could not be checked, the verdict is
    // about some other tool: the read becomes a write until a release reviews
    // it again (INV-1).
    return annotate({ ...downstream, readOnlyHint: false });
  }
  if (record?.verdict === "read-only") {
    if (downstream.destructiveHint === true || downstream.readOnlyHint === false) {
      return annotate(downstream);
    }
    return annotate({
      ...downstream,
      readOnlyHint: true,
      destructiveHint: downstream.destructiveHint ?? false,
    });
  }
  if (record?.verdict === "additive") {
    return annotate({ ...downstream, readOnlyHint: false });
  }
  // Fill-in only: a silent tool is not read-only, so drift fails closed onto
  // `call_destructive_tool`, and it gets no `destructiveHint` it has not
  // earned. An explicit read claim on a name no review lists is believed.
  return annotate({ ...downstream, readOnlyHint: downstream.readOnlyHint ?? false });
}

/**
 * Whether the downstream's own annotation contradicts what a release reviewed.
 *
 * Only an *explicit* contradiction counts. Silence is the ordinary case the
 * classification exists to fill, and an unclassified tool is already counted
 * as an addition rather than twice.
 */
function contradicts(record: VettedToolRecord, definition: ToolDef): boolean {
  const downstream = definition.annotations ?? {};
  if (record.verdict === "read-only") {
    return (
      downstream.readOnlyHint === false || downstream.destructiveHint === true
    );
  }
  return downstream.readOnlyHint === true;
}

/**
 * Names of served tools whose schemas no longer match the digest a release
 * recorded for them. A manifest that recorded no digest for a tool cannot have
 * an opinion about its schema, so it does not pay for a hash either. Throws
 * when a digest cannot be computed; the caller decides what that means.
 */
async function changedSchemas(
  catalog: VettedCatalog,
  tools: readonly ToolDef[],
): Promise<Set<string>> {
  const changed = new Set<string>();
  for (const definition of tools) {
    const recorded = catalog.tools.get(definition.name)?.schemaDigest;
    if (
      recorded !== undefined &&
      recorded !== (await vettedSchemaDigest(definition))
    ) {
      changed.add(definition.name);
    }
  }
  return changed;
}

/** Every served tool whose review recorded a digest: what cannot be verified. */
function digestedTools(
  catalog: VettedCatalog,
  tools: readonly ToolDef[],
): Set<string> {
  return new Set(
    tools
      .filter((definition) => catalog.tools.get(definition.name)?.schemaDigest !== undefined)
      .map((definition) => definition.name),
  );
}

function countDrift(
  catalog: VettedCatalog,
  tools: readonly ToolDef[],
  changed: ReadonlySet<string>,
): CatalogDriftCounts {
  let unclassifiedTools = 0;
  let annotationConflicts = 0;
  const served = new Set<string>();
  for (const definition of tools) {
    served.add(definition.name);
    const record = catalog.tools.get(definition.name);
    if (!record) {
      unclassifiedTools += 1;
      continue;
    }
    if (contradicts(record, definition)) annotationConflicts += 1;
  }
  let unservedTools = 0;
  for (const name of catalog.tools.keys()) {
    if (!served.has(name)) unservedTools += 1;
  }
  return {
    unclassifiedTools,
    unservedTools,
    annotationConflicts,
    schemaChanges: changed.size,
  };
}

/**
 * Compare a live catalog with the manifest and count what moved.
 *
 * Counts only, and by construction: there is nowhere here to put a tool name,
 * a schema, or a downstream string, so no later surface has to remember to
 * strip one. Reads nothing but the tools it was handed — the caller already
 * fetched them to serve a request, and this function never fetches anything.
 */
export async function detectCatalogDrift(
  catalog: VettedCatalog,
  tools: readonly ToolDef[],
): Promise<CatalogDriftCounts> {
  return countDrift(catalog, tools, await changedSchemas(catalog, tools));
}

/**
 * Give a hosted-MCP connector its vetted manifest as a `classification`: the
 * review the registry classifies every read with and counts drift against.
 * The connector itself is unchanged, and its `listTools` still returns what
 * the downstream said.
 *
 * Retained for the hosted providers that have not converted to
 * `remoteMcp({ classify })` yet (#705); it is deleted with the last of them.
 */
export function withVettedCatalog(
  connector: Connector,
  catalog: VettedCatalog,
): Connector {
  return { ...connector, classification: classificationOf(catalog) };
}

/**
 * Each connector object's review, validated the first time a registry reads
 * it. Read once per object, so a getter or a record mutated later cannot
 * hand a later registry (a principal's, say) a different review.
 */
const reviews = new WeakMap<Connector, VettedCatalog | null>();

/**
 * The review `connector.classification` declares, or undefined when it
 * declares none. Throws on a malformed one (INV-11).
 */
export function catalogReviewOf(connector: Connector): VettedCatalog | undefined {
  let review = reviews.get(connector);
  if (review === undefined) {
    const classification = connector.classification;
    review =
      classification === undefined
        ? null
        : reviewedCatalog(classification, `connector "${connector.id}"`);
    reviews.set(connector, review);
  }
  return review ?? undefined;
}

/**
 * Classify downstream facts with a review: what the registry serves on every
 * read, from whichever cache layer the facts came from.
 *
 * Every tool returned is a fresh object, so nothing a caller does to one can
 * reach the facts, `memo`, or a later read. `memo` holds digest verification
 * per facts array; the registry passes one only for deep-frozen arrays it
 * owns. A failed verification is not kept, so the next read tries again, and
 * meanwhile no digested review vouches for a read (INV-1).
 */
export async function classifyCatalog(
  catalog: VettedCatalog,
  connectorId: string,
  facts: readonly ToolDef[],
  logger: Logger,
  memo?: WeakMap<readonly ToolDef[], ReadonlySet<string>>,
  overrides?: Readonly<Record<string, "read" | "write">>,
): Promise<ToolDef[]> {
  let lapsed = memo?.get(facts);
  if (!lapsed) {
    try {
      lapsed = await changedSchemas(catalog, facts);
      memo?.set(facts, lapsed);
    } catch (error) {
      lapsed = digestedTools(catalog, facts);
      logFailure(
        logger,
        "schema digest check failed; serving digested reviews as writes",
        failureRecord({ connector: connectorId }, error),
      );
    }
  }
  const unverified = lapsed;
  return facts.map((fact) => servedTool(catalog, fact, unverified, overrides?.[fact.name]));
}

/**
 * The drift each reviewed connector object showed on its last listing in this
 * runtime. Keyed by the connector rather than by registry, so a principal's
 * registry and the root report one observation, as they serve one connector.
 */
const observations = new WeakMap<Connector, CatalogDriftReport>();

/**
 * Compare a listing a refresh just received with the connector's review, and
 * keep the counts as its latest observation.
 *
 * The check happens where the tools are already in hand, while serving a
 * refresh the deployment asked for. It adds no request of its own, which is
 * the whole boundary: connecta watches a contract while it is serving a
 * refresh, and never initiates one to go looking
 * ([#179](https://github.com/zackbart/connecta/issues/179),
 * [#343](https://github.com/zackbart/connecta/issues/343)).
 */
export async function observeReviewedDrift(
  connector: Connector,
  catalog: VettedCatalog,
  listed: readonly ToolDef[],
  logger: Logger,
): Promise<void> {
  try {
    const changed = await changedSchemas(catalog, listed);
    observations.set(connector, {
      observedAt: new Date().toISOString(),
      ...countDrift(catalog, listed, changed),
    });
  } catch (error) {
    // A drift check is a report about a catalog, never a condition for
    // serving one. Keep the last good observation rather than replacing it
    // with a lie, and let the refresh through; classification fails closed.
    logFailure(logger, "catalog drift check failed", failureRecord({ connector: connector.id }, error));
  }
}

/** The latest drift {@link observeReviewedDrift} kept for `connector`. */
export function observedCatalogDrift(
  connector: Connector,
): CatalogDriftReport | undefined {
  return observations.get(connector);
}
