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
  OperatorPoolV2,
  OperatorRootEndpoint,
  OperatorUiContractV2,
} from "../../src/operator-ui/contract.js";
import type { ConnectaConfigDescription, DescribedConnector, DescribedLimit } from "../../src/describe-config.js";

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
    { name: "team", path: "/mcp/team", tools: ["slack", "notion"], hasGrant: true, readOnly: false },
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
    pool: "support",
    tools: ["search"],
    runsAs: { kind: "workspaceFixed", subject: "support@workspace.example" },
  },
  { connectorId: "slack", pool: null, tools: "all", runsAs: { kind: "personal", connectedMembers: 1, members: 2 } },
  { connectorId: "slack", pool: "team", tools: "all", runsAs: { kind: "personal", connectedMembers: 1, members: 2 } },
  { connectorId: "notion", pool: "team", tools: "all", runsAs: { kind: "personal", connectedMembers: 0, members: 2 } },
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
    pools: ["support"],
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
    manage: { kind: "oauth", actions: ["restart", "disconnect"] },
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
      actions: ["save", "test"],
    },
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
