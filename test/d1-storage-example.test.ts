import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { d1Storage } from "../examples/worker/src/d1-storage.js";
import {
  compareAndSetContract,
  requireCas,
  type CasStorage,
} from "./storage-contract.js";

interface Env {
  STORAGE_DB: D1Database;
}

/**
 * The schema a deployment applies is the one in the example README, so read
 * it from there: a README that drifts from the adapter fails here first.
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
let db: D1Database;

beforeAll(async () => {
  proxy = await getPlatformProxy<Env>({
    configPath: fileURLToPath(
      new URL("./fixtures/d1-storage/wrangler.jsonc", import.meta.url),
    ),
    persist: false,
  });
  db = proxy.env.STORAGE_DB;
  for (const statement of readmeSchema()) await db.prepare(statement).run();
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

async function open(): Promise<CasStorage> {
  await db.prepare("DELETE FROM connecta_kv").run();
  return requireCas(d1Storage(db));
}

async function rowKeys(): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT key FROM connecta_kv ORDER BY key")
    .all<{ key: string }>();
  return results.map((row) => row.key);
}

describe("Worker example D1 storage", () => {
  compareAndSetContract(open);

  it("round-trips get, set, delete, and a sorted list", async () => {
    const storage = await open();
    await storage.set("conn:b:token", "2");
    await storage.set("conn:a:token", "1");
    await storage.set("results:x", "3");
    await storage.set("conn:a:token", "1b");
    expect(await storage.get("conn:a:token")).toBe("1b");
    expect(await storage.list?.("conn:")).toEqual([
      "conn:a:token",
      "conn:b:token",
    ]);
    expect(await storage.list?.("")).toEqual([
      "conn:a:token",
      "conn:b:token",
      "results:x",
    ]);
    await storage.delete("conn:a:token");
    expect(await storage.get("conn:a:token")).toBeNull();
    expect(await storage.list?.("conn:")).toEqual(["conn:b:token"]);
  });

  it("treats a list prefix literally, never as a pattern", async () => {
    const storage = await open();
    await storage.set("a%b", "1");
    await storage.set("a_b", "2");
    await storage.set("axb", "3");
    expect(await storage.list?.("a%")).toEqual(["a%b"]);
    expect(await storage.list?.("a_")).toEqual(["a_b"]);
  });

  it("removes expired rows physically on a later write", async () => {
    const storage = await open();
    await storage.set("old", "v", { ttlSeconds: -1 });
    expect(await storage.get("old")).toBeNull();
    expect(await rowKeys()).toEqual(["old"]);
    await storage.set("new", "v");
    expect(await rowKeys()).toEqual(["new"]);
  });
});
