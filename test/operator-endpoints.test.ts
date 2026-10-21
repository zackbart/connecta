import { describe, expect, it } from "vitest";
import type { OperatorUiContractV2 } from "../src/operator-ui/contract.js";
import {
  endpointRows,
  matrixCell,
  matrixCellLabel,
  matrixCellShare,
  matrixCellText,
  matrixColumns,
} from "../src/operator-ui/endpoints.js";
import { OPERATOR_V2_MAINTAINER, OPERATOR_V2_MEMBER } from "./fixtures/operator-contract-v2.js";

const maintainer = () => structuredClone(OPERATOR_V2_MAINTAINER) as OperatorUiContractV2;
const addresses = (contract: OperatorUiContractV2, path: string) =>
  endpointRows(contract)
    .find((row) => row.path === path)!
    .groups.flatMap((group) => group.tools.map((tool) => tool.address));

describe("endpoint rows from contract v2", () => {
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

  it("INV-2: connector readOnly removes writes from writable endpoint tool counts", () => {
    const contract = maintainer();
    contract.config!.connectors.find((connector) => connector.id === "slack")!.readOnly = true;
    expect(addresses(contract, "/mcp")).toContain("slack.search");
    expect(addresses(contract, "/mcp")).not.toContain("slack.post");
    expect(addresses(contract, "/mcp/team")).not.toContain("slack.post");
  });

  it("INV-4: a member contract yields no maintainer rows or matrix columns", () => {
    const member = structuredClone(OPERATOR_V2_MEMBER) as OperatorUiContractV2;
    expect(endpointRows(member)).toEqual([]);
    expect(matrixColumns(member)).toEqual([]);
  });
});

describe("matrix cells", () => {
  it("names the same granted count against differing live catalog sizes", () => {
    const contract = maintainer();
    const column = matrixColumns(contract).find((c) => c.pool === "support")!;
    expect(matrixCellLabel("GitHub", column, matrixCell(contract, "github", column))).toBe(
      "GitHub on /mcp/support: 1 of 2 live tools, read-only",
    );
    expect(matrixCellLabel("Drive", column, matrixCell(contract, "drive", column))).toBe(
      "Drive on /mcp/support: 1 of 1 live tools, read-only",
    );
  });

  it("distinguishes unavailable catalogs from a known empty catalog for all and named grants", () => {
    const contract = maintainer();
    const overlay = contract.live.connectors.find((c) => c.id === "github")!;
    const column = matrixColumns(contract).find((c) => c.pool === "team")!;
    const checkUnknown = () => {
      for (const pool of [null, "team"]) {
        const cell = matrixCell(contract, "github", { pool });
        expect(matrixCellShare(cell)).toBeNull();
        expect(matrixCellText(cell)).toBe("?");
        expect(matrixCellLabel("GitHub", column, cell)).toBe("GitHub on /mcp/team: unknown live tool coverage");
      }
    };
    overlay.tools = [];
    overlay.problem = "catalog_failed";
    checkUnknown();
    delete overlay.problem;
    overlay.status = "auth_required";
    checkUnknown();
    contract.live.connectors = contract.live.connectors.filter((c) => c.id !== "github");
    checkUnknown();
    contract.live.connectors.push({ ...overlay, status: "ok" });
    expect(matrixCellShare(matrixCell(contract, "github", column))).toBe(0);
    expect(matrixCellLabel("GitHub", column, matrixCell(contract, "github", column))).toBe(
      "GitHub on /mcp/team: 0 of 0 live tools",
    );
  });
});

describe("glance marks", () => {
  it("gives a matrix cell's pie its share of the live catalog", () => {
    const contract = maintainer();
    const share = (id: string, pool: string | null) => matrixCellShare(matrixCell(contract, id, { pool }));
    expect(share("gmail", "ada")).toBe(1);
    expect(share("github", "team")).toBe(0.5);
    expect(share("slack", "support")).toBe(0);
    // Retired names remain inspectable but never count toward live coverage.
    const grant = contract.matrix.find((c) => c.connectorId === "github" && c.pool === "team")!;
    grant.tools = ["retired"];
    expect(share("github", "team")).toBe(0);
    grant.tools = ["read", "retired"];
    expect(share("github", "team")).toBe(0.5);
    grant.tools = ["read", "write", "retired"];
    expect(share("github", "team")).toBe(1);
  });
});
