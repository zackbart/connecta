import { USAGE_SKILL } from "./usage-guide.js";
import { boundedEchoText, ConnectorCallError } from "./errors.js";
import { Effect } from "effect";
import { runEdge, withDeadlineEffect } from "./runtime/run.js";
import { closeScopeOnExit } from "./runtime/connector-scope.js";
import { sentSecretsForRequest } from "./sent-secrets.js";
import type { RegistryView } from "./registry.js";
import type { DeferredWork } from "./connector-scope.js";
import type { Connector, ConnectorContext, ConnectorSkill, ConnectorSkillResourceContents } from "./types.js";

const ROUTE =
  "Choose a route before discovery. One known-address read uses call_tool; one known-address write uses call_destructive_tool. Unknown-address read-only work starts with execute_code to discover, call, and return the answer; use the same route for reduction, multiple or dependent calls, loops, joins, or branches. Keep discovery and calls together when schemas suffice; do not return catalog matches alone. Sample unfamiliar reads.";
const RECOVERY =
  'After auth_required use authorize_connector. After a truncated direct result use connecta.result. Guidance is on demand: fetch skills({ name: "usage" }) only when these instructions and the tool description are insufficient or a run needs repair.';

/**
 * The always-loaded MCP `instructions` string. A program runs reads and the
 * writes in trusted pools; a read-only pool routes every write to top-level
 * call_destructive_tool, where the host's permission prompt is the approval.
 */
export const CONNECTA_INSTRUCTIONS = `${ROUTE} Programs call reads in read-only pools and may also write in trusted pools. The execute_code description names this endpoint's trust. In a read-only pool, discover writes with search_tools then use call_destructive_tool. Never repeat a write to recover its output. ${RECOVERY}`;

export { USAGE_SKILL } from "./usage-guide.js";

/** True when at least one of `connectors` carries a usage guide. */
export function hasConnectorGuides(connectors: readonly Connector[]): boolean {
  return connectors.some(
    (connector) => connectorGuide(connector) !== undefined,
  );
}

/**
 * The built-in usage guide is byte-identical across deployments, so an agent
 * that has read it once in a task never needs an equivalent deployment-local
 * copy. Guide-free deployments still pay no fixed tool-description cost: the
 * conditional notes in meta-tools.ts remain absent.
 */
function usageSkill(): string {
  return USAGE_SKILL;
}

const INVESTIGATE_SKILL = `---
name: investigate
description: Plan purchase verification, experiment checks, and customer or deployment investigations across services; resolve scope and capability limits before querying.
---

# Investigate across services

## Plan the investigation

Start from the user's question and the evidence that would answer it. Select the app, account, and environment from connector titles, purposes, and relevant guides before looking up records. Reuse verified ids within the task; never carry an id across connectors just because its name matches.

- Purchase verification: resolve the same customer and environment across payment, subscription access, and analytics. Check each separately; a recorded payment does not prove access, and a missing analytics event does not prove payment failure.
- Experiment checks: confirm the project, experiment, time window, and exposure population before comparing outcomes. Return the requested comparison and any missing evidence; do not expand into an unrelated analytics audit.
- Customer or deployment investigations: locate the exact customer or deployment first, then follow only the records needed to explain the reported symptom. Use provider links or ids so the answer can be checked.

Establish capability limits early. A partial search is not proof that a tool is absent, and an unavailable catalog is not an empty dataset. Try a scoped search for the missing operation, inspect its guide when relevant, and distinguish unsupported work from missing data or authorization. If the required evidence is unavailable, return what was verified and the specific gap instead of approximating a different question through repeated calls.

A host transport error that requires reconnecting this MCP server cannot be repaired by a downstream tool. Reconnect in the host; do not repeatedly call \`authorize_connector\` through the failed connection.

Return the answer first, then the evidence and any unresolved gap. Include the app/environment, time window, and source ids or links needed to check it. Separate observed facts from inferences. Stop when the requested evidence is sufficient.
`;

const AVAILABLE_SKILLS = [
  {
    name: "usage",
    description:
      "How to route work between one execute_code program and Connecta's explicit call, authorization, and result tools.",
    content: usageSkill,
  },
  {
    name: "investigate",
    description: "Plan purchase verification, experiment checks, and customer or deployment investigations across services; resolve scope and capability limits before querying.",
    content: () => INVESTIGATE_SKILL,
  },
] as const;

/**
 * Namespace for operator-authored per-connector guides. Built-in skill names
 * are bare identifiers and never contain ":", so `connector:<id>` cannot
 * collide with one — not even when a connector's id is literally "usage".
 * Canonical skill URIs and the prefixed compatibility alias reach connector
 * guides. A bare connector id never resolves, so nothing shadows silently.
 */
const CONNECTOR_SKILL_PREFIX = "connector:";

/** The skill name that fetches `connector`'s guide. */
export function connectorSkillName(connectorId: string): string {
  return `${CONNECTOR_SKILL_PREFIX}${connectorId}`;
}

/** The connector's guide, or undefined when it declares none (or a blank one). */
export function connectorGuide(connector: Connector): string | undefined {
  const guide = connector.usageGuide;
  const content = typeof guide === "string" ? guide : guide?.content;
  return content && content.trim() !== "" ? content : undefined;
}

/** Discovery budget for one connector-guide summary, including an ellipsis. */
export const GUIDE_SUMMARY_LENGTH = 120;

/** A `---`/`***`/`___` rule, which also opens and closes YAML frontmatter. */
const RULE_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** A fenced code block's delimiter. */
const FENCE_RE = /^\s*(?:```|~~~)/;

/** Markdown blocks that end a paragraph without a blank physical line. */
const HEADING_RE = /^\s*#{1,6}/;
const LIST_ITEM_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/;
const SETEXT_UNDERLINE_RE = /^\s*=+\s*$/;
const TABLE_DELIMITER_RE =
  /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const OPENS_CLAUSE_RE = /^(?:The|A|An)\b/u;
const ARTICLE_RE = /^(?:the|a|an)\b/u;

/**
 * Markup that carries no summary text of its own: horizontal rules, HTML
 * comments, and table rows. Skipped so a guide that opens with one is
 * summarized by its first real line instead of by punctuation.
 */
const NOT_SUMMARY_RE = /^\s*(?:<!--|\|)|^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** A standard Markdown table starts with a pipe-bearing row and delimiter. */
function startsTable(lines: string[], index: number): boolean {
  const header = lines[index] ?? "";
  const delimiter = lines[index + 1] ?? "";
  return header.includes("|") && TABLE_DELIMITER_RE.test(delimiter);
}

/** True when a sentence-looking period belongs to an abbreviation. */
function isAbbreviation(text: string, end: number): boolean {
  const token = text.slice(0, end).match(/\S+$/u)?.[0] ?? "";
  // These introduce an example or restatement even before a capitalized word.
  if (/^(?:e\.g|i\.e)\.$/iu.test(token)) return true;
  // An initial or title belongs to the proper name that follows it.
  if (/^[A-Z]\.$/u.test(token)) return true;
  if (/^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St)\.$/iu.test(token)) return true;

  if (
    !/^(?:[A-Za-z]\.){2,}$/u.test(token) &&
    !/^(?:vs|etc|approx|dept|fig|no)\.$/iu.test(token)
  ) {
    return false;
  }

  // Initialisms can end a sentence or extend a name ("U.S. East region").
  // The mistakes are asymmetric: a false ending presents a fragment as a
  // complete thought, while a missed ending gets an honest ellipsis. Count
  // the period only with narrow evidence of a new clause: an article in one
  // of its first two words. This is grammar evidence, not a starter-word list.
  const following = text
    .slice(end)
    .match(/^[)\]}'"”’]*\s+(\S+)(?:\s+(\S+))?/u);
  if (!following) return false;
  const [, nextWord, afterNext] = following;
  const startsClause =
    nextWord !== undefined &&
    /^\p{Lu}/u.test(nextWord) &&
    (OPENS_CLAUSE_RE.test(nextWord) ||
      (afterNext !== undefined && ARTICLE_RE.test(afterNext)));
  return !startsClause;
}

/** Drop a leading YAML frontmatter block — metadata, not summary text. */
function withoutFrontmatter(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && (lines[start] ?? "").trim() === "") start++;
  const openingRule = lines[start];
  if (openingRule === undefined || !RULE_RE.test(openingRule)) return lines;
  const close = lines.findIndex((line, i) => i > start && RULE_RE.test(line));
  return close === -1 ? lines : lines.slice(close + 1);
}

/** Normalize authored and derived summaries under one construction contract. */
export function normalizeGuideSummary(summary: string): string | undefined {
  const normalized = summary.replace(/\s+/g, " ").trim();
  return normalized === "" ? undefined : normalized;
}

/**
 * Shorten a normalized summary at the strongest readable boundary available.
 * A complete sentence needs no ellipsis; clause and word cuts do, so discovery
 * never presents an unfinished fragment as the guide's complete thought.
 */
function boundedSummary(summary: string): string | undefined {
  const normalized = normalizeGuideSummary(summary);
  if (!normalized) return undefined;
  if (normalized.length <= GUIDE_SUMMARY_LENGTH) return normalized;

  const contentBudget = GUIDE_SUMMARY_LENGTH - 1;
  let sentenceEnd = 0;
  const sentenceBoundary = /[.!?…。！？](?:[)\]}'"”’]+)?(?=\s|$)/gu;
  for (const match of normalized.matchAll(sentenceBoundary)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end > GUIDE_SUMMARY_LENGTH) break;
    const punctuationEnd = (match.index ?? 0) + 1;
    if (
      match[0].startsWith(".") &&
      isAbbreviation(normalized, punctuationEnd)
    ) {
      continue;
    }
    // Do not mistake another short fragment for a useful complete thought.
    if (end >= 24) sentenceEnd = end;
  }
  if (sentenceEnd > 0) return normalized.slice(0, sentenceEnd);

  const available = normalized.slice(0, contentBudget);
  let clauseEnd = 0;
  const clauseBoundary = /[,;:](?=\s)|\s[—–-](?=\s)/g;
  for (const match of available.matchAll(clauseBoundary)) {
    const end = match.index ?? 0;
    // Prefer a clause only when it retains most of the discovery budget.
    if (end >= 80) clauseEnd = end;
  }
  if (clauseEnd > 0) {
    return `${available.slice(0, clauseEnd).trimEnd()}…`;
  }

  const wordEnd = available.search(/\s+\S*$/);
  if (wordEnd > 0) {
    const prefix = available
      .slice(0, wordEnd)
      .trimEnd()
      .replace(/[,;:([{—–-]+$/u, "")
      .trimEnd();
    if (prefix !== "") return `${prefix}…`;
  }

  let hardEnd = contentBudget;
  const code = normalized.charCodeAt(hardEnd - 1);
  if (code >= 0xd800 && code <= 0xdbff) hardEnd--;
  return `${normalized.slice(0, hardEnd)}…`;
}

/**
 * One thought describing a guide for the cheap list view: the first meaningful
 * paragraph, joined across physical lines, with headings and the connector
 * description as fallbacks when the guide opens with markup alone.
 */
function summarizeGuide(connector: Connector, guide: string): string {
  const lines = withoutFrontmatter(guide.split("\n"));
  let inFence = false;
  let inComment = false;
  let headingFallback: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    if (inComment) {
      if (raw.includes("-->")) inComment = false;
      continue;
    }
    if (FENCE_RE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (raw.trimStart().startsWith("<!--")) {
      if (!raw.includes("-->")) inComment = true;
      continue;
    }
    if (startsTable(lines, index)) {
      index++;
      while (
        index + 1 < lines.length &&
        (lines[index + 1] ?? "").includes("|")
      ) {
        index++;
      }
      continue;
    }
    if (raw.trim() === "" || NOT_SUMMARY_RE.test(raw)) continue;
    const heading = HEADING_RE.test(raw);
    const line = raw
      // `\s*` (not `\s+`) so a bare `#` strips to nothing and is skipped, and
      // an unspaced `#Heading` is still read as a heading.
      .replace(/^\s*#{1,6}\s*/, "")
      .replace(/^\s*[-*+]\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line === "") continue;
    if (heading) {
      headingFallback ??= boundedSummary(line);
      continue;
    }

    const paragraph = [line];
    while (index + 1 < lines.length) {
      const next = lines[index + 1] ?? "";
      if (
        next.trim() === "" ||
        startsTable(lines, index + 1) ||
        FENCE_RE.test(next) ||
        HEADING_RE.test(next) ||
        LIST_ITEM_RE.test(next) ||
        SETEXT_UNDERLINE_RE.test(next) ||
        NOT_SUMMARY_RE.test(next)
      ) {
        break;
      }
      paragraph.push(next.trim());
      index++;
      if (paragraph.join(" ").length > GUIDE_SUMMARY_LENGTH) break;
    }
    return boundedSummary(paragraph.join(" ")) ?? line;
  }
  if (headingFallback) return headingFallback;
  const fallback = connector.description ?? `Usage guide for "${connector.id}".`;
  return boundedSummary(fallback) ?? `Usage guide for "${connector.id}".`;
}

/** Bounded, decision-useful discovery summary for a connector guide. */
export function connectorGuideSummary(
  connector: Connector,
): string | undefined {
  const guide = connectorGuide(connector);
  if (!guide) return undefined;
  const configured =
    typeof connector.usageGuide === "object"
      // Registry construction rejects over-budget configured summaries. Keep
      // normalization here so direct Connector callers see the same text.
      ? boundedSummary(connector.usageGuide.summary ?? "")
      : undefined;
  return configured ?? summarizeGuide(connector, guide);
}

/** Whether correct use always depends on conventions outside the tool schema. */
export function connectorGuideRequired(connector: Connector): boolean {
  return (
    connectorGuide(connector) !== undefined &&
    typeof connector.usageGuide === "object" &&
    connector.usageGuide.required === true
  );
}

/** Complete entries stay atomic within ChatGPT's five-skill import budget. */
const SKILL_PAGE_SIZE = 5;
const MAX_SKILL_FILES = 512;
const MAX_SKILL_BYTES = 16 * 1024 * 1024;
const MAX_SKILL_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_SKILLS = 1_024;
const encoder = new TextEncoder();
const PRIVATE = { resultType: "complete" as const, ttlMs: 0, cacheScope: "private" as const };

interface SkillRecord {
  entry: ConnectorSkill;
  aliases: string[];
  content?: string;
  connector?: Connector;
  files?: Map<string, string>;
}

function localRecord(name: string, uri: string, description: string, content: string, aliases: string[]): SkillRecord {
  return { entry: { uri, frontmatter: { name, description }, resources: "dynamic" }, content, aliases };
}

/** JSON frontmatter is YAML too; no runtime provider imports or filesystem reads. */
function localRecords(connectors: readonly Connector[]): SkillRecord[] {
  const builtIns = AVAILABLE_SKILLS.map(skill => localRecord(skill.name,
    `skill://connecta/${skill.name}/SKILL.md`, skill.description, skill.content(), [skill.name, `skill://connecta/${skill.name}`]));
  const guides = connectors.filter(connector => connectorGuide(connector) !== undefined)
    .sort((a, b) => Number(connectorGuideRequired(b)) - Number(connectorGuideRequired(a)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(connector => {
      const name = connector.id;
      const description = connectorGuideSummary(connector)!;
      const root = `skill://connecta/connectors/${encodeURIComponent(name)}`;
      const content = `---\n${JSON.stringify({ name, description }, null, 2)}\n---\n\n${connectorGuide(connector)!}`;
      return localRecord(name, `${root}/SKILL.md`, description, content, [connectorSkillName(name), root]);
    });
  return [builtIns[0]!, ...guides, ...builtIns.slice(1)];
}

/** Keep the downstream path tree, so relative supporting-file references still resolve. */
export function downstreamSkillUri(connectorId: string, uri: string): string {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*:(?:\/\/[^/?#]*)?)(\/[^?#]+)$/.exec(uri);
  if (!match || match[2]!.split("/").slice(1).some(segment => {
    try { const decoded = decodeURIComponent(segment); return !decoded || decoded === "." || decoded === ".." || decoded.includes("\\") || decoded.includes("/") || decoded.includes("\u0000"); }
    catch { return true; }
  })) throw new ConnectorCallError("unavailable", "Downstream skill URI is not a supported file URI.");
  const authority = match[1]!.split("://")[1];
  // A skill may root at the authority, e.g. skill://review/SKILL.md.
  // Repeating it as a path segment preserves the Agent Skills directory name.
  return `skill://downstream/${encodeURIComponent(connectorId)}/${encodeURIComponent(match[1]!)}${authority ? `/${encodeURIComponent(authority)}` : ""}${match[2]}`;
}

function validateEntry(entry: ConnectorSkill): void {
  if (!entry || typeof entry.uri !== "string" || typeof entry.frontmatter !== "object" || !entry.frontmatter || Array.isArray(entry.frontmatter) ||
    typeof entry.frontmatter.name !== "string" || !entry.frontmatter.name || typeof entry.frontmatter.description !== "string" || !entry.frontmatter.description ||
    (entry.resources !== "dynamic" && !Array.isArray(entry.resources))) {
    throw new ConnectorCallError("unavailable", "Downstream skill entry is invalid.");
  }
  const root = entry.uri.slice(0, entry.uri.lastIndexOf("/") + 1);
  if (!entry.uri.endsWith("/SKILL.md") || decodeURIComponent(root.split("/").at(-2) ?? "") !== entry.frontmatter.name) {
    throw new ConnectorCallError("unavailable", "Downstream skill root does not match its name.");
  }
  if (entry.resources === "dynamic") return;
  if (!entry.resources.length || entry.resources.length > MAX_SKILL_FILES) throw new ConnectorCallError("unavailable", "Downstream skill manifest exceeds the file bound.");
  let bytes = 0;
  const files = new Set<string>();
  for (const file of entry.resources) {
    if (!file || typeof file.uri !== "string" || !file.uri.startsWith(root) || files.has(file.uri) ||
      typeof file.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(file.digest) || !Number.isSafeInteger(file.size) || file.size < 0) {
      throw new ConnectorCallError("unavailable", "Downstream skill manifest is invalid.");
    }
    bytes += file.size;
    files.add(file.uri);
  }
  if (!files.has(entry.uri) || bytes > MAX_SKILL_BYTES) throw new ConnectorCallError("unavailable", "Downstream skill manifest is incomplete or oversized.");
}

async function withManifest(record: SkillRecord): Promise<SkillRecord> {
  const bytes = encoder.encode(record.content!);
  if (bytes.length > MAX_SKILL_BYTES) throw new ConnectorCallError("unavailable", "Local skill exceeds the byte bound.");
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { ...record, entry: { ...record.entry, resources: [{ uri: record.entry.uri, digest: `sha256:${digest}`, size: bytes.length }] } };
}

export interface SkillsRegistryOptions {
  requestScope?: object | undefined;
  requestSignal?: AbortSignal | undefined;
  probeTimeoutMs?: number | undefined;
  defer?: DeferredWork | undefined;
}

/**
 * One caller-view registry for native methods, the meta-tool and the guest API.
 * No content reaches storage or operator sinks. The transport's list/read seam
 * can adopt #753's private partition cache without changing any reader here.
 * Only a complete snapshot lives in this request; a failed build is discarded.
 */
export class SkillsRegistry {
  private readonly scope: object;
  private readonly local: SkillRecord[];
  private snapshot: Promise<SkillRecord[]> | undefined;

  constructor(private readonly registry: RegistryView, private readonly baseUrl: string, private readonly options: SkillsRegistryOptions = {}) {
    this.scope = options.requestScope ?? {};
    this.local = localRecords(registry.listConnectors());
  }

  private operation<T>(connector: Connector, read: (ctx: ConnectorContext) => Promise<T>): Promise<T> {
    const timeoutMs = this.options.probeTimeoutMs ?? 20_000;
    const operationScope = {};
    sentSecretsForRequest(this.scope).include(sentSecretsForRequest(operationScope));
    return runEdge(withDeadlineEffect(signal => Effect.scoped(Effect.gen({ self: this }, function* () {
      const ctx = this.registry.contextFor(connector.id, this.baseUrl, operationScope, { signal, timeoutMs, ...(this.options.defer ? { defer: this.options.defer } : {}) });
      yield* closeScopeOnExit(connector, ctx, this.options.defer);
      return yield* Effect.tryPromise({ try: () => read(ctx), catch: error => error instanceof ConnectorCallError && error.code === "auth_required" ? new ConnectorCallError("auth_required", "Downstream skills require authorization.") : new ConnectorCallError("unavailable", "Downstream skills are unavailable.") });
    })), { timeoutMs, ...(this.options.requestSignal ? { signal: this.options.requestSignal } : {}), timeoutError: new ConnectorCallError("unavailable", "Downstream skills timed out.") }), { signal: this.options.requestSignal });
  }

  private async records(): Promise<SkillRecord[]> {
    if (!this.snapshot) {
      this.snapshot = this.build();
      this.snapshot.catch(() => { this.snapshot = undefined; });
    }
    return this.snapshot;
  }

  private async build(): Promise<SkillRecord[]> {
    const records = await Promise.all(this.local.map(withManifest));
    // Bounded sequential connector reads avoid unbounded fan-out and finish
    // cleanup before a later connector's failure can end the whole listing.
    for (const connector of this.registry.listConnectors()) {
      if (!connector.downstreamSkills || !this.registry.canReadConnectorSkills(connector.id)) continue;
      const entries = await this.operation(connector, ctx => connector.downstreamSkills!.list(ctx));
      if (!Array.isArray(entries) || entries.length > MAX_SKILLS) throw new ConnectorCallError("unavailable", "Downstream skills listing exceeds its bound.");
      for (const original of entries) {
        const entry = structuredClone(original);
        validateEntry(entry);
        const files = new Map<string, string>();
        const uri = downstreamSkillUri(connector.id, entry.uri);
        const secrets = sentSecretsForRequest(this.scope);
        if (secrets.containsUrl(entry.uri)) throw new ConnectorCallError("unavailable", "Downstream skill URI contains sent credentials.");
        files.set(uri, entry.uri);
        const resources = entry.resources === "dynamic" ? "dynamic" : entry.resources.map(file => {
          const uri = downstreamSkillUri(connector.id, file.uri);
          if (secrets.containsUrl(file.uri)) throw new ConnectorCallError("unavailable", "Downstream skill URI contains sent credentials.");
          files.set(uri, file.uri);
          return { ...file, uri };
        });
        if (records.some(record => record.entry.uri === uri)) throw new ConnectorCallError("unavailable", "Downstream skills listing contains duplicate entries.");
        records.push({ entry: { ...entry, uri, resources }, aliases: [], connector, files });
      }
    }
    if (records.length > MAX_SKILLS || encoder.encode(JSON.stringify(records.map(record => record.entry))).length > MAX_SKILL_CATALOG_BYTES) {
      throw new ConnectorCallError("unavailable", "Skills listing exceeds its byte or entry bound.");
    }
    // Keep the old investigation guide behind every connector and downstream
    // guide, where it cannot consume one of the first five import slots.
    const investigate = records.findIndex(record => record.aliases.includes("investigate"));
    if (investigate >= 0) records.push(records.splice(investigate, 1)[0]!);
    return records;
  }

  private async lookup(uri: string): Promise<SkillRecord> {
    const local = this.local.find(record => record.entry.uri === uri || record.aliases.includes(uri));
    if (local) return withManifest(local);
    // A non-skill URI never starts a downstream resource request or listing.
    if (!uri.startsWith("skill://downstream/")) throw this.missing(uri);
    const record = (await this.records()).find(record => record.entry.uri === uri);
    if (!record) throw this.missing(uri);
    return record;
  }

  private missing(name: string): ConnectorCallError {
    const available = this.local.map(record => record.aliases[0]).join(", ");
    // Caller-authored URI/error text never enters operator records. Preserve
    // legacy guidance without allowing a missing name to probe a hidden view.
    const id = name.startsWith(CONNECTOR_SKILL_PREFIX) ? name.slice(CONNECTOR_SKILL_PREFIX.length) : name;
    const connector = this.registry.getConnector(id);
    const message = name.startsWith(CONNECTOR_SKILL_PREFIX)
      ? connector ? `Connector "${boundedEchoText(id)}" has no usage guide.` : `Unknown connector "${boundedEchoText(id)}".`
      : connector ? `Unknown skill "${boundedEchoText(name)}". Connector guides are fetched as "${boundedEchoText(connectorSkillName(name))}".` : `Unknown skill "${boundedEchoText(name)}".`;
    return new ConnectorCallError("not_found", `${message} Available skills: ${available}.`);
  }

  async list(cursor?: string) {
    const records = await this.records();
    const offset = cursor === undefined ? 0 : /^skills:[1-9][0-9]*$/.test(cursor) ? Number(cursor.slice(7)) : NaN;
    if (!Number.isSafeInteger(offset) || offset % SKILL_PAGE_SIZE !== 0 || offset >= records.length) throw new ConnectorCallError("invalid_args", "Invalid skills cursor.");
    return { ...PRIVATE, skills: records.slice(offset, offset + SKILL_PAGE_SIZE).map(record => record.entry),
      ...(offset + SKILL_PAGE_SIZE < records.length ? { nextCursor: `skills:${offset + SKILL_PAGE_SIZE}` } : {}) };
  }

  async get(uri: string) { return { ...PRIVATE, skill: (await this.lookup(uri)).entry }; }

  async resources(cursor?: string) {
    const page = await this.list(cursor);
    return { ...PRIVATE, resources: page.skills.flatMap(skill => (skill.resources === "dynamic" ? [{ uri: skill.uri }] : skill.resources).map(file => ({
      uri: file.uri, name: file.uri === skill.uri ? String(skill.frontmatter.name) : file.uri.slice(file.uri.lastIndexOf("/") + 1),
      ...(file.uri === skill.uri ? { description: String(skill.frontmatter.description), mimeType: "text/markdown" } : {}),
      ...("size" in file ? { size: file.size } : {}),
    }))), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async read(uri: string) {
    const local = this.local.find(record => record.entry.uri === uri || record.aliases.includes(uri));
    if (local) return { ...PRIVATE, contents: [{ uri: local.entry.uri, mimeType: "text/markdown", text: (await withManifest(local)).content! }] };
    if (!uri.startsWith("skill://downstream/")) throw this.missing(uri);
    const record = (await this.records()).find(record => record.files?.has(uri));
    if (!record?.connector || !record.files || !this.registry.canReadConnectorSkills(record.connector.id)) throw this.missing(uri);
    const originalUri = record.files.get(uri)!;
    const contents = await this.operation(record.connector, ctx => record.connector!.downstreamSkills!.read(originalUri, ctx));
    if (!Array.isArray(contents) || contents.length !== 1 || contents[0]?.uri !== originalUri) throw new ConnectorCallError("unavailable", "Downstream skill read returned unexpected files.");
    const content = contents[0];
    if (!content || (typeof content.text === "string") === (typeof content.blob === "string")) throw new ConnectorCallError("unavailable", "Downstream skill read did not return one file.");
    let bytes: number;
    try { bytes = typeof content.text === "string" ? encoder.encode(content.text).length : atob(content.blob!).length; }
    catch { throw new ConnectorCallError("unavailable", "Downstream skill file is not valid base64."); }
    if (bytes > MAX_SKILL_BYTES) throw new ConnectorCallError("unavailable", "Downstream skill file exceeds the byte bound.");
    return { ...PRIVATE, contents: [{ ...content, uri } as ConnectorSkillResourceContents] };
  }

  async text(name: string): Promise<string> {
    const record = await this.lookup(name);
    const content = (await this.read(record.entry.uri)).contents[0]!;
    if (typeof content.text === "string") return content.text;
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(atob(content.blob!), char => char.charCodeAt(0))); }
    catch { throw new ConnectorCallError("unavailable", "Skill instructions are not UTF-8 text."); }
  }

  async summaries() {
    return (await this.records()).map(record => ({ name: record.aliases[0] ?? record.entry.uri, uri: record.entry.uri, description: String(record.entry.frontmatter.description) }));
  }
}
