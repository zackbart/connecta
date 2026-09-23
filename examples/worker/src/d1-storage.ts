import type { KVStorage } from "@zackbart/connecta";

/**
 * KVStorage over a D1 database, with the atomic `compareAndSet` that Workers
 * KV cannot offer. Apply the `connecta_kv` schema in README.md § "Strongly
 * consistent storage" before first use.
 *
 * Every compare-and-set is a single SQL statement. D1 runs one database's
 * statements one at a time against its primary, so the comparison and the
 * write cannot interleave with another request's: of fifty concurrent claims
 * on an absent key, exactly one changes a row.
 *
 * Expiry is judged by the Worker's clock at each call, the same `Date.now()`
 * the core uses. An expired row reads as absent immediately and is removed
 * physically by later writes, a bounded batch at a time, so no request starts
 * a background job and no cron is required.
 */
export function d1Storage(db: D1Database): KVStorage {
  // Every statement that tests liveness binds the current time as ?2.
  const live = "(expires_at_ms IS NULL OR expires_at_ms > ?2)";
  const expiresAt = (now: number, ttlSeconds?: number) =>
    ttlSeconds ? now + ttlSeconds * 1000 : null;
  const changed = (result: D1Result) => result.meta.changes > 0;
  return {
    async get(key) {
      const row = await db
        .prepare(`SELECT value FROM connecta_kv WHERE key = ?1 AND ${live}`)
        .bind(key, Date.now())
        .first<{ value: string }>();
      return row?.value ?? null;
    },
    async set(key, value, opts) {
      const now = Date.now();
      await db.batch([
        db
          .prepare(
            `DELETE FROM connecta_kv WHERE key IN (
              SELECT key FROM connecta_kv WHERE expires_at_ms <= ?1 LIMIT 16
            )`,
          )
          .bind(now),
        db
          .prepare(
            `INSERT INTO connecta_kv (key, value, expires_at_ms)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (key) DO UPDATE SET
               value = excluded.value, expires_at_ms = excluded.expires_at_ms`,
          )
          .bind(key, value, expiresAt(now, opts?.ttlSeconds)),
      ]);
    },
    async delete(key) {
      await db.prepare("DELETE FROM connecta_kv WHERE key = ?1").bind(key).run();
    },
    async list(prefix) {
      const { results } = await db
        .prepare(
          `SELECT key FROM connecta_kv
           WHERE key >= ?1 AND substr(key, 1, length(?1)) = ?1 AND ${live}`,
        )
        .bind(prefix, Date.now())
        .all<{ key: string }>();
      // Sort in JavaScript: SQLite orders UTF-8 bytes, the contract orders
      // the UTF-16 code units every other adapter sorts by.
      return results.map((row) => row.key).sort();
    },
    async compareAndSet(key, expected, next, opts) {
      const now = Date.now();
      if (next === null && expected === null) {
        // Nothing to write; the claim holds exactly when no live row exists.
        const row = await db
          .prepare(`SELECT 1 AS present FROM connecta_kv WHERE key = ?1 AND ${live}`)
          .bind(key, now)
          .first();
        return row === null;
      }
      if (next === null) {
        return changed(
          await db
            .prepare(
              `DELETE FROM connecta_kv WHERE key = ?1 AND ${live} AND value = ?3`,
            )
            .bind(key, now, expected)
            .run(),
        );
      }
      const expiry = expiresAt(now, opts?.ttlSeconds);
      if (expected === null) {
        // Insert, or take over a row that has expired. A live row makes the
        // upsert's WHERE false, so nothing changes and the claim is refused.
        return changed(
          await db
            .prepare(
              `INSERT INTO connecta_kv (key, value, expires_at_ms)
               VALUES (?1, ?3, ?4)
               ON CONFLICT (key) DO UPDATE SET
                 value = excluded.value, expires_at_ms = excluded.expires_at_ms
               WHERE connecta_kv.expires_at_ms IS NOT NULL
                 AND connecta_kv.expires_at_ms <= ?2`,
            )
            .bind(key, now, next, expiry)
            .run(),
        );
      }
      return changed(
        await db
          .prepare(
            `UPDATE connecta_kv SET value = ?4, expires_at_ms = ?5
             WHERE key = ?1 AND ${live} AND value = ?3`,
          )
          .bind(key, now, expected, next, expiry)
          .run(),
      );
    },
  };
}
