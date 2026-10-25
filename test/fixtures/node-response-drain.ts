// Run in a child: exercise the production signal handlers with a peer that never closes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Connecta } from "../../src/index.js";
import { listen } from "../../src/node.js";

const mode = process.argv[2]!;
const duration = mode === "long" ? 6_000 : mode === "deadline" ? 60_000 : 1_500;
let started!: () => void;
const handling = new Promise<void>((resolve) => { started = resolve; });
let finishResponse!: () => void;
const release = new Promise<void>((resolve) => { finishResponse = resolve; });
let requests = 0;
const app = {
  async fetch(request: Request) {
    requests++;
    if (new URL(request.url).pathname === "/warm") return new Response("warm");
    if (new URL(request.url).pathname === "/after") return new Response("after-pipeline");
    if (mode === "sse" || mode === "error") {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: opened\n\n"));
          started();
          void release.then(() => {
            if (mode === "error") controller.error(new Error("PRIVATE_STREAM_FAILURE"));
            else {
              controller.enqueue(new TextEncoder().encode("data: finished\n\n"));
              controller.close();
            }
          });
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    started();
    await release;
    return new Response("finished");
  },
  async close() {},
} as unknown as Connecta;
const server = listen(app, {
  port: 0, host: "127.0.0.1",
  ...(mode === "deadline" ? { shutdownTimeoutMs: 350 } : {}),
});
await once(server, "listening");
const peer = fork(fileURLToPath(new URL("./node-drain-peer.ts", import.meta.url)), [String((server.address() as { port: number }).port), mode], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
await new Promise<void>((resolve) => { peer.on("message", (message) => { if (message === "ready") resolve(); }); });
if (mode !== "unused" && mode !== "partial") {
  await handling;
  assert.equal(requests, mode === "pipeline" ? 3 : 2, "the same keepalive connection must serve every request");
}
const before = performance.now();
process.once("exit", (code) => {
  console.log(JSON.stringify({ mode, code, elapsed: performance.now() - before, requests }));
});
// The client deliberately keeps its readable half open after the server closes.
// A keepalive timer or reliance on the client sending FIN would fail these rows.
if (mode !== "unused" && mode !== "partial") setTimeout(finishResponse, duration);
process.kill(process.pid, "SIGTERM");
