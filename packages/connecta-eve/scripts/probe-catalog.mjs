// Local, real-Eve contract probe. Requires built core/helper and Node 24.
// A deterministic LanguageModelV4 transport drives Eve; no model quality claim.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const output = resolve(option("output", ""));
assert.ok(process.argv.includes("--output"), "Supply --output outside the checkout");
assert.ok(output !== root && !output.startsWith(`${root}/`), "Machine evidence belongs outside the checkout");
assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Eve requires Node 24");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const save = (name, value) => writeFile(join(output, name), `${JSON.stringify(value, null, 2)}\n`);
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 180_000 });
await mkdir(output, { recursive: true });

// Same public Eve/client + dev-server recipe as the retained 40-tool harness.
// This transport exercises the public LanguageModel interface accepted by
// defineAgent. Usage is deliberately unknown: bytes are not token estimates.
const modelSource = `
export default {
  specificationVersion: "v4", provider: "connecta-offline", modelId: "scripted-contract-v1", supportedUrls: {},
  async doGenerate() { throw new Error("Streaming required"); },
  async doStream(options) {
    const response = await fetch(process.env.PROBE_TRANSPORT, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: options.prompt, tools: options.tools }), signal: options.abortSignal,
    });
    if (!response.ok) throw new Error("Local deterministic transport failed");
    const chunks = await response.json();
    return { stream: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }) };
  },
};
`;

async function serve(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((accept, reject) => server.close((error) => (error ? reject(error) : accept())));
    },
  };
}
async function json(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function unusedPort() {
  const server = await serve((_req, res) => res.end());
  const port = new URL(server.origin).port;
  await server.close();
  return port;
}
async function boot(consumer, url, token, transport) {
  const require = createRequire(join(consumer, "package.json"));
  const { Client } = await import(pathToFileURL(require.resolve("eve/client")));
  const eveRoot = join(consumer, "node_modules/eve");
  const port = await unusedPort();
  // Do not inherit any gateway/model credentials from the invoking shell.
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LD_PRELOAD"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]),
  );
  Object.assign(env, {
    CONNECTA_URL: url,
    CONNECTA_ACCESS_TOKEN: token,
    PROBE_TRANSPORT: transport,
    DO_NOT_TRACK: "1",
    EVE_TELEMETRY_DISABLED: "1",
  });
  const child = spawn(
    process.execPath,
    [join(eveRoot, "bin/eve.js"), "dev", "--no-ui", "--no-default-extensions", "--host", "127.0.0.1", "--port", port],
    {
      cwd: consumer,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  const append = (chunk) => {
    logs = (logs + String(chunk).replaceAll(token, "[local credential]")).slice(-12_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
    await exited;
    clearTimeout(timer);
  };
  const client = new Client({ baseUrl: `http://127.0.0.1:${port}` });
  try {
    const start = performance.now();
    while (performance.now() - start < 120_000) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Eve exited: ${logs}`);
      try {
        await client.health();
        return { client, close, startupMs: performance.now() - start, pid: child.pid };
      } catch {}
      await new Promise((accept) => setTimeout(accept, 200));
    }
    throw new Error(`Eve boot timeout: ${logs}`);
  } catch (error) {
    await close();
    throw error;
  }
}

async function cell(consumer, count, surface) {
  const start = performance.now();
  const installedCore = join(consumer, "node_modules/@zackbart/connecta/dist");
  const { createConnecta, api, memoryStorage } = await import(pathToFileURL(join(installedCore, "index.js")));
  const { AccessTokenManager, accessTokens } = await import(pathToFileURL(join(installedCore, "access-tokens.js")));
  const { listen } = await import(pathToFileURL(join(installedCore, "node.js")));
  const { quickJsExecutor } = await import(pathToFileURL(join(installedCore, "executors/quickjs.js")));
  const importMs = performance.now() - start;
  const { connectaInstructions } = await import(
    pathToFileURL(join(consumer, "node_modules/@zackbart/connecta-eve/dist/index.js"))
  );
  const storage = memoryStorage();
  const { token } = await new AccessTokenManager(storage, { agents: ["assistant"] }).rotate("assistant", "probe");
  const ledger = [];
  const wire = [];
  const tool = (index) => `lookup_${String(index).padStart(4, "0")}`;
  const address = (index) => `crm.${tool(index)}`;
  // Stable arithmetic fixture, seed 1040, realistic bounded input schemas.
  const value = (index, args) => ({
    id: args.id,
    index,
    cents: (1040 + index * 7919) % 100000,
    region: args.region ?? "us",
  });
  const tools = Array.from({ length: count }, (_, index) => ({
    name: tool(index),
    description: `${["Read customer contact", "Update support ticket", "List invoice payments", "Read inventory stock", "Read archival retention seal"][index % 5]} by exact record ID in partition ${index}.`,
    annotations: { readOnlyHint: index !== 1, destructiveHint: index === 1 },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        region: { type: "string", enum: ["us", "eu"] },
        large: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: (args) => {
      const result = value(index, args);
      if (args.large)
        result.rows = Array.from({ length: 600 }, (_, row) => ({
          row,
          note: `fixture-${1040 + row}-${"x".repeat(80)}`,
        }));
      ledger.push({ index, args, resultBytes: bytes(result) });
      return result;
    },
  }));
  const before = process.memoryUsage();
  const constructionStart = performance.now();
  const app = createConnecta({
    readOnly: false,
    storage,
    agents: ["assistant"],
    accessTokens: accessTokens(storage),
    pools: {
      assistant: {
        tools: ["crm"],
        members: ["agent:assistant"],
        description: "Seeded CRM and billing fixture",
        ...(surface === "meta" ? {} : { surface: "native", executeCode: surface === "native-code" }),
      },
    },
    connectors: [api("crm", { tools })],
    executor: quickJsExecutor({ concurrency: 2 }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const constructionMs = performance.now() - constructionStart;
  const server = listen(
    {
      fetch: async (request) => {
        const rpc =
          request.method === "POST"
            ? await request
                .clone()
                .json()
                .catch(() => null)
            : null;
        const response = await app.fetch(request);
        wire.push({
          method: rpc?.method,
          name: rpc?.params?.name,
          status: response.status,
          bytes: (await response.clone().arrayBuffer()).byteLength,
        });
        return response;
      },
    },
    { host: "127.0.0.1", port: 0, gracefulShutdown: false },
  );
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const rpc = async (method, params = {}) => {
    const response = await fetch(`${url}/agent/assistant`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    const payload = JSON.parse(
      body.trimStart().startsWith("{")
        ? body
        : body
            .split("\n")
            .find((line) => line.startsWith("data:"))
            .slice(5),
    );
    assert.equal(response.status, 200);
    return payload;
  };
  const call = (index, args) =>
    rpc(
      "tools/call",
      surface === "meta"
        ? {
            name: index === 1 ? "call_destructive_tool" : "call_tool",
            arguments: { address: address(index), args, resultMode: "value" },
          }
        : { name: `crm__${tool(index)}`, arguments: args },
    );
  let eve;
  let transport;
  try {
    const coldStart = performance.now();
    const listed = await rpc("tools/list");
    const coldListMs = performance.now() - coldStart;
    if (count === 1001 && surface !== "meta") {
      assert.equal(listed.error?.code, -32603);
      assert.match(listed.error.message, /1,000|1000/);
      return { count, surface, capRefused: true };
    }
    assert.ok(!listed.error);
    assert.equal(listed.result.tools.length, surface === "meta" ? 6 : count + 2);
    const native = listed.result.tools.filter((entry) => entry._meta?.["dev.connecta/address"]);
    if (surface !== "meta")
      assert.equal(new Set(native.map((entry) => entry._meta["dev.connecta/address"])).size, count);
    const warmListMs = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      const t = performance.now();
      const warm = await rpc("tools/list");
      warmListMs.push(performance.now() - t);
      assert.deepEqual(warm.result, listed.result);
    }
    const guidance = connectaInstructions({ url, pool: "assistant", getToken: () => token });
    const guidanceStart = performance.now();
    const memos = new Map();
    const memo = async (key, fn) => {
      const memoKey = JSON.stringify(key);
      if (!memos.has(memoKey))
        memos.set(memoKey, await fn({ idempotencyKey: memoKey, abortSignal: new AbortController().signal }));
      return memos.get(memoKey);
    };
    // Eve keys a defineDynamic() function by this registered symbol.
    const evaluate = (id) => guidance[Symbol.for("eve.dynamic")]({ memo, turn: { id, status: "running", input: [] } });
    const instructions = await evaluate("probe_1");
    assert.match(instructions.content, /Seeded CRM/);
    const guidanceMs = performance.now() - guidanceStart;
    const cachedStart = performance.now();
    assert.deepEqual(await evaluate("probe_2"), instructions);
    const cachedGuidanceMs = performance.now() - cachedStart;
    const discovery = [];
    if (surface === "meta") {
      for (let offset = 0; offset < count; offset += 100) {
        const t = performance.now();
        const response = await rpc("tools/call", {
          name: "search_tools",
          arguments: { connector: "crm", offset, limit: 100, includeSchemas: "json" },
        });
        const result = response.result.structuredContent;
        assert.equal(result.total, count);
        discovery.push({ ms: performance.now() - t, bytes: bytes(response.result), tools: result.tools });
      }
      assert.equal(new Set(discovery.flatMap((page) => page.tools.map((entry) => entry.address))).size, count);
    }
    const concurrent = [0, Math.floor(count / 2), count - 1, 2, 3, 4, 5, 6];
    const concurrentStart = performance.now();
    const responses = await Promise.all(concurrent.map((index, i) => call(index, { id: `race-${i}` })));
    responses.forEach((response, i) => {
      assert.ok(!response.error && !response.result.isError);
      const data =
        surface === "meta" ? response.result.structuredContent.data : JSON.parse(response.result.content[0].text);
      assert.deepEqual(data, value(concurrent[i], { id: `race-${i}` }));
    });
    const concurrentMs = performance.now() - concurrentStart;
    assert.deepEqual(ledger.map((entry) => entry.args.id).sort(), concurrent.map((_, i) => `race-${i}`).sort());
    assert.equal(ledger.length, 8);
    const write = await call(1, { id: "write-once" });
    assert.ok(!write.result.isError);
    assert.equal(ledger.filter((entry) => entry.index === 1).length, 1);
    const invalid = await call(0, {});
    assert.equal(invalid.result.isError, true);
    assert.equal(ledger.length, 9);
    const large = await call(0, { id: "large", large: true });
    assert.ok(!large.result.isError);
    assert.ok(bytes(large.result) < 30_000);
    assert.ok(ledger.at(-1).resultBytes > 60_000);
    const notice =
      surface === "meta"
        ? large.result.structuredContent.data
        : JSON.parse(large.result.content[0].text.split("\n")[0]);
    assert.equal(notice.truncated, true);
    assert.equal(notice.totalBytes, ledger.at(-1).resultBytes);
    const pageParams = { id: notice.resultId, offset: 24_000 };
    const page = await rpc(
      "tools/call",
      surface === "native"
        ? { name: "read_result", arguments: pageParams }
        : {
            name: "execute_code",
            arguments: {
              code: `async () => { const p = await connecta.result(${JSON.stringify(notice.resultId)}, {offset: 24000, maxBytes: 12000}); return {offset: p.offset, bytes: p.bytes, hasMore: p.hasMore}; }`,
            },
          },
    );
    assert.ok(!page.result.isError);
    const paged = surface === "native" ? page.result.structuredContent : page.result.structuredContent.result;
    assert.equal(paged.offset, 24_000);
    assert.equal(paged.bytes, surface === "native" ? 24_000 : 12_000);
    assert.equal(paged.hasMore, true);
    assert.equal(ledger.length, 10, "Paging must never re-dispatch the original call");
    // Retain genuine model inputs/results as evidence. No synthetic event log.
    const modelRequests = [];
    const transportErrors = [];
    const sequence =
      surface === "meta"
        ? [
            ["eve__search", { query: "connecta__call_tool" }],
            ["connecta__call_tool", { address: address(count - 1), args: { id: "eve-read" }, resultMode: "value" }],
            ["eve__search", { query: "connecta__execute_code" }],
            [
              "connecta__execute_code",
              {
                code: `async () => { return (await connecta.call(${JSON.stringify(address(0))}, {id: "eve-code"})).data; }`,
              },
            ],
          ]
        : [
            ["eve__search", { query: `connecta__crm__${tool(count - 1)}` }],
            [`connecta__crm__${tool(count - 1)}`, { id: "eve-read" }],
            ...(surface === "native-code"
              ? [
                  ["eve__search", { query: "connecta__execute_code" }],
                  [
                    "connecta__execute_code",
                    {
                      code: `async () => { return (await connecta.call(${JSON.stringify(address(0))}, {id: "eve-code"})).data; }`,
                    },
                  ],
                ]
              : []),
          ];
    transport = await serve(async (req, res) => {
      try {
        const input = await json(req);
        const ordinal = modelRequests.length;
        modelRequests.push(input);
        const next = sequence[ordinal];
        const chunks = [{ type: "stream-start", warnings: [] }];
        if (next) {
          const direct = input.tools.some((entry) => entry.name === next[0]);
          assert.ok(direct || input.tools.some((entry) => entry.name === "eve__tool"), `Tool unavailable: ${next[0]}`);
          chunks.push({
            type: "tool-call",
            toolCallId: `probe-${ordinal}`,
            toolName: direct ? next[0] : "eve__tool",
            input: JSON.stringify(direct ? next[1] : { name: next[0], input: next[1] }),
          });
        } else {
          chunks.push(
            { type: "text-start", id: "final" },
            { type: "text-delta", id: "final", delta: "contract-complete" },
            { type: "text-end", id: "final" },
          );
        }
        chunks.push({
          type: "finish",
          finishReason: { unified: next ? "tool-calls" : "stop", raw: undefined },
          usage: { inputTokens: {}, outputTokens: {} },
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(chunks));
      } catch (error) {
        transportErrors.push(String(error));
        res.writeHead(500).end();
      }
    });
    eve = await boot(consumer, url, token, transport.origin);
    const eveStart = performance.now();
    const signal = AbortSignal.timeout(90_000);
    const created = await eve.client.sessions.create({ message: "Run the deterministic catalog contract.", signal });
    // The stream reads through the delivery's settlement, so it ends with it.
    const events = [];
    const streamed = (async () => {
      for await (const event of created.delivery.stream({ signal })) events.push(event);
    })();
    // Await both together so a failed stream read cannot reject unhandled.
    const [result] = await Promise.all([created.delivery.result({ signal }), streamed]);
    const eveTurnMs = performance.now() - eveStart;
    await save(`${surface}-${count}-attempt.json`, {
      modelRequests,
      events,
      status: result.status,
      reply: result.reply,
      transportErrors,
      ledger,
      wire,
    });
    assert.deepEqual(transportErrors, []);
    assert.ok(["completed", "awaiting-input"].includes(result.status));
    assert.equal(result.reply, "contract-complete");
    assert.equal(modelRequests.length, sequence.length + 1);
    assert.deepEqual(
      ledger.filter((entry) => entry.args.id.startsWith("eve-")).map((entry) => entry.args.id),
      surface === "native" ? ["eve-read"] : ["eve-read", "eve-code"],
    );
    for (const entry of ledger) assert.equal(entry.resultBytes > 0, true);
    const after = process.memoryUsage();
    const measurement = {
      count,
      surface,
      seed: 1040,
      runtime: process.version,
      importMs,
      constructionMs,
      coldListMs,
      warmListMs,
      listedTools: listed.result.tools.length,
      catalogBytes: bytes(listed.result),
      catalogHash: hash(JSON.stringify(listed.result)),
      inputSchemaBytes: bytes(listed.result.tools.map((entry) => entry.inputSchema)),
      discovery: discovery.map((page) => ({ ms: page.ms, bytes: page.bytes, tools: page.tools.length })),
      guidanceBytes: Buffer.byteLength(instructions.content),
      guidanceMs,
      cachedGuidanceMs,
      concurrentMs,
      eveStartupMs: eve.startupMs,
      eveTurnMs,
      modelRequests: modelRequests.length,
      modelInputBytes: modelRequests.map(bytes),
      modelToolSchemaBytes: modelRequests.map((entry) => bytes(entry.tools)),
      modelToolResultBytes: modelRequests.map((entry) =>
        bytes(entry.prompt.filter((message) => message.role === "tool")),
      ),
      memoryBefore: before,
      memoryAfter: after,
      maxRssKiB: process.resourceUsage().maxRSS,
      eveProcStatus:
        process.platform === "linux"
          ? (await readFile(`/proc/${eve.pid}/status`, "utf8")).split("\n").filter((line) => /^Vm(RSS|HWM):/.test(line))
          : null,
      handlerCalls: ledger.length,
      writes: ledger.filter((entry) => entry.index === 1).length,
      wire,
      ledger,
      usage: "Unknown: deterministic transport provides no tokenizer or paid usage",
      paidCalls: 0,
    };
    await save(`${surface}-${count}-trace.json`, { modelRequests, events, measurement });
    return measurement;
  } finally {
    await eve?.close();
    await transport?.close();
    server.closeAllConnections();
    await new Promise((accept) => server.close(accept));
    await app.close();
  }
}

if (option("cell")) {
  const result = await cell(option("consumer"), Number(option("count")), option("surface"));
  await save(`${option("surface")}-${option("count")}.json`, result);
} else {
  const work = await mkdtemp(join(tmpdir(), "connecta-eve-catalog-"));
  try {
    const helper = join(root, "packages/connecta-eve");
    const manifest = JSON.parse(await readFile(join(helper, "package.json"), "utf8"));
    const eveVersion = manifest.devDependencies.eve;
    const packed = JSON.parse(run("pnpm", ["pack", "--ignore-scripts", "--pack-destination", work, "--json"], helper));
    const archive = resolve(helper, packed.filename);
    const corePacked = JSON.parse(run("pnpm", ["pack", "--ignore-scripts", "--pack-destination", work, "--json"]));
    const coreArchive = resolve(root, corePacked.filename);
    await writeFile(
      join(work, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          eve: eveVersion,
          "@zackbart/connecta-eve": `file:${archive}`,
          "@zackbart/connecta": `file:${coreArchive}`,
          "quickjs-emscripten": "0.32.0",
        },
      }),
    );
    await writeFile(join(work, "pnpm-workspace.yaml"), `minimumReleaseAgeExclude:\n  - eve@${eveVersion}\n`);
    run("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], work);
    await writeFile(join(output, "consumer-pnpm-lock.yaml"), await readFile(join(work, "pnpm-lock.yaml")));
    await writeFile(join(output, "consumer-package.json"), await readFile(join(work, "package.json")));
    await mkdir(join(work, "agent/connections"), { recursive: true });
    await mkdir(join(work, "agent/instructions"), { recursive: true });
    await writeFile(join(work, "model.mjs"), modelSource);
    await writeFile(
      join(work, "agent/agent.ts"),
      'import { defineAgent } from "eve";\nimport model from "../model.mjs";\nexport default defineAgent({ model, modelContextWindowTokens: 1000000 });\n',
    );
    await writeFile(
      join(work, "agent/connections/connecta.ts"),
      'import { connectaConnection } from "@zackbart/connecta-eve";\nexport default connectaConnection({ pool: "assistant", description: "Seeded CRM and billing fixture" });\n',
    );
    await writeFile(
      join(work, "agent/instructions/connecta.ts"),
      'import { connectaInstructions } from "@zackbart/connecta-eve";\nexport default connectaInstructions({ pool: "assistant" });\n',
    );
    const matrices = [];
    const counts = option("counts", "40,100,250,500,1000").split(",").map(Number);
    assert.ok(counts.every((count) => Number.isInteger(count) && count >= 10 && count <= 1000));
    for (const surface of ["meta", "native", "native-code"]) {
      for (const count of [...counts, ...(surface === "meta" ? [] : [1001])]) {
        run(process.execPath, [
          fileURLToPath(import.meta.url),
          "--output",
          output,
          "--cell",
          "true",
          "--consumer",
          work,
          "--surface",
          surface,
          "--count",
          String(count),
        ]);
        matrices.push(JSON.parse(await readFile(join(output, `${surface}-${count}.json`), "utf8")));
        console.log(`${surface} ${count}: passed`);
      }
    }
    await save("catalog-results.json", {
      recordedAt: new Date().toISOString(),
      source: run("git", ["rev-parse", "HEAD"]).trim(),
      tree: run("git", ["rev-parse", "HEAD^{tree}"]).trim(),
      dirty: run("git", ["status", "--porcelain"]).trim(),
      node: process.version,
      pnpm: run("pnpm", ["--version"]).trim(),
      eve: eveVersion,
      helper: manifest.version,
      helperArchiveSha256: hash(await readFile(archive)),
      coreArchiveSha256: hash(await readFile(coreArchive)),
      consumerLockSha256: hash(await readFile(join(work, "pnpm-lock.yaml"))),
      probeSha256: hash(await readFile(fileURLToPath(import.meta.url))),
      modelSourceSha256: hash(modelSource),
      matrices,
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
