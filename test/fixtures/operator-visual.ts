import type { OperatorMember, OperatorUiContract, OperatorUiContractV2 } from "../../src/operator-ui/contract.js";
import type { UiData } from "../../src/operator-ui/model.js";
import type { UiActivityEvent } from "../../src/operator-ui/view.js";
import type { Connector, InboundAuth } from "../../src/types.js";
import { activityHistory, type ToolCallActivityEvent } from "../../src/activity.js";
import { accessTokens } from "../../src/access-tokens.js";
import { encryptedCredentialVault } from "../../src/credentials.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { createTestConnecta } from "../helpers.js";
import { fakeClerkAuth } from "./http.js";
import { contractV2 } from "./operator-contract-v2-bridge.js";
import { OPERATOR_V2_MAINTAINER, OPERATOR_V2_MEMBER } from "./operator-contract-v2.js";

export const VISUAL_NOW = "2026-10-08T12:00:00.000Z";
export const VISUAL_ORIGIN = "https://connecta.example";
export const VISUAL_TOKEN = "visual-operator";
export const VISUAL_STATES = ["empty", "loading", "error", "populated", "restricted"] as const;
export type VisualState = typeof VISUAL_STATES[number];

// The contract and legacy auth details come from the current server serializers,
// not a separately maintained copy of their JSON. Collections use their browser
// contract types. All volatile values are fixed in this one fixture module.
// Until P6b of #837 serves contract v2, the maintainer view passes the server's
// v1 answer through the bridge with the pool facts below; the restricted state
// is the frozen member fixture, since v2 has no other restricted viewer.
export interface OperatorVisualFixture {
  contract: OperatorUiContractV2;
  data: UiData;
  activity: { events: UiActivityEvent[]; nextCursor?: string };
  tokens: { agents: Array<{ name: string; state: "issued"; issuedAt: string }> };
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

/** The fake Clerk provider, admitting alice by principal alone: a non-interactive bearer session. */
function bearerMaintainer(): InboundAuth {
  const clerk = fakeClerkAuth({ token: VISUAL_TOKEN, userId: "alice" });
  return {
    ...clerk,
    authorize: async (request, baseUrl, runtimeContext) => {
      const result = await clerk.authorize(request, baseUrl, runtimeContext);
      return result.ok ? { ok: true, principal: ALICE } : result;
    },
  };
}

export async function createOperatorVisualFixture(state: VisualState, keepEmptyConnector = false): Promise<OperatorVisualFixture> {
  const empty = state === "empty";
  const restricted = state === "restricted";
  const storage = memoryStorage();
  const github: Connector = { id: "github", title: "GitHub", description: "Repositories and issues", staticTools: empty ? [] : catalog, listTools: async () => empty ? [] : catalog, callTool: async () => null, status: async () => ({ state: "ok" }) };
  const connectors: Connector[] = [github, {
    id: "slack", title: "Slack", description: "Messages and channels", authScope: "personal",
    staticTools: [], listTools: async () => [], callTool: async () => null,
    status: async () => ({ state: "auth_required" }), startAuth: async () => ({ state: "auth_required" }), finishAuth: async () => {}, verifyState: async () => true, disconnectAuth: async () => {},
  }, { ...github, id: "slot", title: "Empty slot", credential: { label: "API key", description: "A deployment-managed service token" }, staticTools: [] },
  { ...github, id: "broken", title: "Hosted proxy", staticTools: [], status: async () => ({ state: "error" }) }];
  // Operator routes serve maintainers only (#837), and a maintainer sees every
  // connector whole. The restricted state keeps its old view (GitHub's read
  // tool and the credential slot) by declaring only those. Its maintainer is
  // a bearer session, not an interactive sign-in, so it manages nothing
  // (#837), and the activity read gate refuses it.
  const readOnlyGithub: Connector = { ...github, staticTools: catalog.filter(t => t.name === "read"), listTools: async () => catalog.filter(t => t.name === "read") };
  const restrictedConnectors: Connector[] = [readOnlyGithub, connectors[2]!];
  const app = createTestConnecta({
    connectors: empty ? keepEmptyConnector ? [github] : [] : restricted ? restrictedConnectors : connectors, publicUrl: VISUAL_ORIGIN,
    serverInfo: { name: "Production", version: "1" }, auth: restricted ? bearerMaintainer() : fakeClerkAuth({ token: VISUAL_TOKEN, userId: "alice" }),
    ...(restricted ? { maintainers: [ALICE] } : {}),
    storage, vault: encryptedCredentialVault(storage, "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="), logger: "silent",
    // Otherwise alice, the fake Clerk operator, is the default maintainer.
    pools: empty || restricted ? {} : { support: { tools: ["github.read"], readOnly: true, members: ["alice"] }, automation: { tools: ["github"], readOnly: false, members: ["alice"] } },
    activity: activityHistory({ readGate: () => !restricted, store: { record() {}, list: async () => ({ events: empty ? [] : events }) } }),
    accessTokens: accessTokens(storage),
    calls: { maxResultBytes: 1_000_000 },
  });
  try {
    const headers = { Authorization: `Bearer ${VISUAL_TOKEN}` };
    const contractResponse = await app.fetch(new Request(`${VISUAL_ORIGIN}/ui/api/config`, { headers }));
    const dataResponse = await app.fetch(new Request(`${VISUAL_ORIGIN}/ui/data`, { headers }));
    if (!contractResponse.ok || !dataResponse.ok) throw new Error("Visual fixture deployment refused its operator");
    const served: OperatorUiContract = await contractResponse.json();
    const data: UiData = await dataResponse.json();
    const human = (id: string, label: string | null): OperatorMember => ({ kind: "human", namespace: "https://clerk.example.test", id, label });
    const contract = restricted ? structuredClone(OPERATOR_V2_MEMBER) as OperatorUiContractV2 : contractV2(served, {
      maintainers: [human("alice", "Alice Moreau")],
      members: { support: [human("user_lin", "Lin Chen"), { kind: "agent", name: "triage" }], automation: [human("alice", "Alice Moreau")] },
      runsAs: (connectorId) => connectorId === "github" ? { kind: "shared", savedAt: "2026-10-01T09:30:00.000Z" }
        : connectorId === "slack" ? { kind: "personal", connectedMembers: 1, members: 2 } : undefined,
    });
    // /ui/data begins with deferred details. Use the same serializer as the UI
    // uses when its background connector reads finish.
    for (const connector of data.connectors) {
      const response = await app.fetch(new Request(`${VISUAL_ORIGIN}/ui/connectors/${connector.id}`, { headers }));
      if (!response.ok) throw new Error(`Visual fixture connector ${connector.id} failed`);
      Object.assign(connector, await response.json());
    }
    if (contract.config) contract.config.connectaVersion = data.connectaVersion = "0.29.0";
    else data.connectaVersion = "0.29.0";
    for (const connector of data.connectors) {
      if (connector.id === "github" && !empty) connector.catalogDrift = { observedAt: VISUAL_NOW, unclassifiedTools: 2, unservedTools: 0, annotationConflicts: 1, schemaChanges: 1 };
    }
    return {
      contract, data,
      activity: { events: empty ? [] : events, ...(empty ? {} : { nextCursor: "older" }) },
      tokens: { agents: empty ? [] : [{ name: "claude-desktop", state: "issued", issuedAt: VISUAL_NOW }] },
    } satisfies OperatorVisualFixture;
  } finally { await app.close(); }
}

export const VISUAL_VARIANTS = [
  "credential-configured", "credential-mismatch", "credential-unreadable", "credential-fields",
  "oauth-static", "oauth-cimd", "oauth-dcr", "drift-clean", "drift-unobserved", "legacy-activity",
  "endpoints-expanded", "command-search", "narrow-endpoints", "connectors-matrix", "matrix-popover", "narrow-matrix",
  "client-setup", "schema", "tools-read", "tools-write", "config-provenance", "narrow-gate", "narrow-auth", "branded",
] as const;
export type VisualVariant = typeof VISUAL_VARIANTS[number];

/** Variants that need every runs-as kind, agents and three pools: the frozen v2 maintainer fixture. */
const RICH_VARIANTS: readonly VisualVariant[] = ["endpoints-expanded", "narrow-endpoints", "connectors-matrix", "matrix-popover", "narrow-matrix"];

/** `/ui/data` for the frozen maintainer fixture: the same connectors, statuses and tools. */
function richFixture(base: OperatorVisualFixture): OperatorVisualFixture {
  const contract = structuredClone(OPERATOR_V2_MAINTAINER) as OperatorUiContractV2;
  const config = contract.config!;
  const data: UiData = {
    ...structuredClone(base.data),
    serverInfo: { name: config.server.name, version: config.server.version },
    pools: contract.pools.map((pool) => pool.name),
    connectors: contract.live.connectors.map((live) => {
      const described = config.connectors.find((c) => c.id === live.id)!;
      const shared = described.authScope === "shared";
      return {
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

export function operatorVisualVariant(base: OperatorVisualFixture, variant: VisualVariant): OperatorVisualFixture {
  if (RICH_VARIANTS.includes(variant)) return richFixture(base);
  const fixture = structuredClone(base);
  const slot = fixture.data.connectors.find(c => c.id === "slot")!;
  const slotLive = fixture.contract.live.connectors.find(c => c.id === "slot")!;
  if (variant.startsWith("credential-")) {
    slot.credential = { label: "API key", configured: true, removable: true, lastFour: "1234", updatedAt: VISUAL_NOW, testable: true };
    slot.status = slotLive.status = "ok";
    delete slot.problem; delete slotLive.problem;
    if (variant === "credential-mismatch" || variant === "credential-unreadable") {
      slot.credential.configured = variant === "credential-unreadable" ? null : false;
      slot.credential.problem = variant === "credential-mismatch" ? "credential_mismatch" : "credential_unreadable";
      slot.credential.error = variant === "credential-mismatch" ? "Stored fields no longer match the declared credential." : "The stored credential cannot be decrypted.";
      slot.status = slotLive.status = variant === "credential-unreadable" ? "error" : "credential_required";
      slot.problem = slotLive.problem = variant === "credential-unreadable" ? "connector_unavailable" : "credential_mismatch";
    }
    if (variant === "credential-fields") {
      slot.credential.fields = [
      { name: "username", label: "Username", inputType: "text", configured: true, lastFour: "lice", updatedAt: VISUAL_NOW },
      { name: "password", label: "Password", inputType: "password", configured: true, lastFour: "1234", updatedAt: VISUAL_NOW },
      ];
      fixture.contract.config!.connectors.find(c => c.id === "slot")!.credential = { label: slot.credential.label, fields: slot.credential.fields.map(({ name, label }) => ({ name, label })) };
    }
  }
  if (variant.startsWith("oauth-")) {
    const path = variant === "oauth-static" ? "static" : variant === "oauth-cimd" ? "cimd" : "dcr";
    const slack = fixture.data.connectors.find(c => c.id === "slack")!;
    const live = fixture.contract.live.connectors.find(c => c.id === "slack")!;
    slack.status = live.status = "ok"; slack.registrationPath = path; live.auth = { registrationPath: path };
    delete slack.problem; delete live.problem;
  }
  if (variant === "drift-clean" || variant === "drift-unobserved") {
    const github = fixture.data.connectors.find(c => c.id === "github")!;
    if (variant === "drift-unobserved") delete github.catalogDrift;
    else github.catalogDrift = { observedAt: VISUAL_NOW, unclassifiedTools: 0, unservedTools: 0, annotationConflicts: 0, schemaChanges: 0 };
  }
  if (variant === "legacy-activity") fixture.activity.events = [
    { ...call, actor: { kind: "clerk", id: "user_1", namespace: "https://tenant.example", label: "Ada Lovelace" }, source: "resume_execution", outcome: "approved", approval: "call", attempts: 0 },
    { ...call, id: "paused", requestId: "request-two", source: "execute_code", outcome: "paused", attempts: 0 },
    { ...call, id: "unknown", requestId: "request-three", actor: { kind: "bearer" }, outcome: "new-outcome" },
  ];
  return fixture;
}
