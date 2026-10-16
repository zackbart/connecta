import type { OperatorAgent, OperatorUiContractV2 } from "./contract.js";
import { failure, type Notice, type RequestFailureFacts, type Tone } from "./view.js";

/**
 * The Tokens page's rows, computed from the slot list and contract v2 alone.
 * Agents are declared in code: a row's only controls are its token's issue,
 * rotate and revoke, so nothing here creates, renames or rebinds one.
 */

/** One declared agent's token slot, as `GET /ui/access-tokens` returns it. */
export type AgentSlot = (
  | { name: string; state: "none" }
  | { name: string; state: "issued"; issuedAt: string }
  | { name: string; state: "revoked"; revokedAt: string }
) & {
  /**
   * The route's opaque slot revision; it changes on every slot commit (P3b,
   * #837). A slot read without one is unresolved and never acted on.
   */
  revision?: string;
};

/** Issue and rotate are the same request; the slot's state names it. */
export type SlotAction = "issue" | "rotate" | "revoke";

export interface AgentRow {
  name: string;
  /** Pools it belongs to, from `agents[].pools`; empty when the contract does not list it. */
  pools: string[];
  slot: AgentSlot;
  /**
   * Whether `slot` comes from the live slot list. Only a live slot can be
   * acted on: one known only from the contract may be stale, so its controls
   * are disabled until a refresh lists it.
   */
  live: boolean;
  /** Why its controls are off, or null when they work. */
  blocked: string | null;
  /** Its latest activity row; null is "never" (or history that is off). */
  lastSeenAt: string | null;
  actions: SlotAction[];
}

/** Why a row's controls are disabled when its slot is not in the live list. */
const SLOT_UNAVAILABLE = "Token state unavailable, refresh";
/** Why a row's controls are disabled until a fresh list read resolves its slot. */
const SLOT_UNRESOLVED = "Refresh to continue";

export function slotActions(slot: Pick<AgentSlot, "state">): SlotAction[] {
  return slot.state === "issued" ? ["rotate", "revoke"] : ["issue"];
}

function contractSlot(agent: OperatorAgent): AgentSlot {
  return { name: agent.name, ...agent.token };
}

function maintainerAgents(contract: OperatorUiContractV2 | null): OperatorAgent[] {
  return contract?.role === "maintainer" ? contract.agents : [];
}

/**
 * One agent's slot, resolved once for both what the row shows and what an
 * action may do. The live slot list is authoritative; the contract's copy is
 * shown only for an agent the list does not have, and is never acted on.
 */
export function resolveSlot(
  contract: OperatorUiContractV2 | null,
  slots: AgentSlot[],
  name: string,
): { slot: AgentSlot; live: boolean } | null {
  const listed = slots.find((slot) => slot.name === name);
  if (listed) return { slot: listed, live: true };
  const agent = maintainerAgents(contract).find((candidate) => candidate.name === name);
  return agent ? { slot: contractSlot(agent), live: false } : null;
}

/**
 * One row per declared agent, in the slot list's order, then any agent only
 * the contract lists. The contract adds pools and last seen.
 */
export function agentRows(
  contract: OperatorUiContractV2 | null,
  slots: AgentSlot[],
  unresolved: readonly string[] = [],
): AgentRow[] {
  const agents = maintainerAgents(contract);
  const declared = new Map(agents.map((agent) => [agent.name, agent]));
  const names = [...slots.map((slot) => slot.name), ...agents.map((agent) => agent.name)];
  return [...new Set(names)].map((name) => {
    const { slot, live } = resolveSlot(contract, slots, name)!;
    const agent = declared.get(name);
    return {
      name,
      pools: agent?.pools ?? [],
      slot,
      live,
      blocked: !live ? SLOT_UNAVAILABLE : unresolved.includes(name) || !slot.revision ? SLOT_UNRESOLVED : null,
      lastSeenAt: agent?.lastSeenAt ?? null,
      actions: slotActions(slot),
    };
  });
}

export function slotBadge(slot: Pick<AgentSlot, "state">): { label: string; tone: Tone } {
  if (slot.state === "issued") return { label: "Issued", tone: "ok" };
  if (slot.state === "revoked") return { label: "Revoked", tone: "warn" };
  return { label: "No token", tone: "neutral" };
}

/** When the slot last changed, as "Issued <date>" or "Revoked <date>"; a dash when it never has. */
export function slotSince(slot: AgentSlot, format: (value: string) => string): string {
  if (slot.state === "issued") return `Issued ${format(slot.issuedAt)}`;
  if (slot.state === "revoked") return `Revoked ${format(slot.revokedAt)}`;
  return "—";
}

export function lastSeenLabel(lastSeenAt: string | null, format: (value: string) => string): string {
  return lastSeenAt ? format(lastSeenAt) : "never";
}

/**
 * Why a token operation did not land, in fixed sentences keyed by status.
 * `outcome_unknown` (503) and `aborted` (499) are failures like any other and
 * are never retried for the operator: an unknown rotation returned no secret,
 * and only a new, deliberate rotation produces one.
 */
export function tokenFailureNotice(
  action: SlotAction,
  name: string,
  facts: RequestFailureFacts,
  productName: string,
): Notice {
  if (facts.kind === "session") return failure("Your session has ended. Sign in again, then retry.");
  if (facts.kind === "forbidden") return failure("You don't have permission to manage agent tokens.");
  if (facts.kind === "stale") {
    return failure(`${name}'s token changed before the request was sent, so nothing was sent. Check it and try again.`);
  }
  if (facts.kind === "network") {
    return failure(`Couldn't reach ${productName}. Refresh to check ${name}'s token before trying again.`);
  }
  if (facts.status === 503) {
    return failure(
      action === "revoke"
        ? `Revocation outcome unknown for ${name}: revoke again to be sure its token is stopped.`
        : `${action === "issue" ? "Issue" : "Rotation"} outcome unknown for ${name}: no secret was returned, so rotate again for a replacement.`,
    );
  }
  if (facts.status === 499) {
    return failure(
      action === "revoke"
        ? `The request ended before ${name}'s revocation finished. Refresh to check its token before trying again.`
        : `The request ended before ${name}'s token was delivered, so no secret was returned. Refresh to check its token before trying again.`,
    );
  }
  // The route's compare-and-swap refused it: the slot moved after the list was read.
  if (facts.status === 409 && facts.code === "slot_changed") return failure("Changed since you looked, refresh.");
  if (facts.status === 409) return failure(`${name}'s token changed meanwhile. Reload and try again.`);
  if (facts.status === 404) return failure(`${name} is no longer declared in code. Reload the page.`);
  return action === "revoke"
    ? failure(`${name}'s token could not be revoked. Reload and try again.`)
    : failure(`A token could not be issued for ${name}. Reload and try again.`);
}
