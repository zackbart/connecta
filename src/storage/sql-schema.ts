// The existing on-disk schema, shared by native stores and synchronous import.
export const KV_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS connecta_kv (
    key           TEXT PRIMARY KEY,
    value         TEXT NOT NULL,
    expires_at_ms INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS connecta_kv_expiry
    ON connecta_kv (expires_at_ms)`,
];
