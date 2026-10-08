// Node-only: spawns the CLI against a Node HTTP deployment over real sockets.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { api } from "../src/connectors/api.js";
import { machineAuth } from "./helpers/machine-auth.js";
import { operatorUi } from "../src/ui.js";
import { SECRETS, VAULT_KEY, secretBearingDeployment } from "./fixtures/describe-config.js";
import { listen } from "../src/node.js";
import { customExecutor, createConnecta } from "../src/index.js";
import type { Executor, InboundAuth, KVStorage } from "../src/types.js";

// `connecta doctor` is a claim an operator reads and believes. It used to
// print "QuickJS executed" against every deployment, including the Workers
// shape whose sandbox is a Dynamic Worker (#368), so the executor line is
// exercised end to end: real CLI, real HTTP, one deployment per sandbox.
const CLI = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "connecta.mjs",
);
const TOKEN = "doctor-cli-token";
const run = promisify(execFile);

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()?.();
});

async function doctorAgainst(
  executor: Executor,
  options: {
    auth?: InboundAuth;
    env?: Record<string, string>;
    storage?: KVStorage;
  } = {},
): Promise<string> {
  const connecta = createConnecta({
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
  const { stdout } = await run(
    process.execPath,
    [CLI, "doctor", "--url", `http://127.0.0.1:${address.port}`],
    {
      env: {
        ...process.env,
        ...(options.env ?? { CONNECTA_TOKEN: TOKEN }),
      },
    },
  );
  return stdout.trim();
}

describe("connecta doctor's executor line", () => {
  it("names the sandbox the deployment actually runs", async () => {
    // A custom class-named sandbox, independent of either built-in executor.
    class CustomExecutor implements Executor {
      async execute() {
        return { result: 42 };
      }
    }
    const line = await doctorAgainst(new CustomExecutor());
    expect(line).toBe(
      "Connecta doctor passed: 1 connector(s), CustomExecutor " +
        "executed, prescribed seven-tool surface.",
    );
    expect(line).not.toContain("QuickJS");
  });

  it("stays executor-neutral when the deployment identifies none", async () => {
    const line = await doctorAgainst({ execute: async () => ({ result: 42 }) });
    expect(line).toBe(
      "Connecta doctor passed: 1 connector(s), code executed, " +
        "prescribed seven-tool surface.",
    );
  });

  it("bounds and sanitizes the name before it reaches a terminal", async () => {
    const hostile: Executor = {
      name: "\u001b[31mEvil\nSandbox " + "x".repeat(80),
      execute: async () => ({ result: 42 }),
    };
    const line = await doctorAgainst(hostile);
    expect(line).toMatch(
      /^Connecta doctor passed: 1 connector\(s\), 31mEvil Sandbox x+ executed, prescribed seven-tool surface\.$/,
    );
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("x".repeat(41));
  });

  it("can authenticate with Cloudflare Access service-token headers", async () => {
    const accessAuth: InboundAuth = {
      kind: "test-access-edge",
      authorize(request) {
        const admitted =
          request.headers.get("CF-Access-Client-Id") === "client-id" &&
          request.headers.get("CF-Access-Client-Secret") === "client-secret";
        return admitted
          ? { ok: true, subjectId: "doctor" }
          : {
              ok: false,
              response: Response.json({ error: "unauthorized" }, { status: 401 }),
            };
      },
    };
    const line = await doctorAgainst(
      { execute: async () => ({ result: 42 }) },
      {
        auth: accessAuth,
        env: {
          CF_ACCESS_CLIENT_ID: "client-id",
          CF_ACCESS_CLIENT_SECRET: "client-secret",
        },
      },
    );
    expect(line).toContain("Connecta doctor passed");
  });

  it("refuses a partial Cloudflare Access credential pair", async () => {
    await expect(
      run(process.execPath, [CLI, "doctor"], {
        env: {
          ...process.env,
          CONNECTA_TOKEN: "",
          CF_ACCESS_CLIENT_ID: "client-id",
          CF_ACCESS_CLIENT_SECRET: "",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET",
      ),
    });
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
    await expect(run(process.execPath, [CLI, "doctor", "--url", `http://127.0.0.1:${sourceAddress.port}`], {
      env: {
        ...process.env,
        CONNECTA_TOKEN: "synthetic-bearer",
        CF_ACCESS_CLIENT_ID: "synthetic-id",
        CF_ACCESS_CLIENT_SECRET: "synthetic-secret",
      },
    })).rejects.toMatchObject({ stderr: expect.stringContaining("redirect") });
    expect(received).toEqual([]);
  });
});

describe("connecta doctor --config", () => {
  async function deploymentUrl(app: ReturnType<typeof createConnecta>) {
    const server = listen(app, { port: 0, host: "127.0.0.1", gracefulShutdown: false });
    teardown.push(async () => {
      await new Promise<void>(done => server.close(() => done()));
      await app.close();
    });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    return `http://127.0.0.1:${address.port}`;
  }

  it("INV-5 INV-6: prints only the allowlisted snapshot with the full #724 sentinel set absent", async () => {
    const { config, storage, vault } = secretBearingDeployment();
    await vault.set("vaulted_mcp", SECRETS.storedCredential, "operator");
    await storage.set("access-token:sentinel", SECRETS.storedAccessToken);
    for (const connector of config.connectors) connector.status = async () => ({ state: "error", message: SECRETS.headerValue });
    config.publicUrl = `http://localhost/?token=${SECRETS.publicUrlQuery}`;
    const app = createConnecta(config);
    const url = await deploymentUrl(app);
    for (const args of [["--config", "--url", url], ["--url", url, "--config"]]) {
      const { stdout, stderr } = await run(process.execPath, [CLI, "doctor", ...args], {
        env: { ...process.env, CONNECTA_TOKEN: SECRETS.machineToken, CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" },
      });
      expect(JSON.parse(stdout)).toEqual(app.describeConfig());
      expect(stderr).toBe("");
      for (const [position, secret] of Object.entries(SECRETS)) expect(stdout + stderr, position).not.toContain(secret);
      expect(stdout).not.toContain(VAULT_KEY);
      expect(stdout).not.toContain('"you"');
      expect(stdout).not.toContain('"live"');
    }
  });

  it("INV-4: prints the caller's scoped snapshot and does not execute a diagnostic program", async () => {
    let executed = 0;
    const app = createConnecta({
      connectors: [api("visible", { tools: [{ name: "read", description: "Read a thing", annotations: { readOnlyHint: true }, handler: () => null }] }), api("hidden", { tools: [{ name: "read", description: "Read a thing", annotations: { readOnlyHint: true }, handler: () => null }] })],
      executor: customExecutor({ execute: async () => { executed++; return { result: null }; } }, { lifecycle: "self-managed" }),
      auth: machineAuth(TOKEN), ui: operatorUi(), logger: "silent", identity: { connectorAccess: () => ["visible"] },
    });
    const url = await deploymentUrl(app);
    const { stdout } = await run(process.execPath, [CLI, "doctor", "--config", "--url", url], { env: { ...process.env, CONNECTA_TOKEN: TOKEN, CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" } });
    expect(JSON.parse(stdout).connectors.map((c: { id: string }) => c.id)).toEqual(["visible"]);
    expect(stdout).not.toContain("hidden");
    expect(executed).toBe(0);
  });

  it("INV-5 INV-6: refuses config redirects and withholds an authentication failure body", async () => {
    for (const status of [302, 403]) {
      const server = createServer((_request, response) => {
        response.writeHead(status, { Location: "https://other.example/SENTINEL-location" });
        response.end("SENTINEL-error-body");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      teardown.push(() => new Promise<void>(done => server.close(() => done())));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      try {
        await run(process.execPath, [CLI, "doctor", "--config", "--url", `http://127.0.0.1:${address.port}`], { env: { ...process.env, CONNECTA_TOKEN: TOKEN, CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" } });
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
