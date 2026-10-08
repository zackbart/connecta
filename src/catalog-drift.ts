// Web-API only, like the rest of the core: a manifest comparison that ran on
// Node but not on Workers would leave half the deployments unable to tell a
// stale allowlist from a current one.
import { failureRecord, logFailure } from "./operator-record.js";
import type {
  CatalogDriftCounts,
  CatalogDriftReport,
  Connector,
  ConnectorContext,
  Logger,
  ToolClassification,
  ToolDef,
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
 * Rebuild a drift report as four counts and a canonical timestamp.
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
const SCHEMA_DIGEST = /^sha256:[0-9a-f]{64}$/;
const REVIEWED_TOOL_KEYS = new Set(["verdict", "reason", "schemaDigest"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a public {@link ToolClassification} and build the manifest that
 * classifies live tools and counts their drift.
 *
 * Every structural mistake throws, naming `owner`, because a classification
 * that half-applies is worse than one that refuses to boot (INV-11). Unknown
 * keys throw too: a misspelled `verdict` must not quietly leave a write
 * unclassified.
 */
export function reviewedCatalog(
  classification: ToolClassification,
  owner: string,
): VettedCatalog {
  function fail(detail: string): never {
    throw new Error(`[connecta] ${owner} classify ${detail}`);
  }
  if (!isRecord(classification)) fail("must be an object with a tools record.");
  for (const key of Object.keys(classification)) {
    if (key !== "tools") fail(`has unknown key "${key}"; only "tools" is accepted.`);
  }
  if (!isRecord(classification.tools)) fail("tools must be a record of tool name to verdict.");
  const tools = new Map<string, VettedToolRecord>();
  for (const [name, entry] of Object.entries(classification.tools)) {
    if (!name || name.trim() !== name) {
      fail(`tool name "${name}" is empty or has surrounding whitespace.`);
    }
    const record: Record<string, unknown> =
      typeof entry === "string" ? { verdict: entry } : isRecord(entry) ? entry : {};
    for (const key of Object.keys(record)) {
      if (!REVIEWED_TOOL_KEYS.has(key)) fail(`tool "${name}" has unknown key "${key}".`);
    }
    const verdict =
      typeof record.verdict === "string" && Object.hasOwn(VERDICTS, record.verdict)
        ? VERDICTS[record.verdict]
        : undefined;
    if (verdict === undefined) {
      fail(`tool "${name}" needs verdict "read", "write", or "destructive".`);
    }
    if (
      record.reason !== undefined &&
      (typeof record.reason !== "string" || !record.reason.trim())
    ) {
      fail(`tool "${name}" reason must be a non-empty string.`);
    }
    const digest = record.schemaDigest;
    if (digest !== undefined && (typeof digest !== "string" || !SCHEMA_DIGEST.test(digest))) {
      fail(`tool "${name}" schemaDigest must be "sha256:" and 64 lowercase hex digits.`);
    }
    tools.set(name, {
      verdict: verdict as VettedVerdict,
      ...(typeof digest === "string" ? { schemaDigest: digest } : {}),
    });
  }
  return { version: 1, tools };
}

/**
 * Fill in downstream silence; keep reviewed destructive tools fail-closed.
 *
 * Silence is what a vetted classification is for, and an explicit downstream
 * annotation otherwise wins in both directions. `destructiveHint: true` or
 * `readOnlyHint: false` on a classified read is the downstream telling us this
 * release's allowlist is stale; `readOnlyHint: true` on a name no release has
 * classified says the same thing from the other side. The single place a
 * vetted verdict still overrides the downstream is a name this release
 * reviewed and filed destructive: there connecta knows what the tool does, and
 * a claim to the contrary is a downstream bug rather than news
 * ([#310](https://github.com/zackbart/connecta/issues/310),
 * [#315](https://github.com/zackbart/connecta/issues/315)).
 *
 * A reviewed tool whose recorded schema digest the live tool no longer
 * matches, or could not be checked against, keeps no reviewed verdict: it is
 * served as a write on both wrappers.
 *
 * `reviewedWritesWin` extends that override to reviewed additive writes, which
 * `remoteMcp({ classify })` always sets: a review that filed a tool as a write
 * outranks a downstream read claim. The legacy `withVettedCatalog()` wrapper
 * keeps the older fill-in rule until its providers convert (#705).
 */
function applyVettedSafety(
  catalog: VettedCatalog,
  definition: ToolDef,
  reviewedWritesWin: boolean,
  unverified: ReadonlySet<string>,
): ToolDef {
  const downstream = definition.annotations ?? {};
  const record = catalog.tools.get(definition.name);
  if (record?.verdict !== "destructive" && unverified.has(definition.name)) {
    // A review vouches for the schema it read. When the live schema no longer
    // matches that digest, or the digest could not be checked, the verdict is
    // about some other tool: the read becomes a write until a release reviews
    // it again (INV-1). A reviewed destructive tool is already closed below.
    return {
      ...definition,
      annotations: { ...downstream, readOnlyHint: false },
    };
  }
  if (record?.verdict === "read-only") {
    if (
      downstream.destructiveHint === true ||
      downstream.readOnlyHint === false
    ) {
      return definition;
    }
    return {
      ...definition,
      annotations: {
        ...downstream,
        readOnlyHint: true,
        destructiveHint: downstream.destructiveHint ?? false,
      },
    };
  }
  if (record?.verdict === "destructive") {
    return {
      ...definition,
      annotations: {
        ...downstream,
        readOnlyHint: false,
        destructiveHint: true,
      },
    };
  }
  if (record?.verdict === "additive" && reviewedWritesWin) {
    return {
      ...definition,
      annotations: { ...downstream, readOnlyHint: false },
    };
  }
  // Maintained additive creates and tools this release has never seen land
  // here alike. Fill-in only: a silent tool is not read-only, so drift still
  // fails closed onto `call_destructive_tool`, and neither population gets a
  // `destructiveHint` it has not earned. A tool that arrives explicitly
  // read-only keeps that annotation — on a name no release has reviewed, the
  // downstream's own word is the only evidence there is, and rewriting it
  // would be an overrule rather than a fill-in.
  return {
    ...definition,
    annotations: {
      ...downstream,
      readOnlyHint: downstream.readOnlyHint ?? false,
    },
  };
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
 * Wrap a hosted-MCP connector in its vetted manifest: the classification the
 * catalog is normalized with, and the drift check that rides the same listing.
 *
 * Retained for the hosted providers that have not converted to
 * `remoteMcp({ classify })` yet (#705); it is deleted with the last of them.
 */
export function withVettedCatalog(
  connector: Connector,
  catalog: VettedCatalog,
): Connector {
  return observedCatalog(connector, catalog, false);
}

/** The `remoteMcp({ classify })` wrapper: reviewed writes always stay writes. */
export function withReviewedCatalog(
  connector: Connector,
  catalog: VettedCatalog,
): Connector {
  return observedCatalog(connector, catalog, true);
}

/**
 * How the registry keeps a wrapped connector's safety out of its caches.
 *
 * A classification is derived from the downstream listing and the reviewed
 * manifest this process runs, so it is never stored: the registry lists
 * through the connector's current `listTools` (a decorator that filters or
 * augments it is respected), keeps only the {@link facts} behind that listing
 * in both cache layers, and every read runs {@link classify} with the
 * classifier that is current then. A catalog cached under an older manifest,
 * or by an older release, therefore gets no say in what is a read.
 */
export interface CatalogClassifier {
  /**
   * The downstream facts behind a listing this connector's `listTools`
   * served, directly or through a decorator: every tool this classifier
   * produced is traced back to what the downstream said. A tool a decorator
   * rebuilt cannot be traced, so its read-only claim on a reviewed name, the
   * one hint this classifier adds, is dropped; the next read decides it again.
   */
  facts(tools: readonly ToolDef[]): ToolDef[];
  /** The current classification of facts from any cache layer. */
  classify(tools: readonly ToolDef[], logger: Logger): Promise<ToolDef[]>;
}

/**
 * Where a vetted wrapper carries its classifier: an enumerable own property
 * under a symbol no other module holds, so a decorator's `{ ...connector }`
 * copies it, nothing outside connecta can forge it, and the registry finds it
 * whatever `listTools` the decorator put in front of the wrapper's own.
 */
const CATALOG_CLASSIFIER = Symbol("connecta.catalogClassifier");

type ClassifiedConnector = Connector & {
  readonly [CATALOG_CLASSIFIER]?: CatalogClassifier;
};

/** The classifier a vetted wrapper attached to `connector`, or its copies. */
export function catalogClassifierOf(
  connector: Connector,
): CatalogClassifier | undefined {
  return (connector as ClassifiedConnector)[CATALOG_CLASSIFIER];
}

/**
 * Classify a listing and observe its drift.
 *
 * The check happens where the tools are already in hand and still unmodified —
 * after the downstream answered, before the classification is applied. It adds
 * no request of its own, which is the whole boundary: connecta watches a
 * contract while it is serving a refresh the deployment asked for, and never
 * initiates one to go looking ([#179](https://github.com/zackbart/connecta/issues/179),
 * [#343](https://github.com/zackbart/connecta/issues/343)).
 */
function observedCatalog(
  connector: Connector,
  catalog: VettedCatalog,
  reviewedWritesWin: boolean,
): Connector {
  if (catalogClassifierOf(connector)) {
    // The inner classification would reach this one as downstream facts,
    // and its verdicts would be cached as if a downstream had said them.
    throw new Error(
      `[connecta] connector "${connector.id}" is already classified; wrap the unclassified connector once.`,
    );
  }
  let observed: CatalogDriftReport | undefined;
  // Digest verification per listing, held only as long as the listing is.
  // A failed verification is not kept, so the next read tries again.
  const verified = new WeakMap<readonly ToolDef[], ReadonlySet<string>>();
  const classified = new WeakMap<readonly ToolDef[], ToolDef[]>();
  // What each classified listing, tool, and annotations object was derived
  // from, so facts() can hand back the downstream's own words.
  const factsOfListing = new WeakMap<readonly ToolDef[], readonly ToolDef[]>();
  const factsOfTool = new WeakMap<ToolDef, ToolDef>();
  const factsOfAnnotations = new WeakMap<object, ToolDef>();

  async function list(ctx: ConnectorContext): Promise<ToolDef[]> {
    const downstream = await connector.listTools(ctx);
    try {
      const changed = await changedSchemas(catalog, downstream);
      verified.set(downstream, changed);
      observed = {
        observedAt: new Date().toISOString(),
        ...countDrift(catalog, downstream, changed),
      };
    } catch (error) {
      // A drift check is a report about a catalog, never a condition for
      // serving one. Keep the last good observation rather than replacing it
      // with a lie, and let the refresh through; classify() fails closed.
      ctx.logger.warn(
        `[connecta] connector "${connector.id}" catalog drift check failed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    return downstream;
  }

  async function classify(
    tools: readonly ToolDef[],
    logger: Logger,
  ): Promise<ToolDef[]> {
    const done = classified.get(tools);
    if (done) return done;
    let unverified = verified.get(tools);
    let settled = unverified !== undefined;
    if (!unverified) {
      try {
        unverified = await changedSchemas(catalog, tools);
        settled = true;
      } catch (error) {
        // With the schemas uncheckable, no digested review vouches for a
        // read (INV-1).
        unverified = digestedTools(catalog, tools);
        logFailure(logger, "schema digest check failed; serving digested reviews as writes", failureRecord({ connector: connector.id }, error));
      }
    }
    const result = tools.map((definition) => {
      const served = applyVettedSafety(catalog, definition, reviewedWritesWin, unverified);
      factsOfTool.set(served, definition);
      if (served.annotations) factsOfAnnotations.set(served.annotations, definition);
      return served;
    });
    factsOfListing.set(result, tools);
    if (settled) classified.set(tools, result);
    return result;
  }

  function facts(tools: readonly ToolDef[]): ToolDef[] {
    // The listing itself, so its digest verification is reused on read.
    const listing = factsOfListing.get(tools);
    if (listing) return listing as ToolDef[];
    return tools.map((tool) => {
      const traced = factsOfTool.get(tool);
      if (traced) return traced;
      // A decorator that copied the tool but kept its annotations object
      // changed something else; restore the downstream's annotations.
      const behind = tool.annotations && factsOfAnnotations.get(tool.annotations);
      if (behind) {
        const { annotations: _served, ...rest } = tool;
        return behind.annotations ? { ...rest, annotations: behind.annotations } : rest;
      }
      if (tool.annotations?.readOnlyHint !== true || !catalog.tools.has(tool.name)) {
        // Every other hint this classifier adds closes a path, and an
        // unreviewed name's read-only claim is never one it added.
        return tool;
      }
      const { readOnlyHint: _claimed, ...annotations } = tool.annotations;
      return { ...tool, annotations };
    });
  }

  async function listTools(ctx: ConnectorContext): Promise<ToolDef[]> {
    return classify(await list(ctx), ctx.logger);
  }
  const wrapped: ClassifiedConnector = {
    ...connector,
    listTools,
    catalogDrift(): CatalogDriftReport | undefined {
      return observed;
    },
    [CATALOG_CLASSIFIER]: { facts, classify },
  };
  return wrapped;
}
