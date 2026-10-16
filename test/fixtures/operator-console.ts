// UI-3 additions to the frozen v2 fixtures in operator-contract-v2.ts, which
// stay untouched: a team pool long enough to collapse its "who can use it"
// chips, and the slot list for its two agents. Every value is synthetic.
import type { OperatorMember, OperatorUiContractV2 } from "../../src/operator-ui/contract.js";
import type { AgentSlot } from "../../src/operator-ui/agents.js";
import { OPERATOR_V2_MAINTAINER, OPERATOR_V2_MEMBER } from "./operator-contract-v2.js";

const CLERK = "https://clerk.example.test";
const human = (id: string, label: string | null): OperatorMember => ({ kind: "human", namespace: CLERK, id, label });

/**
 * Five more people on team: seven in all, so the row shows four and "+3 more".
 * People only, so team still has no agent URL.
 */
const TEAM_EXTRA_MEMBERS: OperatorMember[] = [
  human("user_noor", "Noor Haddad"),
  human("user_kai", "Kai Brennan"),
  human("user_omar", null),
  human("user_priya", "Priya Shah"),
  human("user_sam", "Sam Okafor"),
];

/** The frozen maintainer view with a crowded team pool. */
export function crowdedMaintainer(): OperatorUiContractV2 {
  const contract = structuredClone(OPERATOR_V2_MAINTAINER) as OperatorUiContractV2;
  const team = contract.pools.find((pool) => pool.name === "team")!;
  team.members = [...team.members, ...structuredClone(TEAM_EXTRA_MEMBERS)];
  return contract;
}

/** `GET /ui/access-tokens` for the frozen maintainer's agents, at the revisions its contract lists. */
export const OPERATOR_V2_SLOTS: { agents: AgentSlot[] } = {
  agents: [
    { name: "simon-ada", state: "issued", issuedAt: "2026-10-01T09:30:00.000Z", revision: "simonAdaIssuedRevision" },
    { name: "triage", state: "none", revision: "triageNoneRevision0000" },
  ],
};

/**
 * The frozen member view with Notion's credential `actions` replaced. Per P6b,
 * presence is read from `actions` alone: `save` when the member may manage it
 * and a vault exists, `clear` only when a value is stored in their own
 * partition, `test` only when one is stored and the connector can test it.
 * The frozen fixture lists all three while Notion's state is
 * `credential_required`, so pages that want "nothing stored yet" use `["save"]`.
 */
export function memberWithNotion(actions: Array<"save" | "test" | "clear">): OperatorUiContractV2 {
  const contract = structuredClone(OPERATOR_V2_MEMBER) as OperatorUiContractV2;
  const notion = contract.connectors.find((connector) => connector.id === "notion")!;
  if (notion.manage.kind !== "credential") throw new Error("Notion is a credential connector");
  notion.manage.actions = actions;
  if (actions.includes("clear")) notion.connection = { state: "ok" };
  return contract;
}
