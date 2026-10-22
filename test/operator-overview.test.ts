import { describe, expect, it } from "vitest";
import type { OperatorUiContractV2 } from "../src/operator-ui/contract.js";
import { connectionMap } from "../src/operator-ui/connection-map.js";
import { attentionItems, overviewHeadline } from "../src/operator-ui/overview.js";
import { OPERATOR_V2_MAINTAINER, OPERATOR_V2_MEMBER } from "./fixtures/operator-contract-v2.js";

const maintainer = () => structuredClone(OPERATOR_V2_MAINTAINER) as OperatorUiContractV2;

describe("overview attention list", () => {
  it("gives each problem its existing fix and fix prompt, and each tokenless agent the Tokens page", () => {
    const items = attentionItems(maintainer(), { tokensPage: true });
    expect(items).toEqual([
      {
        key: "connector:notion",
        kind: "connector",
        tone: "warn",
        subject: "Notion",
        problem: "needs a credential",
        body: "Affects /mcp and /mcp/team",
        action: { label: "Connect", href: "/connectors/notion#connection", ariaLabel: "Connect Notion" },
        href: "/connectors/notion#connection",
        fix: { kind: "credential_required", connectorId: "notion" },
      },
      {
        key: "agent:triage",
        kind: "agent",
        tone: "warn",
        subject: "triage",
        problem: "has no token",
        body: "Can't connect at /agent/support",
        action: { label: "Issue token", href: "/tokens", ariaLabel: "Issue a token for triage" },
        href: "/tokens",
        fix: null,
      },
    ]);
    // Without the Tokens page the row stays, with nothing to click.
    expect(attentionItems(maintainer()).find((item) => item.kind === "agent")).toMatchObject({
      action: null,
      href: null,
    });
  });

  it("is empty when everything is healthy, and for a member", () => {
    const contract = maintainer();
    const notion = contract.live.connectors.find((c) => c.id === "notion")!;
    notion.status = "ok";
    delete notion.problem;
    contract.agents[1]!.token = { state: "issued", issuedAt: "2026-10-02T00:00:00.000Z", revision: "r" };
    expect(attentionItems(contract)).toEqual([]);
    expect(attentionItems(structuredClone(OPERATOR_V2_MEMBER) as OperatorUiContractV2)).toEqual([]);
    const headline = overviewHeadline(contract, connectionMap(contract), []);
    expect(headline).toMatchObject({ connectors: 6, healthy: 6, warn: 0, danger: 0 });
  });
});
