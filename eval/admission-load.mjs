import { fork } from "node:child_process";
import { request } from "node:http";
import { once } from "node:events";

const catalogSize = Number(process.env.CONNECTA_LOAD_CATALOG_SIZE ?? "10000");
const serverConcurrency = Number(
  process.env.CONNECTA_LOAD_CONCURRENCY ?? "16",
);
const serverMaxQueueSize = Number(
  process.env.CONNECTA_LOAD_MAX_QUEUE_SIZE ?? "256",
);

async function startServer() {
  const child = fork(new URL("./admission-load-server.mjs", import.meta.url), {
    execArgv: ["--expose-gc"],
    env: {
      ...process.env,
      CONNECTA_LOAD_CATALOG_SIZE: String(catalogSize),
      CONNECTA_LOAD_CONCURRENCY: String(serverConcurrency),
      CONNECTA_LOAD_MAX_QUEUE_SIZE: String(serverMaxQueueSize),
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const [ready] = await once(child, "message");
  if (ready?.type !== "ready") {
    throw new Error("Load server did not become ready.");
  }
  return { child, port: ready.port, nextMessageId: 1 };
}

async function stopServer(server) {
  server.child.send({ type: "shutdown" });
  await once(server.child, "exit");
}

function percentile(sorted, fraction) {
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * fraction) - 1,
  );
  return sorted[index];
}

function oneCall(server, id) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "call_tool",
      arguments: { address: "load.tool_0", args: { value: id } },
    },
  });
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode !== 200) {
              throw new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 500)}`);
            }
            const outer = JSON.parse(raw);
            const value = JSON.parse(outer.result.content[0].text);
            if (value.value !== id) {
              throw new Error(`Unexpected value for call ${id}`);
            }
            resolve(performance.now() - started);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function snapshot(server, { gc = false, resetPeak = false } = {}) {
  const id = server.nextMessageId++;
  const response = new Promise((resolve) => {
    const onMessage = (message) => {
      if (message?.type !== "snapshot" || message.id !== id) return;
      server.child.off("message", onMessage);
      resolve(message);
    };
    server.child.on("message", onMessage);
  });
  server.child.send({ type: "snapshot", id, gc, resetPeak });
  return response;
}

async function runCase(server, calls, inFlight) {
  const before = await snapshot(server, { gc: true, resetPeak: true });
  const latencies = Array(calls);
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(calls, inFlight) }, async () => {
      while (true) {
        const index = next++;
        if (index >= calls) return;
        latencies[index] = await oneCall(server, index + 1);
      }
    }),
  );
  const durationMs = performance.now() - started;
  const after = await snapshot(server, { gc: true });
  latencies.sort((a, b) => a - b);
  return {
    calls,
    inFlight,
    succeeded: latencies.length,
    throughput: calls / (durationMs / 1_000),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    rssBefore: before.rss,
    peakRss: after.peakRss,
    rssAfterGc: after.rss,
    liveHeapAfterGc: after.heapUsed,
  };
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function fixed(value) {
  return value.toFixed(1);
}

const matrix = [];
for (const calls of [100, 500, 1_000, 5_000]) {
  for (const inFlight of [10, 50, 100]) {
    const server = await startServer();
    try {
      // Warm the catalog before recording this independent server baseline.
      await oneCall(server, 0);
      matrix.push(await runCase(server, calls, inFlight));
    } finally {
      await stopServer(server);
    }
  }
}

const soak = [];
const soakServer = await startServer();
try {
  await oneCall(soakServer, 0);
  for (let round = 1; round <= 3; round++) {
    soak.push({ round, ...(await runCase(soakServer, 5_000, 50)) });
  }
} finally {
  await stopServer(soakServer);
}

console.log(
  `\nCatalog: ${catalogSize.toLocaleString()} tools; server admission concurrency: ${serverConcurrency}; max queue: ${serverMaxQueueSize}\n`,
);
console.log(
  "| Calls | Client in flight | Throughput/s | p50 ms | p95 ms | p99 ms | RSS before MB | Peak RSS MB | RSS after GC MB | Live heap MB |",
);
console.log(
  "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
);
for (const row of matrix) {
  console.log(
    `| ${row.calls} | ${row.inFlight} | ${fixed(row.throughput)} | ${fixed(row.p50Ms)} | ${fixed(row.p95Ms)} | ${fixed(row.p99Ms)} | ${mb(row.rssBefore)} | ${mb(row.peakRss)} | ${mb(row.rssAfterGc)} | ${mb(row.liveHeapAfterGc)} |`,
  );
}
console.log("\nThree-round soak (5,000 calls, 50 client in flight):\n");
console.log(
  "| Round | Succeeded | Throughput/s | Peak RSS MB | RSS after GC MB | Live heap MB |",
);
console.log("| ---: | ---: | ---: | ---: | ---: | ---: |");
for (const row of soak) {
  console.log(
    `| ${row.round} | ${row.succeeded} | ${fixed(row.throughput)} | ${mb(row.peakRss)} | ${mb(row.rssAfterGc)} | ${mb(row.liveHeapAfterGc)} |`,
  );
}
