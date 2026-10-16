import { describe, expect, it } from "vitest";
import { accessChips, endpointRows, visibleChips } from "../src/operator-ui/endpoints.js";
import {
  agentRows,
  lastSeenLabel,
  slotActions,
  slotBadge,
  slotSince,
  tokenFailureNotice,
} from "../src/operator-ui/agents.js";
import { memberConfirmCopy, memberPage, toolCountLabel } from "../src/operator-ui/member-page.js";
import type {
  OperatorMemberConnector,
  OperatorMemberManage,
  OperatorUiContractV2,
} from "../src/operator-ui/contract.js";
import { OPERATOR_V2_MAINTAINER, OPERATOR_V2_MEMBER } from "./fixtures/operator-contract-v2.js";

const maintainer = () => structuredClone(OPERATOR_V2_MAINTAINER) as OperatorUiContractV2;
const member = () => structuredClone(OPERATOR_V2_MEMBER) as OperatorUiContractV2;
const day = (value: string) => value.slice(0, 10);
const CLERK = "https://clerk.example.test";

describe("who can use an endpoint", () => {
  it("lists root maintainers on /mcp and pool members elsewhere, by label or raw id", () => {
    const rows = endpointRows(maintainer());
    expect(rows.map((row) => [row.path, row.access.map((chip) => chip.text)])).toEqual([
      ["/mcp", ["Ada Lovelace", "user_grace"]],
      ["/mcp/ada", ["Ada Lovelace", "agent:simon-ada"]],
      ["/mcp/support", ["Lin Chen", "agent:triage"]],
      ["/mcp/team", ["Ada Lovelace", "Lin Chen"]],
    ]);
  });

  it("marks agents apart from people and gives each person stable initials and tint", () => {
    const chips = accessChips([
      { kind: "agent", name: "nightly" },
      { kind: "human", namespace: CLERK, id: "user_ada", label: "Ada Lovelace" },
      { kind: "human", namespace: CLERK, id: "user_grace", label: null },
      { kind: "human", namespace: CLERK, id: "user_ada", label: "Ada Lovelace" },
    ]);
    // People first, agents after, each member once.
    expect(chips.map(({ kind, text, initials }) => [kind, text, initials])).toEqual([
      ["human", "Ada Lovelace", "AL"],
      ["human", "user_grace", "GR"],
      ["agent", "agent:nightly", ""],
    ]);
    expect(new Set(chips.map((chip) => chip.key)).size).toBe(3);
    const again = accessChips([{ kind: "human", namespace: CLERK, id: "user_ada", label: "Renamed" }]);
    expect(again[0]!.hue).toBe(chips[0]!.hue);
    for (const chip of chips) expect(chip.hue).toBeGreaterThanOrEqual(0);
    for (const chip of chips) expect(chip.hue).toBeLessThan(6);
  });

  it("shows four chips and a count of the rest until expanded", () => {
    const many = accessChips(
      Array.from({ length: 7 }, (_, index) => ({
        kind: "human" as const,
        namespace: CLERK,
        id: `user_${index}`,
        label: `Person ${index}`,
      })),
    );
    const collapsed = visibleChips(many, false);
    expect(collapsed.shown.map((chip) => chip.text)).toEqual(["Person 0", "Person 1", "Person 2", "Person 3"]);
    expect(collapsed.hidden).toBe(3);
    expect(visibleChips(many, true)).toEqual({ shown: many, hidden: 0 });
    expect(visibleChips(many.slice(0, 4), false)).toEqual({ shown: many.slice(0, 4), hidden: 0 });
  });

  it("INV-4: a member contract yields no endpoint rows and so no chips", () => {
    expect(endpointRows(member())).toEqual([]);
  });
});

describe("agent token slots", () => {
  it("joins the live slot list with the contract's pools and last seen, list first", () => {
    const rows = agentRows(maintainer(), [
      { name: "triage", state: "revoked", revokedAt: "2026-10-09T00:00:00.000Z" },
      { name: "simon-ada", state: "issued", issuedAt: "2026-10-01T09:30:00.000Z" },
      { name: "undeclared-yet", state: "none" },
    ]);
    expect(
      rows.map(({ name, pools, slot, lastSeenAt, actions }) => [name, pools, slot.state, lastSeenAt, actions]),
    ).toEqual([
      // The list is newer than the contract's "none" for triage.
      ["triage", ["support"], "revoked", null, ["issue"]],
      ["simon-ada", ["ada"], "issued", "2026-10-08T12:00:00.000Z", ["rotate", "revoke"]],
      ["undeclared-yet", [], "none", null, ["issue"]],
    ]);
  });

  it("shows the contract's own slots before the list has loaded", () => {
    const rows = agentRows(maintainer(), []);
    expect(rows.map((row) => [row.name, row.slot])).toEqual([
      [
        "simon-ada",
        {
          name: "simon-ada",
          state: "issued",
          issuedAt: "2026-10-01T09:30:00.000Z",
          revision: "simonAdaIssuedRevision",
        },
      ],
      ["triage", { name: "triage", state: "none", revision: "triageNoneRevision0000" }],
    ]);
  });

  it("blocks a row the live list lacks or an unknown outcome left unresolved, with the reason", () => {
    const triage = { name: "triage", state: "none" as const, revision: "triageNoneRevision0000" };
    const rows = agentRows(maintainer(), [triage], ["triage"]);
    expect(rows.map((row) => [row.name, row.live, row.blocked])).toEqual([
      ["triage", true, "Refresh to continue"],
      ["simon-ada", false, "Token state unavailable, refresh"],
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

  it("offers issue for none or revoked, rotate and revoke for issued", () => {
    expect(slotActions({ state: "none" })).toEqual(["issue"]);
    expect(slotActions({ state: "revoked" })).toEqual(["issue"]);
    expect(slotActions({ state: "issued" })).toEqual(["rotate", "revoke"]);
  });

  it("labels state, its date and last seen", () => {
    expect(slotBadge({ state: "none" })).toEqual({ label: "No token", tone: "neutral" });
    expect(slotBadge({ state: "issued" })).toEqual({ label: "Issued", tone: "ok" });
    expect(slotBadge({ state: "revoked" })).toEqual({ label: "Revoked", tone: "warn" });
    expect(slotSince({ name: "a", state: "issued", issuedAt: "2026-10-01T09:30:00Z" }, day)).toBe("Issued 2026-10-01");
    expect(slotSince({ name: "a", state: "revoked", revokedAt: "2026-10-02T00:00:00Z" }, day)).toBe(
      "Revoked 2026-10-02",
    );
    expect(slotSince({ name: "a", state: "none" }, day)).toBe("—");
    expect(lastSeenLabel(null, day)).toBe("never");
    expect(lastSeenLabel("2026-10-08T12:00:00Z", day)).toBe("2026-10-08");
  });

  it("INV-6: says unknown and aborted outcomes in fixed sentences, never the route's words", () => {
    const refused = (status: number) => ({ kind: "refused" as const, status, problem: "route text sentinel" });
    expect(tokenFailureNotice("rotate", "simon", refused(503), "Connecta").message).toBe(
      "Rotation outcome unknown for simon: no secret was returned, so rotate again for a replacement.",
    );
    expect(tokenFailureNotice("revoke", "simon", refused(503), "Connecta").message).toBe(
      "Revocation outcome unknown for simon: revoke again to be sure its token is stopped.",
    );
    expect(tokenFailureNotice("issue", "simon", refused(499), "Connecta").message).toBe(
      "The request ended before simon's token was delivered, so no secret was returned. Refresh to check its token before trying again.",
    );
    expect(tokenFailureNotice("revoke", "simon", refused(499), "Connecta").message).toContain("revocation finished");
    expect(tokenFailureNotice("rotate", "simon", refused(409), "Connecta").message).toContain("changed meanwhile");
    expect(
      tokenFailureNotice("rotate", "simon", { kind: "refused", status: 409, code: "slot_changed" }, "Connecta").message,
    ).toBe("Changed since you looked, refresh.");
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
  it("lists their endpoints, their own accounts and what is shared, from the member contract", () => {
    const page = memberPage(member());
    expect(page.endpoints).toEqual([
      { pool: "support", path: "/mcp/support" },
      { pool: "team", path: "/mcp/team" },
    ]);
    expect(page.accounts.map((a) => [a.id, a.toolCount, a.badge, a.controls.map((c) => c.label)])).toEqual([
      ["slack", 2, { label: "Connected", tone: "ok" }, ["Reconnect", "Disconnect"]],
      // The frozen fixture lists clear for Notion: a value is stored, whatever the state says.
      ["notion", 1, { label: "Credential needed", tone: "warn" }, ["Replace", "Test", "Clear"]],
      ["calendar", 1, { label: "Connected", tone: "ok" }, ["Disconnect"]],
    ]);
    expect(page.accounts.map((a) => a.controls.map((c) => c.kind))).toEqual([
      ["restart", "disconnect"],
      ["save", "test", "clear"],
      ["disconnect"],
    ]);
    expect(page.shared).toEqual([
      { id: "github", title: "GitHub", toolCount: 1 },
      { id: "drive", title: "Drive", toolCount: 1 },
    ]);
  });

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
  const credential = {
    kind: "credential",
    label: "Key",
    actions: ["save", "test", "clear"],
  } satisfies OperatorMemberManage;

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

  it("reads credential presence from actions alone, never from connection state", () => {
    const labels = (actions: Array<"save" | "test" | "clear">, connection: OperatorMemberConnector["connection"]) =>
      account(connection, { ...credential, actions }).controls.map((c) => c.label);
    // The same three shapes whatever the state claims.
    for (const connection of [
      { state: "ok" as const },
      { state: "credential_required" as const, problem: "credential_required" as const },
      { state: "credential_required" as const, problem: "credential_mismatch" as const },
    ]) {
      expect(labels(["save"], connection)).toEqual(["Add credential"]);
      expect(labels(["save", "clear"], connection)).toEqual(["Replace", "Clear"]);
      expect(labels(["save", "test", "clear"], connection)).toEqual(["Replace", "Test", "Clear"]);
    }
    expect(labels([], { state: "credential_required", problem: "credential_required" })).toEqual([]);
    expect(account({ state: "ok" }, { ...credential, actions: ["save"] }).summary).toBe(
      "Add your credential to use its tools.",
    );
    expect(account({ state: "credential_required", problem: "credential_mismatch" }, credential).summary).toBe(
      "Your saved credential no longer fits. Replace it.",
    );
    expect(account({ state: "ok" }, { ...credential, actions: ["save", "clear"] }).summary).toBe(
      "Your credential is saved.",
    );
  });

  it("gives a no-manage personal connector its name and badge only", () => {
    const row = account({ state: "ok" }, { kind: "none" });
    expect(row.controls).toEqual([]);
    expect(row.badge).toEqual({ label: "Connected", tone: "ok" });
  });

  it("says counts and confirms in the member's own words", () => {
    expect(toolCountLabel(1)).toBe("1 tool");
    expect(toolCountLabel(3)).toBe("3 tools");
    expect(memberConfirmCopy("oauth_disconnect", "Slack")).toEqual({
      question: "Disconnect your Slack account? Its tools stop working for you until you connect again.",
      confirm: "Disconnect",
    });
    expect(memberConfirmCopy("credential_remove", "Notion").confirm).toBe("Clear");
    expect(memberConfirmCopy("oauth_restart", "Slack").confirm).toBe("Reconnect");
  });
});
