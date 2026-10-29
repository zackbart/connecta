import type { OperatorAgent, OperatorUiContractV2 } from "./contract.js";
import { endpointRows, hueOf, initialsOf, type EndpointRow } from "./endpoints.js";
import { connectorVerdict, type ConnectorSignals, type ConnectorVerdict } from "./view.js";

/**
 * The Overview's connection map, computed from operator contract v2 alone:
 * callers (people, then agents) on the left, endpoints in the middle,
 * connectors on the right. Every function here is pure, so what a node says,
 * where it sits, which links are dashed and what hovering it highlights are
 * answered without a browser. The component draws exactly this.
 */

type MapHealth = ConnectorVerdict["tone"];
type MapNodeKind = "person" | "agent" | "endpoint" | "connector";

export interface MapNode {
  /** Stable and unique: `person:<namespace>:<id>`, `agent:<name>`, `endpoint:<path>`, `connector:<id>`. */
  id: string;
  kind: MapNodeKind;
  column: 0 | 1 | 2;
  /** The full name: a person's label or raw id, an agent's name, a path, a connector title. */
  name: string;
  /** `name`, shortened to fit the node. */
  label: string;
  /** The node's second line. */
  detail: string;
  /** Where clicking the node goes, or null when there is no page for it. */
  href: string | null;
  /** Connectors carry their health; an agent without a working token is `warn`. */
  tone: MapHealth;
  /** Endpoints only. */
  readOnly: boolean;
  /** Connectors only: their live tools by final classification, or null while the catalog is unknown. */
  tools: { read: number; write: number } | null;
  /** Up to two letters for a person's avatar, or a connector's monogram; empty otherwise. */
  initials: string;
  /** A person's tint bucket, 0–5, the same one their endpoint chips use. */
  hue: number;
  /** Connectors only: the tools box in the last column, level with the node. */
  toolsBox: { x: number; y: number; width: number; height: number } | null;
  /** What hovering or focusing the node says, in one sentence or two. */
  summary: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MapEdge {
  id: string;
  from: string;
  to: string;
  /** Caller → endpoint (`access`) or endpoint → connector (`grant`). */
  kind: "access" | "grant";
  /** A grant takes its connector's health; access links are neutral. */
  tone: MapHealth;
  /** Dashed: a grant on a read-only endpoint. */
  readOnly: boolean;
  /** Dotted: an agent's access without a working token. */
  noToken: boolean;
  /** Grants only: the live tools this endpoint serves from the connector, after read-only mode. */
  served: { tools: number; write: number } | null;
  /** An SVG cubic from the right edge of `from` to the left edge of `to`. */
  path: string;
}

interface MapColumn {
  label: string;
  count: number;
  x: number;
}

export interface ConnectionMap {
  nodes: MapNode[];
  edges: MapEdge[];
  columns: MapColumn[];
  width: number;
  height: number;
}

export interface ConnectionMapOptions {
  /** Drift and failed reads by connector id. */
  signals?: Readonly<Record<string, ConnectorSignals>>;
  /** Whether the Tokens page is open to this viewer; agents link there when it is. */
  tokensPage?: boolean;
}

/* Layout. One coordinate system, scaled by the SVG's viewBox. */

const MAP_WIDTH = 1000;
const COLUMN_X = [16, 280, 544] as const;
const COLUMN_WIDTH = [196, 196, 196] as const;
/** Each connector's read and write tools sit in a fourth column, joined by a straight link. */
const TOOLS_X = 808;
const TOOLS_WIDTH = 176;
const NODE_HEIGHT = 54;
const NODE_GAP = 12;
const HEAD = 40;
const FOOT = 12;
/** Characters a node's name keeps before it is cut with an ellipsis. */
const LABEL_LIMIT = [18, 17, 17] as const;
/** A read-only endpoint's name shares its row with the read-only chip. */
const READ_ONLY_LABEL_LIMIT = 12;

/** "a", "a and b", "a, b and c". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Cut a name to `limit` characters, ending in an ellipsis when it was longer. */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

/** Where an endpoint's row opens on the Endpoints page. */
function endpointHref(path: string): string {
  return `/endpoints#${path.replace(/^\//, "")}`;
}

/** The endpoint path an Endpoints page hash names, or null. */
export function endpointFromHash(hash: string): string | null {
  const value = hash.replace(/^#/, "");
  return value.startsWith("mcp") ? `/${value}` : null;
}

function connectorHref(id: string, healthy: boolean): string {
  return `/connectors/${encodeURIComponent(id)}#${healthy ? "tools" : "connection"}`;
}

interface Caller {
  id: string;
  kind: "person" | "agent";
  name: string;
  agent: OperatorAgent | null;
  /** Endpoints this caller is listed on, in endpoint order. */
  endpoints: EndpointRow[];
}

function tokenWorks(agent: OperatorAgent | null): boolean {
  return agent?.credentialTypes.includes("vercel_oidc") === true || agent?.token?.state === "issued";
}

/**
 * People in the order the contract first lists them (plain /mcp's
 * maintainers, then each pool's members), then every declared agent, then any
 * agent a pool lists that is not declared. Plain /mcp admits no agents.
 */
function callersOf(contract: OperatorUiContractV2, rows: EndpointRow[]): Caller[] {
  const people = new Map<string, Caller>();
  const agents = new Map<string, Caller>();
  for (const agent of contract.agents) {
    agents.set(agent.name, { id: `agent:${agent.name}`, kind: "agent", name: agent.name, agent, endpoints: [] });
  }
  const memberLists: Array<[EndpointRow, OperatorUiContractV2["pools"][number]["members"]]> = rows.map((row) => [
    row,
    row.pool === null
      ? (contract.root?.maintainers ?? [])
      : (contract.pools.find((pool) => pool.name === row.pool)?.members ?? []),
  ]);
  for (const [row, members] of memberLists) {
    for (const member of members) {
      if (member.kind === "agent") {
        if (row.pool === null) continue;
        let caller = agents.get(member.name);
        if (!caller) {
          caller = { id: `agent:${member.name}`, kind: "agent", name: member.name, agent: null, endpoints: [] };
          agents.set(member.name, caller);
        }
        if (!caller.endpoints.includes(row)) caller.endpoints.push(row);
        continue;
      }
      const id = `person:${member.namespace}:${member.id}`;
      let caller = people.get(id);
      if (!caller) {
        caller = { id, kind: "person", name: member.label ?? member.id, agent: null, endpoints: [] };
        people.set(id, caller);
      }
      if (!caller.endpoints.includes(row)) caller.endpoints.push(row);
    }
  }
  return [...people.values(), ...agents.values()];
}

/** Unique live tools a set of endpoints serves, by address. */
function servedTools(rows: EndpointRow[]): { connectors: Set<string>; tools: number; write: number } {
  const connectors = new Set<string>();
  const tools = new Map<string, "read" | "write">();
  for (const row of rows) {
    for (const group of row.groups) {
      connectors.add(group.config.id);
      for (const tool of group.tools) tools.set(tool.address, tool.classification);
    }
  }
  const write = [...tools.values()].filter((value) => value === "write").length;
  return { connectors, tools: tools.size, write };
}

export function toolsPhrase(tools: number, write: number): string {
  if (!tools) return "no tools";
  return write ? `${plural(tools, "tool")}, ${write} write` : `${plural(tools, "tool")}, all read`;
}

function callerSummary(caller: Caller): string {
  const name = caller.name;
  if (!caller.endpoints.length) {
    return caller.kind === "agent" ? `${name} is in no endpoint, so it reaches nothing.` : `${name} reaches nothing.`;
  }
  const served = servedTools(caller.endpoints);
  // An agent connects only at a pool's agent URL, never the people's one.
  const through = joinList(
    caller.endpoints.map((row) => (caller.kind === "agent" ? (row.agentPath ?? row.path) : row.path)),
  );
  const reach = served.connectors.size
    ? `${name} reaches ${plural(served.connectors.size, "connector")} through ${through}: ${toolsPhrase(served.tools, served.write)}.`
    : `${name} uses ${through}, which serves no connectors.`;
  if (caller.kind !== "agent" || tokenWorks(caller.agent)) return reach;
  const state = caller.agent?.token?.state;
  return `${reach} ${state === "revoked" ? "Its token is revoked" : "It has no token"}, so it can't connect.`;
}

function callerDetail(caller: Caller, maintainers: ReadonlySet<string>): string {
  if (caller.kind === "person") return maintainers.has(caller.id) ? "maintainer" : "member · /mcp if one pool";
  if (caller.agent?.credentialTypes.includes("vercel_oidc")) return "agent · Vercel OIDC";
  const state = caller.agent?.token?.state;
  return state === "issued"
    ? "agent · token issued"
    : state === "revoked"
      ? "agent · token revoked"
      : "agent · no token";
}

function endpointSummary(row: EndpointRow, callers: Caller[]): string {
  const listed = callers.filter((caller) => caller.endpoints.includes(row));
  const people = listed.filter((caller) => caller.kind === "person").length;
  const agents = listed.length - people;
  const who = row.pool === null ? plural(people, "maintainer") : plural(people, "person", "people");
  const users = agents ? `${who} and ${plural(agents, "agent")}` : who;
  const served = servedTools([row]);
  const mode = row.readOnly ? `${row.path} is read-only and serves ${users}` : `${row.path} serves ${users}`;
  if (!served.connectors.size) return `${mode}. It has no connectors.`;
  return `${mode} with ${plural(served.connectors.size, "connector")}: ${toolsPhrase(served.tools, served.write)}.`;
}

const STATUS_SENTENCE: Readonly<Record<MapHealth, string>> = {
  ok: "",
  neutral: "",
  warn: " It needs attention.",
  danger: " It is failing.",
};

function connectorSummary(
  title: string,
  id: string,
  health: ConnectorVerdict,
  rows: EndpointRow[],
  callers: Caller[],
): string {
  const on = rows.filter((row) => row.groups.some((group) => group.config.id === id));
  const status = STATUS_SENTENCE[health.tone];
  if (!on.length) return `No endpoint serves ${title}, so nobody reaches it.${status}`;
  const reaching = callers.filter((caller) => caller.endpoints.some((row) => on.includes(row)));
  const people = reaching.filter((caller) => caller.kind === "person").length;
  const agents = reaching.length - people;
  const who = agents
    ? `${plural(people, "person", "people")} and ${plural(agents, "agent")}`
    : plural(people, "person", "people");
  const verb = reaching.length === 1 ? "reaches" : "reach";
  return `${who} ${verb} ${title} through ${joinList(on.map((row) => row.path))}.${status}`;
}

function edgePath(from: MapNode, to: MapNode): string {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;
  const dx = (x2 - x1) / 2;
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

/** Each column's nodes stacked from the top, the shorter columns centered on the tallest. */
function place(nodes: MapNode[]): number {
  const columns = [0, 1, 2].map((column) => nodes.filter((node) => node.column === column));
  const tallest = Math.max(1, ...columns.map((column) => column.length));
  const body = tallest * (NODE_HEIGHT + NODE_GAP) - NODE_GAP;
  columns.forEach((column, index) => {
    const height = column.length * (NODE_HEIGHT + NODE_GAP) - NODE_GAP;
    const top = HEAD + Math.max(0, (body - height) / 2);
    column.forEach((node, position) => {
      node.x = COLUMN_X[index]!;
      node.width = COLUMN_WIDTH[index]!;
      node.height = NODE_HEIGHT;
      node.y = top + position * (NODE_HEIGHT + NODE_GAP);
      if (node.kind === "connector") node.toolsBox = { x: TOOLS_X, y: node.y, width: TOOLS_WIDTH, height: NODE_HEIGHT };
    });
  });
  return HEAD + body + FOOT;
}

function node(
  fields: Omit<MapNode, "x" | "y" | "width" | "height" | "label" | "toolsBox" | "hue"> & { hue?: number },
  limit: number,
): MapNode {
  return { hue: 0, ...fields, label: truncate(fields.name, limit), toolsBox: null, x: 0, y: 0, width: 0, height: 0 };
}

/** A connector's tile: two words' initials, a camel-case title's two capitals, or one letter. */
export function monogram(title: string): string {
  const words = title.split(/[\s._-]+/).filter(Boolean);
  if (words.length > 1) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  const capitals = title.match(/[A-Z]/g) ?? [];
  if (capitals.length >= 2) return capitals[0]! + capitals[1]!;
  return (words[0] ?? title).charAt(0).toUpperCase();
}

/** The whole map for a maintainer's contract; an empty map for anyone else. */
export function connectionMap(contract: OperatorUiContractV2, options: ConnectionMapOptions = {}): ConnectionMap {
  const rows = contract.role === "maintainer" ? endpointRows(contract) : [];
  const callers = callersOf(contract, rows);
  const maintainers = new Set(
    (contract.root?.maintainers ?? []).flatMap((member) =>
      member.kind === "human" ? [`person:${member.namespace}:${member.id}`] : [],
    ),
  );
  const connectors = (contract.role === "maintainer" ? (contract.config?.connectors ?? []) : []).flatMap((config) => {
    const live = contract.live.connectors.find((c) => c.id === config.id);
    const signals =
      options.signals && Object.hasOwn(options.signals, config.id) ? options.signals[config.id] : undefined;
    return live ? [{ config, live, health: connectorVerdict(live, signals) }] : [];
  });
  const health = new Map(connectors.map(({ config, health }) => [config.id, health]));

  const nodes: MapNode[] = [];
  for (const caller of callers) {
    const works = caller.kind === "person" || tokenWorks(caller.agent);
    nodes.push(
      node(
        {
          id: caller.id,
          kind: caller.kind,
          column: 0,
          name: caller.name,
          detail: callerDetail(caller, maintainers),
          href:
            caller.kind === "agent"
              ? options.tokensPage
                ? "/tokens"
                : null
              : caller.endpoints[0]
                ? endpointHref(caller.endpoints[0].path)
                : null,
          tone: works ? "neutral" : "warn",
          readOnly: false,
          tools: null,
          initials: caller.kind === "person" ? initialsOf(caller.name) : "",
          hue: caller.kind === "person" ? hueOf(caller.id.slice("person:".length)) : 0,
          summary: callerSummary(caller),
        },
        LABEL_LIMIT[0],
      ),
    );
  }
  for (const row of rows) {
    const listed = callers.filter((caller) => caller.endpoints.includes(row)).length;
    nodes.push(
      node(
        {
          id: `endpoint:${row.path}`,
          kind: "endpoint",
          column: 1,
          name: row.path,
          detail: `${row.pool === null ? "maintainers" : plural(listed, "caller")} · ${plural(row.groups.length, "connector")}`,
          href: endpointHref(row.path),
          tone: "neutral",
          readOnly: row.readOnly,
          tools: null,
          initials: "",
          summary: endpointSummary(row, callers),
        },
        row.readOnly ? READ_ONLY_LABEL_LIMIT : LABEL_LIMIT[1],
      ),
    );
  }
  for (const { config, live, health: verdict } of connectors) {
    const title = config.title ?? config.id;
    const read = live.tools.filter((tool) => tool.classification === "read").length;
    const scope = config.authScope === "personal" ? "personal" : "shared";
    // A failed or unobserved catalog has no tools to count, which is not zero tools.
    const known = live.tools.length > 0 || (live.status === "ok" && !live.problem);
    nodes.push(
      node(
        {
          id: `connector:${config.id}`,
          kind: "connector",
          column: 2,
          name: title,
          detail: verdict.tone === "ok" ? `${scope} · ${plural(live.tools.length, "tool")}` : verdict.label,
          href: connectorHref(config.id, verdict.tone === "ok"),
          tone: verdict.tone,
          readOnly: false,
          tools: known ? { read, write: live.tools.length - read } : null,
          initials: monogram(title),
          summary: connectorSummary(title, config.id, verdict, rows, callers),
        },
        LABEL_LIMIT[2],
      ),
    );
  }
  const height = place(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const edges: MapEdge[] = [];
  for (const caller of callers) {
    for (const row of caller.endpoints) {
      const from = byId.get(caller.id)!;
      const to = byId.get(`endpoint:${row.path}`)!;
      edges.push({
        id: `${from.id}>${to.id}`,
        from: from.id,
        to: to.id,
        kind: "access",
        tone: "neutral",
        readOnly: false,
        noToken: caller.kind === "agent" && !tokenWorks(caller.agent),
        served: null,
        path: edgePath(from, to),
      });
    }
  }
  for (const row of rows) {
    for (const group of row.groups) {
      const from = byId.get(`endpoint:${row.path}`)!;
      const to = byId.get(`connector:${group.config.id}`);
      if (!to) continue;
      edges.push({
        id: `${from.id}>${to.id}`,
        from: from.id,
        to: to.id,
        kind: "grant",
        tone: health.get(group.config.id)?.tone ?? "neutral",
        readOnly: row.readOnly,
        noToken: false,
        served: {
          tools: group.tools.length,
          write: group.tools.filter((tool) => tool.classification === "write").length,
        },
        path: edgePath(from, to),
      });
    }
  }

  return {
    nodes,
    edges,
    width: MAP_WIDTH,
    height,
    columns: [
      { label: "Callers", count: callers.length, x: COLUMN_X[0] },
      { label: "Endpoints", count: rows.length, x: COLUMN_X[1] },
      { label: "Connectors", count: connectors.length, x: COLUMN_X[2] },
      { label: "Tools", count: connectors.reduce((n, { live }) => n + live.tools.length, 0), x: TOOLS_X },
    ],
  };
}

/**
 * What hovering a node lights up: every node and link on a path through it.
 * Links are walked forward from the node and backward to it, never both ways
 * from a neighbor, so a caller lights only what it reaches and a connector
 * lights only who reaches it.
 */
export function mapHighlight(
  map: Pick<ConnectionMap, "edges">,
  id: string,
): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set([id]);
  const edges = new Set<string>();
  const walk = (forward: boolean) => {
    const queue = [id];
    const seen = new Set([id]);
    while (queue.length) {
      const current = queue.shift()!;
      for (const edge of map.edges) {
        if ((forward ? edge.from : edge.to) !== current) continue;
        const target = forward ? edge.to : edge.from;
        edges.add(edge.id);
        nodes.add(target);
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
  };
  walk(true);
  walk(false);
  return { nodes, edges };
}

/** The stacked list a narrow screen reads instead of the drawing: one entry per endpoint. */
export interface MapListEntry {
  endpoint: MapNode;
  callers: Array<{ node: MapNode; noToken: boolean }>;
  /** Each connector with what this endpoint serves from it. */
  connectors: Array<{ node: MapNode; served: { tools: number; write: number } }>;
}

export function mapList(map: ConnectionMap): MapListEntry[] {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  return map.nodes
    .filter((n) => n.kind === "endpoint")
    .map((endpoint) => ({
      endpoint,
      callers: map.edges
        .filter((edge) => edge.to === endpoint.id)
        .map((edge) => ({ node: byId.get(edge.from)!, noToken: edge.noToken })),
      connectors: map.edges
        .filter((edge) => edge.from === endpoint.id)
        .map((edge) => ({ node: byId.get(edge.to)!, served: edge.served ?? { tools: 0, write: 0 } })),
    }));
}
