import { AccessTokenManager,accessTokens } from "../../src/access-tokens.js";
import { activityHistory,type ToolCallActivityEvent } from "../../src/activity.js";
import { encryptedCredentialVault } from "../../src/credentials.js";
import type { AgentSlot } from "../../src/operator-ui/agents.js";
import type { OperatorUiContractV2 } from "../../src/operator-ui/contract.js";
import type { UiData } from "../../src/operator-ui/model.js";
import type { UiActivityEvent } from "../../src/operator-ui/view.js";
import { memoryStorage } from "../../src/storage/memory.js";
import type { Connector,InboundAuth } from "../../src/types.js";
import { createTestConnecta } from "../helpers.js";
import { fakeClerkAuth } from "./http.js";
import { crowdedMaintainer } from "./operator-console.js";

export const VISUAL_NOW = "2026-10-08T12:00:00.000Z";
export const VISUAL_ORIGIN = "https://connecta.example";
export const VISUAL_TOKEN = "visual-operator";

// The contract and legacy auth details come from the current server serializers,
// not a separately maintained copy of their JSON. Collections use their browser
// contract types. All volatile values are fixed in this one fixture module.
// The maintainer view is the server's own v2 answer; its people carry labels
// from the fake directory below.
export interface OperatorVisualFixture {
  contract: OperatorUiContractV2;
  data: UiData;
  activity: { events: UiActivityEvent[]; nextCursor?: string };
  tokens: { agents: AgentSlot[] };
}

const catalog = [
  { name: "read", description: "Read repository metadata", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { owner: { type: "string" } }, required: ["owner"] }, outputSchema: { type: "array", items: { type: "string" } } },
  { name: "write", description: "Update an issue", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
];
const call: ToolCallActivityEvent = {
  schemaVersion: 1, id: "call-one", requestId: "request-one", occurredAt: VISUAL_NOW,
  actor: { kind: "clerk", id: "alice", namespace: "https://clerk.example.test" },
  connectorId: "github", toolName: "read", address: "github.read", source: "call_tool",
  outcome: "success", durationMs: 8, attempts: 1, classification: "read", resultBytes: 42,
  serverName: "Production", serverVersion: "1", packageVersion: "0.29.0", clientName: "Claude Code", clientVersion: "2.1.0",
};
const events: ToolCallActivityEvent[] = [
  call,
  { ...call, id: "call-two", toolName: "write", address: "github.write", classification: "write", outcome: "error", errorCode: "connector_call_failed" },
  { ...call, id: "drift", requestId: "refresh-one", kind: "catalog_drift", source: "catalog_refresh", toolName: "<catalog>", address: "github.<catalog>", drift: { kind: "catalog_changed", addedTools: 1, removedTools: 2, changedTools: 3 } },
  // Legacy rows deliberately lack the later request/classification/client fields.
  { schemaVersion: 1, id: "legacy", requestId: "", occurredAt: VISUAL_NOW, actor: call.actor, connectorId: "github", toolName: "read", address: "github.read", source: "call_tool", outcome: "success", durationMs: 12, attempts: 1, serverName: "Production", serverVersion: "1" },
];

const ALICE = { namespace: "https://clerk.example.test", id: "alice" };
/** The fake Clerk directory: the labels a maintainer's view shows beside people. */
const DIRECTORY: Record<string, string> = { alice: "Alice Moreau", user_lin: "Lin Chen" };

/** The fake Clerk operator with a directory, so listed people carry labels. */
function labelledMaintainer(): InboundAuth {
  return { ...fakeClerkAuth({ token: VISUAL_TOKEN, userId: "alice" }), activityActorLabel: (id) => DIRECTORY[id] };
}

/** Tokens' agents, one per slot state: claude-desktop issued, triage none, nightly revoked. */
const AGENTS = ["claude-desktop", "triage", "nightly"];
/**
 * Fixed times for the real slots' issue and revoke dates and last seen, so
 * screenshots do not move with the clock. Revisions stay as the server minted
 * them, the same in the contract and the slot list.
 */
const SLOT_TIMES: Record<string, { at?: string; lastSeenAt: string | null }> = {
  "claude-desktop": { at: VISUAL_NOW, lastSeenAt: VISUAL_NOW },
  triage: { lastSeenAt: null },
  nightly: { at: "2026-10-05T08:00:00.000Z", lastSeenAt: "2026-10-04T23:10:00.000Z" },
};

/** One slot, or one contract token, with its timestamp fixed and its revision kept. */
function fixedTime<T extends { state: string; issuedAt?: string; revokedAt?: string }>(name: string, slot: T): T {
  const at = SLOT_TIMES[name]?.at;
  if (!at) return slot;
  return slot.state === "issued" ? { ...slot, issuedAt: at } : slot.state === "revoked" ? { ...slot, revokedAt: at } : slot;
}

export async function createOperatorVisualFixture(): Promise<OperatorVisualFixture> {
  const storage = memoryStorage();
  const github: Connector = { id: "github", title: "GitHub", description: "Repositories and issues", callAdmission: { rules: [{ maxConcurrency: 4, budget: { kind: "rolling-window", maxCalls: 100, windowMs: 60_000 } }] }, staticTools: catalog, listTools: async () => catalog, callTool: async () => null, status: async () => ({ state: "ok" }) };
  const connectors: Connector[] = [github, {
    id: "slack", title: "Slack", description: "Messages and channels", authScope: "personal",
    // The connector Configuration card draws these OAuth facts as badges.
    describe: () => ({ source: { kind: "api", provider: "slack" }, endpoint: { origin: "https://slack.com", path: "/api" }, auth: { mode: "oauth", scope: "channels:read chat:write", authorizationEndpoint: { origin: "https://slack.com", path: "/oauth/v2/authorize" }, tokenEndpoint: { origin: "https://slack.com", path: "/api/oauth.v2.access" }, apiOrigins: ["https://slack.com"], confidentialClient: true, pkce: true } }),
    staticTools: [], listTools: async () => [], callTool: async () => null,
    status: async () => ({ state: "auth_required" }), startAuth: async () => ({ state: "auth_required" }), finishAuth: async () => {}, verifyState: async () => true, disconnectAuth: async () => {},
  }, { ...github, id: "slot", title: "Empty slot", credential: { label: "API key", description: "A deployment-managed service token" }, staticTools: [] },
  { ...github, id: "broken", title: "Hosted proxy", staticTools: [], status: async () => ({ state: "error" }) }];
  const app = createTestConnecta({
    connectors, publicUrl: VISUAL_ORIGIN,
    serverInfo: { name: "Production", version: "1" }, auth: labelledMaintainer(),
    maintainers: [ALICE],
    storage, vault: encryptedCredentialVault(storage, "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="), logger: "silent",
    // Alice is the maintainer. People and agents use separate support and
    // automation pools with matching tools.
    pools: { support: { tools: ["github.read"], readOnly: true, members: ["user_lin"] }, "support-agents": { tools: ["github.read"], readOnly: true, members: ["agent:triage"] }, automation: { tools: ["github"], readOnly: false, members: ["alice"] }, "automation-agents": { tools: ["github"], readOnly: false, members: ["agent:claude-desktop"] } },
    agents: AGENTS,
    activity: activityHistory({ store: { record() {}, list: async () => ({ events: events }), describe: () => ({ kind: "sqlite", retentionDays: 30, optionSources: { retentionDays: "config" } }) } }),
    accessTokens: accessTokens(storage),
    // Settings draws a value set in code apart from a default: these few are set.
    calls: { maxResultBytes: 1_000_000 },
    discovery: { catalogTtlSeconds: 600 },
    execute: { watchdogMs: 60_000 },
    classification: { github: { write: "write" } },
  });
  try {
    const headers = { Authorization: `Bearer ${VISUAL_TOKEN}` };
    // Real slots in each state, committed through the deployment's own store.
    {
      const manager = new AccessTokenManager(storage, { agents: AGENTS });
      await manager.rotate("claude-desktop", "visual-fixture");
      await manager.rotate("nightly", "visual-fixture");
      await manager.revoke("nightly");
    }
    const contractResponse = await app.fetch(new Request(`${VISUAL_ORIGIN}/ui/api/config`, { headers }));
    const dataResponse = await app.fetch(new Request(`${VISUAL_ORIGIN}/ui/data`, { headers }));
    if (!contractResponse.ok || !dataResponse.ok) throw new Error("Visual fixture deployment refused its operator");
    const served: OperatorUiContractV2 = await contractResponse.json();
    const data: UiData = await dataResponse.json();
    const contract = served;
    // /ui/data begins with deferred details. Use the same serializer as the UI
    // uses when its background connector reads finish.
    for (const connector of data.connectors) {
      const response = await app.fetch(new Request(`${VISUAL_ORIGIN}/ui/connectors/${connector.id}`, { headers }));
      if (!response.ok) throw new Error(`Visual fixture connector ${connector.id} failed`);
      Object.assign(connector, await response.json());
    }
    // The real contract lists every declared agent with its slot, and the slot
    // list agrees, revision included. Only the timestamps are fixed.
    let slots: AgentSlot[] = [];
    {
      const listed = await app.fetch(new Request(`${VISUAL_ORIGIN}/ui/access-tokens`, { headers }));
      if (!listed.ok) throw new Error("Visual fixture deployment refused its slot list");
      slots = ((await listed.json()) as { agents: AgentSlot[] }).agents.map((slot) => fixedTime(slot.name, slot));
      contract.agents = contract.agents.map((agent) => ({
        ...agent,
        token: agent.token ? fixedTime(agent.name, agent.token) : null,
        lastSeenAt: SLOT_TIMES[agent.name]?.lastSeenAt ?? null,
      }));
    }
    if (contract.config) contract.config.connectaVersion = data.connectaVersion = "0.29.0";
    else data.connectaVersion = "0.29.0";
    return {
      contract, data,
      activity: { events: events, nextCursor: "older" },
      tokens: { agents: slots },
    } satisfies OperatorVisualFixture;
  } finally { await app.close(); }
}

/** `/ui/data` for the frozen maintainer fixture: the same connectors, statuses and tools. */
function richFixture(base: OperatorVisualFixture): OperatorVisualFixture {
  const contract = crowdedMaintainer();
  const config = contract.config!;
  const data: UiData = {
    ...structuredClone(base.data),
    viewerKey: contract.you.viewerKey,
    serverInfo: { name: config.server.name, version: config.server.version },
    pools: contract.pools.map((pool) => pool.name),
    connectors: contract.live.connectors.map((live) => {
      const described = config.connectors.find((c) => c.id === live.id)!;
      const shared = described.authScope === "shared";
      return {
        viewerKey: contract.you.viewerKey,
        id: live.id, title: described.title ?? live.id, authScope: described.authScope, status: live.status,
        ...(live.problem ? { problem: live.problem } : {}),
        toolCount: live.tools.length,
        tools: live.tools.map(({ name, address, classification }) => ({ name, address, safety: classification === "read" ? "runs_in_programs" : "needs_approval" })),
        permissions: { use: true, manageSharedAuth: shared, connectPersonal: !shared },
      };
    }),
  };
  return { ...structuredClone(base), contract, data };
}

export function operatorVisualVariant(base: OperatorVisualFixture): OperatorVisualFixture {
  return richFixture(base);
}
