import type { OperatorUiContract } from "../../src/operator-ui/contract.js";
import type { UiArtifactRow, UiArtifactView, UiData } from "../../src/operator-ui/model.js";
import type { UiAccessToken, UiActivityEvent } from "../../src/operator-ui/view.js";
import type { Connector } from "../../src/types.js";
import { activityHistory, type ToolCallActivityEvent } from "../../src/activity.js";
import { accessTokens } from "../../src/access-tokens.js";
import { artifacts, kvArtifactStore } from "../../src/artifacts.js";
import { encryptedCredentialVault } from "../../src/credentials.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { createTestConnecta } from "../helpers.js";
import { fakeClerkAuth } from "./http.js";

export const VISUAL_NOW = "2026-10-08T12:00:00.000Z";
export const VISUAL_ORIGIN = "https://connecta.example";
export const VISUAL_TOKEN = "visual-operator";
export const VISUAL_STATES = ["empty", "loading", "error", "populated", "restricted"] as const;
export type VisualState = typeof VISUAL_STATES[number];

// The contract and legacy auth details come from the current server serializers,
// not a separately maintained copy of their JSON. Collections use their browser
// contract types. All volatile values are fixed in this one fixture module.
export interface OperatorVisualFixture {
  contract: OperatorUiContract;
  data: UiData;
  activity: { events: UiActivityEvent[]; nextCursor?: string };
  artifacts: { artifacts: UiArtifactRow[]; nextCursor?: string };
  artifact: UiArtifactView;
  tokens: { accessTokens: UiAccessToken[] };
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
  const app = createTestConnecta({
    connectors: empty ? keepEmptyConnector ? [github] : [] : connectors, publicUrl: VISUAL_ORIGIN,
    serverInfo: { name: "Production", version: "1" }, auth: fakeClerkAuth({ token: VISUAL_TOKEN, userId: "alice" }),
    storage, vault: encryptedCredentialVault(storage, "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="), logger: "silent",
    identity: { connectorAccess: () => restricted ? ["github.read", "slot"] : "all", activityAccess: () => !restricted,
      credentialAdministration: () => restricted ? [] : "all", personalConnection: () => restricted ? [] : "all", accessTokenManagement: () => !restricted },
    pools: empty || restricted ? {} : { support: { tools: ["github.read"], trust: "read-only", grant: () => true }, automation: { tools: ["github"], trust: "trusted", grant: () => true } },
    activity: activityHistory({ store: { record() {}, list: async () => ({ events: empty ? [] : events }) } }),
    artifacts: artifacts({ store: kvArtifactStore(storage) }), accessTokens: accessTokens(storage),
    calls: { maxResultBytes: 1_000_000 },
  });
  try {
    const headers = { Authorization: `Bearer ${VISUAL_TOKEN}` };
    const contractResponse = await app.fetch(new Request(`${VISUAL_ORIGIN}/ui/api/config`, { headers }));
    const dataResponse = await app.fetch(new Request(`${VISUAL_ORIGIN}/ui/data`, { headers }));
    if (!contractResponse.ok || !dataResponse.ok) throw new Error("Visual fixture deployment refused its operator");
    const contract: OperatorUiContract = await contractResponse.json();
    const data: UiData = await dataResponse.json();
    // /ui/data begins with deferred details. Use the same serializer as the UI
    // uses when its background connector reads finish.
    for (const connector of data.connectors) {
      const response = await app.fetch(new Request(`${VISUAL_ORIGIN}/ui/connectors/${connector.id}`, { headers }));
      if (!response.ok) throw new Error(`Visual fixture connector ${connector.id} failed`);
      Object.assign(connector, await response.json());
    }
    contract.config.connectaVersion = data.connectaVersion = "0.29.0";
    for (const connector of data.connectors) {
      if (connector.id === "github" && !empty) connector.catalogDrift = { observedAt: VISUAL_NOW, unclassifiedTools: 2, unservedTools: 0, annotationConflicts: 1, schemaChanges: 1 };
    }
    return {
      contract, data,
      activity: { events: empty ? [] : events, ...(empty ? {} : { nextCursor: "older" }) },
      artifacts: { artifacts: empty ? [] : [
        { id: "report", title: "Weekly report", kind: "html", viewVersion: 3, updatedAt: VISUAL_NOW, updatedBy: { label: "Alice" }, archived: false, freshness: { state: "current", last: { at: VISUAL_NOW, status: "succeeded" } } },
        { id: "notes", title: "Release notes", kind: "markdown", viewVersion: 1, updatedAt: VISUAL_NOW, updatedBy: { label: "Bob" }, archived: true, freshness: { state: "stale", last: { at: VISUAL_NOW, status: "failed" } } },
      ], ...(empty ? {} : { nextCursor: "more" }) },
      artifact: { id: "report", title: "Weekly report", kind: "html", archived: false, snapshot: false, latestViewVersion: 3,
        view: { version: 3, at: VISUAL_NOW, by: { label: "Alice" } }, documents: [], url: `${VISUAL_ORIGIN}/artifacts/report`, snapshotUrl: `${VISUAL_ORIGIN}/artifacts/report?v=3`,
        document: '<!doctype html><html><body style="margin:0;padding:24px;font:16px system-ui;background:#f5f6fa;color:#20222a"><h2>Weekly report</h2><p>42 requests completed this week.</p></body></html>', freshness: { state: "current" } },
      tokens: { accessTokens: empty ? [] : [{ id: "desktop", name: "Claude desktop", tokenPrefix: "cta_fixture", createdAt: VISUAL_NOW }] },
    } satisfies OperatorVisualFixture;
  } finally { await app.close(); }
}

export const VISUAL_VARIANTS = [
  "credential-configured", "credential-mismatch", "credential-unreadable", "credential-fields",
  "oauth-static", "oauth-cimd", "oauth-dcr", "drift-clean", "drift-unobserved", "legacy-activity",
  "client-setup", "schema", "tools-read", "tools-write", "config-provenance", "narrow-gate", "narrow-auth", "branded",
] as const;
export type VisualVariant = typeof VISUAL_VARIANTS[number];

export function operatorVisualVariant(base: OperatorVisualFixture, variant: VisualVariant): OperatorVisualFixture {
  const fixture = structuredClone(base);
  const slot = fixture.data.connectors.find(c => c.id === "slot")!;
  const slotLive = fixture.contract.live.connectors.find(c => c.id === "slot")!;
  if (variant.startsWith("credential-")) {
    slot.credential = { label: "API key", configured: true, removable: true, lastFour: "1234", updatedAt: VISUAL_NOW, testable: true };
    slot.status = slotLive.status = "ok";
    delete slot.problem; delete slotLive.problem;
    if (variant === "credential-mismatch" || variant === "credential-unreadable") {
      slot.credential.configured = false;
      slot.credential.problem = variant === "credential-mismatch" ? "credential_mismatch" : "credential_unreadable";
      slot.credential.error = variant === "credential-mismatch" ? "Stored fields no longer match the declared credential." : "The stored credential cannot be decrypted.";
      slot.status = slotLive.status = "credential_required";
      slot.problem = slotLive.problem = "credential_mismatch";
    }
    if (variant === "credential-fields") slot.credential.fields = [
      { name: "username", label: "Username", inputType: "text", configured: true, lastFour: "lice", updatedAt: VISUAL_NOW },
      { name: "password", label: "Password", inputType: "password", configured: true, lastFour: "1234", updatedAt: VISUAL_NOW },
    ];
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
