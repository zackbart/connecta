import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = await mkdtemp(join(tmpdir(), "connecta-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const rootManifest = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const templateManifest = JSON.parse(
  await readFile(join(root, "templates", "node", "package.json"), "utf8"),
);

if (
  templateManifest.dependencies?.["@zackbart/connecta"] !==
  rootManifest.version
) {
  throw new Error("Node template must pin the package's current version");
}

function run(command, args, cwd, env = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, ...env },
  });
}

function expectFailure(command, args, cwd, expected, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (
    result.error ||
    result.signal ||
    result.status === 0 ||
    !output.includes(expected)
  ) {
    throw new Error(
      `Expected command failure containing ${JSON.stringify(expected)}; ` +
        `status=${String(result.status)} signal=${String(result.signal)} ` +
        `error=${String(result.error)} output=${output.slice(-2_000)}`,
    );
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a package-smoke port");
  }
  await new Promise((resolvePromise, reject) =>
    server.close((error) => error ? reject(error) : resolvePromise()),
  );
  return address.port;
}

async function waitForHealth(url, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Generated deployment exited before health was ready:\n${output()}`,
      );
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(
    `Generated deployment did not become healthy within 15s:\n${output()}`,
  );
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise();
    }, 5_000);
    void once(child, "exit").then(() => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

try {
  const packed = JSON.parse(
    run(
      npm,
      ["pack", "--json", "--ignore-scripts", "--pack-destination", work],
      root,
    ),
  )[0];
  const archive = join(work, packed.filename);
  const paths = new Set(packed.files.map((file) => file.path));

  for (const required of [
    "AGENTS.md",
    "README.md",
    "LICENSE",
    "assets/connecta-clay-hero.png",
    "bin/connecta.mjs",
    "documentation/code-mode.md",
    "ethos.md",
    "templates/node/.env.example",
    "templates/node/AGENTS.md",
    "templates/node/package.json",
    "templates/node/src/index.ts",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/types.d.ts",
    "dist/json-schema.js",
    "dist/json-schema.d.ts",
    "dist/executors/quickjs.js",
    "dist/executors/quickjs.d.ts",
    "dist/executors/quickjs-child.js",
    "dist/executors/quickjs-protocol.js",
    "dist/executors/quickjs-runtime.js",
    "src/index.ts",
  ]) {
    if (!paths.has(required)) {
      throw new Error(`Packed artifact is missing ${required}`);
    }
  }
  for (const path of paths) {
    if (path.startsWith("eval/")) {
      throw new Error(`Eval-only file leaked into the package: ${path}`);
    }
    if (path.startsWith("examples/docker/")) {
      throw new Error(`Repository-only Docker file leaked into package: ${path}`);
    }
    if (
      path.includes("connectors/cloudflare") ||
      path.includes("storage/cloudflare")
    ) {
      throw new Error(`Platform-specific implementation leaked into ${path}`);
    }
  }
  await writeFile(
    join(work, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await writeFile(
    join(work, "smoke.mjs"),
    `
const core = await import("@zackbart/connecta");
if (typeof core.createConnecta !== "function") throw new Error("missing core");
if (typeof core.validateToolInput !== "function") {
  throw new Error("missing validateToolInput");
}
const jsonSchema = await import("@zackbart/connecta/json-schema");
if (typeof jsonSchema.Validator !== "function") {
  throw new Error("missing Validator re-export");
}
for (const name of [
  "clerkAuth",
  "cloudflareApi",
  "cloudflareKvStorage",
  "d1ActivityStore",
  "quickJsExecutor",
]) {
  if (name in core) throw new Error(name + " leaked into the core entry");
}
`,
  );
  await writeFile(
    join(work, "optional.mjs"),
    `
const clerk = await import("@zackbart/connecta/auth/clerk");
const quickjs = await import("@zackbart/connecta/quickjs");
if (typeof clerk.clerkAuth !== "function") throw new Error("missing Clerk adapter");
if (typeof quickjs.quickJsExecutor !== "function") throw new Error("missing QuickJS adapter");
const executor = quickjs.quickJsExecutor({ timeoutMs: 2_000 });
try {
  const outcome = await executor.execute("async () => 42", []);
  if (outcome.result !== 42 || outcome.error) {
    throw new Error("packed QuickJS child execution failed: " + JSON.stringify(outcome));
  }
} finally {
  await executor.close();
}
`,
  );
  run(
    npm,
    ["install", "--ignore-scripts", "--omit=optional", archive],
    work,
  );
  const installedBin = join(
    work,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "connecta.cmd" : "connecta",
  );
  run(installedBin, ["init", "generated-deployment"], work);
  expectFailure(
    installedBin,
    ["init", "generated-deployment"],
    work,
    "Refusing to overwrite existing path",
  );
  const generatedPackage = JSON.parse(
    await readFile(join(work, "generated-deployment", "package.json"), "utf8"),
  );
  if (
    generatedPackage.dependencies?.["@zackbart/connecta"] !==
    packed.version
  ) {
    throw new Error("Initializer did not pin the packed Connecta version");
  }
  for (const generated of [
    ".env.example",
    ".gitignore",
    "AGENTS.md",
    "CLAUDE.md",
    "src/index.ts",
    "tsconfig.json",
  ]) {
    if (!existsSync(join(work, "generated-deployment", generated))) {
      throw new Error(`Initializer is missing ${generated}`);
    }
  }
  if (
    process.platform !== "win32" &&
    !(await lstat(
      join(work, "generated-deployment", "CLAUDE.md"),
    )).isSymbolicLink()
  ) {
    throw new Error("Initializer did not link CLAUDE.md to AGENTS.md");
  }

  // Substitute the tarball under test for the registry pin, then exercise the
  // generated deployment exactly as a consumer would.
  generatedPackage.dependencies["@zackbart/connecta"] = `file:${archive}`;
  await writeFile(
    join(work, "generated-deployment", "package.json"),
    JSON.stringify(generatedPackage, null, 2) + "\n",
  );
  const generatedRoot = join(work, "generated-deployment");
  run(npm, ["install", "--ignore-scripts"], generatedRoot);
  run(npm, ["run", "typecheck"], generatedRoot);
  const generatedTsx = join(
    generatedRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );
  expectFailure(
    generatedTsx,
    ["src/index.ts"],
    generatedRoot,
    "CONNECTA_TOKEN is required",
  );
  const generatedSource = await readFile(
    join(generatedRoot, "src", "index.ts"),
    "utf8",
  );
  const executorLine = "  executor: quickJsExecutor(),\n";
  if (!generatedSource.includes(executorLine)) {
    throw new Error("Generated deployment is missing its required executor");
  }
  await writeFile(
    join(generatedRoot, "src", "no-executor.ts"),
    generatedSource.replace(executorLine, ""),
  );
  expectFailure(
    generatedTsx,
    ["src/no-executor.ts"],
    generatedRoot,
    "ConnectaConfig.executor is required",
    { CONNECTA_TOKEN: "package-smoke-token" },
  );
  await writeFile(
    join(generatedRoot, "src", "removed-surface.ts"),
    generatedSource.replace(
      "const connecta = createConnecta({\n",
      'const connecta = createConnecta({\n  surface: "classic",\n',
    ),
  );
  expectFailure(
    generatedTsx,
    ["src/removed-surface.ts"],
    generatedRoot,
    "ConnectaConfig.surface was removed in issue #273",
    { CONNECTA_TOKEN: "package-smoke-token" },
  );

  const port = await freePort();
  const smokeToken = "package-smoke-token";
  let serverOutput = "";
  const deployment = spawn(generatedTsx, ["src/index.ts"], {
    cwd: generatedRoot,
    env: {
      ...process.env,
      CONNECTA_TOKEN: smokeToken,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const retainOutput = (chunk) => {
    serverOutput = (serverOutput + chunk.toString()).slice(-8_000);
  };
  deployment.stdout.on("data", retainOutput);
  deployment.stderr.on("data", retainOutput);
  try {
    await waitForHealth(
      `http://127.0.0.1:${port}/health`,
      deployment,
      () => serverOutput,
    );
    const generatedConnecta = join(
      generatedRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "connecta.cmd" : "connecta",
    );
    const doctorOutput = run(
      generatedConnecta,
      ["doctor", "--url", `http://127.0.0.1:${port}`],
      generatedRoot,
      { CONNECTA_TOKEN: smokeToken },
    );
    if (!doctorOutput.includes("QuickJS executed")) {
      throw new Error(`Doctor did not prove execution: ${doctorOutput}`);
    }
  } finally {
    await stopChild(deployment);
  }

  const coreDeclarations = await readFile(
    join(
      work,
      "node_modules",
      "@zackbart",
      "connecta",
      "dist",
      "index.d.ts",
    ),
    "utf8",
  );
  for (const declaration of [
    "export interface ConnectaActivityConfig {",
    "    store: ActivityStore;",
    "    readGate?: ActivityReadGate;",
    "    deploymentId?: string;",
    "export interface ConnectaCredentialsConfig {",
    "    encryptionKey?: string;",
    "export interface ConnectaDiscoveryConfig {",
    "    catalogTtlSeconds?: number;",
    "    persistCatalog?: boolean;",
    "    staleCatalogSeconds?: number;",
    "    probeTimeoutMs?: number;",
    "export interface ConnectaCallsConfig {",
    "    defaultTimeoutMs?: number;",
    "    maxResultBytes?: number;",
    "    maxBatchResultBytes?: number;",
    "    activity?: ConnectaActivityConfig;",
    "    credentials?: ConnectaCredentialsConfig;",
    "    discovery?: ConnectaDiscoveryConfig;",
    "    calls?: ConnectaCallsConfig;",
    "    close: () => Promise<void>;",
    "AdmittingExecutor,",
    "ExecutorLease,",
  ]) {
    if (!coreDeclarations.includes(declaration)) {
      throw new Error(
        `Packed core declarations are missing: ${declaration.trim()}`,
      );
    }
  }
  for (const removedDeclaration of [
    "health?: CredentialHealthConfig",
    "checkCredentials:",
    "CredentialCheckResult",
    "CredentialHealthConfig",
    "CredentialHealthRecord",
  ]) {
    if (coreDeclarations.includes(removedDeclaration)) {
      throw new Error(
        `Packed core declarations still expose removed credential liveness API: ${removedDeclaration}`,
      );
    }
  }
  const publicConfigStart = coreDeclarations.indexOf(
    "export interface ConnectaConfig {",
  );
  const connectaStart = coreDeclarations.indexOf("export interface Connecta {");
  if (publicConfigStart < 0 || connectaStart <= publicConfigStart) {
    throw new Error("Packed core declarations are missing ConnectaConfig");
  }
  const publicConfig = coreDeclarations.slice(
    publicConfigStart,
    connectaStart,
  );
  const typeDeclarations = await readFile(
    join(
      work,
      "node_modules",
      "@zackbart",
      "connecta",
      "dist",
      "types.d.ts",
    ),
    "utf8",
  );
  for (const declaration of [
    "export interface AdmittingExecutor extends Executor {",
    "export interface ExecutorLease {",
  ]) {
    if (!typeDeclarations.includes(declaration)) {
      throw new Error(
        `Packed executor declarations are missing: ${declaration}`,
      );
    }
  }
  for (const legacyName of [
    "activityReadGate",
    "activityDeploymentId",
    "credentialEncryptionKey",
    "credentialHealth",
    "toolCacheTtlSeconds",
    "persistToolCatalog",
    "toolCatalogStaleSeconds",
    "probeTimeoutMs",
    "defaultToolTimeoutMs",
    "maxResultBytes",
    "surface",
  ]) {
    if (new RegExp(`^\\s+${legacyName}\\??:`, "m").test(publicConfig)) {
      throw new Error(
        `Packed ConnectaConfig still exposes legacy field ${legacyName}`,
      );
    }
  }
  if (!/^\s+executor: Executor;/m.test(publicConfig)) {
    throw new Error("Packed ConnectaConfig does not require executor");
  }
  for (const dependency of ["@clerk/backend", "quickjs-emscripten"]) {
    if (existsSync(join(work, "node_modules", dependency))) {
      throw new Error(`Optional peer ${dependency} was installed with core`);
    }
  }
  run(process.execPath, ["smoke.mjs"], work);

  run(
    npm,
    [
      "install",
      "--ignore-scripts",
      "@clerk/backend@^3.12.0",
      "quickjs-emscripten@^0.32.0",
    ],
    work,
  );
  run(process.execPath, ["optional.mjs"], work);

  console.log(
    `package smoke passed (${packed.entryCount} files, ${packed.size} bytes)`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
