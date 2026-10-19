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

  it("lists connectors in config order regardless of severity, with the matching actions", () => {
    const contract = maintainer();
    const gmail = contract.live.connectors.find((c) => c.id === "gmail")!;
    gmail.status = "error";
    gmail.problem = "connector_unavailable";
    contract.live.connectors.find((c) => c.id === "slack")!.problem = "credential_mismatch";
    const items = attentionItems(contract, { signals: { drive: { failed: true } } });
    expect(items.map((item) => [item.key, item.tone, item.action?.label, item.fix?.kind ?? null])).toEqual([
      ["connector:gmail", "danger", "Inspect", "connector_unavailable"],
      ["connector:drive", "warn", "Inspect", null],
      ["connector:slack", "danger", "Replace key", "credential_mismatch"],
      ["connector:notion", "warn", "Connect", "credential_required"],
      ["agent:triage", "warn", undefined, null],
    ]);
    expect(items[0]!.problem).toBe("is unavailable");
    expect(items[1]!.body).toBe("Affects /mcp and /mcp/support");
  });

  it("keeps a problem's row and fix prompt when the detail read also failed", () => {
    const items = attentionItems(maintainer(), { signals: { notion: { failed: true } } });
    expect(items[0]).toMatchObject({
      key: "connector:notion",
      tone: "warn",
      problem: "needs a credential",
      body: "Details didn't load · Affects /mcp and /mcp/team",
      action: { label: "Connect" },
      fix: { kind: "credential_required", connectorId: "notion" },
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

describe("overview headline", () => {
  it("counts connectors by health, endpoints, people and agents", () => {
    const contract = maintainer();
    const items = attentionItems(contract);
    const headline = overviewHeadline(contract, connectionMap(contract), items);
    expect(headline).toMatchObject({
      connectors: 6,
      healthy: 5,
      warn: 1,
      danger: 0,
      endpoints: 4,
      readOnlyEndpoints: 1,
      people: 3,
      agents: 2,
    });
    expect(headline.bar.map((entry) => entry.tone)).toEqual(["ok", "ok", "ok", "ok", "ok", "warn"]);
  });

  it("has an empty bar when no connectors are declared", () => {
    const contract = maintainer();
    contract.config!.connectors = [];
    contract.live.connectors = [];
    const headline = overviewHeadline(contract, connectionMap(contract), []);
    expect(headline).toMatchObject({ connectors: 0, healthy: 0 });
    expect(headline.bar).toEqual([]);
  });
});
