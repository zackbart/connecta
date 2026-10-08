#!/usr/bin/env node
// Run only during the maintenance-window cutover. See README "Upgrading from 0.28".

export const HELP = `Usage: node scripts/copy-kv-to-d1.mjs [config] --maintenance [options]
Config defaults to kv-to-d1.wrangler.jsonc; source is its CONNECTA_KV namespace id.
1. Bulk-export KV and export D1 with wrangler d1 export. Preserve the credentials key.
2. Block traffic and all background writers, then drain in-flight requests.
3. Wait at least 60 seconds, or the longest configured KV cacheTtl, whichever is
   greater. Propagation can take longer. Two consecutive listing/hash passes
   must match; this script checks them before copying or verifying.
4. Copy BEFORE switching traffic. Resolve invalid/conflict counts under maintenance.
   --overwrite-family <family> may be repeated; there is no blanket overwrite.
   Token/OAuth/vault families also require --confirm-stale-d1 after the operator
   confirms that D1's conflicting rows are stale. Run --verify for exact value
   hashes and expiries; it reports mismatch counts by family, never payloads.
5. Deploy D1 config under maintenance. Run doctor and check an existing OAuth
   connector, cta_ token, vault credential, and visible activity. Set
   CONNECTA_ACTIVITY="on"; config lives in src/connecta.config.ts.
6. Run --mark-live before reopening traffic. It permanently seals this source
   in D1. Never rerun afterward. --i-know-this-is-stale overrides the seal only
   after assessing stale KV state, with traffic and writers stopped again.
   Keep backups before deleting KV.
Options: --verify, --mark-live, --overwrite-family <family>, --confirm-stale-d1,
         --i-know-this-is-stale, --maintenance, --help`;

export class MigrationUsageError extends Error {}

export function parseArgs(args) {
  const options = { configPath: "kv-to-d1.wrangler.jsonc", overwriteFamilies: [] };
  let hasConfig = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--overwrite-family") {
      const family = args[++i];
      if (!family || family.startsWith("--")) throw new MigrationUsageError("--overwrite-family requires a family");
      options.overwriteFamilies.push(family);
    } else if (arg === "--maintenance") options.maintenance = true;
    else if (arg === "--verify") options.verify = true;
    else if (arg === "--mark-live") options.markLive = true;
    else if (arg === "--confirm-stale-d1") options.confirmStale = true;
    else if (arg === "--i-know-this-is-stale") options.allowStale = true;
    else if (arg === "--help") options.help = true;
    else if (!arg.startsWith("--") && !hasConfig) { options.configPath = arg; hasConfig = true; }
    else throw new MigrationUsageError("Unknown argument; use --help");
  }
  if (options.help) return options;
  if (!options.maintenance) throw new MigrationUsageError("Traffic and writers must be stopped; pass --maintenance after draining and waiting for KV propagation");
  if (options.overwriteFamilies.some((family) => family === "access-token" || family === "credential" || family.startsWith("oauth")) && !options.confirmStale) {
    throw new MigrationUsageError("Token/OAuth/vault overwrite requires --confirm-stale-d1 after confirming D1 rows are stale");
  }
  if ((options.verify || options.markLive) && options.overwriteFamilies.length) throw new MigrationUsageError("Verification and cutover marking cannot overwrite families");
  if (options.verify && options.markLive) throw new MigrationUsageError("Verify before marking cutover in a separate command");
  return options;
}

const encode = new TextEncoder();
const hash = async (value) => {
  const bytes = await crypto.subtle.digest("SHA-256", encode.encode(value));
  return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join("");
};

// Keep only entry digests. Sorting makes the comparison independent of list order.
async function sourceHash(kv) {
  const digests = [];
  let cursor;
  do {
    const page = await kv.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) {
      if (key.expiration !== undefined && key.expiration * 1000 <= Date.now()) continue;
      const value = await kv.get(key.name, "text");
      if (value !== null) digests.push(await hash(JSON.stringify([key.name, key.expiration ?? null, value])));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return hash(digests.sort().join(""));
}

/** Injected operations let the Workers suite exercise the real migration flow. */
export async function runMigration(kv, db, options, operations, output = console) {
  if (!options.maintenance) throw new MigrationUsageError("Migration requires maintenance");
  if (options.markLive) {
    await operations.markKvToD1Live(db, options.source);
    output.log("Cutover sealed in D1. Reopen traffic after deployment verification; never copy stale KV afterward.");
    return 0;
  }
  if (await sourceHash(kv) !== await sourceHash(kv)) {
    throw new MigrationUsageError("Workers KV source is not stable; keep maintenance active, wait, and repeat");
  }
  const families = {};
  let cursor;
  do {
    const result = await operations.copyKvToD1(kv, db, {
      source: options.source, cursor, overwriteFamilies: options.overwriteFamilies,
      verify: options.verify, allowStale: options.allowStale,
    });
    for (const [family, counts] of Object.entries(result.families)) {
      const into = (families[family] ??= {});
      for (const [field, n] of Object.entries(counts)) into[field] = (into[field] ?? 0) + n;
    }
    cursor = result.cursor;
  } while (cursor);
  output.table(families);
  if (Object.values(families).some((counts) => counts.invalid > 0 || counts.conflicts > 0 || counts.mismatches > 0)) {
    output.error("Invalid entries, conflicts, or verification mismatches remain. Keep maintenance active and resolve the per-family counts.");
    return 1;
  }
  return 0;
}

async function main() {
  let proxy;
  let operations;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { console.log(HELP); return; }
    const wranglerModule = "wrangler";
    const d1Module = "@zackbart/connecta/d1";
    const { getPlatformProxy, unstable_readConfig } = await import(/* @vite-ignore */ wranglerModule);
    operations = await import(/* @vite-ignore */ d1Module);
    const config = unstable_readConfig({ config: options.configPath });
    const source = config.kv_namespaces?.find((binding) => binding.binding === "CONNECTA_KV")?.id;
    if (!source || source.startsWith("replace-")) throw new MigrationUsageError("Configure the CONNECTA_KV namespace id before copying");
    proxy = await getPlatformProxy({ configPath: options.configPath, persist: false });
    const { CONNECTA_KV: kv, CONNECTA_DB: db } = proxy.env;
    if (!kv || !db) throw new MigrationUsageError("Copy config must bind CONNECTA_KV and CONNECTA_DB");
    process.exitCode = await runMigration(kv, db, { ...options, source }, operations);
  } catch (error) {
    console.error(error instanceof MigrationUsageError || (operations && error instanceof operations.KvToD1CopyError)
      ? error.message : "Workers KV to D1 migration stopped; keep maintenance active and inspect the configuration");
    process.exitCode = 1;
  } finally {
    await proxy?.dispose();
  }
}

if (typeof process !== "undefined" && import.meta.url === `file://${process.argv?.[1]}`) await main();
