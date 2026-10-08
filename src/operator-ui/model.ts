import type { OperatorConnectorOverlay, OperatorTool, OperatorUiContract, OperatorViewer } from "./contract.js";
import type {
  CatalogAccessObservation,
  CatalogDriftReport,
} from "../types.js";

/** Tool verdicts, independent of the selected pool's trust. */
export type UiToolSafety = "runs_in_programs" | "needs_approval";

export interface UiTool extends Pick<OperatorTool, "name" | "address" | "description"> {
  /** Absent only in payloads older than the field; the page then shows no badge. */
  safety?: UiToolSafety;
}

/**
 * What went wrong with a connector, as a closed set the server chooses from.
 * The browser keys both its on-screen description and a fixed fix prompt off
 * this. There is deliberately no message beside it: a connector's status
 * message can quote a downstream error body, so it goes to the deployment's
 * log and never into the operator payload.
 *
 * `auth_required` splits by who has to act: a downstream OAuth grant
 * (`oauth_required`, which also covers an expired or revoked grant — the
 * status seam cannot tell those apart), an operator-managed credential slot
 * (`credential_required`), or a secret that lives in deployment configuration
 * (`auth_required`).
 */
export type UiProblem =
  | "connector_unavailable"
  | "oauth_required"
  | "credential_required"
  | "auth_required"
  | "credential_mismatch"
  | "catalog_failed";

/** A stored credential that cannot be used, by cause. */
export type UiCredentialProblem = "credential_mismatch" | "credential_unreadable";

interface UiCredentialField {
  name: string;
  label: string;
  description?: string;
  placeholder?: string;
  inputType: "email" | "password" | "text";
  configured: boolean;
  lastFour?: string;
  updatedAt?: string;
}

interface UiCredential {
  label: string;
  description?: string;
  placeholder?: string;
  fields?: UiCredentialField[];
  configured: boolean;
  /** A stored value exists and may be deleted even if it cannot be decrypted. */
  removable?: boolean;
  lastFour?: string;
  updatedAt?: string;
  testable: boolean;
  error?: string;
  /** Present exactly when `error` is: the cause, for the fix prompt. */
  problem?: UiCredentialProblem;
  /**
   * Something true and non-blocking about a working credential — today, that
   * the vault still holds fields the connector has stopped declaring.
   * Distinct from `error`, which means the credential cannot be used.
   */
  notice?: string;
}

export interface UiConnector {
  id: string;
  /** Downstream authentication owner. Older payload fixtures omit it as shared. */
  authScope?: "shared" | "personal";
  title?: string;
  description?: string;
  status: "loading" | OperatorConnectorOverlay["status"];
  permissions?: Omit<OperatorViewer["permissions"]["connectors"][number], "id">;
  /**
   * Why this connector is not usable, when it is not. See `UiProblem`. The
   * only failure detail the payload carries; the status message behind it is
   * logged on the server, not shipped.
   */
  problem?: UiProblem;
  authorizationUrl?: string;
  toolCount: number;
  tools: UiTool[];
  /** This connector exposes manageable downstream OAuth lifecycle hooks. */
  oauth?: boolean;
  /** Selected downstream client identity mechanism; never a client ID or secret. */
  registrationPath?: "cimd" | "dcr" | "static";
  credential?: UiCredential;
  /**
   * Drift the last catalog refresh saw *in this runtime*
   * ([#343](https://github.com/zackbart/connecta/issues/343)). Four counts and
   * a timestamp: no tool name, no schema, no payload ever rides this field.
   * Absent means this process has observed no refresh — not that nothing
   * drifted — which is why the UI renders that as its own state rather than as
   * a clean one.
   */
  catalogDrift?: CatalogDriftReport;
  /** Last agent-facing catalog read in this runtime; never persisted. */
  catalogAccess?: CatalogAccessObservation;
}

export type CredentialManagementCapability =
  | "available"
  | "requires_operator"
  | "vault_not_configured"
  | "no_slots";

export interface UiData {
  accessTokenManagement?: "available" | "requires_operator";
  serverInfo: Pick<OperatorUiContract["config"]["server"], "name" | "version">;
  /** Version of the installed @zackbart/connecta package. */
  connectaVersion: OperatorUiContract["config"]["connectaVersion"];
  connectors: UiConnector[];
  activityEnabled: boolean;
  credentialManagement: CredentialManagementCapability;
  /** True when this interactive human may manage any visible OAuth connector. */
  oauthManagement: boolean;
  /**
   * Names of the `/mcp/<name>` pools this identity's grant admits. A pool
   * whose grant refuses or throws is absent, exactly as the endpoint answers
   * it with a 404, so the page never enumerates a pool its reader cannot open.
   */
  pools?: string[];
  /** True when artifact pages are mounted and this identity may open them. */
  artifactsEnabled?: boolean;
}

/**
 * One row of the artifact library. Every field is a fact the store keeps or
 * an enum; nothing here is a message, a log line, or a downstream's words.
 */
export interface UiArtifactRow {
  id: string;
  title: string;
  kind: "html" | "markdown";
  viewVersion: number;
  updatedAt: string;
  updatedBy: { label: string };
  archived: boolean;
  freshness?: UiArtifactFreshness;
}

interface UiArtifactFreshness {
  state: "unconfigured" | "current" | "stale";
  schedule?: "manual" | "daily" | "weekly";
  document?: string;
  dueAt?: string;
  last?: { at: string; status: "succeeded" | "unchanged" | "failed" | "superseded" };
  running?: boolean;
}

/** The viewer's payload: the page's facts and the one document its frame loads. */
export interface UiArtifactView {
  id: string;
  title: string;
  kind: "html" | "markdown";
  archived: boolean;
  snapshot: boolean;
  latestViewVersion: number;
  view: { version: number; at: string; by: { label: string } };
  documents: { name: string; version: number; updatedAt: string }[];
  url: string;
  snapshotUrl: string;
  document: string;
  freshness?: UiArtifactFreshness;
}

export interface FilteredUiConnector {
  connector: UiConnector;
  tools: UiTool[];
}

/**
 * Filter by connector identity/description or tool name/description. A
 * connector-level match stays visible even when it currently exposes no tools
 * (for example while authorization is required).
 */
export function filterUiConnectors(
  connectors: UiConnector[],
  query: string,
): FilteredUiConnector[] {
  const q = query.trim().toLowerCase();
  const filtered: FilteredUiConnector[] = [];
  for (const connector of connectors) {
    const connectorText = [
      connector.id,
      connector.title,
      connector.description,
      connector.status,
    ]
      .join(" ")
      .toLowerCase();
    const connectorMatches = Boolean(q && connectorText.includes(q));
    const tools = connector.tools.filter(
      (tool) =>
        !q ||
        connectorMatches ||
        `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(q),
    );
    if (q && tools.length === 0 && !connectorMatches) continue;
    filtered.push({ connector, tools });
  }
  return filtered;
}
