// Operator contract v2 fixtures, frozen by
// decisions/0006-pools-are-the-access-model.md. Every value is synthetic.
// Unlike operator-visual.ts these are literals, not server output: they hold
// every runsAs variant, labelled people and agents in one view, which the
// server tests check against real responses part by part.
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
  // Resolved references, as describeConfig() reports them (#837): the same
  // people the v2 root lists, without directory labels.
  maintainers: [
    { namespace: CLERK, id: "user_ada" },
    { namespace: CLERK, id: "user_grace" },
  ],
  classification: {},
  auth: [{ kind: "clerk", interactive: true, ui: "clerk" }],
  agents: ["simon-ada", "triage"],
  pools: [
    {
      name: "ada",
      path: "/mcp/ada",
      tools: ["gmail", "github.read"],
      members: [
        { kind: "human", namespace: CLERK, id: "user_ada" },
        { kind: "agent", name: "simon-ada" },
      ],
      readOnly: false,
      surface: "meta",
      executeCode: true,
      owner: "ada@workspace.example",
      description: null,
    },
    {
      name: "support",
      path: "/mcp/support",
      tools: ["github.read", "drive.search"],
      members: [
        { kind: "human", namespace: CLERK, id: "user_lin" },
        { kind: "agent", name: "triage" },
      ],
      readOnly: true,
      surface: "meta",
      executeCode: true,
      owner: "support@workspace.example",
      description: null,
    },
    {
      name: "team",
      path: "/mcp/team",
      tools: ["slack", "notes", "calendar", "github.read"],
      members: [
        { kind: "human", namespace: CLERK, id: "user_ada" },
        { kind: "human", namespace: CLERK, id: "user_lin" },
      ],
      readOnly: false,
      surface: "meta",
      executeCode: true,
      owner: null,
      description: null,
    },
  ],
  modules: {
    ui: { enabled: true },
    vault: { enabled: true, sealsOAuth: true },
    activity: { enabled: true, readable: true, store: { kind: "sqlite", retentionDays: 30 } },
    accessTokens: { enabled: true },
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
    connector("notes", "Notes", "personal", {
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
    surface: "meta",
    executeCode: true,
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
    surface: "meta",
    executeCode: true,
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
    surface: "meta",
    executeCode: true,
    owner: null,
    tools: [
      { connectorId: "slack", tools: "all" },
      { connectorId: "notes", tools: "all" },
      { connectorId: "calendar", tools: "all" },
      // GitHub also reaches Lin through support, so it lists two pools.
      { connectorId: "github", tools: [{ name: "read", requireReadOnly: false }] },
    ],
    members: [ada, lin],
  },
];

const agents: OperatorAgent[] = [
  { name: "simon-ada", pools: ["ada"], token: { state: "issued", issuedAt: EARLIER, revision: "simonAdaIssuedRevision" }, lastSeenAt: NOW },
  { name: "triage", pools: ["support"], token: { state: "none", revision: "triageNoneRevision0000" }, lastSeenAt: null },
];

const matrix: OperatorConnectorPoolCell[] = [
  { connectorId: "github", pool: null, tools: "all", runsAs: { kind: "shared", source: "vault", savedAt: EARLIER } },
  { connectorId: "github", pool: "ada", tools: ["read"], runsAs: { kind: "shared", source: "vault", savedAt: EARLIER } },
  { connectorId: "github", pool: "support", tools: ["read"], runsAs: { kind: "shared", source: "vault", savedAt: EARLIER } },
  { connectorId: "github", pool: "team", tools: ["read"], runsAs: { kind: "shared", source: "vault", savedAt: EARLIER } },
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
  { connectorId: "notes", pool: null, tools: "all", runsAs: { kind: "personal", connectedMembers: 1, members: 2 } },
  { connectorId: "notes", pool: "team", tools: "all", runsAs: { kind: "personal", connectedMembers: 1, members: 2 } },
  { connectorId: "calendar", pool: null, tools: "all", runsAs: { kind: "personal", connectedMembers: 2, members: 2 } },
  { connectorId: "calendar", pool: "team", tools: "all", runsAs: { kind: "personal", connectedMembers: 2, members: 2 } },
];

export const OPERATOR_V2_MAINTAINER = {
  schemaVersion: 2,
  role: "maintainer",
  config,
  configSources: {
    "config.maintainers.0.id": "config",
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
      overlay("notes", [["query", "read"]], {
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
    id: "notes",
    title: "Notes",
    pools: ["team"],
    authScope: "personal",
    tools: [{ address: "notes.query", classification: "read" }],
    connection: { state: "credential_required", problem: "credential_required" },
    // Nothing is stored in Lin's partition, so only save is offered: test and
    // clear need a stored value, and the page reads stored-ness from actions.
    manage: {
      kind: "credential",
      label: "Integration token",
      fields: [
        { name: "workspace", label: "Workspace" },
        { name: "token", label: "Token", description: "An internal integration secret" },
      ],
      actions: ["save"],
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

const notesSlot = config.connectors.find((c) => c.id === "notes")!.credential!;

/**
 * What each member may do with each personal connector here, as the server
 * derives it from permission, hooks, deployment availability and, for a
 * credential, whether their own partition holds a value.
 */
const manage = {
  slack: { kind: "oauth", actions: ["connect", "restart", "disconnect"] },
  // disconnectAuth without startAuth: the member can only drop the grant.
  calendar: { kind: "oauth", actions: ["disconnect"] },
} satisfies Record<string, OperatorMemberManage>;
/** Notes has named fields with testCredentials and a vault: save always; test and clear once a value is stored. */
const notesManage = (stored: boolean): OperatorMemberManage => ({
  kind: "credential",
  label: notesSlot.label,
  fields: notesSlot.fields!,
  actions: stored ? ["save", "test", "clear"] : ["save"],
});

/** Each member's own partition status. Ada's and Lin's differ, so neither may see the other's. */
export const OPERATOR_V2_PARTITIONS = {
  user_lin: {
    slack: { state: "ok" },
    notes: { state: "credential_required", problem: "credential_required" },
    calendar: { state: "ok" },
  },
  user_ada: {
    slack: { state: "auth_required", problem: "oauth_required" },
    notes: { state: "ok" },
    calendar: { state: "ok" },
  },
} satisfies Record<string, Record<"slack" | "notes" | "calendar", MemberPartition["connection"]>>;

/**
 * The trusted inputs for one member's view: config, catalog, membership, that
 * member's partition status and each connector's derived `manage`, gathered
 * the way P6b gathers them from a real deployment, never from a member response.
 */
export function operatorV2MemberSource(id: keyof typeof OPERATOR_V2_PARTITIONS): MemberViewSource {
  const connections: Record<"slack" | "notes" | "calendar", MemberPartition["connection"]> =
    OPERATOR_V2_PARTITIONS[id];
  // Ada's Notes is connected, so her partition holds a value; Lin's holds none.
  const manages = { ...manage, notes: notesManage(connections.notes.state === "ok") };
  const partition = (connector: keyof typeof manages): MemberPartition => ({
    connection: { ...connections[connector] },
    manage: structuredClone(manages[connector]),
  });
  return {
    member: { namespace: CLERK, id },
    pools: structuredClone(pools),
    connectors: structuredClone(config.connectors),
    catalog: OPERATOR_V2_MAINTAINER.live.connectors.flatMap((connector) => connector.tools),
    personal: { slack: partition("slack"), notes: partition("notes"), calendar: partition("calendar") },
  };
}

/** What Lin's view must carry. */
export const OPERATOR_V2_MEMBER_EXPECTED = memberViewExpectation(operatorV2MemberSource("user_lin"));
