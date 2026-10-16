import type {
  OperatorConnectorOverlay,
  OperatorConnectorPoolCell,
  OperatorGrant,
  OperatorMember,
  OperatorRootEndpoint,
  OperatorRunsAs,
  OperatorSharedSource,
  OperatorTool,
  OperatorUiContractV2,
} from "./contract.js";
import type { DescribedConnector } from "../describe-config.js";

/**
 * The maintainer's endpoint and matrix views, computed from operator
 * contract v2 alone. Every function here is pure, so the questions the pages
 * answer (how many tools an endpoint serves, what a matrix cell says, who a
 * connector runs as) are answered without a browser.
 */

export interface EndpointGroup {
  config: DescribedConnector;
  live: OperatorConnectorOverlay;
  /** Live tools this endpoint serves, after grants, guards and read-only mode. */
  tools: OperatorTool[];
  /** The matching matrix cell's subject, or null when the matrix has no cell. */
  runsAs: OperatorRunsAs | null;
}

export interface EndpointRow {
  /** `null` is plain /mcp. */
  pool: string | null;
  label: string;
  /** Where people connect: `/mcp` or the pool's humanPath. */
  path: string;
  /** The pool's agentPath, only when an agent is a member. */
  agentPath: string | null;
  readOnly: boolean;
  toolCount: number;
  groups: EndpointGroup[];
  /** Who can use it: root.maintainers for /mcp, the pool's members otherwise. */
  access: AccessChip[];
}

/** One "who can use it" chip: a person by label or raw id, or an agent. */
export interface AccessChip {
  /** Unique within one endpoint. */
  key: string;
  kind: "human" | "agent";
  /** A person's label or raw id; an agent's bare name (its key is `agent:<name>`). */
  text: string;
  /** Up to two letters for a person's avatar; empty for an agent. */
  initials: string;
  /** A stable tint bucket, 0–5, so one person keeps one color everywhere. */
  hue: number;
}

/** How many chips an endpoint row shows before "+N more". */
const ACCESS_CHIP_LIMIT = 4;

function initialsOf(text: string): string {
  const words = text
    .replace(/^user_/, "")
    .split(/[\s._@-]+/)
    .filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? text).slice(0, 2);
  return letters.toUpperCase();
}

function hueOf(key: string): number {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 6;
}

/** A member as a chip. Labels are null on Access deployments, where the raw id shows instead. */
function accessChip(member: OperatorMember): AccessChip {
  if (member.kind === "agent") {
    const key = `agent:${member.name}`;
    return { key, kind: "agent", text: member.name, initials: "", hue: hueOf(key) };
  }
  const key = `${member.namespace}:${member.id}`;
  const text = member.label ?? member.id;
  return { key, kind: "human", text, initials: initialsOf(text), hue: hueOf(key) };
}

/** Chips for one endpoint in contract order, people first, without repeats. */
export function accessChips(members: OperatorMember[]): AccessChip[] {
  const unique = new Map<string, AccessChip>();
  for (const chip of members.map(accessChip)) if (!unique.has(chip.key)) unique.set(chip.key, chip);
  const chips = [...unique.values()];
  return [...chips.filter((chip) => chip.kind === "human"), ...chips.filter((chip) => chip.kind === "agent")];
}

/** The chips a collapsed row shows, and how many the "+N more" button holds back. */
export function visibleChips(chips: AccessChip[], expanded: boolean): { shown: AccessChip[]; hidden: number } {
  if (expanded || chips.length <= ACCESS_CHIP_LIMIT) return { shown: chips, hidden: 0 };
  return { shown: chips.slice(0, ACCESS_CHIP_LIMIT), hidden: chips.length - ACCESS_CHIP_LIMIT };
}

/** Matrix cells for one endpoint, keyed by connector id. */
function cellsFor(contract: OperatorUiContractV2, pool: string | null): Map<string, OperatorConnectorPoolCell> {
  return new Map(contract.matrix.filter((cell) => cell.pool === pool).map((cell) => [cell.connectorId, cell]));
}

/** Plain /mcp declares no tool list; its matrix cells are its grants. */
function rootGrants(contract: OperatorUiContractV2): OperatorGrant[] {
  return contract.matrix
    .filter((cell) => cell.pool === null)
    .map((cell) => ({
      connectorId: cell.connectorId,
      tools: cell.tools === "all" ? "all" : cell.tools.map((name) => ({ name, requireReadOnly: false })),
    }));
}

/** Intersect declared grants with final live verdicts, in config order. */
function endpointGroups(
  contract: OperatorUiContractV2,
  grants: OperatorGrant[],
  readOnly: boolean,
  pool: string | null,
): EndpointGroup[] {
  const cells = cellsFor(contract, pool);
  return (contract.config?.connectors ?? []).flatMap((config) => {
    const live = contract.live.connectors.find((c) => c.id === config.id);
    const grant = grants.find((g) => g.connectorId === config.id);
    if (!live || !grant) return [];
    const tools = live.tools.filter((tool) => {
      if (readOnly && tool.classification !== "read") return false;
      return (
        grant.tools === "all" ||
        grant.tools.some((g) => g.name === tool.name && (!g.requireReadOnly || tool.classification === "read"))
      );
    });
    // A granted connector with no complete catalog still needs a visible fix.
    return [{ config, live, tools, runsAs: cells.get(config.id)?.runsAs ?? null }];
  });
}

const toolCount = (groups: EndpointGroup[]) => groups.reduce((n, group) => n + group.tools.length, 0);

/** One row for plain /mcp, then one per pool, in contract order. Maintainer view only. */
export function endpointRows(contract: OperatorUiContractV2): EndpointRow[] {
  if (contract.role !== "maintainer") return [];
  const rows: EndpointRow[] = [];
  if (contract.root) {
    const groups = endpointGroups(contract, rootGrants(contract), contract.root.readOnly, null);
    rows.push({
      pool: null,
      label: "Default",
      path: contract.root.path,
      agentPath: null,
      readOnly: contract.root.readOnly,
      toolCount: toolCount(groups),
      groups,
      access: accessChips(contract.root.maintainers),
    });
  }
  for (const pool of contract.pools) {
    const groups = endpointGroups(contract, pool.tools, pool.readOnly, pool.name);
    rows.push({
      pool: pool.name,
      label: pool.name,
      path: pool.humanPath,
      agentPath: pool.members.some((member) => member.kind === "agent") ? pool.agentPath : null,
      readOnly: pool.readOnly,
      toolCount: toolCount(groups),
      groups,
      access: accessChips(pool.members),
    });
  }
  return rows;
}

/** A calendar day, without the time: when a shared credential was saved. */
function formatDay(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** Where a shared credential lives; a vault or OAuth date when the contract has one. */
function sharedSourceLabel(source: OperatorSharedSource, date: string): string {
  switch (source) {
    case "vault":
      return date ? `saved ${date}` : "saved";
    case "oauth":
      return date ? `connected ${date}` : "connected";
    case "missing":
      return "not configured";
    case "config":
      return "set in deployment";
    case "unauthenticated":
      return "no credential needed";
  }
}

/** Whose account a connector acts with on one endpoint, in one line. */
export function runsAsLabel(runsAs: OperatorRunsAs, day: (value: string) => string = formatDay): string {
  switch (runsAs.kind) {
    case "shared":
      return `Shared · ${sharedSourceLabel(runsAs.source, runsAs.savedAt ? day(runsAs.savedAt) : "")}`;
    case "personal":
      return `Personal · ${runsAs.connectedMembers} of ${runsAs.members} connected`;
    case "workspace":
      return `Workspace · people: self · agents: ${runsAs.agents ?? "none"}`;
    case "workspaceFixed":
      return `Everyone acts as ${runsAs.subject}`;
  }
}

/** One matrix column: plain /mcp first, then each pool. */
export interface MatrixColumn {
  pool: string | null;
  path: string;
  readOnly: boolean;
}

export function matrixColumns(contract: OperatorUiContractV2): MatrixColumn[] {
  if (contract.role !== "maintainer") return [];
  return [
    ...(contract.root ? [{ pool: null, path: contract.root.path, readOnly: contract.root.readOnly }] : []),
    ...contract.pools.map((pool) => ({ pool: pool.name, path: pool.humanPath, readOnly: pool.readOnly })),
  ];
}

export type MatrixCell =
  | { kind: "none" }
  | {
      kind: "all" | "some";
      /** Exactly the cell's tool names; "all" expands to the live catalog. */
      tools: Array<{ name: string; classification: "read" | "write" | null }>;
      runsAs: OperatorRunsAs;
    };

/** What one connector × endpoint cell holds, straight from the contract's matrix. */
export function matrixCell(
  contract: OperatorUiContractV2,
  connectorId: string,
  column: Pick<MatrixColumn, "pool">,
): MatrixCell {
  const cell = contract.matrix.find((c) => c.connectorId === connectorId && c.pool === column.pool);
  if (!cell) return { kind: "none" };
  const live = contract.live.connectors.find((c) => c.id === connectorId)?.tools ?? [];
  const tools =
    cell.tools === "all"
      ? live.map(({ name, classification }) => ({ name, classification }))
      : cell.tools.map((name) => ({ name, classification: live.find((t) => t.name === name)?.classification ?? null }));
  return { kind: cell.tools === "all" ? "all" : "some", tools, runsAs: cell.runsAs };
}

/** The cell's visible text: "all", a count, or a dash. */
export function matrixCellText(cell: MatrixCell): string {
  if (cell.kind === "none") return "—";
  return cell.kind === "all" ? "all" : String(cell.tools.length);
}

/** The cell's accessible name, e.g. "GitHub on /support: 3 tools". */
export function matrixCellLabel(connector: string, column: Pick<MatrixColumn, "path" | "readOnly">, cell: MatrixCell) {
  const where = `${connector} on ${column.path}`;
  if (cell.kind === "none") return `${where}: no tools`;
  const what = cell.kind === "all" ? "all tools" : `${cell.tools.length} ${cell.tools.length === 1 ? "tool" : "tools"}`;
  return `${where}: ${what}${column.readOnly ? ", read-only" : ""}`;
}

/** The connector's subject for the matrix's Runs as column: the /mcp cell, else its first pool's. */
export function connectorRunsAs(contract: OperatorUiContractV2, connectorId: string): OperatorRunsAs | null {
  const cells = contract.matrix.filter((cell) => cell.connectorId === connectorId);
  const root = cells.find((cell) => cell.pool === null);
  if (root) return root.runsAs;
  for (const pool of contract.pools) {
    const cell = cells.find((c) => c.pool === pool.name);
    if (cell) return cell.runsAs;
  }
  return null;
}

/** Who may use plain /mcp, for Settings: each maintainer by label, else by raw id. */
export function rootAccessSentence(root: OperatorRootEndpoint): string {
  const names = root.maintainers.map((member) => (member.kind === "human" ? (member.label ?? member.id) : member.name));
  return names.length
    ? `Only maintainers can use ${root.path}: ${names.join(", ")}.`
    : `Only maintainers can use ${root.path}, and none are listed.`;
}
