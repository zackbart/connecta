#!/usr/bin/env node
// Copy a 0.28 deployment's Workers KV state into its D1 database, once.
//
//   node scripts/copy-kv-to-d1.mjs [config] [--overwrite]
//
// Run from this folder right after deploying 0.29; README.md § "Upgrading
// from 0.28" has the steps. `config` defaults to kv-to-d1.wrangler.jsonc,
// which binds the old namespace as CONNECTA_KV and the database as
// CONNECTA_DB. The copy is idempotent, so rerunning it after a failure is
// safe. It prints counts per key family, never a key or a value.

import { copyKvToD1, KvToD1CopyError } from "@zackbart/connecta/d1";
import { getPlatformProxy } from "wrangler";

const args = process.argv.slice(2);
const overwrite = args.includes("--overwrite");
const configPath = args.find((arg) => !arg.startsWith("--")) ?? "kv-to-d1.wrangler.jsonc";

const proxy = await getPlatformProxy({ configPath, persist: false });
const { CONNECTA_KV: kv, CONNECTA_DB: db } = proxy.env;
if (!kv || !db) {
  await proxy.dispose();
  throw new Error(`${configPath} must bind CONNECTA_KV and CONNECTA_DB`);
}

const families = {};
let cursor;
try {
  do {
    // Each call reads at most 500 keys and hands back a resume token.
    const result = await copyKvToD1(kv, db, { overwrite, ...(cursor ? { cursor } : {}) });
    for (const [family, counts] of Object.entries(result.families)) {
      const into = (families[family] ??= {});
      for (const [field, n] of Object.entries(counts)) into[field] = (into[field] ?? 0) + n;
    }
    cursor = result.cursor;
  } while (cursor);
} catch (error) {
  // A KvToD1CopyError's message is fixed wording; any other error is not
  // printed, because a binding's message can quote a key or a value.
  console.error(error instanceof KvToD1CopyError
    ? error.message
    : "Workers KV to D1 copy stopped on an unexpected error");
  console.error("Rerun to continue: entries already copied count as unchanged.");
  process.exitCode = 1;
} finally {
  await proxy.dispose();
}

console.table(families);
const conflicts = Object.entries(families)
  .filter(([, counts]) => counts.conflicts > 0)
  .map(([family]) => family);
if (conflicts.length > 0) {
  console.warn(
    `D1 kept its own value for some ${conflicts.join(", ")} entries. ` +
    "Rerun with --overwrite to take Workers KV's instead.",
  );
}
