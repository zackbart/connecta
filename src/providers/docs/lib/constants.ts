/**
 * The Docs API root. Unlike Gmail there is no per-user path segment: the
 * delegated token's subject decides which documents a request can reach.
 */
export const DOCS_API_BASE_URL = "https://docs.googleapis.com/v1";

/**
 * Exactly the scope this connection requests, and exactly what the Admin
 * console's domain-wide delegation entry must list for it. `documents` reads
 * and edits Docs the user can reach; it lists nothing and touches no other
 * Drive file type.
 */
export const DOCS_SCOPES = ["https://www.googleapis.com/auth/documents"] as const;

/**
 * A document with every tab, as JSON. Styles ride on every text run, so the
 * JSON is many times the text; this admits documents near Google's own size
 * limit without letting one exhaust a Worker.
 */
export const DOCS_MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
