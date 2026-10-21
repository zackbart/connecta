import { describe, expect, it } from "vitest";
import { agentRows, tokenFailureNotice } from "../src/operator-ui/agents.js";
import { memberPage } from "../src/operator-ui/member-page.js";
import type {
  OperatorMemberConnector,
  OperatorMemberManage,
  OperatorUiContractV2,
} from "../src/operator-ui/contract.js";
import { OPERATOR_V2_MAINTAINER, OPERATOR_V2_MEMBER } from "./fixtures/operator-contract-v2.js";

const maintainer = () => structuredClone(OPERATOR_V2_MAINTAINER) as OperatorUiContractV2;
const member = () => structuredClone(OPERATOR_V2_MEMBER) as OperatorUiContractV2;

describe("agent token slots", () => {
  it("blocks a row the live list lacks or an unknown outcome left unresolved, with the reason", () => {
    const triage = { name: "triage", state: "none" as const, revision: "triageNoneRevision0000" };
    const rows = agentRows(maintainer(), [triage], ["triage"]);
    expect(rows.map((row) => [row.name, row.live, row.blocked])).toEqual([
      ["triage", true, "Refresh to continue"],
      ["simon-ada", false, "Token state unknown. Refresh."],
    ]);
    expect(agentRows(maintainer(), [triage])[0]!.blocked).toBeNull();
    // A slot read without a revision cannot be acted on either (P3b, #837).
    expect(agentRows(maintainer(), [{ name: "triage", state: "none" }])[0]!.blocked).toBe("Refresh to continue");
  });

  it("INV-4: never reads agents from a member contract", () => {
    const contract = member();
    contract.agents = maintainer().agents;
    expect(agentRows(contract, [])).toEqual([]);
  });

  it("INV-6: says unknown and aborted outcomes in fixed sentences, never the route's words", () => {
    const refused = (status: number) => ({ kind: "refused" as const, status, problem: "route text sentinel" });
    expect(tokenFailureNotice("rotate", "simon", refused(503), "Connecta").message).toBe(
      "Rotate result unknown for simon. No secret came back, so rotate again.",
    );
    expect(tokenFailureNotice("revoke", "simon", refused(503), "Connecta").message).toBe(
      "Revoke result unknown for simon. Revoke again to be sure.",
    );
    expect(tokenFailureNotice("issue", "simon", refused(499), "Connecta").message).toBe(
      "The request ended before simon's token arrived. Refresh to check its token.",
    );
    expect(tokenFailureNotice("revoke", "simon", refused(499), "Connecta").message).toContain("revoke finished");
    expect(tokenFailureNotice("rotate", "simon", refused(409), "Connecta").message).toContain("token changed. Reload");
    expect(
      tokenFailureNotice("rotate", "simon", { kind: "refused", status: 409, code: "slot_changed" }, "Connecta").message,
    ).toBe("Changed since you looked. Refresh.");
    expect(tokenFailureNotice("rotate", "simon", { kind: "network" }, "Connecta").message).toContain(
      "Couldn't reach Connecta",
    );
    for (const status of [400, 409, 499, 503]) {
      for (const action of ["issue", "rotate", "revoke"] as const) {
        const notice = tokenFailureNotice(action, "simon", refused(status), "Connecta");
        expect(notice.tone).toBe("error");
        expect(notice.message).not.toContain("sentinel");
        expect(notice.fix).toBeUndefined();
      }
    }
  });
});

describe("member page", () => {
  it("INV-4: builds nothing from a maintainer contract", () => {
    expect(memberPage(maintainer())).toEqual({ endpoints: [], accounts: [], shared: [] });
    expect(memberPage(null)).toEqual({ endpoints: [], accounts: [], shared: [] });
  });

  const account = (connection: OperatorMemberConnector["connection"], manage: OperatorMemberConnector["manage"]) => {
    const contract = member();
    contract.connectors = [
      {
        id: "x",
        title: "X",
        pools: ["team"],
        authScope: "personal",
        tools: [{ address: "x.read", classification: "read" }],
        connection,
        manage,
      },
    ];
    return memberPage(contract).accounts[0]!;
  };
  const oauth: OperatorMemberManage = { kind: "oauth", actions: ["connect", "restart", "disconnect"] };

  it("drives OAuth controls by actions and state: continue to connect, restart to reconnect", () => {
    const kinds = (state: "ok" | "auth_required" | "error") => account({ state }, oauth).controls;
    expect(kinds("auth_required")).toEqual([{ kind: "connect", label: "Connect" }]);
    expect(kinds("error")).toEqual([
      { kind: "connect", label: "Reconnect" },
      { kind: "disconnect", label: "Disconnect" },
    ]);
    expect(kinds("ok")).toEqual([
      { kind: "restart", label: "Reconnect" },
      { kind: "disconnect", label: "Disconnect" },
    ]);
    // Actions the deployment does not allow never render.
    expect(account({ state: "auth_required" }, { kind: "oauth", actions: ["disconnect"] }).controls).toEqual([]);
    expect(account({ state: "ok" }, { kind: "oauth", actions: ["connect"] }).controls).toEqual([]);
  });
});
