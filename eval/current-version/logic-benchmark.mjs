import { fork, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { round } from "./audit-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function positiveWhole(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive whole number.`);
  }
  return value;
}

const samples = positiveWhole(
  Number(option("--samples", process.env.CONNECTA_PERF_SAMPLES ?? "40")),
  "--samples",
);
const loadCalls = positiveWhole(
  Number(option("--load-calls", process.env.CONNECTA_PERF_LOAD_CALLS ?? "400")),
  "--load-calls",
);
const outputPath = resolve(
  here,
  option("--output", "results/current-logic-performance.json"),
);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const profiles = [
  { name: "small-distributed", connectors: 10, toolsPerConnector: 10 },
  { name: "medium-distributed", connectors: 25, toolsPerConnector: 40 },
  { name: "large-distributed", connectors: 100, toolsPerConnector: 100 },
  { name: "large-wide", connectors: 1, toolsPerConnector: 10_000 },
];

function percentile(sorted, fraction) {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? 0;
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    minMs: round(sorted[0] ?? 0, 3),
    p50Ms: round(percentile(sorted, 0.5), 3),
    p95Ms: round(percentile(sorted, 0.95), 3),
    p99Ms: round(percentile(sorted, 0.99), 3),
    maxMs: round(sorted.at(-1) ?? 0, 3),
    meanMs: round(
      sorted.reduce((sum, value) => sum + value, 0) /
        Math.max(1, sorted.length),
      3,
    ),
    valuesMs: sorted.map((value) => round(value, 3)),
  };
}

function alphabetic(value) {
  let remaining = value;
  let result = "";
  do {
    result = String.fromCharCode(97 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return result;
}

function startServer(profile) {
  const started = performance.now();
  const child = fork(new URL("./performance-server.ts", import.meta.url), {
    execArgv: ["--import", "tsx", "--expose-gc"],
    env: {
      ...process.env,
      CONNECTA_PERF_CONNECTORS: String(profile.connectors),
      CONNECTA_PERF_TOOLS_PER_CONNECTOR: String(profile.toolsPerConnector),
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error(`Performance server "${profile.name}" timed out.`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(
        new Error(
          `Performance server "${profile.name}" exited before readiness (${code}).`,
        ),
      );
    });
    child.once("message", (message) => {
      clearTimeout(timeout);
      resolveReady({
        ...message,
        startupMs: performance.now() - started,
      });
    });
  });
  return { child, ready, nextId: 1 };
}

async function stopServer(server) {
  if (server.child.exitCode !== null) return;
  server.child.send({ type: "shutdown" });
  await new Promise((resolveExit) => server.child.once("exit", resolveExit));
}

async function snapshot(server, { gc = false, resetPeak = false } = {}) {
  const id = server.nextId++;
  const result = new Promise((resolveSnapshot) => {
    const receive = (message) => {
      if (message?.type !== "snapshot" || message.id !== id) return;
      server.child.off("message", receive);
      resolveSnapshot(message);
    };
    server.child.on("message", receive);
  });
  server.child.send({ type: "snapshot", id, gc, resetPeak });
  return result;
}

async function rpc(port, method, params = {}, id = 1) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body,
  });
  const text = await response.text();
  const latencyMs = performance.now() - started;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const envelope = JSON.parse(text);
  if (envelope.error) {
    throw new Error(`RPC ${method} failed: ${JSON.stringify(envelope.error)}`);
  }
  return {
    latencyMs,
    requestBytes: Buffer.byteLength(body),
    responseBytes: Buffer.byteLength(text),
    result: envelope.result,
  };
}

function toolCall(port, name, args, id) {
  return rpc(port, "tools/call", { name, arguments: args }, id);
}

async function sample(run, count = samples) {
  const latencies = [];
  let requestBytes = 0;
  let responseBytes = 0;
  for (let index = 0; index < count; index += 1) {
    const result = await run(index);
    latencies.push(result.latencyMs);
    requestBytes += result.requestBytes;
    responseBytes += result.responseBytes;
  }
  return {
    ...distribution(latencies),
    meanRequestBytes: round(requestBytes / count, 1),
    meanResponseBytes: round(responseBytes / count, 1),
  };
}

async function load(port, calls, inFlight, address) {
  const latencies = Array(calls);
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(calls, inFlight) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= calls) return;
        const result = await toolCall(
          port,
          "call_tool",
          {
            address,
            args: { value: index },
            resultMode: "value",
          },
          index + 10_000,
        );
        latencies[index] = result.latencyMs;
      }
    }),
  );
  const durationMs = performance.now() - started;
  return {
    calls,
    inFlight,
    durationMs: round(durationMs, 1),
    throughputPerSecond: round(calls / (durationMs / 1_000), 1),
    latency: distribution(latencies),
  };
}

async function benchmarkProfile(profile) {
  const server = startServer(profile);
  try {
    const ready = await server.ready;
    const lastConnector = profile.connectors - 1;
    const lastTool = profile.toolsPerConnector - 1;
    const address = `connector_${lastConnector}.lookup_record_${lastTool}`;
    const searchQuery =
      `markerc${alphabetic(lastConnector)}xt${alphabetic(lastTool)}`;
    const listed = await rpc(ready.port, "tools/list", {}, 1);
    const coldSearch = await toolCall(
      ready.port,
      "search_tools",
      { query: searchQuery, includeSchemas: "compact" },
      2,
    );
    const warmSearch = await sample((index) =>
      toolCall(
        ready.port,
        "search_tools",
        { query: searchQuery, includeSchemas: "compact" },
        index + 100,
      ),
    );
    const negativeSearch = await sample((index) =>
      toolCall(
        ready.port,
        "search_tools",
        { query: "zzzzabsentmarker" },
        index + 1_000,
      ),
    );
    const directCall = await sample((index) =>
      toolCall(
        ready.port,
        "call_tool",
        {
          address,
          args: { value: index },
          resultMode: "value",
          diagnostics: true,
        },
        index + 2_000,
      ),
    );
    const batchAddresses = Array.from(
      { length: Math.min(10, profile.toolsPerConnector) },
      (_, index) =>
        `connector_${lastConnector}.lookup_record_${profile.toolsPerConnector - index - 1}`,
    );
    const batch = await sample(
      (index) =>
        toolCall(
          ready.port,
          "batch_call",
          {
            calls: batchAddresses.map((batchAddress, value) => ({
              address: batchAddress,
              args: { value },
              resultMode: "value",
            })),
          },
          index + 3_000,
        ),
      Math.min(samples, 20),
    );
    const memoryBeforeLoad = await snapshot(server, {
      gc: true,
      resetPeak: true,
    });
    const concurrency = [];
    for (const inFlight of [1, 16, 64]) {
      concurrency.push(
        await load(ready.port, loadCalls, inFlight, address),
      );
    }
    const memoryAfterLoad = await snapshot(server, { gc: true });
    const soak = [];
    if (profile.name === "large-distributed") {
      for (let roundIndex = 1; roundIndex <= 3; roundIndex += 1) {
        const measured = await load(
          ready.port,
          loadCalls * 2,
          16,
          address,
        );
        const memory = await snapshot(server, { gc: true });
        soak.push({
          round: roundIndex,
          throughputPerSecond: measured.throughputPerSecond,
          p95Ms: measured.latency.p95Ms,
          rss: memory.rss,
          heapUsed: memory.heapUsed,
        });
      }
    }
    return {
      ...profile,
      totalTools: ready.totalTools,
      startupMs: round(ready.startupMs, 1),
      toolsList: {
        latencyMs: round(listed.latencyMs, 3),
        responseBytes: listed.responseBytes,
        toolCount: listed.result.tools?.length ?? 0,
      },
      coldSearchMs: round(coldSearch.latencyMs, 3),
      warmSearch,
      negativeSearch,
      directCall,
      batch,
      concurrency,
      memoryBeforeLoad,
      memoryAfterLoad,
      soak,
    };
  } finally {
    await stopServer(server);
  }
}

async function benchmarkExecutor() {
  const profile = {
    name: "executor-medium",
    connectors: 25,
    toolsPerConnector: 40,
  };
  const server = startServer(profile);
  try {
    const ready = await server.ready;
    const calls = [];
    for (let index = 0; index < Math.min(samples, 20); index += 1) {
      calls.push(
        await toolCall(
          ready.port,
          "execute_code",
          {
            code:
              index === 0
                ? "async () => 1"
                : "async () => connector_24.lookup_record_39({ value: 7 })",
          },
          index + 4_000,
        ),
      );
    }
    return {
      profile,
      startupMs: round(ready.startupMs, 1),
      coldNoopMs: round(calls[0].latencyMs, 3),
      warmHostCall: distribution(calls.slice(1).map((call) => call.latencyMs)),
    };
  } finally {
    await stopServer(server);
  }
}

const profileResults = [];
for (const profile of profiles) {
  process.stderr.write(
    `Benchmarking ${profile.name} (${(
      profile.connectors * profile.toolsPerConnector
    ).toLocaleString()} tools)…\n`,
  );
  profileResults.push(await benchmarkProfile(profile));
}
process.stderr.write("Benchmarking QuickJS executor…\n");
const executor = await benchmarkExecutor();
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: {
    commit: sourceCommit,
    nodeVersion: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    samples,
    loadCalls,
  },
  profiles: profileResults,
  executor,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({
    event: "logic_benchmark_complete",
    output: outputPath,
    sourceCommit,
    profiles: profileResults.map((profile) => ({
      name: profile.name,
      totalTools: profile.totalTools,
      startupMs: profile.startupMs,
      searchP50Ms: profile.warmSearch.p50Ms,
      callP50Ms: profile.directCall.p50Ms,
      throughputAt64: profile.concurrency.at(-1).throughputPerSecond,
      rssMb: round(profile.memoryAfterLoad.rss / 1024 / 1024, 1),
    })),
    executor,
  })}\n`,
);
