import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = await mkdtemp(join(tmpdir(), "connecta-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
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
    "README.md",
    "LICENSE",
    "assets/connecta-clay-hero.png",
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
  ]) {
    if (new RegExp(`^\\s+${legacyName}\\??:`, "m").test(publicConfig)) {
      throw new Error(
        `Packed ConnectaConfig still exposes legacy field ${legacyName}`,
      );
    }
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
