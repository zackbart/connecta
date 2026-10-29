// Credential reads through one request's memo (src/runtime/request-reads.ts).
// The built-in vault registers a reader that shares its stored envelope, with
// the base class's own read methods as their canonical identities. The memo
// answers only for an instance whose `getAll` or `metadata` is exactly that
// method; a subclass or instance override is always called itself, as is any
// other vault.
import type { CredentialVault } from "./credential-contract.js";
import type { RequestReads } from "./runtime/request-reads.js";

type Reads = Pick<CredentialVault, "getAll" | "metadata">;
type MemoReads = {
  [K in keyof Reads]: (...args: [...Parameters<Reads[K]>, reads: RequestReads, fresh: boolean]) => ReturnType<Reads[K]>;
};

const readers = new WeakMap<object, { canonical: Reads; memo: MemoReads }>();

/** `canonical` is the base class's own prototype methods, never the instance's. */
export function registerCredentialReads(vault: CredentialVault, canonical: Reads, memo: MemoReads): void {
  readers.set(vault, { canonical, memo });
}

/** A `fresh` reader always reads storage and records what it saw. */
export function credentialReads(vault: CredentialVault, reads: RequestReads, fresh = false): Reads {
  const reader = readers.get(vault);
  return {
    getAll: (connectorId, owner) =>
      reader && vault.getAll === reader.canonical.getAll
        ? reader.memo.getAll(connectorId, owner, reads, fresh)
        : vault.getAll(connectorId, owner),
    metadata: (connectorId, owner) =>
      reader && vault.metadata === reader.canonical.metadata
        ? reader.memo.metadata(connectorId, owner, reads, fresh)
        : vault.metadata(connectorId, owner),
  };
}
