// The last verification of a connector's credential or OAuth grant: a typed,
// payload-free observation stored per connector and owner (the connector's
// `ctx.storage` is already partitioned by both). Credential tests and, for
// `api()` OAuth, real calls write it; status only reads it (INV-10).
import { classifyCallError } from "./errors.js";
import { verificationKeys } from "./storage/keys.js";
import type { CredentialFailureClass, CredentialTestResult, KVStorage } from "./types.js";

/**
 * Whether a connector's stored credential or OAuth grant works, as last
 * observed. `ok` and the failure classes come from a credential test or, for
 * `api()` OAuth, from real calls; `unverified` marks a credential saved
 * without a passing test.
 */
export interface CredentialVerification {
  outcome: "ok" | "unverified" | CredentialFailureClass;
  /** ISO 8601 time of the observation. */
  observedAt: string;
}

const FAILURES: readonly unknown[] = ["rejected", "scope", "unreachable", "timeout", "failed"];
const OUTCOMES: readonly unknown[] = ["ok", "unverified", "rejected", "scope", "unreachable", "timeout", "failed"];
/** Each typed code that names a class; every other code is `failed`. */
const CLASS_OF: Partial<Record<string, CredentialFailureClass>> = {
  auth_required: "rejected",
  downstream_oauth_required: "rejected",
  provider_permission_denied: "scope",
  timeout: "timeout",
  unavailable: "unreachable",
  rate_limited: "unreachable",
};

/** A thrown failure's class, read from its typed code alone, never its text. */
export const credentialFailureClass = (error: unknown): CredentialFailureClass =>
  CLASS_OF[classifyCallError(error).code] ?? "failed";

/** A hook's answer as an outcome. Only its typed fields count; `message` never does. */
export const credentialTestOutcome = (result: CredentialTestResult | undefined): "ok" | CredentialFailureClass =>
  result?.ok === true ? "ok" : FAILURES.includes(result?.failure) ? result!.failure! : "failed";

/** A checked copy, or undefined: nothing here trusts stored bytes. */
function checkedVerification(value: unknown): CredentialVerification | undefined {
  const { outcome, observedAt } = (value ?? {}) as Partial<CredentialVerification>;
  return OUTCOMES.includes(outcome) &&
    typeof observedAt === "string" &&
    observedAt.length < 64 &&
    !Number.isNaN(Date.parse(observedAt))
    ? { outcome: outcome!, observedAt }
    : undefined;
}

/**
 * The stored observation, or undefined when there is none or it cannot be
 * read. With `credential`, only one made about that vault credential (its
 * `updatedAt`) counts: a replacement saved since is unverified.
 */
export async function readVerification(
  storage: KVStorage,
  credential?: string,
): Promise<CredentialVerification | undefined> {
  try {
    const stored = JSON.parse((await storage.get(verificationKeys.record)) ?? "null") as { credential?: unknown };
    return credential === undefined || stored?.credential === credential ? checkedVerification(stored) : undefined;
  } catch {
    return undefined;
  }
}

/** Record an outcome, bound to the vault credential's `updatedAt` when it is about one; `null` removes the record. */
export async function writeVerification(
  storage: KVStorage,
  outcome: CredentialVerification["outcome"] | null,
  credential?: string,
): Promise<CredentialVerification | undefined> {
  if (!outcome) return void (await storage.delete(verificationKeys.record));
  const record = { outcome, observedAt: new Date().toISOString() };
  await storage.set(verificationKeys.record, JSON.stringify({ ...record, credential }));
  return record;
}
