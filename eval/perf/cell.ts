/**
 * One `eval:perf` cell in its own process, so isolate-wide caches start empty
 * and nothing one cell warmed reaches the next. The parent passes the cell as
 * JSON and reads one `PERF_RESULT` line from stdout.
 *
 * The deployment is the Node shape (`listen()`, QuickJS, stored agent tokens)
 * with the D1 driver over an in-memory `node:sqlite` binding that counts every
 * round trip and statement, beside what the request's timing trace saw. Fake
 * downstreams are stateless MCP SDK servers on loopback; each counts the HTTP
 * requests it answers.
 */
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { createConnecta, remoteMcp, type ConnectaConfig } from "@zackbart/connecta";
import { accessTokens, AccessTokenManager } from "@zackbart/connecta/auth/access-tokens";
import { encryptedCredentialVault } from "@zackbart/connecta/credentials";
import { d1Storage, type D1DatabaseBinding } from "@zackbart/connecta/d1";
import { listen } from "@zackbart/connecta/node";
import { quickJsExecutor } from "@zackbart/connecta/quickjs";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { serveFetch, type Served } from "../support/serve.js";
import { assertBuiltPackage } from "./built.js";
import { OPERATIONS, type Cell, type CellLatency, type CellResult, type Counts, type Operation } from "./matrix.js";

const AGENT = "perf";
const QUERY = "search issues";
/** Below the 60 s agent admission observation window, the shortest clock any counted request reads. */
const COUNTING_WINDOW_MS = 45_000;
/** Below the 15 s host-call deadline, the shortest that can end a request without failing it. */
const REQUEST_LIMIT_MS = 12_000;
const QUIET = { debug() {}, info() {}, warn() {}, error() {} };
/** Elapsed-time fields such as `durationMs`, escaped or not; counted as one digit. */
const TIMING_FIELD = /(\\?"\w*Ms\\?":)\d+(?:\.\d+)?/g;
const ENTITIES = ["account", "invoice", "contact", "ticket", "project", "order", "asset", "report"];

interface StorageCount {
  roundTrips: number;
  statements: number;
}

function countingD1(db: DatabaseSync, count: StorageCount): D1DatabaseBinding {
  type Bound = ReturnType<D1DatabaseBinding["prepare"]> & { sql: string; params: unknown[] };
  const statement = (sql: string, params: unknown[] = []): Bound => ({
    sql,
    params,
    bind: (...values: unknown[]) => statement(sql, values),
    all: async () => {
      count.roundTrips++;
      count.statements++;
      return { results: db.prepare(sql).all(...(params as never[])) };
    },
    run: async () => {
      count.roundTrips++;
      count.statements++;
      return { meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (list) => {
      count.roundTrips++;
      count.statements += list.length;
      db.exec("BEGIN");
      try {
        const out = (list as Bound[]).map((s) => ({
          meta: { changes: Number(db.prepare(s.sql).run(...(s.params as never[])).changes) },
        }));
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function documentResult(id: string, bytes: number) {
  const rows: { id: string; line: number; text: string }[] = [];
  let size = 32;
  while (size < bytes) {
    const text = `${id} line ${rows.length}: ${"lorem ipsum dolor sit amet ".repeat(8)}`;
    rows.push({ id, line: rows.length, text });
    size += text.length + 40;
  }
  return { id, rows };
}

interface Fake {
  served: Served;
  requests: number;
  listings: number;
  inFlight: number;
}

async function startFake(index: number, cell: Cell): Promise<Fake> {
  const fake = { requests: 0, listings: 0, inFlight: 0 } as Fake;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: `perf-${index}`, version: "1.0.0" });
    const read = { readOnlyHint: true };
    server.registerTool(
      "get_document",
      {
        description: "Read one document by id, with every line of its body.",
        inputSchema: z.object({ id: z.string() }),
        annotations: read,
      },
      async ({ id }) => {
        const value = documentResult(id, cell.resultBytes);
        return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
      },
    );
    server.registerTool(
      "search_issues",
      {
        description: "Search issues by text, status and label.",
        inputSchema: z.object({ query: z.string(), status: z.enum(["open", "closed"]).optional() }),
        annotations: read,
      },
      async () => ({ content: [{ type: "text" as const, text: "[]" }] }),
    );
    const generated = (index === 0 ? cell.largestCatalog : 8) - 2;
    for (let n = 0; n < generated; n++) {
      const entity = ENTITIES[n % ENTITIES.length]!;
      const write = n % 4 === 3;
      const verb = write ? "update" : ["list", "get", "count"][n % 3]!;
      server.registerTool(
        `${verb}_${entity}_${n}`,
        {
          description: `${write ? "Update" : "Read"} ${entity} records in collection ${n}, filtered by owner, status and date range.`,
          inputSchema: z.object({
            owner: z.string().optional(),
            status: z.enum(["active", "archived"]).optional(),
            since: z.string().optional(),
            limit: z.number().int().optional(),
          }),
          annotations: write ? { readOnlyHint: false, destructiveHint: false } : read,
        },
        async () => ({ content: [{ type: "text" as const, text: "{}" }] }),
      );
    }
    return server;
  });
  fake.served = await serveFetch(async (request) => {
    fake.requests++;
    fake.inFlight++;
    try {
      if (request.method === "POST") {
        const body = (await request
          .clone()
          .json()
          .catch(() => undefined)) as { method?: string } | undefined;
        if (body?.method === "tools/list") fake.listings++;
      }
      return await handler.fetch(request);
    } finally {
      fake.inFlight--;
    }
  });
  return fake;
}

const id = (index: number) => `c${String(index + 1).padStart(2, "0")}`;

function request(operation: Operation, cell: Cell): { method: string; params: Record<string, unknown> } {
  const second = id(Math.min(1, cell.connectors - 1));
  switch (operation) {
    case "tools/list":
      return { method: "tools/list", params: {} };
    case "search_tools":
      return { method: "tools/call", params: { name: "search_tools", arguments: { query: QUERY } } };
    case "call_tool":
      return {
        method: "tools/call",
        params: { name: "call_tool", arguments: { address: "c01.get_document", args: { id: "doc-1" } } },
      };
    case "execute_code":
      return {
        method: "tools/call",
        params: {
          name: "execute_code",
          arguments: {
            code: `async () => {
  const found = await connecta.search({ query: ${JSON.stringify(QUERY)} });
  const first = await connecta.call("c01.get_document", { id: "doc-1" });
  const second = await connecta.call("${second}.get_document", { id: "doc-2" });
  return { catalogErrors: found.catalogErrors.length, first: typeof first.data, second: typeof second.data };
}`,
          },
        },
      };
  }
}

interface TimingRecord {
  operations: Record<string, { count: number; statements: number }>;
}

async function runCell(cell: Cell, samples: number): Promise<CellResult> {
  const fakes = await Promise.all(Array.from({ length: cell.connectors }, (_, index) => startFake(index, cell)));
  const traces: TimingRecord[] = [];
  const logger = {
    ...QUIET,
    info: (message: unknown, record: unknown) => {
      if (message === "connecta.timing") traces.push(record as TimingRecord);
    },
  };
  const db = new DatabaseSync(":memory:");
  const storageCount: StorageCount = { roundTrips: 0, statements: 0 };
  const storage = d1Storage(countingD1(db, storageCount));
  let connecta: ReturnType<typeof createConnecta> | undefined;
  const deferred = new Set<Promise<unknown>>();
  const server = listen(
    {
      fetch: (request, env, ctx) =>
        connecta!.fetch(request, env, {
          ...(ctx as object),
          waitUntil(promise: Promise<unknown>) {
            deferred.add(promise);
            void promise.finally(() => deferred.delete(promise)).catch(() => {});
            (ctx as { waitUntil(promise: Promise<unknown>): void }).waitUntil(promise);
          },
        }),
      close: async () => {
        await connecta?.close();
      },
    } as ReturnType<typeof createConnecta>,
    { port: 0, host: "127.0.0.1", gracefulShutdown: false },
  );
  try {
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { token } = await new AccessTokenManager(storage, { agents: [AGENT] }).rotate(AGENT, "perf-provisioning");
    const vault = cell.secrets ? encryptedCredentialVault(storage, randomBytes(32).toString("base64")) : undefined;
    const connectors = fakes.map((fake, index) =>
      remoteMcp(id(index), {
        url: `${fake.served.url}/mcp`,
        title: `Records ${index + 1}`,
        description: `Documents, issues and ${ENTITIES.join(", ")} records for team ${index + 1}.`,
        logger: QUIET,
        ...(cell.secrets ? { auth: { type: "credential" as const, credential: { label: "API token" } } } : {}),
      }),
    );
    if (vault) {
      for (let index = 0; index < cell.connectors; index++) {
        await vault.set(id(index), `perf-secret-${id(index)}-${"s".repeat(24)}`, "operator");
      }
    }
    const config: ConnectaConfig = {
      readOnly: false,
      storage,
      publicUrl: origin,
      executor: quickJsExecutor(),
      discovery: { catalogZeroTtlSeconds: cell.catalogZeroTtlSeconds },
      agents: [AGENT],
      accessTokens: accessTokens(storage),
      pools: { [AGENT]: { tools: connectors.map((connector) => connector.id), members: [`agent:${AGENT}`] } },
      ...(vault ? { vault } : {}),
      timingTraceSampleRate: 1,
      logger,
      connectors,
    };
    connecta = createConnecta(config);
    const url = `${origin}/agent/${AGENT}`;
    const activity = () =>
      `${storageCount.roundTrips} ${fakes.map((fake) => `${fake.requests}/${fake.inFlight}`).join(" ")}`;
    const quiet = async () => {
      for (let still = 0, last = activity(); still < 3;) {
        while (deferred.size) await Promise.allSettled(deferred);
        await new Promise((resolve) => setTimeout(resolve, 1));
        const now = activity();
        still = now === last && fakes.every((fake) => fake.inFlight === 0) ? still + 1 : 0;
        last = now;
      }
    };
    const send = async (operation: Operation): Promise<{ ms: number; counts: Counts }> => {
      await quiet();
      const tracesBefore = traces.length;
      const storageBefore = { ...storageCount };
      const requestsBefore = fakes.reduce((sum, fake) => sum + fake.requests, 0);
      const listingsBefore = fakes.reduce((sum, fake) => sum + fake.listings, 0);
      const { method, params } = request(operation, cell);
      const started = performance.now();
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = new Uint8Array(await response.arrayBuffer());
      const ms = performance.now() - started;
      const text = new TextDecoder().decode(body);
      const message = JSON.parse(text.startsWith("{") ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? "{}")) as {
        result?: {
          isError?: boolean;
          structuredContent?: {
            catalogErrors?: unknown[];
            result?: { catalogErrors?: number };
            hostCalls?: { attempted: number; succeeded: number };
          };
        };
        error?: unknown;
      };
      if (!response.ok || message.error || !message.result || message.result.isError) {
        throw new Error(`${cell.id} ${operation} failed: ${response.status} ${text.slice(0, 400)}`);
      }
      const structured = message.result.structuredContent;
      if (structured?.hostCalls && structured.hostCalls.succeeded !== structured.hostCalls.attempted) {
        throw new Error(`${cell.id} ${operation}: a host call failed: ${text.slice(0, 400)}`);
      }
      if (ms > REQUEST_LIMIT_MS) {
        throw new Error(
          `${cell.id} ${operation}: took ${Math.round(ms)} ms, past ${REQUEST_LIMIT_MS} ms; the 15 s host-call and 30 s catalog deadlines would move its counts`,
        );
      }
      if (structured?.catalogErrors?.length || structured?.result?.catalogErrors) {
        throw new Error(
          `${cell.id} ${operation}: discovery degraded (a probe deadline, fan-out budget or failure), so its counts would depend on machine speed: ${text.slice(0, 400)}`,
        );
      }
      for (let wait = 0; traces.length === tracesBefore && wait < 2_000; wait++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      if (traces.length !== tracesBefore + 1) {
        throw new Error(`${cell.id} ${operation}: expected one timing record, saw ${traces.length - tracesBefore}`);
      }
      await quiet();
      const families = traces.at(-1)!.operations;
      const family = (name: string) => families[name] ?? { count: 0, statements: 0 };
      return {
        ms,
        counts: {
          storageRoundTrips: storageCount.roundTrips - storageBefore.roundTrips,
          storageStatements: storageCount.statements - storageBefore.statements,
          tracedRoundTrips: ["d1.read", "d1.write", "d1.batch"].reduce((sum, name) => sum + family(name).count, 0),
          downstreamRequests: fakes.reduce((sum, fake) => sum + fake.requests, 0) - requestsBefore,
          downstreamListings: fakes.reduce((sum, fake) => sum + fake.listings, 0) - listingsBefore,
          catalogLookups: family("catalog.cache.lookup").count,
          catalogHits: family("catalog.cache.hit").count,
          catalogStores: family("catalog.store").count,
          responseBytes: Buffer.byteLength(text.replace(TIMING_FIELD, "$10")),
        },
      };
    };
    const counts = {} as CellResult["counts"];
    const measured = new Map<Operation, { firstMs: number; warmMs: number }>();
    const countingStarted = performance.now();
    for (const operation of OPERATIONS) {
      const first = await send(operation);
      await send(operation);
      const warm = await send(operation);
      counts[operation] = { first: first.counts, warm: warm.counts };
      measured.set(operation, { firstMs: first.ms, warmMs: warm.ms });
    }
    const countingMs = performance.now() - countingStarted;
    if (countingMs > COUNTING_WINDOW_MS) {
      throw new Error(
        `${cell.id}: counted requests took ${Math.round(countingMs)} ms, past ${COUNTING_WINDOW_MS} ms; the agent admission observation refreshes after 60 s, which would move a count`,
      );
    }
    const latency: CellLatency[] = [];
    for (const operation of OPERATIONS) {
      const { firstMs, warmMs } = measured.get(operation)!;
      const times: number[] = [warmMs];
      for (let sample = 1; sample < samples; sample++) times.push((await send(operation)).ms);
      times.sort((a, b) => a - b);
      const at = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))]!;
      latency.push({
        operation,
        firstMs,
        samples: times.length,
        p50Ms: at(0.5),
        p90Ms: at(0.9),
        minMs: times[0]!,
        maxMs: times.at(-1)!,
      });
    }
    return { counts, latency };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await connecta?.close();
    db.close();
    await Promise.all(fakes.map((fake) => fake.served.close()));
  }
}

assertBuiltPackage();
const [cellJson, samplesArg] = process.argv.slice(2);
const result = await runCell(JSON.parse(cellJson!) as Cell, Number(samplesArg ?? 1));
process.stdout.write(`PERF_RESULT ${JSON.stringify(result)}\n`);
