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
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "holds, settles and prunes own evidence for connector id %s",
    (id) => {
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
    },
  );

  it("keeps attention rows in config order through each publication of a full refresh", () => {
    const old = maintainer();
    for (const id of ["github", "gmail"]) {
      Object.assign(
        old.live.connectors.find((row) => row.id === id)!,
        {
          status: "error",
          problem: "catalog_failed",
        },
      );
    }
    const start = page(old);
    let health = steadyHealth(start, null);
    const order = shown(start, health).attention;
    expect(order).toEqual(["connector:github", "connector:gmail", "connector:notion", "agent:triage"]);
    const next = structuredClone(old);
    for (const id of ["github", "gmail"]) {
      Object.assign(
        next.live.connectors.find((row) => row.id === id)!,
        {
          status: "auth_required",
          problem: "oauth_required",
        },
      );
    }
    for (const reading of [["github", "gmail"], ["gmail"], []]) {
      const state = page(next, { reading });
      health = steadyHealth(state, health);
      expect(shown(state, health).attention).toEqual(order);
      expect(shown(state, health).labels.github).toBe(
        reading.includes("github") ? "Catalog failed" : "Authorization needed",
      );
      expect(shown(state, health).labels.gmail).toBe(
        reading.includes("gmail") ? "Catalog failed" : "Authorization needed",
      );
    }
  });

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
