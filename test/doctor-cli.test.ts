import { execFile } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { api } from "../src/connectors/api.js";
import { bearerToken } from "../src/auth/bearer.js";
import { listen } from "../src/node.js";
import { createConnecta } from "../src/index.js";
import type { Executor } from "../src/types.js";

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

async function doctorAgainst(executor: Executor): Promise<string> {
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
    executor,
    auth: bearerToken(TOKEN),
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
    { env: { ...process.env, CONNECTA_TOKEN: TOKEN } },
  );
  return stdout.trim();
}

describe("connecta doctor's executor line", () => {
  it("names the sandbox the deployment actually runs", async () => {
    // The Workers shape, structurally: a class-named executor that is not
    // QuickJS and never claimed to be.
    class DynamicWorkerExecutor implements Executor {
      async execute() {
        return { result: 42 };
      }
    }
    const line = await doctorAgainst(new DynamicWorkerExecutor());
    expect(line).toBe(
      "Connecta doctor passed: 1 connector(s), DynamicWorkerExecutor " +
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
    const hostile = {
      name: "\u001b[31mEvil\nSandbox " + "x".repeat(80),
      execute: async () => ({ result: 42 }),
    } as Executor;
    const line = await doctorAgainst(hostile);
    expect(line).toMatch(
      /^Connecta doctor passed: 1 connector\(s\), 31mEvil Sandbox x+ executed, prescribed seven-tool surface\.$/,
    );
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("x".repeat(41));
  });
});
