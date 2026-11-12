/** Complete-catalog ceiling shared by dynamically listed connector catalogs. */
export const MAX_CATALOG_TOOLS = 100_000;

/**
 * Large enough to span many stored chunks while keeping the serialized form
 * at one quarter of a 128 MiB Worker heap.
 */
export const MAX_SERIALIZED_CATALOG_BYTES = 32 * 1024 * 1024;

/** Persisted values stay comfortably below platform per-value limits. */
export const MAX_CATALOG_CHUNK_BYTES = 1024 * 1024;

/** Catalog chunks one storage read fetches together, so one answer stays a few megabytes. */
export const CATALOG_CHUNKS_PER_READ = 8;

/**
 * Generation-derived keys one locating snapshot may select: a refusal fence,
 * private and public manifests, and one read's worth of hinted chunks.
 */
export const MAX_CATALOG_LOCATOR_SUFFIXES = 3 + CATALOG_CHUNKS_PER_READ;
