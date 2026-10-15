// Operator contract v2 fixtures, frozen by
// decisions/0006-pools-are-the-access-model.md so the UI can build against
// them before the server serves v2. Every value is synthetic. Unlike
// operator-visual.ts these are literals, not server output: no route serves
// this shape yet.
import { CONFIG_DEFAULTS } from "../../src/config-defaults.js";
import type {
  OperatorAgent,
  OperatorConnectorOverlay,
  OperatorConnectorPoolCell,
  OperatorMember,
  OperatorMemberConnector,
  OperatorMemberManage,
  OperatorPoolV2,
  OperatorRootEndpoint,
  OperatorUiContractV2,
} from "../../src/operator-ui/contract.js";
import type { ConnectaConfigDescription, DescribedConnector, DescribedLimit } from "../../src/describe-config.js";
import {
  memberViewExpectation,
  type MemberPartition,
  type MemberViewSource,
} from "../helpers/operator-member-view.js";

const NOW = "2026-10-08T12:00:00.000Z";
const EARLIER = "2026-10-01T09:30:00.000Z";
const CLERK = "https://clerk.example.test";

const ada: OperatorMember = { kind: "human", namespace: CLERK, id: "user_ada", label: "Ada Lovelace" };
const grace: OperatorMember = { kind: "human", namespace: CLERK, id: "user_grace", label: null };
const lin: OperatorMember = { kind: "human", namespace: CLERK, id: "user_lin", label: "Lin Chen" };

const defaults = <T extends Record<string, number>>(values: T) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, source: "default" }])) as Record<
    keyof T,
    DescribedLimit
  >;

const connector = (
  id: string,
  title: string,
  authScope: "shared" | "personal",
  extra: Partial<DescribedConnector> = {},
): DescribedConnector => ({
  id,
  title,
  authScope,
  source: { kind: "remote-mcp" },
  endpoint: { origin: `https://${id}.example.test`, path: "/mcp" },
  maxResultBytes: { value: CONFIG_DEFAULTS.calls.maxResultBytes, source: "deployment" },
  ...extra,
});

const config: ConnectaConfigDescription = {
  schemaVersion: 1,
  connectaVersion: "0.33.0",
  server: { name: "Production", version: "1", icons: 0 },
  urls: { publicUrl: { origin: "https://connecta.example", path: "/" }, mcpPath: "/mcp", allowedOrigins: "default" },
  executor: { name: "quickjs", admission: defaults(CONFIG_DEFAULTS.admission.code) },
  limits: {
    discovery: defaults(CONFIG_DEFAULTS.discovery),
    calls: {
      defaultTimeoutMs: { value: null, source: "default" },
      maxResultBytes: { value: CONFIG_DEFAULTS.calls.maxResultBytes, source: "default" },
    },
    results: defaults(CONFIG_DEFAULTS.results),
    execute: defaults(CONFIG_DEFAULTS.execute),
    requests: defaults(CONFIG_DEFAULTS.admission.requests),
  },
  readOnly: false,
  hasGrant: true,
  classification: {},
  auth: [{ kind: "clerk", interactive: true, ui: "clerk" }],
  identity: {
    connectorAccess: "custom",
    activityAccess: "default",
    credentialAdministration: "default",
    accessTokenManagement: "default",
    personalConnection: "default",
  },
  pools: [
    { name: "ada", path: "/mcp/ada", tools: ["gmail", "github.read"], hasGrant: true, readOnly: false },
    { name: "support", path: "/mcp/support", tools: ["github.read", "drive.search"], hasGrant: true, readOnly: true },
    { name: "team", path: "/mcp/team", tools: ["slack", "notion", "calendar", "github.read"], hasGrant: true, readOnly: false },
  ],
  modules: {
    ui: { enabled: true },
    vault: { enabled: true, sealsOAuth: true },
    activity: { enabled: true, readable: true, store: { kind: "sqlite", retentionDays: 30 } },
    accessTokens: { enabled: true, maxActive: 20 },
  },
  storage: { configured: true, kind: "sqlite" },
  branding: {
    productName: "Connecta",
    description: "One MCP endpoint for every connector",
    faviconHref: "/favicon.svg",
    themeColor: "#1f2937",
    theme: { colorScheme: "light dark" },
  },
  deploymentInfo: ["commit"],
  connectors: [
    connector("github", "GitHub", "shared", { auth: { mode: "credential", header: "Authorization", scheme: "Bearer" } }),
    connector("gmail", "Gmail", "shared", { source: { kind: "api", provider: "gmail" }, auth: { mode: "request" } }),
    connector("drive", "Drive", "shared", { source: { kind: "api", provider: "drive" }, auth: { mode: "request" } }),
    connector("slack", "Slack", "personal", { auth: { mode: "oauth", scope: "search:read chat:write" } }),
    // Provisioned out of band: it has disconnectAuth but no startAuth.
    connector("calendar", "Calendar", "personal", { source: { kind: "custom" } }),
    connector("notion", "Notion", "personal", {
      auth: { mode: "credential", header: "Authorization", scheme: "Bearer" },
      credential: {
        label: "Integration token",
        fields: [
          { name: "workspace", label: "Workspace" },
          { name: "token", label: "Token", description: "An internal integration secret" },
        ],
      },
    }),
  ],
};

const overlay = (id: string, tools: Array<[string, "read" | "write"]>, extra: Partial<OperatorConnectorOverlay> = {}) =>
  ({
    id,
    status: "ok",
    tools: tools.map(([name, classification]) => ({ name, address: `${id}.${name}`, classification })),
    catalogAgeMs: 42_000,
    lastCall: { at: NOW, outcome: "success" },
    ...extra,
  }) satisfies OperatorConnectorOverlay;

const root: OperatorRootEndpoint = { path: "/mcp", readOnly: false, maintainers: [ada, grace] };

const pools: OperatorPoolV2[] = [
  // Per-person: agents act as Ada's Workspace address.
  {
    name: "ada",
    humanPath: "/mcp/ada",
    agentPath: "/agent/ada",
    readOnly: false,
    owner: "ada@workspace.example",
    tools: [
      { connectorId: "gmail", tools: "all" },
      { connectorId: "github", tools: [{ name: "read", requireReadOnly: false }] },
    ],
    members: [ada, { kind: "agent", name: "simon-ada" }],
  },
  {
    name: "support",
    humanPath: "/mcp/support",
    agentPath: "/agent/support",
    readOnly: true,
    owner: "support@workspace.example",
    tools: [
      { connectorId: "github", tools: [{ name: "read", requireReadOnly: false }] },
      { connectorId: "drive", tools: [{ name: "search", requireReadOnly: true }] },
    ],
    members: [lin, { kind: "agent", name: "triage" }],
  },
  // A group pool has no owner, so no Workspace subject for agents.
  {
    name: "team",
    humanPath: "/mcp/team",
    agentPath: "/agent/team",
    readOnly: false,
    owner: null,
    tools: [
      { connectorId: "slack", tools: "all" },
      { connectorId: "notion", tools: "all" },
      { connectorId: "calendar", tools: "all" },
      // GitHub also reaches Lin through support, so it lists two pools.
      { connectorId: "github", tools: [{ name: "read", requireReadOnly: false }] },
    ],
    members: [ada, lin],
  },
];

const agents: OperatorAgent[] = [
  { name: "simon-ada", pools: ["ada"], token: { state: "issued", issuedAt: EARLIER }, lastSeenAt: NOW },
  { name: "triage", pools: ["support"], token: { state: "none" }, lastSeenAt: null },
];

const matrix: OperatorConnectorPoolCell[] = [
  { connectorId: "github", pool: null, tools: "all", runsAs: { kind: "shared", savedAt: EARLIER } },
  { connectorId: "github", pool: "ada", tools: ["read"], runsAs: { kind: "shared", savedAt: EARLIER } },
  { connectorId: "github", pool: "support", tools: ["read"], runsAs: { kind: "shared", savedAt: EARLIER } },
  { connectorId: "github", pool: "team", tools: ["read"], runsAs: { kind: "shared", savedAt: EARLIER } },
  // Plain /mcp admits no agents, so the mapping has no agent subject there.
  { connectorId: "gmail", pool: null, tools: "all", runsAs: { kind: "workspace", humans: "self", agents: null } },
  {
    connectorId: "gmail",
    pool: "ada",
    tools: "all",
    runsAs: { kind: "workspace", humans: "self", agents: "ada@workspace.example" },
  },
  // A fixed-subject Workspace connector: every caller acts as the subject.
  {
    connectorId: "drive",
    pool: null,
    tools: "all",
    runsAs: { kind: "workspaceFixed", subject: "support@workspace.example" },
  },
  {
    connectorId: "drive",
    pool: "support",
    tools: ["search"],
    runsAs: { kind: "workspaceFixed", subject: "support@workspace.example" },
  },
  { connectorId: "slack", pool: null, tools: "all", runsAs: { kind: "personal", connectedMembers: 1, members: 2 } },
  { connectorId: "slack", pool: "team", tools: "all", runsAs: { kind: "personal", connectedMembers: 1, members: 2 } },
  { connectorId: "notion", pool: null, tools: "all", runsAs: { kind: "personal", connectedMembers: 1, members: 2 } },
  { connectorId: "notion", pool: "team", tools: "all", runsAs: { kind: "personal", connectedMembers: 1, members: 2 } },
  { connectorId: "calendar", pool: null, tools: "all", runsAs: { kind: "personal", connectedMembers: 2, members: 2 } },
  { connectorId: "calendar", pool: "team", tools: "all", runsAs: { kind: "personal", connectedMembers: 2, members: 2 } },
];

export const OPERATOR_V2_MAINTAINER = {
  schemaVersion: 2,
  role: "maintainer",
  config,
  configSources: {
    "config.hasGrant": "config",
    "config.readOnly": "default",
    "config.limits.calls.maxResultBytes": "default",
    "config.pools.support.readOnly": "config",
  },
  live: {
    connectors: [
      overlay("github", [
        ["read", "read"],
        ["write", "write"],
      ]),
      overlay("gmail", [
        ["search", "read"],
        ["send", "write"],
      ]),
      overlay("drive", [["search", "read"]], { catalogAgeMs: null, lastCall: null }),
      overlay("slack", [
        ["search", "read"],
        ["post", "write"],
      ]),
      overlay("calendar", [["list", "read"]]),
      overlay("notion", [["query", "read"]], {
        status: "credential_required",
        problem: "credential_required",
        catalogAgeMs: null,
        lastCall: null,
      }),
    ],
    activity: "available",
  },
  root,
  pools,
  agents,
  matrix,
  connectors: [],
  you: { interactive: true },
} satisfies OperatorUiContractV2;

const memberConnectors: OperatorMemberConnector[] = [
  {
    id: "github",
    title: "GitHub",
    pools: ["support", "team"],
    authScope: "shared",
    tools: [{ address: "github.read", classification: "read" }],
    connection: null,
    manage: { kind: "none" },
  },
  {
    id: "drive",
    title: "Drive",
    pools: ["support"],
    authScope: "shared",
    tools: [{ address: "drive.search", classification: "read" }],
    connection: null,
    manage: { kind: "none" },
  },
  {
    id: "slack",
    title: "Slack",
    pools: ["team"],
    authScope: "personal",
    tools: [
      { address: "slack.search", classification: "read" },
      { address: "slack.post", classification: "write" },
    ],
    connection: { state: "ok" },
    manage: { kind: "oauth", actions: ["connect", "restart", "disconnect"] },
  },
  {
    id: "notion",
    title: "Notion",
    pools: ["team"],
    authScope: "personal",
    tools: [{ address: "notion.query", classification: "read" }],
    connection: { state: "credential_required", problem: "credential_required" },
    manage: {
      kind: "credential",
      label: "Integration token",
      fields: [
        { name: "workspace", label: "Workspace" },
        { name: "token", label: "Token", description: "An internal integration secret" },
      ],
      actions: ["save", "test", "clear"],
    },
  },
  {
    id: "calendar",
    title: "Calendar",
    pools: ["team"],
    authScope: "personal",
    tools: [{ address: "calendar.list", classification: "read" }],
    connection: { state: "ok" },
    manage: { kind: "oauth", actions: ["disconnect"] },
  },
];

/** Lin's view: only their pools, stripped of owner and members. */
export const OPERATOR_V2_MEMBER = {
  schemaVersion: 2,
  role: "member",
  config: null,
  configSources: null,
  live: { connectors: [], activity: "forbidden" },
  root: null,
  pools: pools
    .filter((pool) => pool.name === "support" || pool.name === "team")
    .map((pool) => ({ ...pool, owner: null, members: [] })),
  agents: [],
  matrix: [],
  connectors: memberConnectors,
  you: { interactive: true },
} satisfies OperatorUiContractV2;

const notionSlot = config.connectors.find((c) => c.id === "notion")!.credential!;

/**
 * What every member may do with each personal connector here, as P6b derives
 * it server-side from permission, hooks and deployment availability.
 */
const manage = {
  slack: { kind: "oauth", actions: ["connect", "restart", "disconnect"] },
  // Named fields with testCredentials, and a vault for save and clear.
  notion: { kind: "credential", label: notionSlot.label, fields: notionSlot.fields!, actions: ["save", "test", "clear"] },
  // disconnectAuth without startAuth: the member can only drop the grant.
  calendar: { kind: "oauth", actions: ["disconnect"] },
} satisfies Record<string, OperatorMemberManage>;

/** Each member's own partition status. Ada's and Lin's differ, so neither may see the other's. */
export const OPERATOR_V2_PARTITIONS = {
  user_lin: {
    slack: { state: "ok" },
    notion: { state: "credential_required", problem: "credential_required" },
    calendar: { state: "ok" },
  },
  user_ada: {
    slack: { state: "auth_required", problem: "oauth_required" },
    notion: { state: "ok" },
    calendar: { state: "ok" },
  },
} satisfies Record<string, Record<keyof typeof manage, MemberPartition["connection"]>>;

/**
 * The trusted inputs for one member's view: config, catalog, membership, that
 * member's partition status and each connector's derived `manage`, gathered
 * the way P6b gathers them from a real deployment, never from a member response.
 */
export function operatorV2MemberSource(id: keyof typeof OPERATOR_V2_PARTITIONS): MemberViewSource {
  const connections: Record<keyof typeof manage, MemberPartition["connection"]> = OPERATOR_V2_PARTITIONS[id];
  const partition = (connector: keyof typeof manage): MemberPartition => ({
    connection: { ...connections[connector] },
    manage: structuredClone(manage[connector]),
  });
  return {
    member: { namespace: CLERK, id },
    pools: structuredClone(pools),
    connectors: structuredClone(config.connectors),
    catalog: OPERATOR_V2_MAINTAINER.live.connectors.flatMap((connector) => connector.tools),
    personal: { slack: partition("slack"), notion: partition("notion"), calendar: partition("calendar") },
  };
}

/** What Lin's view must carry. */
export const OPERATOR_V2_MEMBER_EXPECTED = memberViewExpectation(operatorV2MemberSource("user_lin"));
