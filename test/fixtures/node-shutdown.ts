// Run outside Vitest: the production listener owns this process's signal handlers.
import assert from "node:assert/strict";
import childProcess, { execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AccessTokenManager, accessTokens } from "../../src/access-tokens.js";
import { api } from "../../src/connectors/api.js";
import { quickJsExecutor } from "../../src/executors/quickjs.js";
import { createConnecta } from "../../src/index.js";
import { listen } from "../../src/node.js";
import { memoryStorage } from "../../src/storage/memory.js";

// Observe real sandbox children without replacing their behavior. Checking at
// close prevents the listener's existing process.exit(0) from hiding an orphan.
const children: ChildProcess[] = [];
childProcess.fork = new Proxy(childProcess.fork, {
  apply(fork, receiver, args) {
    const child = Reflect.apply(fork, receiver, args) as ChildProcess;
    children.push(child);
    console.log(`sandbox pid ${child.pid}`);
    return child;
  },
});
syncBuiltinESMExports();

const legacy = JSON.parse(readFileSync(new URL("./access-tokens-v023.json", import.meta.url), "utf8"));
const storage = memoryStorage();
for (const [key, value] of Object.entries(legacy.records)) await storage.set(key, value as string);
const manager = new AccessTokenManager(storage, { agents: ["assistant"] });
let hostStarted!: () => void;
const started = new Promise<void>((resolve) => { hostStarted = resolve; });
const executor = quickJsExecutor({ timeoutMs: 60_000, cpuTimeMs: 5_000 });
const close = executor.close!.bind(executor);
executor.close = async () => {
  const health = await app.fetch(new Request(`${origin}/health`));
  const { admission } = await health.json() as any;
  assert.equal(admission.requests.closed, true);
  await close();
  const closedHealth = await app.fetch(new Request(`${origin}/health`));
  assert.equal(((await closedHealth.json()) as any).admission.code.closed, true);
  assert.ok(children.length > 0, "the test must start a real QuickJS child");
  for (const child of children) {
    assert.ok(child.exitCode !== null || child.signalCode !== null, "sandbox child must be reaped");
  }
  console.log("admission closed; sandbox children reaped");
};
const app = createConnecta({
  readOnly: false,
  storage,
  auth: [],
  agents: ["assistant"],
  accessTokens: accessTokens(storage),
  executor,
  logger: "silent",
  pools: { assistant: { tools: ["hold"], members: ["agent:assistant"] } },
  connectors: [api("hold", {
    tools: [{
      name: "read",
      description: "Wait until the execution is canceled",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
      handler: (_args, ctx) => {
        hostStarted();
        return new Promise((_, reject) => {
          ctx.signal?.addEventListener("abort", () => reject(ctx.signal?.reason), { once: true });
        });
      },
    }],
  })],
});
const server = listen(app, { port: 0, host: "127.0.0.1" });
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const run = promisify(execFile);
const doctor = (token: string) => run(process.execPath, [
  fileURLToPath(new URL("../../bin/connecta.mjs", import.meta.url)),
  "doctor", "--url", origin, "--pool", "assistant",
], { env: { ...process.env, CONNECTA_TOKEN: token }, timeout: 30_000 });

for (const path of ["/mcp", "/agent/assistant"]) {
  for (const token of [undefined, "static-placeholder", `cta_${"A".repeat(43)}`, legacy.unbound.token]) {
    const response = await fetch(`${origin}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    assert.equal(response.status, 401);
    await response.body?.cancel();
  }
}
await manager.adopt(legacy.unbound.accessToken.id, "assistant");
assert.match((await doctor(legacy.unbound.token)).stdout, /QuickJS executed/);
const { token } = await manager.rotate("assistant");
await assert.rejects(doctor(legacy.unbound.token));
assert.match((await doctor(token)).stdout, /QuickJS executed/);

// Reproduce the spare zero-byte connection left by canceled native-fetch auth
// probes deterministically, independent of the client's connection-pool timing.
const accepted = once(server, "connection");
const spare = createConnection({ host: "127.0.0.1", port: address.port });
spare.on("error", () => {});
const [socket] = await accepted;
assert.equal(socket.bytesRead, 0);
assert.equal(socket.bytesWritten, 0);

// Keep an admitted execution live too: cleanup must still cancel and reap it.
void fetch(`${origin}/agent/assistant`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "execute_code", arguments: { code: 'async () => connecta.call("hold.read", {})' },
  } }),
}).then((response) => response.body?.cancel()).catch(() => {});
await started;
const shutdownStarted = performance.now();
process.once("exit", () => console.log(`shutdown ms ${performance.now() - shutdownStarted}`));
process.kill(process.pid, "SIGTERM");
