// Node-only: drives the D1 storage and activity adapters through wrangler's getPlatformProxy local D1.
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { quickJsExecutor } from "../src/executors/quickjs.js";
import { checkLargeProgramRead, checkLargeProgramWrite } from "./program-result-cases.js";
import { getPlatformProxy } from "wrangler";
import { d1ActivityStore, d1Storage } from "../src/d1.js";
import { sqlStorageContract } from "./sql-storage-contract.js";

// Every case here is real I/O against a local workerd that wrangler spawns,
// wall-clock nothing here can fake: on a loaded host the slower contract cases
// outran vitest's 5s default with no behavior at fault. This file budget is a
// hang guard, not a speed assertion.
vi.setConfig({ testTimeout: 30_000 });

interface Env {
  CONNECTA_DB: D1Database;
}

let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>> | undefined;
let db: D1Database;

beforeAll(async () => {
  proxy = await getPlatformProxy<Env>({
    configPath: fileURLToPath(new URL("./fixtures/d1-storage/wrangler.jsonc", import.meta.url)),
    persist: false,
  });
  db = proxy.env.CONNECTA_DB;
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

/** An empty database: no tables, so each case also proves schema creation. */
async function open() {
  await db.batch([
    db.prepare("DROP TABLE IF EXISTS connecta_kv"),
    db.prepare("DROP TABLE IF EXISTS tool_call_activity"),
  ]);
  return {
    storage: () => d1Storage(db),
    activity: (options?: { retentionDays?: number }) => d1ActivityStore(db, options),
    async exec(sql: string, ...params: (string | number | null)[]) {
      await db
        .prepare(sql)
        .bind(...params)
        .run();
    },
    async rows<Row>(sql: string, ...params: (string | number | null)[]) {
      return (
        await db
          .prepare(sql)
          .bind(...params)
          .all<Row>()
      ).results;
    },
  };
}

describe("d1Storage and d1ActivityStore over a local D1", () => {
  it("INV-9: program result transfers and write handles share the D1 stash", async () => {
    const executor = quickJsExecutor({ cpuTimeMs: 5_000 });
    try {
      const storage = (await open()).storage();
      await checkLargeProgramRead(executor, storage);
      await checkLargeProgramWrite(executor, storage);
    } finally {
      await executor.close?.();
    }
  });
  sqlStorageContract(open);
});
