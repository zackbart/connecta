import { describe, expect, it } from "vitest";
import type { OperatorSharedSource, OperatorUiContractV2 } from "../src/operator-ui/contract.js";
import {
  connectorRunsAs,
  endpointRows,
  matrixCell,
  matrixCellLabel,
  matrixCellText,
  matrixColumns,
  runsAsLabel,
} from "../src/operator-ui/endpoints.js";
import { OPERATOR_V2_MAINTAINER, OPERATOR_V2_MEMBER } from "./fixtures/operator-contract-v2.js";

const maintainer = () => structuredClone(OPERATOR_V2_MAINTAINER) as OperatorUiContractV2;
const addresses = (contract: OperatorUiContractV2, path: string) =>
  endpointRows(contract)
    .find((row) => row.path === path)!
    .groups.flatMap((group) => group.tools.map((tool) => tool.address));

describe("endpoint rows from contract v2", () => {
  it("INV-4: lists /mcp then every pool with exact tool counts and agent URLs only for agent pools", () => {
    const rows = endpointRows(maintainer());
    expect(rows.map((row) => [row.path, row.label, row.readOnly, row.toolCount, row.agentPath])).toEqual([
      ["/mcp", "Default", false, 9, null],
      ["/mcp/ada", "ada", false, 3, "/agent/ada"],
      ["/mcp/support", "support", true, 2, "/agent/support"],
      // Team has only human members, so it has no agent URL to show.
      ["/mcp/team", "team", false, 5, null],
    ]);
    expect(addresses(maintainer(), "/mcp/ada")).toEqual(["github.read", "gmail.search", "gmail.send"]);
    expect(addresses(maintainer(), "/mcp/team")).toEqual([
      "github.read",
      "slack.search",
      "slack.post",
      "calendar.list",
      "notion.query",
    ]);
  });

  it("INV-2: a read-only endpoint serves no write tool, and a guarded grant follows the live verdict", () => {
    const contract = maintainer();
    expect(addresses(contract, "/mcp/support")).toEqual(["github.read", "drive.search"]);
    contract.root!.readOnly = true;
    expect(addresses(contract, "/mcp")).toEqual([
      "github.read",
      "gmail.search",
      "drive.search",
      "slack.search",
      "calendar.list",
      "notion.query",
    ]);
    // drive.search requires a read verdict; a changed verdict drops it at once.
    contract.live.connectors.find((c) => c.id === "drive")!.tools[0]!.classification = "write";
    contract.pools.find((p) => p.name === "support")!.readOnly = false;
    expect(addresses(contract, "/mcp/support")).toEqual(["github.read"]);
  });

  it("takes each connector's runs-as from the matching matrix cell, with null meaning /mcp", () => {
    const rows = endpointRows(maintainer());
    const runsAs = (path: string, id: string) =>
      rows.find((row) => row.path === path)!.groups.find((group) => group.config.id === id)!.runsAs;
    expect(runsAs("/mcp", "gmail")).toEqual({
      kind: "workspace",
      humans: "self",
      agents: null,
    });
    expect(runsAs("/mcp/ada", "gmail")).toEqual({
      kind: "workspace",
      humans: "self",
      agents: "ada@workspace.example",
    });
    expect(runsAs("/mcp/support", "drive")).toEqual({
      kind: "workspaceFixed",
      subject: "support@workspace.example",
    });
    const missing = maintainer();
    missing.matrix = missing.matrix.filter((cell) => !(cell.connectorId === "github" && cell.pool === "team"));
    expect(
      endpointRows(missing)
        .find((row) => row.path === "/mcp/team")!
        .groups.find((group) => group.config.id === "github")!.runsAs,
    ).toBeNull();
  });

  it("INV-4: a member contract yields no maintainer rows or matrix columns", () => {
    const member = structuredClone(OPERATOR_V2_MEMBER) as OperatorUiContractV2;
    expect(endpointRows(member)).toEqual([]);
    expect(matrixColumns(member)).toEqual([]);
  });
});

describe("runs-as labels", () => {
  const day = (value: string) => `day(${value.slice(0, 10)})`;
  it("labels where every shared source keeps its credential", () => {
    const at = "2026-10-01T09:30:00.000Z";
    const shared = (source: OperatorSharedSource, savedAt: string | null = null) =>
      runsAsLabel({ kind: "shared", source, savedAt }, day);
    expect(shared("vault", at)).toBe("Shared · saved day(2026-10-01)");
    expect(shared("oauth", at)).toBe("Shared · connected day(2026-10-01)");
    expect(shared("missing")).toBe("Shared · not configured");
    expect(shared("config")).toBe("Shared · set in deployment");
    expect(shared("unauthenticated")).toBe("Shared · no credential needed");
    // A vault or OAuth source without a date still says where it lives.
    expect(shared("vault")).toBe("Shared · saved");
    expect(shared("oauth")).toBe("Shared · connected");
    // An unparseable date is dropped rather than printed.
    expect(runsAsLabel({ kind: "shared", source: "oauth", savedAt: "not a date" })).toBe("Shared · connected");
  });

  it("labels every runs-as kind", () => {
    expect(runsAsLabel({ kind: "personal", connectedMembers: 1, members: 2 })).toBe("Personal · 1 of 2 connected");
    expect(
      runsAsLabel({
        kind: "workspace",
        humans: "self",
        agents: "ada@workspace.example",
      }),
    ).toBe("Workspace · people: self · agents: ada@workspace.example");
    expect(runsAsLabel({ kind: "workspace", humans: "self", agents: null })).toBe(
      "Workspace · people: self · agents: none",
    );
    // A fixed subject is never described as people acting as themselves.
    expect(
      runsAsLabel({
        kind: "workspaceFixed",
        subject: "support@workspace.example",
      }),
    ).toBe("Everyone acts as support@workspace.example");
  });

  it("summarizes a connector by its /mcp cell, else its first pool's", () => {
    const contract = maintainer();
    expect(connectorRunsAs(contract, "gmail")).toEqual({
      kind: "workspace",
      humans: "self",
      agents: null,
    });
    contract.matrix = contract.matrix.filter((cell) => !(cell.connectorId === "gmail" && cell.pool === null));
    expect(connectorRunsAs(contract, "gmail")).toEqual({
      kind: "workspace",
      humans: "self",
      agents: "ada@workspace.example",
    });
    expect(connectorRunsAs(contract, "absent")).toBeNull();
  });
});

describe("matrix cells", () => {
  it("INV-2: renders all, a count or a dash from the matrix, with read-only columns named", () => {
    const contract = maintainer();
    const columns = matrixColumns(contract);
    expect(columns).toEqual([
      { pool: null, path: "/mcp", readOnly: false },
      { pool: "ada", path: "/mcp/ada", readOnly: false },
      { pool: "support", path: "/mcp/support", readOnly: true },
      { pool: "team", path: "/mcp/team", readOnly: false },
    ]);
    const [root, ada, support] = columns as [(typeof columns)[0], (typeof columns)[0], (typeof columns)[0]];
    const all = matrixCell(contract, "gmail", ada);
    expect(matrixCellText(all)).toBe("all");
    expect(all).toMatchObject({
      kind: "all",
      tools: [
        { name: "search", classification: "read" },
        { name: "send", classification: "write" },
      ],
    });
    expect(matrixCellLabel("Gmail", ada, all)).toBe("Gmail on /mcp/ada: all tools");
    const some = matrixCell(contract, "github", support);
    expect(some).toMatchObject({
      kind: "some",
      tools: [{ name: "read", classification: "read" }],
    });
    expect(matrixCellText(some)).toBe("1");
    expect(matrixCellLabel("GitHub", support, some)).toBe("GitHub on /mcp/support: 1 tool, read-only");
    const none = matrixCell(contract, "slack", support);
    expect(none).toEqual({ kind: "none" });
    expect(matrixCellText(none)).toBe("—");
    expect(matrixCellLabel("Slack", support, none)).toBe("Slack on /mcp/support: no tools");
    // A named tool the live catalog no longer lists keeps its name, with no verdict.
    contract.matrix.push({
      connectorId: "drive",
      pool: "ada",
      tools: ["search", "gone"],
      runsAs: { kind: "shared", source: "missing", savedAt: null },
    });
    const stale = matrixCell(contract, "drive", ada);
    expect(stale).toMatchObject({
      kind: "some",
      tools: [
        { name: "search", classification: "read" },
        { name: "gone", classification: null },
      ],
    });
    expect(matrixCellLabel("Drive", ada, stale)).toBe("Drive on /mcp/ada: 2 tools");
    expect(matrixCell(contract, "github", root)).toMatchObject({
      kind: "all",
      runsAs: { kind: "shared" },
    });
  });
});
