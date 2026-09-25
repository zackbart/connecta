import type { ArtifactBlobStore } from "@zackbart/connecta/artifacts";

/**
 * Artifact bodies — page sources, data documents, refresh programs — in an R2
 * bucket, beside a D1-backed `kvArtifactStore` that keeps the heads, versions,
 * and runs. Optional: without it, bodies live in D1 rows, which the default
 * limits keep well under D1's row size. Use it once pages or documents grow,
 * or to keep large bodies out of the database a backup copies.
 *
 * Keys are content addresses, so writing one twice writes the same bytes, and
 * nothing here ever deletes one: versions are immutable, and a rollback points
 * back at an old body rather than copying it.
 */
export function r2ArtifactBlobs(
  bucket: R2Bucket,
  prefix = "artifacts/blobs/",
): ArtifactBlobStore {
  return {
    async put(key, body) {
      await bucket.put(`${prefix}${key}`, body, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      });
    },
    async get(key) {
      const object = await bucket.get(`${prefix}${key}`);
      return object ? object.text() : null;
    },
  };
}
