import { describe, expect, it } from "vitest";
import type { OperatorUiContractV2 } from "../src/operator-ui/contract.js";
import { shownHealth, steadyHealth, type SteadyHealth } from "../src/operator-ui/health.js";
import type { UiData } from "../src/operator-ui/model.js";
import { attentionItems } from "../src/operator-ui/overview.js";
import { connectorVerdict, type OperatorState } from "../src/operator-ui/view.js";
import { OPERATOR_V2_MAINTAINER } from "./fixtures/operator-contract-v2.js";

const maintainer = () => structuredClone(OPERATOR_V2_MAINTAINER) as OperatorUiContractV2;

type HealthState = Pick<OperatorState, "generation" | "contract" | "data" | "connectorFailures">;

/** A maintainer page's health inputs: `/ui/data` marks connectors whose detail read is pending as loading. */
function page(
  contract: OperatorUiContractV2,
  options: { reading?: string[]; failed?: string[]; generation?: number } = {},
): HealthState {
  const connectors = contract.live.connectors.map((live) => ({
    id: live.id,
    status: options.reading?.includes(live.id) ? ("loading" as const) : live.status,
    toolCount: 0,
    tools: [],
  }));
  return {
    generation: options.generation ?? 1,
    contract,
    data: { connectors } as unknown as UiData,
    connectorFailures: Object.fromEntries((options.failed ?? []).map((id) => [id, "network" as const])),
  };
}

/** Each connector's label as the views show it, and the attention list's keys in order. */
function shown(state: HealthState, health: SteadyHealth) {
  const { contract, signals } = shownHealth(state.contract, health);
  return {
    labels: Object.fromEntries(
      contract!.live.connectors.map((live) => [live.id, connectorVerdict(live, signals[live.id]).label]),
    ),
    attention: attentionItems(contract!, { signals }).map((item) => item.key),
  };
}

/** A local read failure marks the contract row unavailable, as the store does. */
function failedLocally(contract: OperatorUiContractV2, id: string): OperatorUiContractV2 {
  const live = contract.live.connectors.find((row) => row.id === id)!;
  Object.assign(live, { status: "error", problem: "connector_unavailable", tools: [] });
  return contract;
}

describe("steady connector health", () => {
  it("keeps a connector's last verdict while its detail is read again", () => {
    const failed = page(failedLocally(maintainer(), "gmail"), { failed: ["gmail"] });
    const before = steadyHealth(failed, null);
    expect(shown(failed, before).labels.gmail).toBe("Couldn't load");
    // A connector refresh clears the failure and marks the row loading. The
    // contract row alone now reads "Unavailable"; the views keep "Couldn't load".
    const rereading = page(failed.contract!, { reading: ["gmail"] });
    expect(connectorVerdict(rereading.contract!.live.connectors.find((c) => c.id === "gmail")!).label).toBe(
      "Unavailable",
    );
    const during = steadyHealth(rereading, before);
    expect(during).toBe(before);
    expect(shown(rereading, during)).toEqual(shown(failed, before));
    // Its read settles: the new verdict appears once.
    const settled = page(maintainer());
    const after = steadyHealth(settled, during);
    expect(shown(settled, after).labels.gmail).toBe("Connected");
    expect(shown(settled, after).attention).toEqual(["connector:notion", "agent:triage"]);
  });

  it("updates each connector only when its own read settles, holding counts and order meanwhile", () => {
    const start = page(maintainer());
    const health = steadyHealth(start, null);
    const baseline = shown(start, health);
    // Both reads in flight, and the contract already carries the next answers.
    const next = failedLocally(maintainer(), "drive");
    const gmail = next.live.connectors.find((c) => c.id === "gmail")!;
    Object.assign(gmail, { status: "error", problem: "connector_unavailable", tools: [] });
    const reading = page(next, { reading: ["gmail", "drive"] });
    const during = steadyHealth(reading, health);
    expect(shown(reading, during)).toEqual(baseline);
    // gmail settles first; drive still shows what it showed before.
    const gmailDone = page(next, { reading: ["drive"] });
    const partial = steadyHealth(gmailDone, during);
    expect(shown(gmailDone, partial).labels).toMatchObject({ gmail: "Unavailable", drive: "Connected" });
    expect(shown(gmailDone, partial).attention).toEqual(["connector:gmail", "connector:notion", "agent:triage"]);
    // drive settles with a failed read on this page.
    const done = page(next, { failed: ["drive"] });
    const after = steadyHealth(done, partial);
    expect(shown(done, after).labels).toMatchObject({ gmail: "Unavailable", drive: "Couldn't load" });
    expect(shown(done, after).attention).toEqual([
      "connector:gmail",
      "connector:drive",
      "connector:notion",
      "agent:triage",
    ]);
  });

  it("shows the contract's verdict, never Loading details, when nothing was settled before", () => {
    const first = page(maintainer(), { reading: ["github", "gmail", "drive", "slack", "calendar", "notion"] });
    const health = steadyHealth(first, null);
    expect(Object.values(shown(first, health).labels)).not.toContain("Loading details");
    expect(shown(first, health).labels).toMatchObject({ github: "Connected", notion: "Credential needed" });
    expect(shownHealth(first.contract, health).contract).toBe(first.contract);
  });

  it("forgets held verdicts when the identity changes", () => {
    const failed = page(failedLocally(maintainer(), "gmail"), { failed: ["gmail"] });
    const before = steadyHealth(failed, null);
    const other = page(maintainer(), { reading: ["gmail"], generation: 2 });
    const after = steadyHealth(other, before);
    expect(after.generation).toBe(2);
    expect(shown(other, after).labels.gmail).toBe("Connected");
  });

  it("keeps what was shown while no contract is on screen", () => {
    const state = page(maintainer());
    const health = steadyHealth(state, null);
    expect(steadyHealth({ ...state, contract: null }, health)).toBe(health);
    expect(steadyHealth({ ...state, contract: null, generation: 2 }, health)).toEqual({ generation: 2, rows: {} });
  });
});
