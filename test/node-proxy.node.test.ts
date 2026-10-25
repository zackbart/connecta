// Node-only: physical HTTP bodies through an owned undici CONNECT proxy.
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { Agent, RetryAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { expect, it, onTestFinished } from "vitest";
import { createNodeGuardedTransport } from "../src/http/node-transport.js";
import { configureGuardedTransport, sendGuarded } from "../src/guarded-transport.js";
import { listen } from "../src/node.js";
import type { Connecta } from "../src/index.js";
import { connectProxy } from "./fixtures/connect-proxy.js";
import { probeRemoteAttempt } from "./fixtures/remote-mcp-attempts.js";

it("INV-9 INV-5: owned CONNECT writes have one body under 421/reset/503; reads and credentials use the tunnel", async () => {
  const proxy = await connectProxy();
  const old = getGlobalDispatcher();
  const hostile = new RetryAgent(new Agent(), { methods: ["POST"], statusCodes: [503], maxRetries: 1, minTimeout: 1 });
  setGlobalDispatcher(hostile);
  onTestFinished(async () => {
    setGlobalDispatcher(old);
    await hostile.close();
  });
  const bodies: string[] = [];
  const headers: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    bodies.push(body);
    headers.push(request.headers);
    if (request.url === "/reset") {
      request.socket.destroy();
      return;
    }
    if (request.url === "/gzip") {
      response.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync("streamed"));
      return;
    }
    response.writeHead(request.url === "/421" ? 421 : 503).end("reply");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sender = createNodeGuardedTransport(proxy.url.replace("://", "://alice:proxy%3Asecret@"));
  for (const challenge of ["421", "reset", "503"]) {
    let dispatched = 0;
    const answer = sendGuarded(
      sender,
      new URL(`${base}/${challenge}`),
      {
        method: "POST",
        body: "one-physical-write",
        headers: { Authorization: "Bearer destination-secret" },
      },
      () => {
        dispatched++;
      },
    );
    if (challenge === "reset") await expect(answer).rejects.toMatchObject({ retryable: false });
    else expect(await (await answer).text()).toBe("reply");
    expect(dispatched).toBe(1);
    expect(bodies).toHaveLength(["421", "reset", "503"].indexOf(challenge) + 1);
  }
  expect(await (await sender.send(new URL(`${base}/gzip`), {})).text()).toBe("streamed");
  expect(bodies).toEqual(["one-physical-write", "one-physical-write", "one-physical-write", ""]);
  expect(headers.every((header) => header["proxy-authorization"] === undefined)).toBe(true);
  expect(headers[0]!.authorization).toBe("Bearer destination-secret");
  expect(proxy.tunnels).toHaveLength(4);
  expect(
    proxy.tunnels.every(
      (tunnel) => tunnel.authorization === `Basic ${Buffer.from("alice:proxy:secret").toString("base64")}`,
    ),
  ).toBe(true);
  await expect.poll(() => proxy.sockets.size).toBe(0);
});

it("INV-7 INV-9: real SDK writes preserve JSON/SSE and cancellation through CONNECT", async () => {
  const proxy = await connectProxy();
  const old = configureGuardedTransport(createNodeGuardedTransport(proxy.url));
  onTestFinished(() => {
    configureGuardedTransport(old);
  });
  for (const mode of ["421-open", "reset", "retry-503", "json", "sse", "sse-hold"]) {
    const probe = await probeRemoteAttempt(
      mode,
      "write",
      mode === "sse-hold" ? { signal: AbortSignal.timeout(500) } : {},
    );
    expect(probe.received, mode).toHaveLength(1);
    if (["json", "sse"].includes(mode)) expect(probe.error, mode).toBeUndefined();
    else expect(probe.error, mode).toMatchObject({ retryable: false });
    await expect.poll(probe.inspect).toMatchObject({ closed: 1 });
  }
  expect(proxy.tunnels).toHaveLength(6);
  await expect.poll(() => proxy.sockets.size).toBe(0);
});

it.each(["refuse", "reset", "hold"] as const)(
  "INV-7 INV-9: CONNECT %s fails before destination dispatch and releases sockets",
  async (mode) => {
    const proxy = await connectProxy(mode);
    let dispatched = 0;
    const controller = new AbortController();
    const reason = new Error("caller canceled");
    const pending = sendGuarded(
      createNodeGuardedTransport(proxy.url),
      new URL("http://127.0.0.1:1/items"),
      {
        method: "POST",
        body: "withheld-credential",
        signal: controller.signal,
      },
      () => {
        dispatched++;
      },
    );
    if (mode === "hold") {
      await expect.poll(() => proxy.tunnels.length).toBe(1);
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
    } else
      await expect(pending).rejects.toMatchObject({
        message: expect.stringContaining("was not sent"),
        retryable: false,
      });
    expect(dispatched).toBe(0);
    expect(proxy.tunnels).toHaveLength(1);
    await expect.poll(() => proxy.sockets.size).toBe(0);
  },
);

it("INV-11: listen validates explicit proxies synchronously without disclosing credentials", () => {
  for (const proxy of [
    "invalid-secret",
    "socks5://alice:private@localhost:1",
    "http://alice:private@localhost:1/path",
    "http://alice:private@localhost:1/?query",
    "http://%ZZ:secret@localhost:1",
  ]) {
    expect(() => listen({} as Connecta, { port: 0, proxy, gracefulShutdown: false })).toThrow(/^proxy must/);
  }
});

it("INV-9: a refused CONNECT leaves the real SDK write undispatched", async () => {
  const proxy = await connectProxy("refuse");
  const old = configureGuardedTransport(createNodeGuardedTransport(proxy.url));
  onTestFinished(() => {
    configureGuardedTransport(old);
  });
  const probe = await probeRemoteAttempt("pass", "write");
  expect(probe.received).toEqual([]);
  expect(probe.error).toMatchObject({ retryable: false });
  expect(probe.error).not.toHaveProperty("writeOutcome", "unknown");
});

it(
  "INV-5 INV-9: HTTPS CONNECT to HTTPS preserves one attempt and certificate hostname checks",
  { timeout: 30_000 },
  () => {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./fixtures/node-proxy-tls.mjs", import.meta.url))],
      { encoding: "utf8", timeout: 25_000 },
    );
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    expect(child.stdout).toContain('"bodyCount":3');
    expect(child.stdout).toContain("certificate hostname verification preserved");
  },
);
