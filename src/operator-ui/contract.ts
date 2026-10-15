// Read-only facts for operator pages. Runtime implementations stay outside
// this file so both the browser and connecta/ui can consume its types.
import type { ActivityOutcome } from "../activity.js";
import type { ConnectaConfigDescription } from "../describe-config.js";
import type { ConnectorStatus, ConnectorToolDescription } from "../types.js";
import type { UiProblem } from "./model.js";

/** The registry's final verdict, independent of whether the viewer's endpoint is read-only. */
export interface OperatorTool extends ConnectorToolDescription {
  address: string;
  classification: "read" | "write";
}

export interface OperatorLastCall {
  at: string;
  outcome: ActivityOutcome;
}

export interface OperatorConnectorOverlay {
  id: string;
  status: ConnectorStatus["state"];
  /** Selected downstream client mechanism, when a client has been selected. */
  auth?: { registrationPath: NonNullable<ConnectorStatus["registrationPath"]> };
  problem?: UiProblem;
  tools: OperatorTool[];
  /** Age of the last complete listing. Static or unobserved catalogs have no age. */
  catalogAgeMs: number | null;
  /** Latest visible call in the bounded activity window, or null when unknown. */
  lastCall: OperatorLastCall | null;
}

/** Whole connector access, or exact tool grants. Guarded grants still require a live read verdict. */
export interface OperatorGrant {
  connectorId: string;
  tools: "all" | Array<{ name: string; requireReadOnly: boolean }>;
}

export interface OperatorPool {
  name: string;
  path: string;
  /** Whether this pool's endpoint refuses every write. */
  readOnly: boolean;
  /** Pool access intersected with the caller's grants. */
  grants: OperatorGrant[];
}

export interface OperatorViewer {
  interactive: boolean;
  grants: OperatorGrant[];
  /** Whether the root /mcp endpoint refuses every write. */
  readOnly: boolean;
  pools: OperatorPool[];
  permissions: {
    activity: boolean;
    accessTokenManagement: boolean;
    connectors: Array<{ id: string; use: boolean; manageSharedAuth: boolean; connectPersonal: boolean }>;
  };
}

export interface OperatorUiContract {
  schemaVersion: 1;
  /** describeConfig's allowlisted snapshot, restricted to this caller's view. */
  config: ConnectaConfigDescription;
  /** Leaf provenance, built from the same allowlisted snapshot and scoped with it. */
  configSources?: Record<string, "default" | "config">;
  live: {
    connectors: OperatorConnectorOverlay[];
    /** Last-call lookup scans at most 1,000 recent rows. No payload or actor is returned. */
    activity: "available" | "unconfigured" | "forbidden" | "unavailable";
  };
  you: OperatorViewer;
}

// Contract v2, frozen by decisions/0006-pools-are-the-access-model.md ahead of
// the server cutover. One shape serves both roles; maintainer-only fields are
// null or empty in the member view, never omitted.

export type OperatorRole = "maintainer" | "member";

export type OperatorMember =
  | { kind: "human"; namespace: string; id: string; label: string | null }
  | { kind: "agent"; name: string };

export interface OperatorPoolV2 {
  name: string;
  /** `/mcp/<name>`. */
  humanPath: string;
  /** `/agent/<name>`. */
  agentPath: string;
  readOnly: boolean;
  /** Workspace address agents act as; null in the member view. */
  owner: string | null;
  /** The pool's declared tools, unfiltered. */
  tools: OperatorGrant[];
  /** Maintainer view only; [] for members. */
  members: OperatorMember[];
}

/** Plain /mcp. Maintainer view only; null for members. */
export interface OperatorRootEndpoint {
  /** `/mcp`. */
  path: string;
  readOnly: boolean;
  /** Humans only. */
  maintainers: OperatorMember[];
}

/** What a member may see about one connector in their pools. */
export interface OperatorMemberConnector {
  id: string;
  title: string;
  pools: string[];
  authScope: "shared" | "personal";
  /** Tools their pools grant. */
  tools: Array<{ address: string; classification: "read" | "write" }>;
  /** Own connection state for personal connectors; null for shared ones. */
  connection: { state: ConnectorStatus["state"]; problem?: UiProblem } | null;
  /** What the member may do. Always "none" for shared connectors. */
  manage: OperatorMemberManage;
}

export type OperatorMemberManage =
  | { kind: "none" }
  // connect: POST /ui/oauth/<id>?mode=continue; restart: POST ?mode=restart; disconnect: DELETE
  | { kind: "oauth"; actions: Array<"connect" | "restart" | "disconnect"> }
  | {
      /** /ui/credentials/<id>, the member's own partition. */
      kind: "credential";
      label: string;
      description?: string;
      /** Labels and names, never values. */
      fields?: Array<{ name: string; label: string; description?: string }>;
      actions: Array<"save" | "test" | "clear">;
    };

export interface OperatorAgent {
  name: string;
  pools: string[];
  token: { state: "none" } | { state: "issued"; issuedAt: string } | { state: "revoked"; revokedAt: string };
  /** Latest activity row for this agent, null when activity is off or none is visible. */
  lastSeenAt: string | null;
}

export type OperatorRunsAs =
  | { kind: "shared"; savedAt: string | null }
  | { kind: "personal"; connectedMembers: number; members: number }
  // Mapping subject: humans act as themselves; agents act as the pool owner.
  // `agents` is null on plain /mcp (`pool: null`), which admits no agents.
  | { kind: "workspace"; humans: "self"; agents: string | null }
  // Fixed subject: every caller acts as it.
  | { kind: "workspaceFixed"; subject: string };

export interface OperatorConnectorPoolCell {
  connectorId: string;
  /** Null is plain /mcp. */
  pool: string | null;
  /** Connector-relative tool names, as in `OperatorGrant`, not addresses. */
  tools: "all" | string[];
  runsAs: OperatorRunsAs;
}

export interface OperatorUiContractV2 {
  schemaVersion: 2;
  role: OperatorRole;
  /** Maintainer only; null for members. */
  config: ConnectaConfigDescription | null;
  /** Leaf provenance for Settings, as in v1. Maintainer only; null for members. */
  configSources: Record<string, "default" | "config"> | null;
  live: {
    /** Maintainer only; [] for members. */
    connectors: OperatorConnectorOverlay[];
    /** "forbidden" for members. */
    activity: "available" | "unconfigured" | "forbidden" | "unavailable";
  };
  /** Maintainer only. */
  root: OperatorRootEndpoint | null;
  /** Maintainer: all; member: their pools, owner null, members []. */
  pools: OperatorPoolV2[];
  /** Maintainer only; [] for members. */
  agents: OperatorAgent[];
  /** Maintainer only; [] for members. */
  matrix: OperatorConnectorPoolCell[];
  /** Member only; [] for maintainers, who read live.connectors. */
  connectors: OperatorMemberConnector[];
  you: { interactive: boolean };
}
