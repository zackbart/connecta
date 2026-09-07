import type { ConnectorCredentialValues } from "./types.js";
interface CredentialFieldMetadata {
  configured: true;
  /** Only emitted when the value is long enough that four chars don't leak much. */
  lastFour?: string;
  updatedAt: string;
}

export interface CredentialMetadata {
  configured: true;
  /** Backward-compatible metadata for the reserved single credential field. */
  lastFour?: string;
  updatedAt: string;
  /** Per-field masked metadata for named multi-value credentials. */
  fields?: Record<string, CredentialFieldMetadata>;
}

export interface CredentialVault {
  get(connectorId: string, field?: string, owner?: string): Promise<string | null>;
  getAll(connectorId: string, owner?: string): Promise<ConnectorCredentialValues | null>;
  metadata(connectorId: string, owner?: string): Promise<CredentialMetadata | null>;
  set(connectorId: string, value: string, updatedBy: string, owner?: string): Promise<CredentialMetadata>;
  setAll(connectorId: string, values: ConnectorCredentialValues, updatedBy: string, owner?: string): Promise<CredentialMetadata>;
  delete(connectorId: string, owner?: string): Promise<void>;
}
