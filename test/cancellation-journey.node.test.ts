// Node-only: observe real client disconnects and downstream socket closure.
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { api } from "@zackbart/connecta";
import { startNodeDeployment } from "../eval/deploy/node.js";
import { deferred, waitFor } from "./fixtures/misc.js";

it("INV-7 INV-9: client cancellation removes queued work, closes a committed write's response and admits recovery", async () => {
  const received = deferred<void>();
  const disconnected = deferred<void>();
  const commits: string[] = [];
  const vendor = createServer((request, response) => {
    void (async () => {
      if (request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += chunk;
        commits.push(body);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"saved":');
        response.once("close", () => disconnected.resolve());
        received.resolve();
      } else response.end(JSON.stringify({ intents: commits }));
    })();
  });
  vendor.listen(0, "127.0.0.1");
  await once(vendor, "listening");
  const url = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}`;
  let deployment: Awaited<ReturnType<typeof startNodeDeployment>> | undefined;
  const active = new AbortController();
  const queued = new AbortController();
  let first: Promise<unknown> | undefined;
  let second: Promise<unknown> | undefined;
  try {
    deployment = await startNodeDeployment([], {
      pools: { eval: { tools: ["notes"], members: ["agent:eval-machine"] } },
      admission: { requests: { concurrency: 1, maxQueueSize: 1, queueTimeoutMs: 5_000, maxDurationMs: 10_000 } },
      connectors: [
        api("notes", {
          tools: [
            {
              name: "save",
              description: "Save",
              annotations: { readOnlyHint: false },
              handler: async (_args, ctx) => (await ctx.fetch(url, { method: "POST", body: "requested-once" })).json(),
            },
            {
              name: "read",
              description: "Read",
              annotations: { readOnlyHint: true },
              handler: async (_args, ctx) => (await ctx.fetch(url)).json(),
            },
          ],
        }),
      ],
    });
    const headers = {
      Authorization: `Bearer ${deployment.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const send = (signal: AbortSignal) =>
      fetch(deployment!.mcpUrl, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "call_destructive_tool", arguments: { address: "notes.save", args: {} } },
        }),
      })
        .then((response) => response.text())
        .catch((error) => error);
    const health = async () =>
      (await (await fetch(`${deployment!.origin}/health`)).json()) as {
        admission: { requests: { active: number; queued: number } };
      };
    first = send(active.signal);
    await received.promise;
    second = send(queued.signal);
    await waitFor(async () => (await health()).admission.requests.queued === 1);
    queued.abort(new Error("queued caller left"));
    await second;
    await waitFor(async () => (await health()).admission.requests.queued === 0);
    expect(commits).toEqual(["requested-once"]);
    active.abort(new Error("active caller left"));
    await first;
    // The vendor must observe disconnection before it releases the incomplete response.
    await disconnected.promise;
    await waitFor(async () => (await health()).admission.requests.active === 0);
    const recovered = await fetch(deployment.mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "call_tool", arguments: { address: "notes.read" } },
      }),
    });
    expect(recovered.status).toBe(200);
    const body = JSON.parse(await recovered.text());
    expect(body.result.isError).not.toBe(true);
    expect(JSON.stringify(body.result)).toContain("requested-once");
    expect(commits).toEqual(["requested-once"]);
  } finally {
    active.abort();
    queued.abort();
    await Promise.allSettled([first, second]);
    await deployment?.close();
    vendor.closeAllConnections();
    await new Promise<void>((resolve) => vendor.close(() => resolve()));
  }
}, 20_000);
