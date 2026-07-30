export interface UiTool {
  name: string;
  address: string;
  description?: string;
}

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
  /**
   * Something true and non-blocking about a working credential — today, that
   * the vault still holds fields the connector has stopped declaring.
   * Distinct from `error`, which means the credential cannot be used.
   */
  notice?: string;
}

export interface UiConnector {
  id: string;
  title?: string;
  description?: string;
  status: "ok" | "auth_required" | "error";
  message?: string;
  authorizationUrl?: string;
  toolCount: number;
  tools: UiTool[];
  /** This connector exposes operator-managed downstream OAuth lifecycle hooks. */
  oauth?: boolean;
  credential?: UiCredential;
}

export type CredentialManagementCapability =
  | "available"
  | "requires_clerk"
  | "vault_not_configured"
  | "no_slots";

export type AccessTokenManagementCapability =
  | "available"
  | "requires_clerk"
  | "not_configured";

export interface UiData {
  serverInfo: { name: string; version: string };
  /** Version of the installed @zackbart/connecta package. */
  connectaVersion: string;
  connectors: UiConnector[];
  activityEnabled: boolean;
  credentialManagement: CredentialManagementCapability;
  accessTokenManagement: AccessTokenManagementCapability;
  /** True only for an eligible Clerk operator. */
  oauthManagement: boolean;
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
