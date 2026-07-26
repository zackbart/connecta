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

Use \`list_connectors({ probe: false })\` for a fast inventory. Use \`probe: true\` only when diagnosing live health or authorization.

## Per-connector guides

Operators may attach a usage guide to a connector — preferred tools, address quirks, pagination conventions, rate-limit etiquette, query patterns. \`skills({})\` lists each one as \`connector:<connectorId>\`; fetch it with \`skills({ name: "connector:<connectorId>" })\`. \`search_tools\` and \`describe_tools\` set \`guide\` on matches whose connector has one. Read a connector's guide before working with it for the first time in a task.

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

export const AVAILABLE_SKILLS = [
  {
    name: "usage",
    description:
      "How to choose among Connecta discovery, direct, batch, destructive, and code-mode tools.",
    content: USAGE_SKILL,
  },
] as const;

/**
 * Namespace for operator-authored per-connector guides. Built-in skill names
 * are bare identifiers and never contain ":", so `connector:<id>` cannot
 * collide with one — not even when a connector's id is literally "usage".
 * The prefixed form is the ONLY way to reach a connector guide: a bare
 * connector id is never resolved, so nothing shadows anything silently.
 */
export const CONNECTOR_SKILL_PREFIX = "connector:";

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

/**
 * One line describing a guide, for the cheap list view: the guide's first
 * meaningful line (heading marks and list bullets stripped), falling back to
 * the connector's own description.
 */
function summarizeGuide(connector: Connector, guide: string): string {
  for (const raw of guide.split("\n")) {
    const line = raw
      .replace(/^\s*#{1,6}\s+/, "")
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
 * place guide visibility is decided, so a later scoped view (issue #22) can
 * filter that list and everything downstream follows.
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
  if (builtIn) return { found: true, content: builtIn.content };
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
        ? `Unknown skill "${name}". Connector guides are fetched as "${connectorSkillName(name)}". Available: ${available()}.`
        : `Connector "${name}" has no usage guide. Available skills: ${available()}.`,
    };
  }
  return {
    found: false,
    message: `Unknown skill "${name}". Available: ${available()}.`,
  };
}
