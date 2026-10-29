// Credential reads through one request's memo (src/runtime/request-reads.ts).
// The built-in vault registers a reader that shares its stored envelope; any
// other vault, or the built-in one with a replaced method, answers each call as
// it always does.
import type { CredentialVault } from "./credential-contract.js";
import type { RequestReads } from "./runtime/request-reads.js";

type Reads = Pick<CredentialVault, "getAll" | "metadata">;
type MemoReads = {
  [K in keyof Reads]: (...args: [...Parameters<Reads[K]>, reads: RequestReads, fresh: boolean]) => ReturnType<Reads[K]>;
};

const readers = new WeakMap<object, { own: Reads; memo: MemoReads }>();

export function registerCredentialReads(vault: CredentialVault, memo: MemoReads): void {
  readers.set(vault, { own: { getAll: vault.getAll, metadata: vault.metadata }, memo });
}

/** A `fresh` reader always reads storage and records what it saw. */
export function credentialReads(vault: CredentialVault, reads: RequestReads, fresh = false): Reads {
  const reader = readers.get(vault);
  return {
    getAll: (connectorId, owner) =>
      reader && reader.own.getAll === vault.getAll
        ? reader.memo.getAll(connectorId, owner, reads, fresh)
        : vault.getAll(connectorId, owner),
    metadata: (connectorId, owner) =>
      reader && reader.own.metadata === vault.metadata
        ? reader.memo.metadata(connectorId, owner, reads, fresh)
        : vault.metadata(connectorId, owner),
  };
}
