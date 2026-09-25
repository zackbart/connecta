// The reference ArtifactStore over KVStorage.
//
// Layout, under one prefix (default `artifact:`):
//
//   head:<id>                          the one mutable record per artifact
//   ver:<id>:<stream>:<n, 10 digits>   every version but each stream's latest
//   blob:<sha256>                      bodies, unless a blob store holds them
//   run:<id>:<startedAt ms>:<runId>    refresh run history, newest 50
//
// The head is the only key ever compared-and-set, and a write commits by
// swapping it. Everything else is written before that swap and is either
// content-addressed (bodies) or immutable once the head that describes it
// exists (versions), so a plain `set` of the same key twice writes the same
// bytes twice.

import type { KVStorage } from "../types.js";
import {
  ARTIFACT_RUNS_RETAINED,
  type ArtifactBlobStore,
  type ArtifactHeadRecord,
  type ArtifactRunRecord,
  type ArtifactStore,
  type ArtifactStream,
  type ArtifactVersionRecord,
} from "./types.js";

export interface KvArtifactStoreOptions {
  /**
   * Keep bodies here instead of in the key-value store — an R2 bucket on
   * Workers. Heads, versions, and runs stay in the key-value store, which
   * owns the compare-and-set.
   */
  blobs?: ArtifactBlobStore;
  /** Key prefix for every record. Default `artifact:`. */
  prefix?: string;
}

const VERSION_DIGITS = 10;
const pad = (n: number, digits: number) => String(n).padStart(digits, "0");

/**
 * An artifact store over `KVStorage`. The storage must provide `compareAndSet`
 * — a write commits by swapping one head record, and a read followed by a
 * write cannot stand in for that — and `list`, which history and the library
 * page through. Cloudflare Workers KV has neither guarantee and is refused
 * here, at construction, rather than losing a write later.
 */
export function kvArtifactStore(
  kv: KVStorage,
  options: KvArtifactStoreOptions = {},
): ArtifactStore {
  const { compareAndSet, list } = kv;
  if (typeof compareAndSet !== "function" || typeof list !== "function") {
    throw new TypeError(
      "kvArtifactStore needs storage with compareAndSet and list: every " +
        "artifact write commits by compare-and-set, and Cloudflare Workers KV " +
        "cannot offer one. Use the Worker example's D1 store (d1Storage), " +
        "fileStorage from @zackbart/connecta/node, or memoryStorage in tests.",
    );
  }
  const cas = compareAndSet.bind(kv);
  const keys = list.bind(kv);
  const prefix = options.prefix ?? "artifact:";
  if (typeof prefix !== "string") {
    throw new TypeError("kvArtifactStore: prefix must be a string");
  }
  const blobs = options.blobs;
  const headKey = (id: string) => `${prefix}head:${id}`;
  const versionPrefix = (id: string, stream: ArtifactStream) =>
    `${prefix}ver:${id}:${stream}:`;
  const runPrefix = (id: string) => `${prefix}run:${id}:`;
  const blobKey = (key: string) => `${prefix}blob:${key}`;
  const scanKey = `${prefix}refresh:scan-cursor`;

  const readJson = async <T>(key: string): Promise<T | null> => {
    const text = await kv.get(key);
    return text === null ? null : (JSON.parse(text) as T);
  };

  return {
    async head(id) {
      const token = await kv.get(headKey(id));
      if (token === null) return null;
      return { head: JSON.parse(token) as ArtifactHeadRecord, token };
    },

    async swapHead(id, expected, next) {
      return cas(headKey(id), expected, JSON.stringify(next));
    },

    async heads({ after, limit }) {
      const base = `${prefix}head:`;
      const ids = (await keys(base))
        .map((key) => key.slice(base.length))
        .filter((id) => after === undefined || id > after);
      const page = ids.slice(0, Math.max(0, limit));
      const heads: { id: string; head: ArtifactHeadRecord }[] = [];
      for (const [index, head] of (
        await Promise.all(page.map((id) => readJson<ArtifactHeadRecord>(headKey(id))))
      ).entries()) {
        const id = page[index];
        // A head listed and then gone is not an error: nothing deletes one,
        // but an adapter's listing may lag its reads.
        if (id !== undefined && head !== null) heads.push({ id, head });
      }
      const last = page.at(-1);
      return ids.length > page.length && last !== undefined
        ? { heads, next: last }
        : { heads };
    },

    async putBody(key, body) {
      if (blobs) await blobs.put(key, body);
      else await kv.set(blobKey(key), body);
    },

    async body(key) {
      return blobs ? blobs.get(key) : kv.get(blobKey(key));
    },

    async putVersion(id, stream, version, record) {
      await kv.set(
        `${versionPrefix(id, stream)}${pad(version, VERSION_DIGITS)}`,
        JSON.stringify(record),
      );
    },

    async versions(id, stream, { below, limit }) {
      const base = versionPrefix(id, stream);
      if (limit <= 0) return [];
      let wanted: number[];
      if (below === undefined) {
        // Versions below each stream's latest are dense, but the latest
        // itself lives only in the head, so an unbounded read lists.
        wanted = (await keys(base))
          .map((key) => Number(key.slice(base.length)))
          .filter(Number.isInteger)
          .sort((a, b) => b - a)
          .slice(0, limit);
      } else {
        wanted = [];
        for (let n = below - 1; n >= 1 && wanted.length < limit; n--) {
          wanted.push(n);
        }
      }
      const records = await Promise.all(
        wanted.map((n) =>
          readJson<ArtifactVersionRecord>(`${base}${pad(n, VERSION_DIGITS)}`),
        ),
      );
      return records.filter(
        (record): record is ArtifactVersionRecord => record !== null,
      );
    },

    async putRun(id, run) {
      const started = Date.parse(run.startedAt);
      const key = `${runPrefix(id)}${pad(Number.isFinite(started) ? started : 0, 15)}:${run.runId}`;
      await kv.set(key, JSON.stringify(run));
      const all = await keys(runPrefix(id));
      const excess = all.length - ARTIFACT_RUNS_RETAINED;
      if (excess > 0) {
        await Promise.all(all.slice(0, excess).map((old) => kv.delete(old)));
      }
    },

    async runs(id, limit) {
      if (limit <= 0) return [];
      const newest = (await keys(runPrefix(id))).slice(-limit).reverse();
      const runs = await Promise.all(
        newest.map((key) => readJson<ArtifactRunRecord>(key)),
      );
      return runs.filter((run): run is ArtifactRunRecord => run !== null);
    },

    async refreshScanCursor() {
      return (await kv.get(scanKey)) ?? undefined;
    },

    async setRefreshScanCursor(after) {
      if (after === undefined) await kv.delete(scanKey);
      else await kv.set(scanKey, after);
    },
  };
}
