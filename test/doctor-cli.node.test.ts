// Node-only: spawns the CLI against a Node HTTP deployment over real sockets.
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { accessTokens } from "../src/access-tokens.js";
import { api } from "../src/connectors/api.js";
import { CONNECTA_VERSION, META_TOOL_NAMES, createConnecta, customExecutor } from "../src/index.js";
import { listen } from "../src/node.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Executor, IdentityReference, InboundAuth, KVStorage } from "../src/types.js";
import { operatorUi } from "../src/ui.js";
import { SECRETS, VAULT_KEY, secretBearingDeployment } from "./fixtures/describe-config.js";
import { issueAgentToken } from "./helpers/agent-tokens.js";
import { TEST_MACHINE_NAMESPACE, machineAuth } from "./helpers/machine-auth.js";

// `connecta doctor` is a claim an operator reads and believes. It used to
// print "QuickJS executed" against every deployment, including the Workers
// shape whose sandbox is a Dynamic Worker (#368), so the executor line is
// exercised end to end: real CLI, real HTTP, one deployment per sandbox.
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "connecta.mjs");
const TOKEN = "doctor-cli-token";
/** The principal `machineAuth(TOKEN)` admits; doctor opens plain /mcp, so it is a maintainer (#837). */
const MACHINE: IdentityReference = { namespace: TEST_MACHINE_NAMESPACE, id: "machine" };
const run = promisify(execFile);

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()?.();
});

async function doctorAgainst(
  executor: Executor,
  options: {
    auth?: InboundAuth;
    maintainers?: IdentityReference[];
    env?: Record<string, string>;
    storage?: KVStorage;
    member?: boolean;
    args?: string[];
  } = {},
): Promise<string> {
  const connecta = createConnecta({
    readOnly: false,
    connectors: [
      api("echo", {
        tools: [
          {
            name: "shout",
            description: "Uppercase text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
            },
            annotations: { readOnlyHint: true },
            handler: async (args: { text: string }) => ({
              shouted: String(args.text).toUpperCase(),
            }),
          },
        ],
      }),
    ],
    executor: customExecutor(executor, { lifecycle: "self-managed" }),
    auth: options.auth ?? machineAuth(TOKEN),
    maintainers:
      options.maintainers ?? (options.member ? [{ namespace: TEST_MACHINE_NAMESPACE, id: "owner" }] : [MACHINE]),
    ...(options.member ? { pools: { team: { tools: ["echo"], members: [MACHINE] } } } : {}),
    logger: "silent",
    ...(options.storage ? { storage: options.storage } : {}),
  });
  const server = listen(connecta, {
    port: 0,
    host: "127.0.0.1",
    gracefulShutdown: false,
  });
  teardown.push(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await connecta.close();
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP listen address.");
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? { CONNECTA_TOKEN: TOKEN }) };
  if (options.env && !("CONNECTA_TOKEN" in options.env)) delete env.CONNECTA_TOKEN;
  const { stdout } = await run(
    process.execPath,
    [CLI, "doctor", "--url", `http://127.0.0.1:${address.port}`, ...(options.args ?? [])],
    { env },
  );
  return stdout.trim();
}

describe("connecta doctor's executor line", () => {
  it("checks a person's unique pool at /mcp without --pool", async () => {
    const line = await doctorAgainst({ execute: async () => ({ result: 42 }) }, { member: true });
    expect(line).toContain("Connecta doctor passed");
  });

  it("names the executor only when its name is a plain identifier", async () => {
    const named = await doctorAgainst({ name: "Custom.Sandbox-1", execute: async () => ({ result: 42 }) });
    expect(named).toBe(
      `Connecta doctor passed: 1 connector(s), Custom.Sandbox-1 executed, prescribed 7-tool surface, MCP 2026-07-28, package ${CONNECTA_VERSION}.`,
    );
    const hostile: Executor = {
      name: "\u001b[31mEvil\nSandbox " + "x".repeat(80),
      execute: async () => ({ result: 42 }),
    };
    const line = await doctorAgainst(hostile);
    expect(line).toBe(
      `Connecta doctor passed: 1 connector(s), code executed, prescribed 7-tool surface, MCP 2026-07-28, package ${CONNECTA_VERSION}.`,
    );
  });

  it("accepts the read program route at an agent endpoint and refuses any other extra tool", async () => {
    let extra = "execute_read_code";
    const server = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/health") {
        response.end(JSON.stringify({ status: "ok", connectors: 0 }));
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
        return;
      }
      let result: unknown = {};
      if (body.method === "initialize")
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "wrong", version: "1" },
        };
      if (body.method === "tools/list")
        result = {
          tools: [...META_TOOL_NAMES, extra].map((name) => ({
            name,
            inputSchema: { type: "object" },
          })),
        };
      if (body.method === "tools/call") result = { content: [{ type: "text", text: '{"result":42}' }] };
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    teardown.push(() => new Promise<void>((done) => server.close(() => done())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const doctor = () =>
      run(process.execPath, [CLI, "doctor", "--url", `http://127.0.0.1:${address.port}`, "--pool", "bots"], {
        env: { ...process.env, CONNECTA_TOKEN: `cta_${"a".repeat(43)}` },
      });
    expect((await doctor()).stdout).toContain("prescribed 7-tool surface");
    extra = "rogue_tool";
    await expect(doctor()).rejects.toThrow(/Unexpected MCP surface/);
  });

  it("auto-negotiates a legacy server and reports its negotiated revision", async () => {
    const methods: string[] = [];
    const server = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/health") {
        response.end(JSON.stringify({ status: "ok", connectors: 0 }));
        return;
      }
      if (request.method === "GET") {
        response.writeHead(405);
        response.end();
        return;
      }
      if (request.method === "DELETE") {
        response.end("{}");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      methods.push(body.method);
      if (body.method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
        return;
      }
      let result;
      if (body.method === "server/discover") {
        response.writeHead(404);
        response.end(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } }),
        );
        return;
      }
      if (body.method === "initialize")
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "legacy", version: "1" },
        };
      if (body.method === "tools/list")
        result = { tools: META_TOOL_NAMES.map((name) => ({ name, inputSchema: { type: "object" } })) };
      if (body.method === "tools/call") result = { content: [{ type: "text", text: '{"result":42}' }] };
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    teardown.push(() => new Promise<void>((done) => server.close(() => done())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const { stdout } = await run(process.execPath, [CLI, "doctor", "--url", `http://127.0.0.1:${address.port}`], {
      env: { ...process.env, CONNECTA_TOKEN: TOKEN },
    });
    expect(stdout).toContain(`prescribed 6-tool surface, MCP 2025-11-25, package ${CONNECTA_VERSION}.`);
    expect(methods).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/list", "tools/call"]);
  });
});

describe("connecta doctor's credential destinations", () => {
  it.each(["/health", "/mcp"])("refuses redirects from %s without forwarding credentials", async (route) => {
    const received: Array<Record<string, string | string[] | undefined>> = [];
    const target = createServer((request, response) => {
      received.push(request.headers);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status: "ok" }));
    });
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    teardown.push(() => new Promise<void>((done) => target.close(() => done())));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") throw new Error("Expected TCP address");
    const source = createServer((request, response) => {
      if (request.url !== route) {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      response.writeHead(302, { Location: `http://127.0.0.1:${targetAddress.port}/capture` });
      response.end();
    });
    source.listen(0, "127.0.0.1");
    await once(source, "listening");
    teardown.push(() => new Promise<void>((done) => source.close(() => done())));
    const sourceAddress = source.address();
    if (!sourceAddress || typeof sourceAddress === "string") throw new Error("Expected TCP address");
    await expect(
      run(process.execPath, [CLI, "doctor", "--url", `http://127.0.0.1:${sourceAddress.port}`], {
        env: {
          ...process.env,
          CONNECTA_TOKEN: "synthetic-bearer",
          CF_ACCESS_CLIENT_ID: "synthetic-access-id",
          CF_ACCESS_CLIENT_SECRET: "synthetic-secret",
        },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("redirect") });
    expect(received).toEqual([]);
  });
});

describe("connecta doctor --config", () => {
  async function deploymentUrl(app: ReturnType<typeof createConnecta>) {
    const server = listen(app, { port: 0, host: "127.0.0.1", gracefulShutdown: false });
    teardown.push(async () => {
      await new Promise<void>((done) => server.close(() => done()));
      await app.close();
    });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    return `http://127.0.0.1:${address.port}`;
  }

  it.each(["error", "per_caller"] as const)(
    "INV-5 INV-6: prints only the snapshot when status is %s, with all sentinels absent",
    async (state) => {
      const { config, storage, vault } = secretBearingDeployment();
      await vault.set("vaulted_mcp", SECRETS.storedCredential, "operator");
      await storage.set("access-token:sentinel", SECRETS.storedAccessToken);
      for (const connector of config.connectors)
        connector.status = async () => ({ state, message: SECRETS.headerValue });
      config.publicUrl = `http://localhost/?token=${SECRETS.publicUrlQuery}`;
      const app = createConnecta(config);
      const url = await deploymentUrl(app);
      for (const args of [
        ["--config", "--url", url],
        ["--url", url, "--config"],
      ]) {
        const { stdout, stderr } = await run(process.execPath, [CLI, "doctor", ...args], {
          env: {
            ...process.env,
            CONNECTA_TOKEN: SECRETS.machineToken,
            CF_ACCESS_CLIENT_ID: "",
            CF_ACCESS_CLIENT_SECRET: "",
          },
        });
        // Doctor prints the maintainer contract's config: describeConfig() verbatim.
        expect(JSON.parse(stdout)).toEqual(app.describeConfig());
        expect(stderr).toBe("");
        for (const [position, secret] of Object.entries(SECRETS))
          expect(stdout + stderr, position).not.toContain(secret);
        expect(stdout).not.toContain(VAULT_KEY);
        expect(stdout).not.toContain('"you"');
        expect(stdout).not.toContain('"live"');
      }
    },
  );

  it("INV-4: prints the snapshot only for a maintainer and does not execute a diagnostic program", async () => {
    // A maintainer reads every connector. A pool member gets their own view,
    // which carries no config snapshot (#837), so doctor prints nothing; anyone
    // else gets the private 404.
    let executed = 0;
    const OTHER = "doctor-cli-other-token";
    const NOBODY = "doctor-cli-nobody-token";
    const app = createConnecta({
      readOnly: false,
      connectors: [
        api("visible", {
          tools: [
            { name: "read", description: "Read a thing", annotations: { readOnlyHint: true }, handler: () => null },
          ],
        }),
        api("hidden", {
          tools: [
            { name: "read", description: "Read a thing", annotations: { readOnlyHint: true }, handler: () => null },
          ],
        }),
      ],
      executor: customExecutor(
        {
          execute: async () => {
            executed++;
            return { result: null };
          },
        },
        { lifecycle: "self-managed" },
      ),
      auth: [
        machineAuth(TOKEN),
        machineAuth(OTHER, { subjectId: "other" }),
        machineAuth(NOBODY, { subjectId: "nobody" }),
      ],
      maintainers: [MACHINE],
      pools: { visible: { tools: ["visible"], members: [{ namespace: TEST_MACHINE_NAMESPACE, id: "other" }] } },
      ui: operatorUi(),
      logger: "silent",
    });
    const url = await deploymentUrl(app);
    const { stdout } = await run(process.execPath, [CLI, "doctor", "--config", "--url", url], {
      env: { ...process.env, CONNECTA_TOKEN: TOKEN, CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" },
    });
    expect(JSON.parse(stdout).connectors.map((c: { id: string }) => c.id)).toEqual(["visible", "hidden"]);
    try {
      await run(process.execPath, [CLI, "doctor", "--config", "--url", url], {
        env: { ...process.env, CONNECTA_TOKEN: OTHER, CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" },
      });
      throw new Error("Expected failure");
    } catch (error) {
      const result = error as { stdout: string; stderr: string };
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("The config snapshot is for maintainers only.");
      expect(result.stderr).not.toContain("hidden");
    }
    try {
      await run(process.execPath, [CLI, "doctor", "--config", "--url", url], {
        env: { ...process.env, CONNECTA_TOKEN: NOBODY, CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" },
      });
      throw new Error("Expected failure");
    } catch (error) {
      const result = error as { stdout: string; stderr: string };
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("HTTP 404");
    }
    expect(executed).toBe(0);
  });

  it(
    "INV-4: --pool checks /agent/<pool> for a pool that lists its agent, and an agent token needs one",
    { timeout: 20_000 },
    async () => {
      const storage = memoryStorage();
      let dispatched = 0;
      let executions = 0;
      const app = createConnecta({
        readOnly: false,
        storage,
        connectors: [
          api("echo", {
            tools: [
              {
                name: "read",
                description: "Read",
                annotations: { readOnlyHint: true },
                handler: () => {
                  dispatched++;
                  return null;
                },
              },
            ],
          }),
          {
            id: "failed",
            listTools: async () => {
              throw new Error("PRIVATE_CATALOG_ERROR");
            },
            callTool: async () => {
              dispatched++;
              return {};
            },
          },
          {
            id: "bulk",
            listTools: async () =>
              Array.from({ length: 1001 }, (_, i) => ({
                name: `get_${i}`,
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true },
              })),
            callTool: async () => {
              dispatched++;
              return {};
            },
          },
        ],
        executor: customExecutor(
          {
            execute: async () => {
              executions++;
              return { result: 42 };
            },
          },
          { lifecycle: "self-managed" },
        ),
        agents: ["bot"],
        accessTokens: accessTokens(storage),
        pools: {
          failed: { tools: ["failed", "echo"], members: ["agent:bot"], surface: "native" },
          bulk: { tools: ["bulk"], members: ["agent:bot"], surface: "native" },
          bots: { tools: ["echo"], members: ["agent:bot"] },
          native: { tools: ["echo"], members: ["agent:bot"], surface: "native" },
          nocode: { tools: ["echo"], members: ["agent:bot"], surface: "native", executeCode: false },
        },
        logger: "silent",
      });
      const token = await issueAgentToken(storage, "bot");
      const url = await deploymentUrl(app);
      const env = { ...process.env, CONNECTA_TOKEN: token, CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" };
      const { stdout } = await run(process.execPath, [CLI, "doctor", "--url", url, "--pool", "bots"], { env });
      expect(stdout).toContain("Connecta doctor passed");
      for (const pool of ["native", "nocode"]) {
        const native = await run(process.execPath, [CLI, "doctor", "--url", url, "--pool", pool], { env });
        expect(native.stdout).toContain("native tool surface");
        expect(native.stdout).toContain(pool === "nocode" ? "code disabled" : "code executed");
      }
      for (const [pool, message] of [
        ["failed", "Native catalogs unavailable: failed"],
        ["bulk", "native listing cap"],
      ]) {
        await expect(run(process.execPath, [CLI, "doctor", "--url", url, "--pool", pool!], { env })).rejects.toThrow(
          message,
        );
      }
      expect(dispatched).toBe(0);
      expect(executions).toBe(3);
      await expect(run(process.execPath, [CLI, "doctor", "--url", url], { env })).rejects.toThrow(
        "An agent token reaches only /agent/<pool>",
      );
      await expect(run(process.execPath, [CLI, "doctor", "--url", url, "--pool", "Bad/Name"], { env })).rejects.toThrow(
        "--pool must be a pool name",
      );
      await expect(
        run(process.execPath, [CLI, "doctor", "--url", url, "--pool", "local"], {
          env: { ...env, CONNECTA_TOKEN: "person-session-token" },
        }),
      ).rejects.toThrow("--pool is for agent tokens");
    },
  );

  it("INV-8: reports degraded discovery when a native pool lists a connector from a stale catalog", async () => {
    const storage = memoryStorage();
    let hung = false;
    const app = createConnecta({
      readOnly: false,
      connectors: [
        {
          id: "slow",
          kind: "mcp",
          listTools: (ctx) =>
            hung
              ? new Promise((_, reject) =>
                  ctx.signal!.addEventListener("abort", () => reject(ctx.signal!.reason), { once: true }),
                )
              : Promise.resolve([
                  { name: "get", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
                ]),
          callTool: async () => ({}),
        },
      ],
      executor: customExecutor({ execute: async () => ({ result: 42 }) }, { lifecycle: "self-managed" }),
      agents: ["bot"],
      accessTokens: accessTokens(storage),
      pools: { native: { tools: ["slow"], members: ["agent:bot"], surface: "native" } },
      discovery: { probeTimeoutMs: 200 },
      storage,
      logger: "silent",
    });
    const token = await issueAgentToken(storage, "bot");
    const url = await deploymentUrl(app);
    const env = { ...process.env, CONNECTA_TOKEN: token, CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" };
    const healthy = await run(process.execPath, [CLI, "doctor", "--url", url, "--pool", "native"], { env });
    expect(healthy.stdout).toContain("Connecta doctor passed");
    hung = true;
    const failed = (await run(process.execPath, [CLI, "doctor", "--url", url, "--pool", "native"], { env }).then(
      () => {
        throw new Error("Expected failure");
      },
      (error: unknown) => error,
    )) as { stdout: string; stderr: string };
    expect(failed.stdout).not.toContain("passed");
    expect(failed.stderr).toContain("Native discovery degraded: slow");
  }, 30_000);

  it("INV-5 INV-6: refuses config redirects and withholds an authentication failure body", async () => {
    for (const status of [302, 403]) {
      const server = createServer((_request, response) => {
        response.writeHead(status, { Location: "https://other.example/SENTINEL-location" });
        response.end("SENTINEL-error-body");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      teardown.push(() => new Promise<void>((done) => server.close(() => done())));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      try {
        await run(process.execPath, [CLI, "doctor", "--config", "--url", `http://127.0.0.1:${address.port}`], {
          env: { ...process.env, CONNECTA_TOKEN: TOKEN, CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" },
        });
        throw new Error("Expected failure");
      } catch (error) {
        const result = error as { stdout: string; stderr: string };
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(`HTTP ${status}`);
        expect(result.stderr).not.toContain("SENTINEL");
      }
    }
  });
});

describe("connecta doctor against a server that reflects its credentials", () => {
  const credentials = {
    CONNECTA_TOKEN: `reflected"token\\<&>%/'`,
    CF_ACCESS_CLIENT_ID: "reflected-access-id.example",
    CF_ACCESS_CLIENT_SECRET: "reflected+access&secret=",
  };

  function reflection(headers: Record<string, string | string[] | undefined>): string {
    const values = [headers.authorization, headers["cf-access-client-id"], headers["cf-access-client-secret"]].map(
      String,
    );
    return [
      ...values,
      JSON.stringify(headers),
      JSON.stringify(JSON.stringify(headers)),
      ...values.map(encodeURIComponent),
      ...values.map((value) => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)),
    ].join("\n");
  }

  async function reflectingDoctor(
    route: "/health" | "/mcp" | "/ui/api/config",
    args: string[] = [],
  ): Promise<{ stdout: string; stderr: string }> {
    const server = createServer((request, response) => {
      if (request.url === route && route === "/ui/api/config") {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            schemaVersion: 2,
            role: "maintainer",
            config: { schemaVersion: 1, echoed: request.headers, quoted: reflection(request.headers) },
          }),
        );
        return;
      }
      if (request.url === route) {
        response.writeHead(431, { "Content-Type": "text/plain" });
        response.end(reflection(request.headers));
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status: "ok", connectors: 0 }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    teardown.push(() => new Promise<void>((done) => server.close(() => done())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    return run(process.execPath, [CLI, "doctor", "--url", `http://127.0.0.1:${address.port}`, ...args], {
      env: { ...process.env, ...credentials },
    }).then(
      ({ stdout, stderr }) => ({ stdout, stderr }),
      (error: { stdout: string; stderr: string }) => ({ stdout: error.stdout, stderr: error.stderr }),
    );
  }

  function expectNoCredential(output: { stdout: string; stderr: string }) {
    for (const value of Object.values(credentials)) {
      for (const form of [value, `Bearer ${value}`, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]) {
        expect(output.stdout).not.toContain(form);
        expect(output.stderr).not.toContain(form);
      }
    }
    expect(`${output.stdout}${output.stderr}`).not.toMatch(/reflected/);
  }

  it("INV-5: withholds a /health error body that quotes the request headers", async () => {
    const output = await reflectingDoctor("/health");
    expect(output.stderr).toContain("HTTP 431 from /health");
    expectNoCredential(output);
  });

  it("INV-5: withholds an MCP error body that quotes the request headers", async () => {
    const output = await reflectingDoctor("/mcp");
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("MCP 431 from /mcp");
    expectNoCredential(output);
  });

  it("INV-5: redacts credentials a --config snapshot reflects", async () => {
    const output = await reflectingDoctor("/ui/api/config", ["--config"]);
    expect(output.stderr).toBe("");
    expect(JSON.parse(output.stdout)).toMatchObject({ schemaVersion: 1, echoed: { host: expect.any(String) } });
    expect(output.stdout).toContain("[redacted]");
    expectNoCredential(output);
  });

  it("INV-5: redacts a credential with consecutive backslashes from a --config snapshot as data", async () => {
    const token = "reflected\\\\\\backslash-token";
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          schemaVersion: 2,
          role: "maintainer",
          config: {
            schemaVersion: 1,
            authorization: request.headers.authorization,
            nested: [{ [String(request.headers.authorization)]: `prefix ${token} suffix` }],
          },
        }),
      );
    });
    const url = await listening(server);
    const output = await run(process.execPath, [CLI, "doctor", "--config", "--url", url], {
      env: { ...process.env, CONNECTA_TOKEN: token, CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" },
    });
    expect(JSON.parse(output.stdout)).toEqual({
      schemaVersion: 1,
      authorization: "[redacted]",
      nested: [{ "[redacted]": "[redacted]" }],
    });
    for (const form of [token, JSON.stringify(token).slice(1, -1), "backslash-token"]) {
      expect(output.stdout).not.toContain(form);
      expect(output.stderr).not.toContain(form);
    }
  });

  it("refuses a --config response that is not JSON without printing it", async () => {
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(`not json ${request.headers.authorization}`);
    });
    const url = await listening(server);
    const output = await run(process.execPath, [CLI, "doctor", "--config", "--url", url], {
      env: { ...process.env, ...credentials },
    }).then(
      () => ({ stdout: "unexpected success", stderr: "" }),
      (error: { stdout: string; stderr: string }) => error,
    );
    expect(output.stderr).toContain("Deployment returned an invalid config contract.");
    expect(output.stderr).not.toContain("not json");
    expectNoCredential(output);
  });
});

async function listening(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  teardown.push(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}

describe("connecta doctor prints facts, not server text", () => {
  const token = `cta_reflected_${"t".repeat(29)}`;

  type Fake = {
    health?: (auth: string) => unknown;
    tools?: (auth: string) => Array<{ name: string; _meta?: unknown }>;
    listError?: (auth: string) => { code: number; message: string };
    call?: (auth: string) => unknown;
    oversizedList?: boolean;
  };

  async function doctorAgainstFake(fake: Fake): Promise<{ stdout: string; stderr: string }> {
    const server = createServer(async (request, response) => {
      const auth = String(request.headers.authorization);
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/health") {
        response.end(JSON.stringify(fake.health?.(auth) ?? { status: "ok", connectors: 0 }));
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
        return;
      }
      if (body.method === "tools/list" && fake.oversizedList) {
        const padding = "x".repeat(5 * 1024 * 1024);
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [], padding } }));
        return;
      }
      if (body.method === "tools/list" && fake.listError) {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: fake.listError(auth) }));
        return;
      }
      let result: unknown = {};
      if (body.method === "initialize")
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1" },
        };
      if (body.method === "tools/list")
        result = {
          tools: (fake.tools?.(auth) ?? META_TOOL_NAMES.map((name) => ({ name }))).map((tool) => ({
            ...tool,
            inputSchema: { type: "object" },
          })),
        };
      if (body.method === "tools/call")
        result = fake.call?.(auth) ?? { content: [{ type: "text", text: '{"result":42}' }] };
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
    const url = await listening(server);
    return run(process.execPath, [CLI, "doctor", "--url", url, "--pool", "bots"], {
      env: { ...process.env, CONNECTA_TOKEN: token, CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" },
    }).then(
      ({ stdout, stderr }) => ({ stdout, stderr }),
      (error: { stdout: string; stderr: string }) => ({ stdout: error.stdout, stderr: error.stderr }),
    );
  }

  function expectNoServerText(output: { stdout: string; stderr: string }) {
    for (const form of [token, `Bearer ${token}`, "reflected", "SERVER-TEXT"]) {
      expect(output.stdout).not.toContain(form);
      expect(output.stderr).not.toContain(form);
    }
  }

  it.each([
    ["a partial credential run", (auth: string) => auth.slice(11, 23)],
    ["an uppercased credential", (auth: string) => auth.slice("Bearer ".length).toUpperCase()],
  ])("INV-5: refuses an identifier carrying %s", async (_label, status) => {
    const output = await doctorAgainstFake({ health: (auth) => ({ status: status(auth) }) });
    expect(output.stderr).toContain("Unexpected health status from /health: <unprintable>.");
    expect(output.stderr.toLowerCase()).not.toContain(token.slice(4, 16).toLowerCase());
  });

  it("INV-5: names an unexpected health status only when it is a plain identifier", async () => {
    const output = await doctorAgainstFake({ health: (auth) => ({ status: auth }) });
    expect(output.stderr).toContain("Unexpected health status from /health: <unprintable>.");
    expectNoServerText(output);
  });

  it("INV-5: prints a connector count and executor name only when they carry no credential", async () => {
    const output = await doctorAgainstFake({
      health: (auth) => ({ status: "ok", connectors: auth, executor: { name: auth.slice("Bearer ".length) } }),
    });
    expect(output.stdout).toMatch(/^Connecta doctor passed: <unprintable> connector\(s\), code executed, /);
    expectNoServerText(output);
  });

  it("INV-5: lists unexpected tool names only as checked identifiers", async () => {
    const output = await doctorAgainstFake({
      tools: (auth) =>
        [...META_TOOL_NAMES, auth.slice("Bearer ".length), `SERVER-TEXT ${auth}`].map((name) => ({ name })),
    });
    expect(output.stderr).toContain("Unexpected MCP surface.");
    expect(output.stderr).toContain("received 8 tool(s): ");
    expect(output.stderr.match(/<unprintable>/g)).toHaveLength(2);
    expectNoServerText(output);
  });

  it("INV-5: names unavailable native catalogs only as checked identifiers", async () => {
    const output = await doctorAgainstFake({
      tools: (auth) =>
        ["authorize_connector", "skills", "execute_code"].map((name) => ({
          name,
          ...(name === "skills"
            ? {
                _meta: {
                  "dev.connecta/surface": {
                    surface: "native",
                    executeCode: true,
                    catalogErrors: ["crm", auth.slice("Bearer ".length), auth.slice(11, 23)],
                    staleCatalogs: [],
                  },
                },
              }
            : {}),
        })),
    });
    expect(output.stderr).toContain("Native catalogs unavailable: crm, <unprintable>, <unprintable>.");
    expectNoServerText(output);
  });

  it("INV-5: reports an execution failure without the tool's result", async () => {
    const output = await doctorAgainstFake({
      call: (auth) => ({ isError: true, content: [{ type: "text", text: `SERVER-TEXT ${auth}` }] }),
    });
    expect(output.stderr).toContain("execute_code check failed: the tool returned an error.");
    expectNoServerText(output);
  });

  it("INV-5: reports a JSON-RPC error by code without its message", async () => {
    const output = await doctorAgainstFake({ listError: (auth) => ({ code: -32603, message: `SERVER-TEXT ${auth}` }) });
    expect(output.stderr).toMatch(/MCP request to \/agent\/bots failed: \S+ -32603\./);
    expectNoServerText(output);
  });

  it("refuses an MCP reply over the byte cap", async () => {
    const output = await doctorAgainstFake({ oversizedList: true });
    expect(output.stderr).toContain(`Response from /agent/bots exceeds ${4 * 1024 * 1024} bytes.`);
    expectNoServerText(output);
  });

  it("refuses a /health body over the byte cap", async () => {
    const output = await doctorAgainstFake({ health: () => ({ status: "ok", padding: "x".repeat(70 * 1024) }) });
    expect(output.stderr).toContain(`Response from /health exceeds ${64 * 1024} bytes.`);
  });

  it("refuses a --config body over the byte cap", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ padding: "x".repeat(5 * 1024 * 1024) }));
    });
    const url = await listening(server);
    const output = await run(process.execPath, [CLI, "doctor", "--config", "--url", url], {
      env: { ...process.env, CONNECTA_TOKEN: token, CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" },
    }).then(
      () => ({ stdout: "unexpected success", stderr: "" }),
      (error: { stdout: string; stderr: string }) => error,
    );
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain(`Response from /ui/api/config exceeds ${4 * 1024 * 1024} bytes.`);
  });

  it("INV-5: fails without printing the SDK's warning when a modern-era server lists a tool it must exclude", async () => {
    const connecta = createConnecta({
      readOnly: false,
      connectors: [],
      executor: customExecutor({ execute: async () => ({ result: 42 }) }, { lifecycle: "self-managed" }),
      auth: machineAuth(TOKEN),
      maintainers: [MACHINE],
      logger: "silent",
    });
    const upstream = listen(connecta, { port: 0, host: "127.0.0.1", gracefulShutdown: false });
    teardown.push(async () => {
      await new Promise<void>((done) => upstream.close(() => done()));
      await connecta.close();
    });
    await once(upstream, "listening");
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("Expected TCP address");
    const origin = `http://127.0.0.1:${upstreamAddress.port}`;
    const injected = `\u001b[2J\u001b]52;c;SERVER-TEXT\u0007\nINJECTED ${TOKEN}`;
    const proxy = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const headers = Object.fromEntries(
        Object.entries(request.headers).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" && !["host", "content-length", "connection"].includes(entry[0]),
        ),
      );
      const forwarded = await fetch(`${origin}${request.url}`, {
        method: request.method ?? "GET",
        headers,
        ...(body.length ? { body } : {}),
      });
      const text = await forwarded.text();
      const listing = body.length > 0 && JSON.parse(body.toString()).method === "tools/list";
      if (!listing || !forwarded.ok) {
        const passthrough: Record<string, string> = {};
        forwarded.headers.forEach((value, key) => {
          if (!["content-length", "content-encoding", "transfer-encoding"].includes(key)) passthrough[key] = value;
        });
        response.writeHead(forwarded.status, passthrough);
        response.end(text);
        return;
      }
      const message = JSON.parse(
        (forwarded.headers.get("content-type") ?? "").includes("text/event-stream")
          ? text
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .pop()!
              .slice("data:".length)
          : text,
      );
      message.result.tools.push({
        name: `SERVER-TEXT-${TOKEN}`,
        inputSchema: {
          type: "object",
          properties: { [`SERVER-TEXT ${TOKEN}`]: { type: injected, "x-mcp-header": "Region" } },
        },
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(message));
    });
    const url = await listening(proxy);
    const output = await run(process.execPath, [CLI, "doctor", "--url", url], {
      env: { ...process.env, CONNECTA_TOKEN: TOKEN, CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" },
    }).then(
      ({ stdout, stderr }) => ({ stdout, stderr, passed: true }),
      (error: { stdout: string; stderr: string }) => ({ stdout: error.stdout, stderr: error.stderr, passed: false }),
    );
    expect(output.passed).toBe(false);
    expect(output.stdout).toBe("");
    expect(output.stderr).toBe(
      "[connecta] The MCP client excluded or flagged part of the tools/list reply from /mcp (1 message(s), not printed).\n",
    );
  });

  it("INV-5: withholds a reflection of credentials loaded from --dotenv", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connecta-env-"));
    teardown.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, ".env");
    const values = {
      CONNECTA_TOKEN: "reflected-dotenv-token-0123456789",
      CF_ACCESS_CLIENT_ID: "reflected-dotenv-id.access",
      CF_ACCESS_CLIENT_SECRET: "reflected-dotenv-secret-abcdef",
    };
    await writeFile(
      path,
      Object.entries(values)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(""),
    );
    const server = createServer((request, response) => {
      response.writeHead(request.url === "/health" ? 200 : 431, { "Content-Type": "application/json" });
      response.end(
        request.url === "/health"
          ? JSON.stringify({ status: "ok", connectors: 0 })
          : JSON.stringify({ quoted: request.headers }),
      );
    });
    const url = await listening(server);
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(values)) delete env[name];
    const output = await run(process.execPath, [CLI, "doctor", "--url", url, "--dotenv", path], { env }).then(
      () => ({ stdout: "unexpected success", stderr: "" }),
      (error: { stdout: string; stderr: string }) => error,
    );
    expect(output.stderr).toContain("MCP 431 from /mcp.");
    expect(`${output.stdout}${output.stderr}`).not.toMatch(/reflected/);
  });

  it("does not blame a reset initialize on the probe's earlier 404", async () => {
    const server = createServer(async (request, response) => {
      if (request.url === "/health") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ status: "ok", connectors: 0 }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (body.method === "server/discover") {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Not found" } }));
        return;
      }
      request.socket.destroy();
    });
    const url = await listening(server);
    const output = await run(process.execPath, [CLI, "doctor", "--url", url], {
      env: { ...process.env, CONNECTA_TOKEN: TOKEN, CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" },
    }).then(
      () => ({ stdout: "unexpected success", stderr: "" }),
      (error: { stdout: string; stderr: string }) => error,
    );
    expect(output.stderr).toMatch(/MCP request to \/mcp failed: /);
    expect(output.stderr).not.toContain("MCP 404");
  });

  it("refuses a too-short credential from --dotenv by name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connecta-env-"));
    teardown.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, ".env");
    await writeFile(path, "CF_ACCESS_CLIENT_ID=synthetic-access-id\nCF_ACCESS_CLIENT_SECRET=short-secret\n");
    const env: NodeJS.ProcessEnv = { ...process.env, CONNECTA_TOKEN: TOKEN };
    delete env.CF_ACCESS_CLIENT_ID;
    delete env.CF_ACCESS_CLIENT_SECRET;
    const output = await run(process.execPath, [CLI, "doctor", "--dotenv", path], { env }).then(
      () => ({ stdout: "unexpected success", stderr: "" }),
      (error: { stdout: string; stderr: string }) => error,
    );
    expect(output.stderr).toContain("CF_ACCESS_CLIENT_SECRET is shorter than 16 characters");
    expect(`${output.stdout}${output.stderr}`).not.toContain("short-secret");
  });

  it("refuses a credential too short to redact soundly, naming only the variable", async () => {
    const executor: Executor = { execute: async () => ({ result: 42 }) };
    for (const [name, value] of [
      ["CONNECTA_TOKEN", "short-token"],
      ["CF_ACCESS_CLIENT_SECRET", "short-secret"],
    ] as const) {
      const env: Record<string, string> = {
        CONNECTA_TOKEN: TOKEN,
        CF_ACCESS_CLIENT_ID: "synthetic-access-id",
        CF_ACCESS_CLIENT_SECRET: "synthetic-access-secret",
        [name]: value,
      };
      const failure = await doctorAgainst(executor, { env }).then(
        () => undefined,
        (error: { stdout: string; stderr: string }) => error,
      );
      expect(failure?.stderr).toContain(`${name} is shorter than 16 characters`);
      expect(`${failure?.stdout}${failure?.stderr}`).not.toContain(value);
    }
  });
});

describe("connecta --help", () => {
  async function cli(line: string[]) {
    const cwd = await mkdtemp(join(tmpdir(), "connecta-help-"));
    teardown.push(() => rm(cwd, { recursive: true, force: true }));
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CONNECTA_TOKEN;
    const result = await run(process.execPath, [CLI, ...line], { cwd, env }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code: number; stdout: string; stderr: string }) => error,
    );
    return { ...result, entries: await readdir(cwd) };
  }

  it.each(["--help", "-h", "doctor --help", "doctor --url http://localhost:1 -h", "init --help", "init -h"])(
    "prints usage and exits 0 for `connecta %s`",
    async (line) => {
      const result = await cli(line.split(" "));
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Usage:");
      expect(result.entries).toEqual([]);
    },
  );

  it("reads -h as the value of --pool, not as a help request", async () => {
    const result = await cli(["doctor", "--pool", "-h"]);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("Usage:");
    expect(result.stderr).toContain("Set CONNECTA_TOKEN");
  });

  it("fails an unknown command whatever follows it", async () => {
    const result = await cli(["nonsense", "--help"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Usage:");
  });

  it("creates a directory literally named -h when given as a path", async () => {
    const result = await cli(["init", "./-h"]);
    expect(result.code).toBe(0);
    expect(result.entries).toEqual(["-h"]);
  });
});

describe("connecta doctor --dotenv", () => {
  async function envFile(contents: string) {
    const directory = await mkdtemp(join(tmpdir(), "connecta-env-"));
    teardown.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, ".env");
    await writeFile(path, contents);
    return path;
  }
  const executor: Executor = { execute: async () => ({ result: 42 }) };

  it("reads the token from the file when the environment has none", async () => {
    const path = await envFile(`CONNECTA_TOKEN=${TOKEN}\n`);
    await expect(doctorAgainst(executor, { env: {}, args: ["--dotenv", path] })).resolves.toContain(
      "Connecta doctor passed",
    );
  });

  it("keeps a token already in the environment over the file's", async () => {
    const path = await envFile("CONNECTA_TOKEN=wrong-token\n");
    await expect(
      doctorAgainst(executor, { env: { CONNECTA_TOKEN: TOKEN }, args: ["--dotenv", path] }),
    ).resolves.toContain("Connecta doctor passed");
  });

  it("refuses a credential that cannot be a header value without printing it", async () => {
    const path = await envFile('CONNECTA_TOKEN="cta_secret-first-line\nsecret-second-line"\n');
    const failure = await doctorAgainst(executor, { env: {}, args: ["--dotenv", path] }).then(
      () => undefined,
      (error: { stderr: string; stdout?: string }) => error,
    );
    expect(failure?.stderr).toContain("CONNECTA_TOKEN holds characters that cannot be sent in a request header");
    expect(`${failure?.stderr}${failure?.stdout ?? ""}`).not.toMatch(/secret-first-line|secret-second-line/);
  });

  it("refuses a file credential holding a NUL byte instead of sending its prefix", async () => {
    const path = await envFile('CONNECTA_TOKEN="cta_secret-prefix\0secret-suffix"\n');
    const failure = await doctorAgainst(executor, { env: {}, args: ["--dotenv", path] }).then(
      () => undefined,
      (error: { stderr: string; stdout?: string }) => error,
    );
    expect(failure?.stderr).toContain("CONNECTA_TOKEN holds characters that cannot be sent in a request header");
    expect(`${failure?.stderr}${failure?.stdout ?? ""}`).not.toMatch(/secret-prefix|secret-suffix/);
  });

  it("changes nothing when the file is absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connecta-env-"));
    teardown.push(() => rm(directory, { recursive: true, force: true }));
    await expect(
      doctorAgainst(executor, { env: {}, args: ["--dotenv", join(directory, ".env")] }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Set CONNECTA_TOKEN") });
  });
});
