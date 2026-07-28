import type { Connector } from "./types.js";

export const CONNECTA_INSTRUCTIONS =
  'Connecta exposes many integrations behind meta-tools. When an address is unknown, start with search_tools and includeSchemas="compact"; use describe_tools only when that schema is insufficient. Use call_tool for one explicitly read-only call, batch_call for 2–10 independent explicitly read-only calls, and execute_code (when available) only for dependent read-only steps, loops, joins, or reducing large results. Unannotated, write-capable, and destructive tools must use call_destructive_tool individually. Use authorize_connector only after auth_required and get_result only for truncated results. For the detailed workflow, call skills({ name: "usage" }) once per task.';

export const USAGE_SKILL = `# Connecta usage

## Choose the smallest execution tool

- Unknown address: \`search_tools({ query, includeSchemas: "compact" })\`.
- Schema still unclear: \`describe_tools({ addresses: [...] })\`.
- One explicitly read-only call: \`call_tool\`.
- Two to ten independent explicitly read-only calls: \`batch_call\`.
- Dependent read-only calls, loops, joins, branching, or large-result reduction: \`execute_code\` when available.
- Any unannotated, write-capable, or destructive call: \`call_destructive_tool\`, individually and only after reviewing its schema and consequences.
- Truncated result: retry with \`fields\` when possible; otherwise page it with \`get_result\`.
- \`auth_required\`: use \`authorize_connector\`, have the operator complete consent, then confirm with \`list_connectors\`.

Use \`list_connectors({ probe: false })\` for a fast inventory. Use \`probe: true\` only when diagnosing live health or authorization. The fast inventory already reports a connector whose stored credential failed a proactive check as \`auth_required\` (with \`credentialCheck\` and the URL to open), so trust it and authorize up front rather than probing to confirm.

## Code mode

Use code mode when a later call depends on an earlier result, when joining across connectors, or when filtering or aggregating data in the sandbox will substantially shrink the response. Use \`Promise.all\` or \`connecta.batch\` for independent calls inside one execution.

Do not use code mode for one straightforward call, for independent calls already handled by \`batch_call\`, or for any tool not explicitly annotated \`readOnlyHint: true\`. Code mode has a bounded host-call budget and per-call deadline. Return only the reduced value the agent needs; do not return a large upstream payload unchanged.

## Examples

These addresses are illustrative; always use the exact address returned by \`search_tools\`.

Single call:
\`\`\`json
{ "address": "crm.get_account", "args": { "id": "acct_123" }, "resultMode": "value" }
\`\`\`

Independent calls:
\`\`\`json
{ "calls": [
  { "address": "crm.get_account", "args": { "id": "acct_123" } },
  { "address": "billing.list_invoices", "args": { "status": "open" } }
] }
\`\`\`

Dependent code with reduction:
\`\`\`js
async () => {
  const accounts = await crm.search_accounts({ query: "renewal" });
  const details = await Promise.all(
    accounts.results.slice(0, 5).map((account) =>
      crm.get_account({ id: account.id })
    )
  );
  return details.map(({ id, name, status }) => ({ id, name, status }));
}
\`\`\`
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

/** True when at least one of `connectors` carries a usage guide. */
export function hasConnectorGuides(connectors: readonly Connector[]): boolean {
  return connectors.some(
    (connector) => connectorGuide(connector) !== undefined,
  );
}

/** The built-in usage guide, plus the guides section when there is one to point at. */
function usageSkill(connectors: readonly Connector[]): string {
  return hasConnectorGuides(connectors)
    ? USAGE_SKILL + CONNECTOR_GUIDES_SECTION
    : USAGE_SKILL;
}

const AVAILABLE_SKILLS = [
  {
    name: "usage",
    description:
      "How to choose among Connecta discovery, direct, batch, destructive, and code-mode tools.",
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
  while (start < lines.length && lines[start].trim() === "") start++;
  if (start >= lines.length || !RULE_RE.test(lines[start])) return lines;
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
 * place guide visibility is decided. The `skills` meta-tool passes its
 * connection's `registry.listConnectors()`, so a toolkit-scoped session lists
 * only in-scope guides, and `resolveSkill` below reports an out-of-scope
 * `connector:<id>` exactly as it reports an unknown connector.
 */
export function listSkills(connectors: readonly Connector[]): SkillListing[] {
  const listing: SkillListing[] = AVAILABLE_SKILLS.map((skill) => ({
    name: skill.name,
    description: skill.description,
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
): SkillLookup {
  const builtIn = AVAILABLE_SKILLS.find((skill) => skill.name === name);
  if (builtIn) return { found: true, content: builtIn.content(connectors) };
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
