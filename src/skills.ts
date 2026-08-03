import type { Connector } from "./types.js";

export const CONNECTA_INSTRUCTIONS =
  'Connecta exposes seven meta-tools. For one read at an unknown address, search_tools with 2–4 distinctive action/object terms and includeSchemas="compact", then one call_tool — a lone cold call is cheaper direct than a program. For read-only reduction, multiple or dependent calls, loops, joins, or branches, do not call top-level search_tools: make one execute_code call whose program searches, selects, calls, and reduces; never return discovery for another call. connecta.ui(html) is a guest function inside execute_code, never a connector address or search_tools result; pass one HTML string for display-only, or bind named read-only refresh/drill-down calls in its optional reads argument, and return the same initial summary data the HTML renders. Unannotated, write-capable, or destructive tools stay top level: search_tools, then call_destructive_tool; authorize_connector follows auth_required; get_result follows truncation. If this routing is unfamiliar, fetch skills({ name: "usage" }).';

const USAGE_SKILL_BASE = `# Connecta usage

## The surface

Seven tools: \`execute_code\`, \`search_tools\`, \`call_tool\`, \`call_destructive_tool\`, \`authorize_connector\`, \`get_result\`, \`skills\`. Broad discovery and multi-call work live in a program, not in top-level tools.

## Choose the smallest execution tool

Use exact addresses from discovery; never invent one. Search 2–4 distinctive action/object terms, not the whole request.

- One read at an unknown address: \`search_tools({ query, includeSchemas: "compact" })\`, then \`call_tool\` once — one cold call is cheaper direct than a program.
- Anything wider — two or more calls, dependent steps, loops, joins, branching, a whole-catalog browse, or a result to reduce: one \`execute_code\` run.
- Any unannotated, write-capable, or destructive call: \`call_destructive_tool\`, one at a time, after reviewing its schema and consequences.
- Truncated result: retry with \`fields\`, else page it with \`get_result\`.
- \`auth_required\`: \`authorize_connector\`, hand its recovery text to the operator, retry the call.

## Inside a program

One async arrow function. The only capabilities are one global per connector (\`<connectorId>.<toolName>(args)\`), the \`connecta\` functions, and \`console.log\`.

- \`connecta.search({})\` loads all catalogs; pass \`connector: "<id>"\` when obvious to load one. \`safety: "readOnly"\` keeps executable calls. Neither grants authority. Matches carry \`address\` and annotations.
- Exact schemas: \`connecta.describe({ address: "connector.tool" })\` for one, \`{ addresses: [...] }\` for many; \`format: "json"\` only for exact constraints.
- Two to ten independent calls: \`connecta.batch([...])\`. Each outcome is \`{ address, ok: true, data }\` or \`{ address, ok: false, error, errorDetails: { code, retryable } }\` — how a program tells a policy refusal from a transient failure.
- Search inside the run, not before it; return only the reduction the answer needs, never raw payloads.
- Only tools annotated \`readOnlyHint: true\` are reachable; the gate, credentials, and admission are enforced below the sandbox — nothing a program does widens its reach.

## Rendering a view

\`connecta.ui(html)\` renders a display-only view on success for the client, never for the model. Fetch first, check the shape in code. On a surprise — empty array, missing key — return a trimmed first record instead of rendering: the wrong view becomes the sample you needed. Otherwise render from the variables you return; the model reads the return value, not the view.

`;

/** Deployment-scoped guide routing appended to the shared usage guide. */
const CONNECTOR_GUIDES_SECTION = `
## Per-connector guides

When a connector here ships a deployment-scoped usage guide, \`skills({})\` and discovery return the exact \`guide\` name plus a bounded \`guideSummary\` saying what it covers. Fetch only a listed or carried name with \`skills({ name: <guide> })\`; never infer one from a connector id. \`guideRequired: true\` is a hard stop: fetch before calling. \`guideRequiredReasons\` says why — \`connector_required\` and \`approval_required\` stand however you expand the schema; \`schema_truncated\` clears once describe returns the exact one. Otherwise fetch when the summary names a connector-specific sequence, unit, pagination rule, alias, or generic API convention relevant to the task. A read-only call whose compact schema is complete and unambiguous may proceed without fetching an otherwise irrelevant guide. Connector guides do not replace the shared Connecta usage guide and never apply to another deployment implicitly.
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

const AVAILABLE_SKILLS = [
  {
    name: "usage",
    description:
      "How to route work between one execute_code program and Connecta's explicit call, authorization, and result tools.",
    content: usageSkill,
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

const SUMMARY_LENGTH = 120;

/** A `---`/`***`/`___` rule, which also opens and closes YAML frontmatter. */
const RULE_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** A fenced code block's delimiter. */
const FENCE_RE = /^\s*(?:```|~~~)/;

/**
 * Markup that carries no summary text of its own: horizontal rules, HTML
 * comments, and table rows. Skipped so a guide that opens with one is
 * summarized by its first real line instead of by punctuation.
 */
const NOT_SUMMARY_RE = /^\s*(?:<!--|\|)|^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** Drop a leading YAML frontmatter block — metadata, not summary text. */
function withoutFrontmatter(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && (lines[start] ?? "").trim() === "") start++;
  const openingRule = lines[start];
  if (openingRule === undefined || !RULE_RE.test(openingRule)) return lines;
  const close = lines.findIndex((line, i) => i > start && RULE_RE.test(line));
  return close === -1 ? lines : lines.slice(close + 1);
}

/**
 * One line describing a guide, for the cheap list view: the guide's first
 * meaningful line (heading marks and list bullets stripped), falling back to
 * the connector's own description when the guide opens with nothing but
 * markup.
 */
function boundedSummary(summary: string): string | undefined {
  const line = summary.replace(/\s+/g, " ").trim();
  if (line === "") return undefined;
  return line.length <= SUMMARY_LENGTH
    ? line
    : `${line.slice(0, SUMMARY_LENGTH - 1).trimEnd()}…`;
}

function summarizeGuide(connector: Connector, guide: string): string {
  let inFence = false;
  let headingFallback: string | undefined;
  for (const raw of withoutFrontmatter(guide.split("\n"))) {
    if (FENCE_RE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (raw.trim() === "" || NOT_SUMMARY_RE.test(raw)) continue;
    const heading = /^\s*#{1,6}/.test(raw);
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
    return boundedSummary(line) ?? line;
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
