import { once } from "node:events";

import {
  createConnecta,
  memoryStorage,
  type Connector,
  type ToolDef,
} from "../../src/index.js";
import { quickJsExecutor } from "../../src/executors/quickjs.js";
import { listen } from "../../src/node.js";

const connectorCount = Number(
  process.env.CONNECTA_PERF_CONNECTORS ?? "10",
);
const toolsPerConnector = Number(
  process.env.CONNECTA_PERF_TOOLS_PER_CONNECTOR ?? "100",
);
const executorEnabled = process.env.CONNECTA_PERF_EXECUTOR === "enabled";
const requestConcurrency = Number(
  process.env.CONNECTA_PERF_REQUEST_CONCURRENCY ?? "64",
);

function positiveWhole(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive whole number.`);
  }
  return value;
}

positiveWhole(connectorCount, "CONNECTA_PERF_CONNECTORS");
positiveWhole(toolsPerConnector, "CONNECTA_PERF_TOOLS_PER_CONNECTOR");
positiveWhole(requestConcurrency, "CONNECTA_PERF_REQUEST_CONCURRENCY");

function alphabetic(value: number): string {
  let remaining = value;
  let result = "";
  do {
    result = String.fromCharCode(97 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return result;
}

function toolDefinitions(connectorIndex: number): ToolDef[] {
  return Array.from({ length: toolsPerConnector }, (_, toolIndex) => ({
    name: `lookup_record_${toolIndex}`,
    description:
      `Retrieve synthetic performance record ${toolIndex} from shard ` +
      `${connectorIndex}. Marker markerc${alphabetic(connectorIndex)}xt${alphabetic(toolIndex)}.`,
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "integer" },
      },
      required: ["value"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        connector: { type: "integer" },
        tool: { type: "integer" },
        value: { type: "integer" },
      },
      required: ["connector", "tool", "value"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
    },
  }));
}

const connectors: Connector[] = Array.from(
  { length: connectorCount },
  (_, connectorIndex) => {
    const tools = toolDefinitions(connectorIndex);
    return {
      id: `connector_${connectorIndex}`,
      kind: "api",
      description: `Synthetic performance connector ${connectorIndex}`,
      staticTools: tools,
      async listTools() {
        return tools;
      },
      async callTool(name, args) {
        const toolIndex = Number(name.slice("lookup_record_".length));
        return {
          connector: connectorIndex,
          tool: toolIndex,
          value: (args as { value: number }).value,
        };
      },
    };
  },
);

const executor = executorEnabled
  ? quickJsExecutor({
      timeoutMs: 10_000,
      cpuTimeMs: 2_000,
      concurrency: 4,
      maxQueueSize: 32,
    })
  : undefined;
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const connecta = createConnecta({
  connectors,
  storage: memoryStorage(),
  logger: silent,
  ...(executor ? { executor } : {}),
  admission: {
    requests: {
      concurrency: requestConcurrency,
      maxQueueSize: 512,
      queueTimeoutMs: 10_000,
      retryAfterMs: 1_000,
    },
  },
  serverInfo: {
    name: "connecta-performance",
    version: "1.0.0",
  },
});
const server = listen(connecta, {
  port: 0,
  host: "127.0.0.1",
  gracefulShutdown: false,
});

let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 5);
sampler.unref();

await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Performance server did not expose a TCP address.");
}
process.send?.({
  type: "ready",
  port: address.port,
  connectorCount,
  toolsPerConnector,
  totalTools: connectorCount * toolsPerConnector,
  executorEnabled,
});

let nextSnapshotId = 1;
process.on("message", async (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const command = message as {
    type?: string;
    id?: number;
    gc?: boolean;
    resetPeak?: boolean;
  };
  if (command.type === "snapshot") {
    if (command.gc && typeof global.gc === "function") {
      global.gc();
      await new Promise((resolve) => setTimeout(resolve, 0));
      global.gc();
    }
    const memory = process.memoryUsage();
    process.send?.({
      type: "snapshot",
      id: command.id ?? nextSnapshotId++,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      peakRss,
    });
    if (command.resetPeak) peakRss = memory.rss;
    return;
  }
  if (command.type === "shutdown") {
    clearInterval(sampler);
    await connecta.close();
    server.close(() => process.exit(0));
  }
});
