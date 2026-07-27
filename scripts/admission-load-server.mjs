import { listen } from "../dist/node.js";
import { createConnecta } from "../dist/index.js";

const catalogSize = Number(process.env.CONNECTA_LOAD_CATALOG_SIZE ?? "10000");
const concurrency = Number(process.env.CONNECTA_LOAD_CONCURRENCY ?? "16");
const maxQueueSize = Number(process.env.CONNECTA_LOAD_MAX_QUEUE_SIZE ?? "256");
const tools = Array.from({ length: catalogSize }, (_, index) => ({
  name: `tool_${index}`,
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object",
    properties: { value: { type: "number" } },
    required: ["value"],
  },
}));
const connector = {
  id: "load",
  kind: "api",
  async listTools() {
    return tools;
  },
  async callTool(name, args) {
    if (name !== "tool_0") throw new Error(`Unexpected tool ${name}`);
    return { value: args.value };
  },
};
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const connecta = createConnecta({
  connectors: [connector],
  logger: silent,
  admission: {
    requests: {
      concurrency,
      maxQueueSize,
      queueTimeoutMs: 10_000,
      retryAfterMs: 1_000,
    },
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

server.once("listening", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP address.");
  }
  process.send?.({ type: "ready", port: address.port });
});

process.on("message", async (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "snapshot") {
    if (message.gc && typeof global.gc === "function") {
      global.gc();
      await new Promise((resolve) => setTimeout(resolve, 0));
      global.gc();
    }
    const memory = process.memoryUsage();
    process.send?.({
      type: "snapshot",
      id: message.id,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      peakRss,
    });
    if (message.resetPeak) peakRss = memory.rss;
    return;
  }
  if (message.type === "shutdown") {
    clearInterval(sampler);
    await connecta.close();
    server.close(() => process.exit(0));
  }
});
