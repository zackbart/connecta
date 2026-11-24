/**
 * The `eval:perf` matrix: which deployments run, which requests they answer,
 * and the deterministic counts each request records. See eval/README.md
 * § "Request counts and latency".
 */

export interface Cell {
  id: string;
  /** `discovery.catalogZeroTtlSeconds`: 0 relists every request, 300 reuses. */
  catalogZeroTtlSeconds: 0 | 300;
  connectors: 1 | 6 | 24;
  /** Tools on connector `c01`; every other connector has 8. */
  largestCatalog: 8 | 400;
  /** UTF-8 bytes of the read tool's JSON result. */
  resultBytes: 1_024 | 65_536 | 614_400;
  /** Each connector declares a credential slot, saved in the vault. */
  secrets: boolean;
  why: string;
}

const base = {
  catalogZeroTtlSeconds: 300,
  connectors: 6,
  largestCatalog: 8,
  resultBytes: 1_024,
  secrets: false,
} as const;

export const CELLS: Cell[] = [
  { id: "base", ...base, why: "the shipped shapes' reuse, six small connectors, 1 KB reads, no secrets" },
  { id: "zero-ttl", ...base, catalogZeroTtlSeconds: 0, why: "the library default: every request relists" },
  { id: "connectors-1", ...base, connectors: 1, why: "connector count, reused" },
  { id: "connectors-1-zero-ttl", ...base, connectors: 1, catalogZeroTtlSeconds: 0, why: "connector count, relisted" },
  { id: "connectors-24", ...base, connectors: 24, why: "connector count past the discovery concurrency of 4" },
  {
    id: "connectors-24-zero-ttl",
    ...base,
    connectors: 24,
    catalogZeroTtlSeconds: 0,
    why: "the relisting cost scales with connectors",
  },
  {
    id: "tools-400",
    ...base,
    largestCatalog: 400,
    why: "catalog size: one 400-tool connector, chunked catalog storage and indexing",
  },
  {
    id: "tools-400-zero-ttl",
    ...base,
    largestCatalog: 400,
    catalogZeroTtlSeconds: 0,
    why: "the relisting cost scales with catalog size",
  },
  { id: "result-64k", ...base, resultBytes: 65_536, why: "result size: past the inline result cap" },
  { id: "result-600k", ...base, resultBytes: 614_400, why: "result size: a retained result in many chunks" },
  { id: "secrets", ...base, secrets: true, why: "vault reads and sent-secret redaction" },
  {
    id: "secrets-result-600k",
    ...base,
    secrets: true,
    resultBytes: 614_400,
    why: "redaction over a large result",
  },
];

export const OPERATIONS = ["tools/list", "search_tools", "call_tool", "execute_code"] as const;
export type Operation = (typeof OPERATIONS)[number];

/** Facts about one upward request; see `reportedCounters` for which are gated. */
export interface Counts {
  /** D1 `all`, `run` and `batch` calls, counted at the binding. */
  storageRoundTrips: number;
  /** SQL statements in those round trips; a batch of three is three. */
  storageStatements: number;
  /** Of those round trips, the ones the request's timing trace saw (`d1.*`). */
  tracedRoundTrips: number;
  /** HTTP requests every fake downstream received while the request ran. */
  downstreamRequests: number;
  /** Of those, `tools/list` requests. */
  downstreamListings: number;
  /** Catalog cache probes and accepted hits (trace `catalog.cache.lookup`/`hit`). */
  catalogLookups: number;
  catalogHits: number;
  /** Catalogs written to storage (trace `catalog.store`). */
  catalogStores: number;
  /** UTF-8 bytes of the upward HTTP response body. */
  responseBytes: number;
}

export const COUNTERS = [
  "storageRoundTrips",
  "storageStatements",
  "tracedRoundTrips",
  "downstreamRequests",
  "downstreamListings",
  "catalogLookups",
  "catalogHits",
  "catalogStores",
  "responseBytes",
] as const satisfies readonly (keyof Counts)[];

export const PHASES = ["first", "warm"] as const;

/**
 * Counters written to results but left out of the gate, as `<operation>.<counter>`.
 * A program read of a 600 KiB result is transferred and then reclaimed, and
 * every reclaim in a run shares a one-second wall-clock budget
 * (`RECLAIM_BUDGET_MS` in src/execute.ts) that may skip or cut short the
 * chunk deletes. That program's storage counts depend on machine speed; its
 * other counts do not, because reclaim only deletes stored chunks.
 */
export function reportedCounters(cell: Cell): string[] {
  return cell.resultBytes > 65_536
    ? ["storageRoundTrips", "storageStatements", "tracedRoundTrips"].map((counter) => `execute_code.${counter}`)
    : [];
}

/** A request's counts the first time it runs in its cell, and once warm. */
interface OperationCounts {
  first: Counts;
  warm: Counts;
}

export type CellCounts = Record<Operation, OperationCounts>;

export interface CellLatency {
  operation: Operation;
  /** The first request of this operation in its cell. */
  firstMs: number;
  /** Warm requests timed; the percentiles cover these. */
  samples: number;
  p50Ms: number;
  p90Ms: number;
  minMs: number;
  maxMs: number;
}

export interface CellResult {
  counts: CellCounts;
  latency: CellLatency[];
}
