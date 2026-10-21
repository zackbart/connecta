// drift.json version 2, the vendor-contract record of decision 0011 (D):
// humans write sources, reasons, and dates; tools write lists and digests.
// `providers:generate` writes the `generated` block from the provider's
// definition and its evidence bytes, and `drift-check.mjs` reads both
// versions. Version 1 stays readable for providers still in PENDING.step1.
//
// {
//   "version": 2,
//   "provider": "<folder name>",
//   "generated": {                      // providers:generate only
//     "operations": ["GET /accounts"],  // api, dual: the kit's manifest(vendor), sorted
//     "hosted": ["get_issue"],          // mcp, dual: the served hosted classification's names, sorted
//     "evidence": { "catalog.json": "sha256:…" } // one digest per hashed evidence file
//   },
//   "checks": [ … ]                     // the check types drift-check.mjs knows
// }
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const DRIFT_VERSION = 2;
/** Evidence files whose bytes `generated.evidence` pins, sorted. */
export const HASHED_EVIDENCE = ["catalog.json", "openapi.document.json", "openapi.json", "value-safety.json"];
/** An operation key: `"METHOD /path"`, the kit manifest's spelling. */
export const OPERATION = /^(GET|HEAD|POST|PUT|PATCH|DELETE) (\/\S*)$/;
/** `providers:check` reports a manual check verified longer ago than this; no test fails as the calendar moves. */
export const STALE_AFTER_DAYS = 180;

/** `{ method, path }` of an operation key, or undefined when it is not one. */
export function parseOperation(key) {
  const match = typeof key === "string" ? OPERATION.exec(key) : null;
  return match ? { method: match[1], path: match[2] } : undefined;
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * The `generated` block (D2): operations from the kit's facts, hosted names
 * from the same reviewed classification the connector serves, and one digest
 * per hashed evidence file the folder holds.
 */
export async function generatedBlock({ directory, kind, kit, classify }) {
  const evidence = {};
  for (const name of HASHED_EVIDENCE) {
    try {
      evidence[name] = digest(await readFile(join(directory, "evidence", name)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return {
    operations: kind === "mcp" ? [] : [...new Set(kit?.operations ?? [])].sort(),
    hosted: kind === "api" ? [] : Object.keys(classify?.tools ?? {}).sort(),
    evidence,
  };
}

/** A version-2 record's one canonical text: version, provider, generated, then everything humans wrote. */
export function serializeDrift(record) {
  const { version, provider, generated, ...rest } = record;
  return `${JSON.stringify({ version, provider, generated, ...rest }, null, 2)}\n`;
}

/** Whole days from a `YYYY-MM-DD` day to `now`, in UTC. */
export function daysSince(day, now = new Date()) {
  return Math.floor((now.getTime() - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
}
