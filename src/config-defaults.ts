// Every configuration default, defined once.
//
// The schema in src/config.ts applies these when a deployment omits a value,
// and `describeConfig()` reports them as `source: "default"`. The modules that
// enforce each bound read the same numbers for the fallbacks their own
// constructors keep, so a test that builds a Registry or an execute tool
// directly sees the deployment's defaults rather than a second copy of them.

export const CONFIG_DEFAULTS = {
  discovery: {
    concurrency: 4,
    catalogTtlSeconds: 300,
    persistCatalog: true,
    staleCatalogSeconds: 3_600,
    probeTimeoutMs: 30_000,
  },
  calls: {
    maxResultBytes: 24_000,
  },
  results: {
    maxStashBytes: 8 * 1024 * 1024,
    maxStashEntries: 64,
  },
  execute: {
    maxEmittedBytes: 4_000_000,
    maxEmittedBlocks: 32,
    maxHostCalls: 20,
    hostCallTimeoutMs: 15_000,
    watchdogMs: 120_000,
    maxWrites: 10,
  },
  admission: {
    requests: {
      concurrency: 16,
      maxQueueSize: 32,
      queueTimeoutMs: 5_000,
      retryAfterMs: 1_000,
      maxDurationMs: 300_000,
    },
    code: {
      concurrency: 2,
      maxQueueSize: 8,
      queueTimeoutMs: 5_000,
      retryAfterMs: 1_000,
    },
  },
} as const;
