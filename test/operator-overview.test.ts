import { describe, expect, it } from "vitest";
import type { OperatorUiContractV2 } from "../src/operator-ui/contract.js";
import { attentionItems } from "../src/operator-ui/overview.js";
import { OPERATOR_V2_MAINTAINER } from "./fixtures/operator-contract-v2.js";

const maintainer = () => structuredClone(OPERATOR_V2_MAINTAINER) as OperatorUiContractV2;

describe("overview attention list", () => {
  it("gives each problem its existing fix and fix prompt, and each tokenless agent the Tokens page", () => {
    const items = attentionItems(maintainer(), { tokensPage: true });
    expect(items).toEqual([
      {
        key: "connector:notes",
        kind: "connector",
        tone: "warn",
        subject: "Notes",
        problem: "needs a credential",
        body: "Affects /mcp and /mcp/team",
        action: { label: "Connect", href: "/connectors/notes#connection", ariaLabel: "Connect Notes" },
        href: "/connectors/notes#connection",
        fix: { kind: "credential_required", connectorId: "notes" },
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
});
