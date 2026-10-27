import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(root, "packages/connecta-eve");
const manifest = JSON.parse(await readFile(join(helper, "package.json"), "utf8"));
const core = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.equal(manifest.version, core.version, "Core and Eve helper release versions must match");
assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Eve package smoke requires Node 24+");
const work = await mkdtemp(join(tmpdir(), "connecta-eve-package-"));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 180_000,
  });
try {
  const packed = JSON.parse(run(pnpm, ["pack", "--ignore-scripts", "--pack-destination", work, "--json"], helper));
  const archive = packed.filename;
  assert.equal(typeof archive, "string");
  for (const file of packed.files) {
    assert.match(file.path, /^(dist\/|package\.json$|README\.md$|LICENSE$)/, `Unexpected published file: ${file.path}`);
  }
  await writeFile(
    join(work, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        [manifest.name]: `file:${resolve(helper, archive)}`,
        eve: manifest.devDependencies.eve,
      },
    }),
  );
  // Only this exact, real Eve release is admitted in the isolated consumer.
  await writeFile(
    join(work, "pnpm-workspace.yaml"),
    `minimumReleaseAgeExclude:\n  - eve@${manifest.devDependencies.eve}\n`,
  );
  run(pnpm, ["install", "--ignore-scripts"], work);
  // Reuse the same real-Eve reaction/memo support against the consumer's pinned
  // Eve installation. Node 24 strips its test-only TypeScript annotations.
  await writeFile(join(work, "eve-runtime.ts"), await readFile(join(helper, "test/eve-runtime.ts"), "utf8"));
  await writeFile(
    join(work, "smoke.mjs"),
    `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import { connectaConnection, connectaEndpoint, connectaInstructions, gateConnectaWrites } from "@zackbart/connecta-eve";
    import { dynamicSession, instructionSession } from "./eve-runtime.ts";
    const require = createRequire(import.meta.url);
    assert.throws(() => require.resolve("@zackbart/connecta"), { code: "MODULE_NOT_FOUND" });
    let token = "cta_first";
    const connection = connectaConnection({ url: "https://connecta.example.com", pool: "assistant", description: "CRM", getToken: () => token });
    assert.equal(connection.url, connectaEndpoint({ url: "https://connecta.example.com", pool: "assistant" }));
    assert.equal(connection.auth.principalType, "app");
    assert.equal((await connection.auth.getToken()).token, token);
    token = "cta_rotated";
    assert.equal((await connection.auth.getToken()).token, token);
    assert.equal(await connection.approval({ toolName: "write" }), "not-applicable");
    assert.equal(gateConnectaWrites({ toolName: "write" }), "user-approval");
    const instructions = connectaInstructions({ url: connection.url, getToken: () => token, fetch: async () => Response.json({ result: { instructions: "CRM guidance" } }) });
    assert.equal((await instructionSession(instructions)("turn_1")).content, "Connecta guidance:\\nCRM guidance");
    let pool = "notes_alice";
    const selector = async () => pool;
    const dynamic = connectaConnection({ url: "https://connecta.example.com", pool: selector, description: "Notes", getToken: () => token });
    assert.equal(dynamic.kind, "eve:dynamic");
    const evaluateConnection = dynamicSession(dynamic, "connection");
    const { result: selected } = await evaluateConnection("turn_1");
    assert.equal(selected.url, "https://connecta.example.com/agent/notes_alice");
    assert.equal(selected.instanceKey, "notes_alice");
    assert.equal((await selected.auth.getToken()).token, token);
    const dynamicInstructions = connectaInstructions({ url: "https://connecta.example.com", pool: selector, getToken: () => token, clientName: "assistant", fetch: async (url, init) => {
      assert.equal(JSON.parse(init.body).params._meta["io.modelcontextprotocol/clientInfo"].name, "assistant");
      return Response.json({ result: { instructions: String(url) } });
    } });
    const evaluateInstructions = instructionSession(dynamicInstructions);
    assert.equal((await evaluateInstructions("turn_1")).content, "Connecta guidance:\\nhttps://connecta.example.com/agent/notes_alice");
    pool = "assistant";
    assert.equal((await evaluateConnection("turn_1")).result.instanceKey, "assistant");
    assert.equal((await evaluateInstructions("turn_1")).content, "Connecta guidance:\\nhttps://connecta.example.com/agent/assistant");
  `,
  );
  run(process.execPath, ["smoke.mjs"], work);
  // Check emitted declarations as TS so skipLibCheck cannot conceal broken
  // imports or drifting Eve symbols in our own public API.
  await writeFile(join(work, "contract.ts"), await readFile(join(helper, "dist/index.d.ts"), "utf8"));
  await writeFile(
    join(work, "check.ts"),
    `
    import { connectaConnection, connectaEndpoint, connectaInstructions, gateConnectaWrites, type ConnectaConnectionOptions, type ConnectaInstructionsOptions, type ConnectaPoolSelector } from "./contract.js";
    import { defineMcpClientConnection, defineDynamic as defineDynamicConnection } from "eve/connections";
    import { defineDynamic } from "eve/instructions";
    import { never } from "eve/tools/approval";
    type IsAny<T> = 0 extends (1 & T) ? true : false;
    const connectionIsAny: IsAny<ReturnType<typeof connectaConnection>> = false;
    const instructionsAreAny: IsAny<ReturnType<typeof connectaInstructions>> = false;
    const connection: ReturnType<typeof defineMcpClientConnection> = connectaConnection({ description: "CRM", approval: never() });
    const staticPoolConnection: ReturnType<typeof defineMcpClientConnection> = connectaConnection({ description: "Notes", pool: "assistant" });
    const instructions: ReturnType<typeof defineDynamic> = connectaInstructions();
    const selector: ConnectaPoolSelector = ctx => ctx.memo(["pool", ctx.turn?.id ?? null], () => "assistant");
    const dynamicConnection: ReturnType<typeof defineDynamicConnection> = connectaConnection({ description: "Notes", pool: selector });
    const dynamicInstructions: ReturnType<typeof defineDynamic> = connectaInstructions({ pool: selector, clientName: "assistant" });
    const connectionOptions: ConnectaConnectionOptions = { description: "Notes", pool: selector };
    const instructionOptions: ConnectaInstructionsOptions = { pool: selector };
    connectaConnection(connectionOptions);
    connectaInstructions(instructionOptions);
    // @ts-expect-error Endpoints stay static-only.
    connectaEndpoint({ pool: selector });
    // @ts-expect-error A dynamic connection cannot be used as a static definition.
    const staticOnly: ReturnType<typeof defineMcpClientConnection> = dynamicConnection;
    const gate: typeof connection.approval = gateConnectaWrites;
    void [staticPoolConnection, dynamicConnection, dynamicInstructions, staticOnly];
    void [connectionIsAny, instructionsAreAny, connection, instructions, gate];
  `,
  );
  await writeFile(
    join(work, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
      files: ["check.ts", "contract.ts"],
    }),
  );
  run(process.execPath, [join(helper, "node_modules/typescript/bin/tsc"), "-p", join(work, "tsconfig.json")], work);
  console.log(
    `Eve package smoke passed: ${manifest.name}@${manifest.version}, eve@${manifest.devDependencies.eve}; isolated runtime and emitted types`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
