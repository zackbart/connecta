// drift.json version 2, the vendor-contract record of decision 0011 (D):
// humans write sources, reasons, and dates; tools write lists and digests.
// `providers:generate` writes the `generated` block from the provider's
// definition and its evidence bytes, and `drift-check.mjs` reads both
// versions. Version 1 stays readable for providers still in PENDING.step1.
// The record's offline structure is `drift-validate.mjs`, shared with the
// provider-standard suite.
//
// {
//   "version": 2,
//   "provider": "<folder name>",
//   "generated": {                      // providers:generate only
//     "operations": ["GET /accounts"],  // the kit's manifest(vendor), sorted
//     "evidence": { "openapi.json": "sha256:…" } // one digest per hashed evidence file
//   },
//   "checks": [ … ]                     // the check types drift-check.mjs knows
// }
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Evidence files whose bytes `generated.evidence` pins, sorted. */
export const HASHED_EVIDENCE = ["openapi.document.json", "openapi.json", "value-safety.json"];
/** `providers:check` reports a manual check verified longer ago than this; no test fails as the calendar moves. */
export const STALE_AFTER_DAYS = 180;

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * The `generated` block (D2): operations from the kit's facts and one digest
 * per hashed evidence file the folder holds.
 */
export async function generatedBlock({ directory, kit }) {
  const evidence = {};
  for (const name of HASHED_EVIDENCE) {
    try {
      evidence[name] = digest(await readFile(join(directory, "evidence", name)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return {
    operations: [...new Set(kit?.operations ?? [])].sort(),
    evidence,
  };
}

/** A version-2 record's one canonical text: version, provider, generated, then everything humans wrote. */
export function serializeDrift(record) {
  const { version, provider, generated, ...rest } = record;
  return `${JSON.stringify({ version, provider, generated, ...rest }, null, 2)}\n`;
}
