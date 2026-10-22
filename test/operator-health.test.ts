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
  it.each(["constructor", "__proto__"])("holds, settles and prunes own evidence for connector id %s", (id) => {
    const contract = maintainer();
    contract.config!.connectors = [{ ...contract.config!.connectors[0]!, id }];
    contract.live.connectors = [{ ...contract.live.connectors[0]!, id }];
    const initial = page(contract, { reading: [id] });
    const first = steadyHealth(initial, null);
    expect(shown(initial, first).labels[id]).toBe("Connected");
    expect(Object.keys(first.rows)).toEqual([id]);
    expect(Object.getPrototypeOf(first.rows)).toBeNull();
    expect(Object.getPrototypeOf(shownHealth(contract, first).signals)).toBeNull();
    // An inherited name in the store's empty failures record is not a failure.
    expect(first.rows[id]!.failed).toBe(false);
    const failed = page(failedLocally(structuredClone(contract), id), { failed: [id] });
    const settled = steadyHealth(failed, first);
    expect(shown(failed, settled).labels[id]).toBe("Couldn't load");
    const rereading = page(contract, { reading: [id] });
    const held = steadyHealth(rereading, settled);
    expect(held).toBe(settled);
    expect(shown(rereading, held).labels[id]).toBe("Couldn't load");
    const done = page(contract);
    expect(shown(done, steadyHealth(done, held)).labels[id]).toBe("Connected");
    const otherIdentity = page(contract, { reading: [id], generation: 2 });
    expect(shown(otherIdentity, steadyHealth(otherIdentity, held)).labels[id]).toBe("Connected");
    const removed = structuredClone(contract);
    removed.config!.connectors = [];
    removed.live.connectors = [];
    expect(Object.keys(steadyHealth(page(removed), held).rows)).toEqual([]);
  });
});
