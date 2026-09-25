import type {
  CatalogAccessObservation,
  CatalogDriftReport,
} from "../types.js";

/**
 * Which call path a tool takes, decided on the server by the same
 * `isExplicitlyReadOnly` predicate discovery and invocation use
 * (`src/tool-safety.ts`) and never re-derived in the browser: a second copy of
 * the rule is a second place for it to be wrong.
 *
 * - `runs_in_programs` — explicitly read-only, so `execute_code` may call it.
 * - `exempt` — not read-only, but the deployment's `execute.approval` lets a
 *   program call it without pausing (#566). Still approval-required
 *   everywhere else.
 * - `needs_approval` — everything else: a program pauses for
 *   `resume_execution`, and a direct call crosses `call_destructive_tool`.
 *
 * The badge renders from a table keyed by this union, so each value is one
 * entry, not a branch.
 */
export type UiToolSafety = "runs_in_programs" | "exempt" | "needs_approval";

export interface UiTool {
  name: string;
  address: string;
  description?: string;
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
  status: "loading" | "ok" | "auth_required" | "error";
  permissions?: { use: boolean; manageSharedAuth: boolean; connectPersonal: boolean };
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
  serverInfo: { name: string; version: string };
  /** Version of the installed @zackbart/connecta package. */
  connectaVersion: string;
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
