import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { d1Storage } from "../examples/worker/src/d1-storage.js";
import { r2ArtifactBlobs } from "../examples/worker/src/r2-artifact-blobs.js";
import { kvArtifactStore } from "../src/artifacts.js";
import { artifactStoreContract } from "./artifact-store-contract.js";

interface Env {
  STORAGE_DB: D1Database;
  ARTIFACTS_BUCKET: R2Bucket;
}

/**
 * Artifacts need no table of their own: they live in `connecta_kv`, so the
 * schema is the one the example README gives for strongly consistent storage.
 */
function readmeSchema(): string[] {
  const readme = readFileSync(
    new URL("../examples/worker/README.md", import.meta.url),
    "utf8",
  );
  const section = readme.slice(readme.indexOf("## Strongly consistent storage"));
  const schema = /```sql\n([\s\S]*?)```/.exec(section)?.[1];
  if (!schema?.includes("connecta_kv")) {
    throw new Error("examples/worker/README.md has no connecta_kv schema block");
  }
  return schema.split(";").map((statement) => statement.trim()).filter(Boolean);
}

let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>> | undefined;
let env: Env;

beforeAll(async () => {
  proxy = await getPlatformProxy<Env>({
    configPath: fileURLToPath(
      new URL("./fixtures/artifacts-d1-r2/wrangler.jsonc", import.meta.url),
    ),
    persist: false,
  });
  env = proxy.env;
  for (const statement of readmeSchema()) await env.STORAGE_DB.prepare(statement).run();
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

let bucketPrefix = 0;

async function reset(): Promise<void> {
  await env.STORAGE_DB.prepare("DELETE FROM connecta_kv").run();
}

describe("kvArtifactStore over the Worker example's D1 store", () => {
  artifactStoreContract(async () => {
    await reset();
    return kvArtifactStore(d1Storage(env.STORAGE_DB));
  });
});

describe("kvArtifactStore over D1 with R2 bodies", () => {
  artifactStoreContract(async () => {
    await reset();
    // A fresh prefix per case stands in for an empty bucket.
    bucketPrefix++;
    return kvArtifactStore(d1Storage(env.STORAGE_DB), {
      blobs: r2ArtifactBlobs(env.ARTIFACTS_BUCKET, `case-${bucketPrefix}/`),
    });
  });

  it("writes bodies to the bucket, not the database", async () => {
    await reset();
    const store = kvArtifactStore(d1Storage(env.STORAGE_DB), {
      blobs: r2ArtifactBlobs(env.ARTIFACTS_BUCKET, "bodies/"),
    });
    await store.putBody("d".repeat(64), "<!doctype html>");
    expect(await (await env.ARTIFACTS_BUCKET.get(`bodies/${"d".repeat(64)}`))?.text()).toBe(
      "<!doctype html>",
    );
    const { results } = await env.STORAGE_DB.prepare("SELECT key FROM connecta_kv").all();
    expect(results).toEqual([]);
  });
});
