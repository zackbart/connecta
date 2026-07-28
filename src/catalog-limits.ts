/** Complete-catalog ceiling shared by dynamically listed connector catalogs. */
export const MAX_CATALOG_TOOLS = 100_000;

/**
 * Large enough to cross a single Workers KV value boundary while keeping the
 * serialized form at one quarter of a 128 MiB Worker heap.
 */
export const MAX_SERIALIZED_CATALOG_BYTES = 32 * 1024 * 1024;

/** Persisted values stay comfortably below platform per-value limits. */
export const MAX_CATALOG_CHUNK_BYTES = 1024 * 1024;
