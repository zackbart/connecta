import type { Connector, ConnectorCredentialConfig } from "./types.js";
/** Which hook a testable credential is checked with. */
type CredentialTestMode = "single" | "multiple";

/** Operator-safe explanation shared by every surface that detects shape drift. */
export const STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR =
  "Stored credential fields do not match this connector's current declaration. Replace the credential before using or testing this connector.";

export type StoredCredentialShape =
  | { state: "missing" }
  | {
      state: "valid";
      mode: CredentialTestMode;
      /**
       * Stored keys the connector no longer declares, sorted. Harmless — the
       * credential works — but worth telling an operator about, since nothing
       * else in `/ui` can show a field the declaration has stopped naming.
       */
      undeclared: string[];
    }
  | {
      state: "mismatch";
      mode: CredentialTestMode;
      message: typeof STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR;
    };

/**
 * Compare a connector's current declaration with the keys in its stored
 * credential. Values are deliberately ignored: callers may pass decrypted
 * values or `/credentials`' masked field metadata and get the same answer.
 *
 * The test is CONTAINMENT, not equality: the stored key set is compatible when
 * it holds every field currently declared — the reserved `value` key for a
 * single-value declaration, every declared name for a named one. Anything the
 * declaration asks for and the vault does not have is `mismatch`, which is
 * precisely what a renamed field, a newly added field, or a swap between the
 * two shapes produces. The swap needs no special case: `value` is never one of
 * the declared names, so single→named and named→single each leave the declared
 * side unsatisfied. An empty stored map (reachable through a hand-written
 * plaintext) satisfies nothing and is a mismatch too.
 *
 * Extra keys are NOT drift. They are what *dropping* a field leaves behind, and
 * every accessor a connector actually uses — `ctx.credential.get("apiKey")`,
 * `getAll().apiKey` — keeps returning the right secret across that redeploy.
 * Calling it drift would order an operator to re-enter a working secret that
 * many providers will not reissue in readable form. The leftovers come back as
 * `undeclared` instead, for a surface to mention without blocking anything.
 */
export function storedCredentialShape(
  config: ConnectorCredentialConfig,
  stored: Readonly<Record<string, unknown>> | null,
): StoredCredentialShape {
  if (!stored) return { state: "missing" };
  const mode: CredentialTestMode = config.fields?.length
    ? "multiple"
    : "single";
  const declared = new Set(
    mode === "multiple" ? config.fields!.map((field) => field.name) : ["value"],
  );
  const actual = Object.keys(stored);
  const present = new Set(actual);
  for (const field of declared) {
    if (!present.has(field)) {
      return {
        state: "mismatch",
        mode,
        message: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
      };
    }
  }
  return {
    state: "valid",
    mode,
    undeclared: actual.filter((field) => !declared.has(field)).sort(),
  };
}

/** How many leftover field names an advisory names before it summarizes. */
const UNDECLARED_SAMPLE = 5;

/**
 * The one sentence describing leftover stored fields, so every surface words it
 * the same way. Names only — the values stay in the vault, and a field name from
 * a previous declaration is not a secret. Deliberately reassuring: nothing is
 * broken, and the only thing an operator gains by acting is that a connector
 * iterating `getAll()` stops seeing a field its code no longer knows about.
 */
export function describeUndeclaredCredentialFields(fields: string[]): string {
  const shown = fields.slice(0, UNDECLARED_SAMPLE);
  const rest = fields.length - shown.length;
  const named = shown.join(", ") + (rest > 0 ? `, and ${rest} more` : "");
  return fields.length === 1
    ? `Stored credential also holds a field this connector no longer declares (${named}). It keeps working; replace the credential to drop it.`
    : `Stored credential also holds fields this connector no longer declares (${named}). It keeps working; replace the credential to drop them.`;
}

/** A declared credential shape whose only test hook cannot test it. */
export interface CredentialTestMismatch {
  /** The shape the connector declared. */
  shape: CredentialTestMode;
  /** The hook it implements, which that shape cannot use. */
  hook: "testCredential" | "testCredentials";
}

export interface CredentialTestRule {
  /** The hook to call, or null when this credential cannot be tested at all. */
  mode: CredentialTestMode | null;
  /** Set only when the sole implemented hook is the one the shape cannot use. */
  mismatch?: CredentialTestMismatch;
}

/**
 * The one rule deciding whether a connector's credential can be tested — read
 * by /credentials' `testable` flag, by `POST /ui/credentials/<id>/test` when
 * it picks a hook, and by the construction-time mismatch warning, so those
 * three cannot drift apart.
 *
 * The declared credential *shape* selects the hook: named `credential.fields`
 * are tested as a set by `testCredentials`, a single-value `credential` by
 * `testCredential` on the vault's reserved `value` field. The other hook is
 * never substituted — it would be handed a shape the connector never declared —
 * so a connector implementing only the mismatched hook is not testable, and
 * says so at construction rather than under an operator's click.
 */
export function credentialTestRule(
  connector: Pick<
    Connector,
    "credential" | "testCredential" | "testCredentials"
  >,
): CredentialTestRule {
  if (!connector.credential) return { mode: null };
  if (connector.credential.fields?.length) {
    if (connector.testCredentials) return { mode: "multiple" };
    return connector.testCredential
      ? { mode: null, mismatch: { shape: "multiple", hook: "testCredential" } }
      : { mode: null };
  }
  if (connector.testCredential) return { mode: "single" };
  return connector.testCredentials
    ? { mode: null, mismatch: { shape: "single", hook: "testCredentials" } }
    : { mode: null };
}

/**
 * One clause naming a mismatch, shared by the startup warning and the test
 * route's 400 so an operator reads the same explanation in both places.
 */
export function describeCredentialTestMismatch(
  mismatch: CredentialTestMismatch,
): string {
  return mismatch.shape === "multiple"
    ? "it declares named credential fields, which only " +
        "`testCredentials(values, ctx)` can test, but implements " +
        "`testCredential`"
    : "it declares a single-value credential, which only " +
        "`testCredential(value, ctx)` can test, but implements " +
        "`testCredentials`";
}
