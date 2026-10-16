import { describe, expect, it } from "vitest";
import type { OperatorUiContractV2 } from "../src/operator-ui/contract.js";
import {
  connectionMap,
  endpointFromHash,
  endpointHref,
  joinList,
  mapHighlight,
  mapList,
  monogram,
  toolsPhrase,
  truncate,
} from "../src/operator-ui/connection-map.js";
import { connectorVerdict } from "../src/operator-ui/view.js";
import { OPERATOR_V2_MAINTAINER, OPERATOR_V2_MEMBER } from "./fixtures/operator-contract-v2.js";

const maintainer = () => structuredClone(OPERATOR_V2_MAINTAINER) as OperatorUiContractV2;
const node = (map: ReturnType<typeof connectionMap>, id: string) => map.nodes.find((n) => n.id === id)!;
const ADA = "person:https://clerk.example.test:user_ada";
const GRACE = "person:https://clerk.example.test:user_grace";
const LIN = "person:https://clerk.example.test:user_lin";

describe("connection map layout", () => {
  it("orders people by first listing, then agents, then endpoints and connectors in contract order", () => {
    const map = connectionMap(maintainer());
    const column = (n: number) => map.nodes.filter((entry) => entry.column === n).map((entry) => entry.name);
    expect(column(0)).toEqual(["Ada Lovelace", "user_grace", "Lin Chen", "simon-ada", "triage"]);
    expect(column(1)).toEqual(["/mcp", "/mcp/ada", "/mcp/support", "/mcp/team"]);
    expect(column(2)).toEqual(["GitHub", "Gmail", "Drive", "Slack", "Calendar", "Notion"]);
    expect(map.columns.map((c) => [c.label, c.count])).toEqual([
      ["Callers", 5],
      ["Endpoints", 4],
      ["Connectors", 6],
      ["Tools", 9],
    ]);
    // The tallest column fills the height; shorter ones are centered on it.
    const tops = (n: number) => map.nodes.filter((entry) => entry.column === n).map((entry) => entry.y);
    expect(Math.min(...tops(2))).toBeLessThan(Math.min(...tops(1)));
    expect(map.nodes.every((entry) => entry.x + entry.width <= map.width)).toBe(true);
    expect(map.nodes.every((entry) => entry.y + entry.height <= map.height)).toBe(true);
    for (const entry of map.nodes.filter((n) => n.kind === "connector")) {
      expect(entry.toolsBox).toMatchObject({ y: entry.y, height: entry.height });
    }
  });

  it("names, links and labels every node, with a tools split for each connector", () => {
    const map = connectionMap(maintainer(), { tokensPage: true });
    expect(node(map, ADA)).toMatchObject({
      kind: "person",
      detail: "maintainer",
      initials: "AL",
      href: "/endpoints#mcp",
    });
    expect(node(map, LIN)).toMatchObject({ detail: "member", href: "/endpoints#mcp/support" });
    expect(node(map, "agent:triage")).toMatchObject({ detail: "agent · no token", tone: "warn", href: "/tokens" });
    expect(node(map, "agent:simon-ada")).toMatchObject({ detail: "agent · token issued", tone: "neutral" });
    expect(node(map, "endpoint:/mcp/support")).toMatchObject({
      readOnly: true,
      detail: "2 callers · 2 connectors",
      href: "/endpoints#mcp/support",
    });
    expect(node(map, "endpoint:/mcp").detail).toBe("maintainers · 6 connectors");
    expect(node(map, "connector:github")).toMatchObject({
      detail: "shared · 2 tools",
      tone: "ok",
      tools: { read: 1, write: 1 },
      initials: "GH",
      href: "/connectors/github#tools",
    });
    expect(node(map, "connector:notion")).toMatchObject({
      detail: "Credential needed",
      tone: "warn",
      href: "/connectors/notion#connection",
    });
    // Without the Tokens page an agent has nowhere to go, but keeps its sentence.
    expect(node(connectionMap(maintainer()), "agent:triage").href).toBeNull();
  });

  it("INV-2: dashes grants on read-only endpoints and dots access from agents without a working token", () => {
    const contract = maintainer();
    contract.agents[0]!.token = { state: "revoked", revokedAt: "2026-10-02T00:00:00.000Z", revision: "r" };
    const map = connectionMap(contract);
    const dashed = map.edges.filter((edge) => edge.readOnly).map((edge) => edge.id);
    expect(dashed).toEqual(["endpoint:/mcp/support>connector:github", "endpoint:/mcp/support>connector:drive"]);
    expect(map.edges.filter((edge) => edge.kind === "access" && edge.readOnly)).toEqual([]);
    const dotted = map.edges.filter((edge) => edge.noToken).map((edge) => edge.id);
    expect(dotted).toEqual(["agent:simon-ada>endpoint:/mcp/ada", "agent:triage>endpoint:/mcp/support"]);
    // Plain /mcp admits no agents, so no agent links to it.
    expect(map.edges.some((edge) => edge.from.startsWith("agent:") && edge.to === "endpoint:/mcp")).toBe(false);
    // Grants carry the connector's health; access links stay neutral.
    expect(map.edges.find((edge) => edge.id === "endpoint:/mcp/team>connector:notion")!.tone).toBe("warn");
    expect(new Set(map.edges.filter((edge) => edge.kind === "access").map((edge) => edge.tone))).toEqual(
      new Set(["neutral"]),
    );
  });

  it("INV-4: keeps an empty deployment drawable and draws nothing from a member's contract", () => {
    const contract = maintainer();
    contract.config!.connectors = [];
    contract.live.connectors = [];
    contract.matrix = [];
    contract.pools = [];
    contract.agents = [];
    const map = connectionMap(contract);
    expect(map.nodes.map((entry) => entry.id)).toEqual([ADA, GRACE, "endpoint:/mcp"]);
    expect(node(map, "endpoint:/mcp").summary).toBe("/mcp serves 2 maintainers. It has no connectors.");
    expect(map.summary).toBe("2 people and 0 agents reach 0 connectors through 1 endpoint.");
    expect(map.height).toBeGreaterThan(0);
    const member = connectionMap(structuredClone(OPERATOR_V2_MEMBER) as OperatorUiContractV2);
    expect(member.nodes).toEqual([]);
    expect(member.edges).toEqual([]);
  });
});

describe("connection map sentences", () => {
  it("says what each caller reaches, through which endpoints, with tool and write counts", () => {
    const map = connectionMap(maintainer());
    expect(node(map, ADA).summary).toBe(
      "Ada Lovelace reaches 6 connectors through /mcp, /mcp/ada and /mcp/team: 9 tools, 3 write.",
    );
    // Writes on read-only /mcp/support are not served, so only team's count.
    expect(node(map, LIN).summary).toBe(
      "Lin Chen reaches 5 connectors through /mcp/support and /mcp/team: 6 tools, 1 write.",
    );
    expect(node(map, "agent:triage").summary).toBe(
      "triage reaches 2 connectors through /agent/support: 2 tools, all read. It has no token, so it can't connect.",
    );
    expect(node(map, "agent:simon-ada").summary).toBe(
      "simon-ada reaches 2 connectors through /agent/ada: 3 tools, 1 write.",
    );
  });

  it("says who uses each endpoint and who reaches each connector", () => {
    const map = connectionMap(maintainer());
    expect(node(map, "endpoint:/mcp").summary).toBe("/mcp serves 2 maintainers with 6 connectors: 9 tools, 3 write.");
    expect(node(map, "endpoint:/mcp/support").summary).toBe(
      "/mcp/support is read-only and serves 1 person and 1 agent with 2 connectors: 2 tools, all read.",
    );
    expect(node(map, "connector:github").summary).toBe(
      "3 people and 2 agents reach GitHub through /mcp, /mcp/ada, /mcp/support and /mcp/team.",
    );
    expect(node(map, "connector:notion").summary).toBe(
      "3 people reach Notion through /mcp and /mcp/team. It needs attention.",
    );
  });

  it("covers agents in no endpoint, revoked tokens and connectors nobody reaches", () => {
    const contract = maintainer();
    contract.agents.push({
      name: "nightly",
      pools: [],
      token: { state: "revoked", revokedAt: "2026-10-02T00:00:00.000Z", revision: "r" },
      lastSeenAt: null,
    });
    contract.agents[1]!.token = { state: "revoked", revokedAt: "2026-10-02T00:00:00.000Z", revision: "r" };
    contract.matrix = contract.matrix.filter((cell) => cell.connectorId !== "drive");
    contract.pools.find((pool) => pool.name === "support")!.tools = [
      { connectorId: "github", tools: [{ name: "read", requireReadOnly: false }] },
    ];
    contract.live.connectors.find((c) => c.id === "drive")!.status = "error";
    const map = connectionMap(contract);
    expect(node(map, "agent:nightly").summary).toBe("nightly is in no endpoint, so it reaches nothing.");
    expect(node(map, "agent:nightly").detail).toBe("agent · token revoked");
    expect(node(map, "agent:triage").summary).toBe(
      "triage reaches 1 connector through /agent/support: 1 tool, all read. Its token is revoked, so it can't connect.",
    );
    expect(node(map, "connector:drive").summary).toBe("No endpoint serves Drive, so nobody reaches it. It is failing.");
  });
});

describe("connection map highlight", () => {
  it("lights what a caller reaches, never its neighbors' other paths", () => {
    const map = connectionMap(maintainer());
    const lit = mapHighlight(map, LIN);
    expect([...lit.nodes].sort()).toEqual(
      [
        LIN,
        "endpoint:/mcp/support",
        "endpoint:/mcp/team",
        "connector:github",
        "connector:drive",
        "connector:slack",
        "connector:calendar",
        "connector:notion",
      ].sort(),
    );
    expect(lit.nodes.has("agent:triage")).toBe(false);
    expect(lit.edges.has("agent:triage>endpoint:/mcp/support")).toBe(false);
    expect(lit.edges.has("endpoint:/mcp/team>connector:slack")).toBe(true);
  });

  it("lights who reaches a connector, back through its endpoints", () => {
    const lit = mapHighlight(connectionMap(maintainer()), "connector:notion");
    expect([...lit.nodes].sort()).toEqual(
      ["connector:notion", "endpoint:/mcp", "endpoint:/mcp/team", ADA, GRACE, LIN].sort(),
    );
    const endpoint = mapHighlight(connectionMap(maintainer()), "endpoint:/mcp/support");
    expect([...endpoint.nodes].sort()).toEqual(
      ["endpoint:/mcp/support", LIN, "agent:triage", "connector:github", "connector:drive"].sort(),
    );
  });
});

describe("connection map helpers", () => {
  it("lists each endpoint with its callers and connectors for narrow screens", () => {
    const list = mapList(connectionMap(maintainer()));
    const support = list.find((entry) => entry.endpoint.name === "/mcp/support")!;
    expect(support.callers.map(({ node: caller, noToken }) => [caller.name, noToken])).toEqual([
      ["Lin Chen", false],
      ["triage", true],
    ]);
    // What support serves, not each connector's whole catalog: GitHub's write is off there.
    expect(support.connectors.map(({ node: c, served }) => [c.name, served])).toEqual([
      ["GitHub", { tools: 1, write: 0 }],
      ["Drive", { tools: 1, write: 0 }],
    ]);
  });

  it("reads health with the Connectors list's verdict, joins lists and shortens names", () => {
    const live = maintainer().live.connectors[0]!;
    expect(connectorVerdict(live)).toEqual({ tone: "ok", label: "Connected", action: null });
    expect(connectorVerdict(live, { drift: true })).toEqual({ tone: "warn", label: "Catalog drift", action: "Review" });
    expect(connectorVerdict(live, { failed: true })).toEqual({
      tone: "warn",
      label: "Couldn't load",
      action: "Inspect",
    });
    // A failed catalog on a connector reporting "ok" is not connected.
    expect(connectorVerdict({ ...live, problem: "catalog_failed" })).toEqual({
      tone: "danger",
      label: "Catalog failed",
      action: "Inspect",
    });
    // The server's problem outranks a failed read on this page.
    expect(connectorVerdict({ ...live, problem: "credential_mismatch" }, { failed: true })).toEqual({
      tone: "danger",
      label: "Credential mismatch",
      action: "Replace key",
    });
    // A failed read marks its connector unavailable in the store; that one is the page's own.
    expect(connectorVerdict({ ...live, status: "error", problem: "connector_unavailable" }, { failed: true })).toEqual({
      tone: "warn",
      label: "Couldn't load",
      action: "Inspect",
    });
    expect(connectorVerdict({ ...live, status: "auth_required", problem: "oauth_required" })).toEqual({
      tone: "warn",
      label: "Authorization needed",
      action: "Connect",
    });
    expect(connectorVerdict({ ...live, status: "error", problem: "connector_unavailable" }).tone).toBe("danger");
    expect(connectorVerdict({ ...live, status: "loading" })).toEqual({
      tone: "neutral",
      label: "Loading details",
      action: null,
    });
    expect([toolsPhrase(0, 0), toolsPhrase(1, 0), toolsPhrase(3, 1)]).toEqual([
      "no tools",
      "1 tool, all read",
      "3 tools, 1 write",
    ]);
    expect(joinList([])).toBe("");
    expect(joinList(["a", "b", "c"])).toBe("a, b and c");
    expect(truncate("/mcp/a-very-long-pool-name", 17)).toBe("/mcp/a-very-long…");
    expect(monogram("GitHub")).toBe("GH");
    expect(monogram("Empty slot")).toBe("ES");
    expect(monogram("notion")).toBe("N");
    expect(monogram("Notion")).toBe("N");
    expect(endpointHref("/mcp/team")).toBe("/endpoints#mcp/team");
    expect(endpointFromHash("#mcp/team")).toBe("/mcp/team");
    expect(endpointFromHash("#tools")).toBeNull();
  });
});
