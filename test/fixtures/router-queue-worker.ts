// Separate native requests share only admission state, never request I/O.
import { createConnecta, customExecutor } from "../../src/index.js";

const BASE = "https://connecta.test";
let queued: ReturnType<typeof createConnecta> | undefined;
let secondReads = 0;
let waiterArrived = false;
let releaseQueuedBody = false;

export default {
  fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/queue-release") {
      releaseQueuedBody = true;
      return Promise.resolve(Response.json({ released: true }));
    }
    if (request.headers.get("x-queue-waiter") === "yes") waiterArrived = true;
    queued ??= createConnecta({
      readOnly: false, connectors: [], logger: "silent", publicUrl: BASE,
      executor: customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
      admission: { requests: { concurrency: 1, maxQueueSize: 2, queueTimeoutMs: 2000 } },
      maintainers: [{ namespace: "fixture", id: "alice" }],
      auth: {
        kind: "fixture",
        async authorize(req) {
          if (req.headers.get("x-queue-waiter") === "yes") {
            secondReads++;
            const body = await req.text();
            const native = await fetch("https://native.example/" + body);
            return { ok: false as const, response: new Response(await native.text(), { status: 401 }) };
          }
          return {
            ok: false as const,
            response: new Response(new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("held"));
                const until = Date.now() + 5000;
                const finishInOwningRequest = () => {
                  if (releaseQueuedBody) controller.close();
                  else if (Date.now() >= until) controller.error(new Error("Queue control timed out"));
                  else setTimeout(finishInOwningRequest, 5);
                };
                setTimeout(finishInOwningRequest, 5);
              },
            }), { status: 401 }),
          };
        },
      },
    });
    if (path === "/queue-state") return Promise.resolve(Response.json({ secondReads, waiterArrived }));
    return queued.fetch(request);
  },
};
