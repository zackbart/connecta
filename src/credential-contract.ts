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
  setAll(
    connectorId: string,
    values: ConnectorCredentialValues,
    updatedBy: string,
    owner?: string,
  ): Promise<CredentialMetadata>;
  delete(connectorId: string, owner?: string): Promise<void>;
  /**
   * Encrypt downstream OAuth state (tokens, a registered client, a PKCE
   * verifier) before it enters storage. `purpose` is the storage key the value
   * is written under, so the result is bound to one connector, owner, and key.
   * Without both `seal` and `open`, that state is stored as plaintext.
   */
  seal?(connectorId: string, purpose: string, plaintext: string, owner?: string): Promise<string>;
  /** Sign browser OAuth handoffs with a purpose-specific key; nothing is stored. */
  signOAuthHandoff?(payload: string): Promise<string>;
  /** Verify a browser OAuth handoff signature without exposing the key. */
  verifyOAuthHandoff?(payload: string, signature: string): Promise<boolean>;
  /**
   * Host-only key for the MCP request-state codec. Must be a stable,
   * purpose-specific deployment key of at least 32 bytes. The registry never
   * exposes the vault or this key through a connector context or guest API.
   */
  requestStateKey?(): Promise<Uint8Array>;
  /** Reverse `seal` for the same connector, purpose, and owner; rejects otherwise. */
  open?(connectorId: string, purpose: string, sealed: string, owner?: string): Promise<string>;
}
