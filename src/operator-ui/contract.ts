// Read-only facts for operator pages. Runtime implementations stay outside
// this file so both the browser and connecta/ui can consume its types.
import type { ActivityOutcome } from "../activity.js";
import type { ConnectaConfigDescription } from "../describe-config.js";
import type { ConnectorStatus, ConnectorToolDescription } from "../types.js";
import type { UiProblem } from "./model.js";

/** The registry's final verdict, independent of the viewer's pool trust. */
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
  trust: "trusted" | "read-only";
  /** Pool access intersected with the caller's grants. */
  grants: OperatorGrant[];
}

export interface OperatorViewer {
  interactive: boolean;
  grants: OperatorGrant[];
  /** Trust of the root /mcp endpoint. */
  trust: "trusted" | "read-only";
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
