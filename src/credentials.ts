import type { ConnectorCredentialValues, KVStorage } from "./types.js";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const MAX_CREDENTIAL_BYTES = 16_384;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Envelope {
  version: 1;
  algorithm: "AES-GCM";
  iv: string;
  ciphertext: string;
}

interface CredentialPlaintext {
  values: ConnectorCredentialValues;
  updatedAt: string;
  updatedBy: string;
}

export interface CredentialFieldMetadata {
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

function storageKey(connectorId: string): string {
  return `conn:${connectorId}:credential:v1`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(
      "credentialEncryptionKey must be a base64-encoded 32-byte key",
    );
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function parseEnvelope(raw: string): Envelope {
  try {
    const parsed = JSON.parse(raw) as Partial<Envelope>;
    if (
      parsed.version !== 1 ||
      parsed.algorithm !== "AES-GCM" ||
      typeof parsed.iv !== "string" ||
      typeof parsed.ciphertext !== "string"
    ) {
      throw new Error("invalid envelope");
    }
    return parsed as Envelope;
  } catch {
    throw new Error("Stored credential is invalid or corrupted");
  }
}

function parsePlaintext(raw: string): CredentialPlaintext {
  try {
    const parsed = JSON.parse(raw) as Partial<CredentialPlaintext> & {
      value?: unknown;
    };
    const values =
      typeof parsed.value === "string"
        ? { value: parsed.value }
        : parsed.values;
    if (
      !values ||
      typeof values !== "object" ||
      Array.isArray(values) ||
      !Object.entries(values).every(
        ([field, value]) =>
          /^[A-Za-z][A-Za-z0-9_-]*$/.test(field) &&
          typeof value === "string",
      ) ||
      typeof parsed.updatedAt !== "string" ||
      typeof parsed.updatedBy !== "string"
    ) {
      throw new Error("invalid plaintext");
    }
    return {
      values: { ...values },
      updatedAt: parsed.updatedAt,
      updatedBy: parsed.updatedBy,
    };
  } catch {
    throw new Error("Stored credential is invalid or corrupted");
  }
}

function validateValues(
  values: ConnectorCredentialValues,
): ConnectorCredentialValues {
  const entries = Object.entries(values);
  if (entries.length === 0) throw new Error("Credential cannot be empty");
  const normalized: ConnectorCredentialValues = {};
  for (const [field, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(field)) {
      throw new Error(`Invalid credential field "${field}"`);
    }
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Credential field "${field}" cannot be empty`);
    }
    normalized[field] = value;
  }
  if (
    encoder.encode(JSON.stringify(normalized)).byteLength >
    MAX_CREDENTIAL_BYTES
  ) {
    throw new Error(`Credential cannot exceed ${MAX_CREDENTIAL_BYTES} bytes`);
  }
  return normalized;
}

/**
 * Encrypted, connector-scoped credential vault over the deployment's existing
 * KVStorage. Only ciphertext enters KV; the AES-GCM key remains an environment
 * secret outside the store.
 */
export class CredentialVault {
  private readonly key: Promise<CryptoKey>;

  constructor(
    private readonly storage: KVStorage,
    encryptionKey: string,
  ) {
    const raw = base64ToBytes(encryptionKey.trim());
    if (raw.byteLength !== KEY_BYTES) {
      throw new Error(
        "credentialEncryptionKey must be a base64-encoded 32-byte key",
      );
    }
    this.key = crypto.subtle.importKey(
      "raw",
      raw,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  }

  private additionalData(connectorId: string): Uint8Array {
    return encoder.encode(`connecta:credential:${connectorId}:v1`);
  }

  private async read(connectorId: string): Promise<CredentialPlaintext | null> {
    const raw = await this.storage.get(storageKey(connectorId));
    if (!raw) return null;
    const envelope = parseEnvelope(raw);
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: base64ToBytes(envelope.iv),
          additionalData: this.additionalData(connectorId),
        },
        await this.key,
        base64ToBytes(envelope.ciphertext),
      );
      return parsePlaintext(decoder.decode(plaintext));
    } catch {
      throw new Error("Stored credential could not be decrypted");
    }
  }

  async get(connectorId: string, field = "value"): Promise<string | null> {
    return (await this.read(connectorId))?.values[field] ?? null;
  }

  async getAll(
    connectorId: string,
  ): Promise<ConnectorCredentialValues | null> {
    const credential = await this.read(connectorId);
    return credential ? { ...credential.values } : null;
  }

  async metadata(connectorId: string): Promise<CredentialMetadata | null> {
    const credential = await this.read(connectorId);
    if (!credential) return null;
    const fields = Object.fromEntries(
      Object.entries(credential.values).map(([field, value]) => [
        field,
        {
          configured: true as const,
          // Only reveal the tail on values comfortably longer than four chars;
          // for a short secret those four would be half of it.
          ...(value.length >= 12 ? { lastFour: value.slice(-4) } : {}),
          updatedAt: credential.updatedAt,
        },
      ]),
    );
    const single = fields.value;
    return {
      configured: true,
      ...(single?.lastFour ? { lastFour: single.lastFour } : {}),
      updatedAt: credential.updatedAt,
      fields,
    };
  }

  async set(
    connectorId: string,
    value: string,
    updatedBy: string,
  ): Promise<CredentialMetadata> {
    // `await` (not a bare promise return) so a validation throw inside setAll
    // never sits handler-less for the thenable-adoption microtask — workerd
    // reports that gap as an unhandled rejection.
    return await this.setAll(connectorId, { value }, updatedBy);
  }

  async setAll(
    connectorId: string,
    values: ConnectorCredentialValues,
    updatedBy: string,
  ): Promise<CredentialMetadata> {
    const normalized = validateValues(values);
    const plaintext: CredentialPlaintext = {
      values: normalized,
      updatedAt: new Date().toISOString(),
      updatedBy,
    };
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: this.additionalData(connectorId),
      },
      await this.key,
      encoder.encode(JSON.stringify(plaintext)),
    );
    const envelope: Envelope = {
      version: 1,
      algorithm: "AES-GCM",
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    };
    await this.storage.set(storageKey(connectorId), JSON.stringify(envelope));
    return (await this.metadata(connectorId))!;
  }

  async delete(connectorId: string): Promise<void> {
    await this.storage.delete(storageKey(connectorId));
  }
}
