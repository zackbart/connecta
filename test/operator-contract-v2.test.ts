import { describe, expect, it } from "vitest";
import type { OperatorMemberManage, OperatorUiContractV2 } from "../src/operator-ui/contract.js";
import {
  OPERATOR_V2_MEMBER,
  OPERATOR_V2_MEMBER_EXPECTED,
  OPERATOR_V2_PARTITIONS,
  operatorV2MemberSource,
} from "./fixtures/operator-contract-v2.js";
import {
  expectMemberViewWithholds,
  memberViewExpectation,
  type MemberViewExpectation,
} from "./helpers/operator-member-view.js";

type View = OperatorUiContractV2;
const connector = (view: View, id: string) => view.connectors.find((c) => c.id === id)!;
const credential = (view: View) =>
  connector(view, "notion").manage as Extract<OperatorMemberManage, { kind: "credential" }>;

function linView(mutate: (view: View) => void = () => {}): View {
  const view: View = structuredClone(OPERATOR_V2_MEMBER);
  mutate(view);
  return view;
}

function expectRejected(mutate: (view: View) => void, expected: MemberViewExpectation = OPERATOR_V2_MEMBER_EXPECTED) {
  const view = linView(mutate);
  expect(() => expectMemberViewWithholds(view, expected)).toThrow();
}

// These fixtures freeze the shape the UI builds against; the server's own
// responses are checked in operator-contract-server.test.ts.
describe("operator contract v2 fixtures", () => {
  it("INV-4 INV-5: the member fixture matches the projection built from config and membership", () => {
    expect(OPERATOR_V2_MEMBER_EXPECTED.pools.map((p) => p.name)).toEqual(["support", "team"]);
    expect(OPERATOR_V2_MEMBER_EXPECTED.connectors.map((c) => c.id)).toEqual([
      "github",
      "drive",
      "slack",
      "calendar",
      "notion",
    ]);
    expectMemberViewWithholds(OPERATOR_V2_MEMBER, OPERATOR_V2_MEMBER_EXPECTED);
    const kinds = OPERATOR_V2_MEMBER.connectors.map((c) => `${c.authScope}:${c.manage.kind}`);
    expect(kinds).toEqual(expect.arrayContaining(["personal:oauth", "personal:credential", "shared:none"]));
    // Stored-ness rides on actions alone: Lin's partition holds no Notion
    // value, so only save; Ada's holds one, so test and clear too.
    expect(credential(linView()).actions).toEqual(["save"]);
    const ada = memberViewExpectation(operatorV2MemberSource("user_ada"));
    expect(ada.connectors.find((c) => c.id === "notion")?.manage).toMatchObject({
      actions: ["save", "test", "clear"],
    });
  });

  it("INV-4 INV-5: Lin's view carrying Ada's partition status fails", () => {
    expect(OPERATOR_V2_PARTITIONS.user_ada.slack).not.toEqual(OPERATOR_V2_PARTITIONS.user_lin.slack);
    expect(OPERATOR_V2_PARTITIONS.user_ada.notion).not.toEqual(OPERATOR_V2_PARTITIONS.user_lin.notion);
    expectMemberViewWithholds(linView(), OPERATOR_V2_MEMBER_EXPECTED);
    expectRejected((view) => (connector(view, "slack").connection = { ...OPERATOR_V2_PARTITIONS.user_ada.slack }));
    expectRejected((view) => (connector(view, "notion").connection = { ...OPERATOR_V2_PARTITIONS.user_ada.notion }));
    // Ada's own view carries her state, so the same values pass against her projection.
    const ada = memberViewExpectation(operatorV2MemberSource("user_ada"));
    expect(ada.connectors.find((c) => c.id === "notion")?.connection).toEqual({ state: "ok" });
  });
});
