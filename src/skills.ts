import type { Connector, ConnectaSurface } from "./types.js";

export const CONNECTA_INSTRUCTIONS =
  'Connecta exposes integrations behind meta-tools. Unknown address: use search_tools with 2–4 distinctive action/object terms, no initial limit, and includeSchemas="compact"; describe_tools only if that shape is ambiguous or exact JSON constraints are needed. Use call_tool for one explicitly read-only call, batch_call for 2–10 independent read-only calls, and execute_code (when available) only for dependencies, loops, joins, or substantial reduction — searching inside that one run rather than searching first. Use call_destructive_tool individually for unannotated, write-capable, or destructive tools. authorize_connector follows auth_required; get_result follows truncation. If this routing is unfamiliar, fetch skills({ name: "usage" }).';

/**
 * The instructions a code-first deployment loads (#224). It never names
 * `list_connectors`, `describe_tools`, or `batch_call` — not even to say they
 * are gone. Always-loaded text describes the surface that exists; a sentence
 * about three tools this deployment does not have is context paid for the past,
 * and a model that names one anyway gets an unknown-tool error, which is a
 * cheaper correction than the tokens the disclaimer costs every request.
 */
export const CODE_FIRST_INSTRUCTIONS =
  'Connecta exposes integrations behind seven meta-tools, and execute_code is the primary one: write an async arrow function and use connecta.search (empty query browses every catalog), connecta.describe, connecta.call, and connecta.batch inside it for discovery, two or more calls, dependent steps, loops, joins, and reducing large results before they reach you. For a single read at an unknown address, search_tools with 2–4 distinctive action/object terms and includeSchemas="compact", then one call_tool — a lone cold call is cheaper direct than through a program. Use call_destructive_tool individually for unannotated, write-capable, or destructive tools; authorize_connector follows auth_required; get_result follows truncation. If this routing is unfamiliar, fetch skills({ name: "usage" }).';

export const USAGE_SKILL = `# Connecta usage

## Choose the smallest execution tool

Use exact addresses returned by discovery; never invent one. Search with 2–4 distinctive action/object terms rather than the full request, and omit \`limit\` initially so the default page stays small.

- Unknown address: \`search_tools({ query, includeSchemas: "compact" })\`; every match then includes its input shape plus any declared output shape and annotations.
- Compact shape still ambiguous: \`describe_tools({ addresses: [...] })\`; use \`format: "json"\` only for exact constraints.
- One explicitly read-only call: \`call_tool\`.
- Two to ten independent explicitly read-only calls: \`batch_call\`.
- Dependent read-only calls, loops, joins, branching, or large-result reduction: \`execute_code\` when available.
- Any unannotated, write-capable, or destructive call: \`call_destructive_tool\`, individually and only after reviewing its schema and consequences.
- Truncated result: retry with \`fields\` when possible; otherwise page it with \`get_result\`.
- \`auth_required\`: use \`authorize_connector\`, give its recovery handoff to the operator, then retry the original call.

Use \`list_connectors({ probe: false })\` for a fast observed-health inventory; use \`probe: true\` only to diagnose live health or authorization.

## Code mode

Unknown addresses plus dependent calls: search inside the run, not in an outer \`search_tools\`. Parallelize independent calls with \`Promise.all\` or \`connecta.batch\`.

Connector namespace calls and \`connecta.call\` use the same read-only gate and throw on downstream errors. Catch only failures the workflow can handle; let authorization failures return to the agent for recovery.

Skip code mode for one call, calls suited to \`batch_call\`, or tools lacking \`readOnlyHint: true\`. Return only the needed reduction.
`;

export const CODE_FIRST_USAGE_SKILL = `# Connecta usage

## The surface

Seven tools: \`execute_code\`, \`search_tools\`, \`call_tool\`, \`call_destructive_tool\`, \`authorize_connector\`, \`get_result\`, \`skills\`. Broad discovery and multi-call work live inside a program rather than in top-level tools.

## Choose the smallest execution tool

Use exact addresses returned by discovery; never invent one. Search with 2–4 distinctive action/object terms rather than the full request.

- One read at an unknown address: \`search_tools({ query, includeSchemas: "compact" })\`, then \`call_tool\` once. A lone cold call is cheaper direct than through a program.
- Anything wider — two or more calls, dependent steps, loops, joins, branching, browsing a whole catalog, or a result that must be reduced: one \`execute_code\` run.
- Any unannotated, write-capable, or destructive call: \`call_destructive_tool\`, individually and only after reviewing its schema and consequences. Generated code cannot make one.
- Truncated result: retry with \`fields\` when possible; otherwise page it with \`get_result\`.
- \`auth_required\`: use \`authorize_connector\`, give its recovery handoff to the operator, then retry the original call.

## Inside a program

One async arrow function. The only capabilities are one global per connector (\`<connectorId>.<toolName>(args)\`), the four \`connecta\` functions, and \`console.log\`.

- What exists: \`connecta.search({})\` browses every catalog; add \`safety: "readOnly"\` for only calls the program can execute, and \`connector: "<id>"\` to browse one. This filters discovery results, not authority, and each match carries its \`address\` and annotations.
- Exact schemas for known addresses: \`connecta.describe({ address: "connector.tool" })\` for one or \`connecta.describe({ addresses: [...] })\` for many; \`format: "json"\` only for exact constraints.
- Two to ten independent calls: \`connecta.batch([...])\`. Each outcome is \`{ address, ok: true, data }\` or \`{ address, ok: false, error, errorDetails: { code, retryable } }\`, which is also how a program tells a policy refusal from a transient failure.
- Search inside the run rather than searching first, and return only the reduction the answer needs — never raw payloads.
- Only tools annotated \`readOnlyHint: true\` are reachable; the read-only gate, credentials, and admission are enforced below the sandbox, so nothing a program does widens what it can reach.
`;

/**
 * Appended to USAGE_SKILL only when the deployment actually has at least one
 * connector guide. A deployment with none — every deployment that has not
 * adopted the feature — keeps the base guide byte-for-byte, rather than paying
 * context for an instruction to fetch guides that do not exist.
 */
export const CONNECTOR_GUIDES_SECTION = `
## Per-connector guides

Some connectors here ship their own usage guide — preferred tools, address quirks, pagination conventions, rate-limit etiquette, query patterns. \`skills({})\` lists each one as \`connector:<connectorId>\`; fetch it with \`skills({ name: "connector:<connectorId>" })\`. \`search_tools\` and \`describe_tools\` set \`guide\` on matches whose connector has one. Read a connector's guide before working with it for the first time in a task.
`;

/** The same section, naming only surfaces a code-first deployment has. */
const CODE_FIRST_CONNECTOR_GUIDES_SECTION = `
## Per-connector guides

Some connectors here ship their own usage guide — preferred tools, address quirks, pagination conventions, rate-limit etiquette, query patterns. \`skills({})\` lists each one as \`connector:<connectorId>\`; fetch it with \`skills({ name: "connector:<connectorId>" })\`. \`search_tools\`, \`connecta.search\`, and \`connecta.describe\` set \`guide\` on matches whose connector has one. Read a connector's guide before working with it for the first time in a task.
`;

/** The always-loaded MCP `instructions` string for `surface`. */
export function instructionsFor(surface: ConnectaSurface): string {
  return surface === "code-first"
    ? CODE_FIRST_INSTRUCTIONS
    : CONNECTA_INSTRUCTIONS;
}

/** True when at least one of `connectors` carries a usage guide. */
export function hasConnectorGuides(connectors: readonly Connector[]): boolean {
  return connectors.some(
    (connector) => connectorGuide(connector) !== undefined,
  );
}

/** The built-in usage guide, plus the guides section when there is one to point at. */
function usageSkill(
  connectors: readonly Connector[],
  surface: ConnectaSurface,
): string {
  const base =
    surface === "code-first" ? CODE_FIRST_USAGE_SKILL : USAGE_SKILL;
  if (!hasConnectorGuides(connectors)) return base;
  return (
    base +
    (surface === "code-first"
      ? CODE_FIRST_CONNECTOR_GUIDES_SECTION
      : CONNECTOR_GUIDES_SECTION)
  );
}

const AVAILABLE_SKILLS = [
  {
    name: "usage",
    description:
      "How to choose among Connecta discovery, direct, batch, destructive, and code-mode tools.",
    codeFirstDescription:
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
  return guide && guide.trim() !== "" ? guide : undefined;
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
function summarizeGuide(connector: Connector, guide: string): string {
  let inFence = false;
  for (const raw of withoutFrontmatter(guide.split("\n"))) {
    if (FENCE_RE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (raw.trim() === "" || NOT_SUMMARY_RE.test(raw)) continue;
    const line = raw
      // `\s*` (not `\s+`) so a bare `#` strips to nothing and is skipped, and
      // an unspaced `#Heading` is still read as a heading.
      .replace(/^\s*#{1,6}\s*/, "")
      .replace(/^\s*[-*+]\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line === "") continue;
    return line.length <= SUMMARY_LENGTH
      ? line
      : `${line.slice(0, SUMMARY_LENGTH - 1).trimEnd()}…`;
  }
  return connector.description ?? `Usage guide for "${connector.id}".`;
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
export function listSkills(
  connectors: readonly Connector[],
  surface: ConnectaSurface = "classic",
): SkillListing[] {
  const listing: SkillListing[] = AVAILABLE_SKILLS.map((skill) => ({
    name: skill.name,
    description:
      surface === "code-first" ? skill.codeFirstDescription : skill.description,
  }));
  for (const connector of connectors) {
    const guide = connectorGuide(connector);
    if (!guide) continue;
    listing.push({
      name: connectorSkillName(connector.id),
      description: summarizeGuide(connector, guide),
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
  surface: ConnectaSurface = "classic",
): SkillLookup {
  const builtIn = AVAILABLE_SKILLS.find((skill) => skill.name === name);
  if (builtIn) {
    return { found: true, content: builtIn.content(connectors, surface) };
  }
  const available = () =>
    listSkills(connectors, surface)
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
