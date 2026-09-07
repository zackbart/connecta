import type { Connector } from "./types.js";

export const CONNECTA_INSTRUCTIONS =
  'Choose a route before discovery. A known-address read needs only call_tool. Unknown-address read-only work starts with execute_code to discover, call, and return the answer; use the same route for reduction, multiple or dependent calls, loops, joins, or branches. Keep discovery and calls together when schemas suffice; do not return catalog matches alone. Inspect unfamiliar result shapes with a small sample before proceeding. Only readOnlyHint: true tools run there. Keep catalog inspection and unannotated, write-capable, or destructive work top level: search_tools then call_destructive_tool when a call is needed. After auth_required use authorize_connector. After a truncated direct result use get_result. Guidance is on demand: fetch skills({ name: "usage" }) only when these instructions and the tool description are insufficient or a run needs repair.';

const USAGE_SKILL_BASE = `# Connecta usage

## The surface

Seven tools: \`execute_code\`, \`search_tools\`, \`call_tool\`, \`call_destructive_tool\`, \`authorize_connector\`, \`get_result\`, \`skills\`. Read-only discovery and multi-call work live in a program. Top-level search remains for catalog inspection and approval-required work.

Follow the MCP instructions for routing. Read at most once for syntax or repair.

## Inside a program

Write one plain-JavaScript async arrow function, without TypeScript or imports. Return reduced JSON-shaped data.

The minimum guest API is:

- \`connecta.call("connector.tool", args)\` uses the canonical address and returns the unwrapped value.
- \`connecta.search(args)\` returns \`{ tools, total, offset, limit, hasMore }\`; \`connecta.describe(args)\` returns \`{ tools }\`.
- Use \`Promise.all\` for independent calls, or \`Promise.allSettled\` to keep successes and failures.
- \`console.log(...)\` is captured. \`connecta.emit(block)\` produces rich output.

## Discover and select

Search and call in one run when schemas suffice. For unfamiliar result formats, return a small sample and continue; do not guess a parser. Use 2–4 distinctive action/object terms; search distinct operations separately.

For top-level catalog inspection or approval-required discovery, omit \`limit\` initially (the default is 8), then page with a limit up to 50 if needed. Empty or whitespace-only queries browse all tools. A non-empty query with no ASCII terms returns no matches; mixed input searches with its ASCII terms. \`includeSchemas: "compact"\` adds bounded input and available output shapes. An \`outputSchemaSource: "observed"\` shape is a hint, not a contract. Plain objects expose \`inputKeys\`, \`requiredInputKeys\`, and \`outputKeys\`; truncation flags mark incomplete shapes; matches also carry declared annotations.

- \`connecta.search({})\` loads all catalogs. Pass \`connector: "<id>"\` when the integration is obvious. Use \`safety: "readOnly"\` for program calls. These inputs filter discovery; they grant no authority.
- Use \`includeSchemas: "json"\` for programmatic schema inspection; compact schemas are text, not objects with \`.properties\`. Check connectorTitle for the account/environment, then address, purpose, annotations, inputs, and outputs. Never select only because a result ranks first or has fewer required inputs.
- Supply every \`requiredInputKey\` from the task or a prior result. For dependencies, match the earlier \`outputKey\` to the later required key. An empty required-key list does not permit invented arguments. Missing \`outputKeys\` means inspect \`outputSchema\`.
- Use \`connecta.describe({ address })\` or \`{ addresses }\` when a compact schema is truncated or insufficient. Use \`format: "json"\` only for exact constraints. Write the property names the schema displays; never guess positions or aliases.
- Reduce through available output keys. Treat an observed key as a hint, since later results may omit it or add others. Do not guess collection roots such as \`items\` or \`results\`. If a match is missing, re-search or describe. If a result shape is unclear, return a small sample for inspection before continuing.
- Match provider identifiers and names exactly after resolving them from source data or a connector guide. A broad regular expression that merely finds a plausible value is not identity resolution.
- Preserve the schema's JSON types exactly: a numeric id is a number, not a numeric-looking string.
- Validate tabular headers, row arrays, and row widths before mapping them. Never let a header or partial row become data.

Only tools explicitly annotated \`readOnlyHint: true\` are reachable. The catalog, credential, admission, and read-only gates run below the sandbox; code cannot widen its authority.

## Errors and repair

Caught Connecta errors expose \`message\`, \`code\`, \`retryable\`, and \`details\`. Promise rejections retain these fields. Branch on fields, never prose. After a shared argument failure, repair one call before repeating it across other records. Do not retry \`retryable: false\`, and do not retry \`rate_limited\` immediately because portable code has no timer.

- \`destructive_tool_requires_approval\`: stop the program and use the returned canonical address with top-level \`call_destructive_tool\`.
- \`auth_required\`: let the failure reach the model, then use top-level \`authorize_connector\`, give its handoff to the operator, and retry after recovery.
- A truncated direct-call result: follow its \`get_result\` action. A truncated program result has no page handle; filter, map, or slice inside a new program.
- Unknown addresses and tools carry scoped search recovery. Use it inside the current run. Do not invent an address.

For a direct call, \`resultMode: "value"\` unwraps the result. \`timeoutMs\` sets its deadline. Every call makes one attempt; use the returned error classification and retry hint to decide whether to reissue. \`diagnostics: true\` adds timing.

\`get_result({ id, offset?, maxBytes? })\` returns \`{ text, offset, nextOffset?, totalBytes }\` for a direct-call result. Both sizes are byte counts: \`maxBytes\` must be a whole number at least 1 and defaults to the deployment cap; \`offset\` must be a whole number at least 0 and defaults to 0. An offset inside a multi-byte character moves back to its first byte, and the response reports the served offset. Follow \`nextOffset\` to reassemble pages. An unknown or expired id is an error.

Limits: 20 host calls per run and a 15-second deadline per host call.

## Runtime portability

Portable code uses standard JavaScript builtins, \`connecta\`, and \`console.*\`. QuickJS blocks imports and lacks fetch, process, timers, crypto, and WebSocket. Dynamic Workers must use only \`{ loader }\`; bindings, modules, or globalOutbound grant ambient authority. With loader only, environment maps are empty; node:fs/http/https are absent; outbound fetch, WebSocket, node:net, and node:tls are denied; DNS is unresolved. Runtime builtins remain through \`import()\` and \`process.getBuiltinModule()\`, including node:path and cloudflare:workers; this set can drift. Timers, process, crypto, WebSocket, and data: fetch remain. Avoid every runtime-only capability because QuickJS fails.

## Examples

One read-only call at a known address:

\`async () => await connecta.call("crm.get_account", { id: "acct_42" })\`

Dependent lookup: verify connector \`ci\`, run 42, and these schema fields first.

\`\`\`js
async () => {
  const find = async name => {
    const page = await connecta.search({ connector: "ci", query: name, safety: "readOnly", includeSchemas: "compact" });
    if (page.queryAnalysis?.catalogError) throw new Error(JSON.stringify(page.queryAnalysis.catalogError));
    return page.tools.find(tool => tool.name === name);
  };
  const runTool = await find("get_run");
  if (!runTool) return { gap: "Run lookup not resolved" };
  const run = await connecta.call(runTool.address, { runId: 42 });
  if (!run.failedJobId) return { status: run.status, gap: "No failed job identified" };
  const logsTool = await find("get_job_logs");
  if (!logsTool) return { status: run.status, gap: "Job logs not resolved" };
  const logs = await connecta.call(logsTool.address, { jobId: run.failedJobId });
  return logs.filter(row => row.level === "error").map(({ timestamp, message }) => ({ timestamp, message }));
}
\`\`\`

## Media output

\`connecta.emit\` accepts text, image, or audio blocks and delivers them only on success. Its byte and block budgets are separate from the JSON return budget. Return data for the client to render as a view.

`;

/** Deployment-scoped guide routing appended to the shared usage guide. */
const CONNECTOR_GUIDES_SECTION = `
## Per-connector guides

Connector guides appear in \`skills({})\` and discovery with an exact \`guide\` name and bounded \`guideSummary\`. Fetch only a listed or carried name with \`skills({ name: <guide> })\`; never infer one from a connector id. \`guideRequired: true\` is a hard stop. \`guideRequiredReasons\` says why: \`connector_required\` and \`approval_required\` stand after schema expansion; \`schema_truncated\` clears after exact describe. Otherwise fetch for a relevant sequence, unit, pagination rule, alias, or API convention. A read-only call with a complete compact schema may skip an irrelevant guide. Connector guides never apply to another deployment.
`;

/** Shared Connecta routing guidance, byte-identical across deployments. */
export const USAGE_SKILL = USAGE_SKILL_BASE + CONNECTOR_GUIDES_SECTION;

/** The always-loaded MCP `instructions` string. */
export function instructionsFor(): string {
  return CONNECTA_INSTRUCTIONS;
}

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
function usageSkill(_connectors: readonly Connector[]): string {
  return USAGE_SKILL;
}

const INVESTIGATE_SKILL = `# Investigate across services

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
 * The prefixed form is the ONLY way to reach a connector guide: a bare
 * connector id is never resolved, so nothing shadows anything silently.
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

export interface SkillListing {
  name: string;
  description: string;
}

/**
 * Every fetchable skill: the built-in guides plus one entry per connector that
 * carries a usage guide. Derived from the connector list passed in — the single
 * place guide visibility is decided.
 */
export function listSkills(connectors: readonly Connector[]): SkillListing[] {
  const listing: SkillListing[] = AVAILABLE_SKILLS.map((skill) => ({
    name: skill.name,
    description: skill.description,
  }));
  for (const connector of connectors) {
    // Undefined here means "no guide" and nothing else: a connector that has
    // one always summarizes to a non-empty line, configured or derived.
    const summary = connectorGuideSummary(connector);
    if (!summary) continue;
    listing.push({
      name: connectorSkillName(connector.id),
      description: summary,
    });
  }
  return listing;
}

export type SkillLookup =
  { found: true; content: string } | { found: false; message: string };

/**
 * Resolve one skill name. Built-in names match exactly; connector guides are
 * reachable only through the `connector:` prefix. Every miss — unknown name,
 * unknown connector, connector without a guide — is an explicit error, never a
 * silent fallback to the generic guide.
 */
export function resolveSkill(
  name: string,
  connectors: readonly Connector[],
): SkillLookup {
  const builtIn = AVAILABLE_SKILLS.find((skill) => skill.name === name);
  if (builtIn) {
    return { found: true, content: builtIn.content(connectors) };
  }
  const available = () =>
    listSkills(connectors)
      .map((skill) => skill.name)
      .join(", ");
  if (name.startsWith(CONNECTOR_SKILL_PREFIX)) {
    const id = name.slice(CONNECTOR_SKILL_PREFIX.length);
    const connector = connectors.find((c) => c.id === id);
    if (!connector) {
      return {
        found: false,
        message: `Unknown connector "${id}". Available skills: ${available()}.`,
      };
    }
    const guide = connectorGuide(connector);
    if (!guide) {
      return {
        found: false,
        message: `Connector "${id}" has no usage guide. Available skills: ${available()}.`,
      };
    }
    return { found: true, content: guide };
  }
  const bare = connectors.find((c) => c.id === name);
  if (bare) {
    return {
      found: false,
      message: connectorGuide(bare)
        ? `Unknown skill "${name}". Connector guides are fetched as "${connectorSkillName(name)}". Available skills: ${available()}.`
        : `Connector "${name}" has no usage guide. Available skills: ${available()}.`,
    };
  }
  return {
    found: false,
    message: `Unknown skill "${name}". Available skills: ${available()}.`,
  };
}
