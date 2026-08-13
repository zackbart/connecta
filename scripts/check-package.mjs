import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import {
  copyFile,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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

function dockerReady() {
  for (const args of [["compose", "version"], ["info"]]) {
    const probe = spawnSync("docker", args, {
      stdio: "ignore",
      timeout: 60_000,
    });
    if (probe.error || probe.status !== 0) return false;
  }
  return true;
}

async function waitForContainerHealth(url, timeoutMs, describe) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The container is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `Generated container did not become healthy within ${timeoutMs}ms:\n` +
      describe(),
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
    "bin/connecta.mjs",
    "documentation/code-mode.md",
    "ethos.md",
    "templates/node/.dockerignore",
    "templates/node/.env.example",
    "templates/node/AGENTS.md",
    "templates/node/Dockerfile",
    "templates/node/docker-compose.yml",
    "templates/node/package.json",
    "templates/node/src/index.ts",
    "templates/node/src/file-activity.ts",
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
    "dist/providers/mixpanel.js",
    "dist/providers/mixpanel.d.ts",
    "dist/providers/linear.js",
    "dist/providers/linear.d.ts",
    "dist/providers/notion.js",
    "dist/providers/notion.d.ts",
    "dist/providers/stripe.js",
    "dist/providers/stripe.d.ts",
    "dist/providers/cloudflare.js",
    "dist/providers/cloudflare.d.ts",
  ]) {
    if (!paths.has(required)) {
      throw new Error(`Packed artifact is missing ${required}`);
    }
  }
  for (const path of paths) {
    if (path.startsWith("eval/")) {
      throw new Error(`Eval-only file leaked into the package: ${path}`);
    }
    // The tarball is built output, not a checkout (#346). `exports` resolves
    // only into dist/, so src/ served nothing but the source and declaration
    // maps that pointed back at it — and both went with it. A packed .map is
    // therefore either dangling or a sign the build config drifted back.
    if (path.startsWith("src/") || path.endsWith(".map")) {
      throw new Error(`Source-only artifact leaked into the package: ${path}`);
    }
    // The hero image is 230 KB of README decoration. npmjs.com resolves the
    // README's relative image path against the repository, so the package page
    // still renders it without every install paying for it (#346).
    if (path.startsWith("assets/")) {
      throw new Error(`README-only asset leaked into the package: ${path}`);
    }
    // Two deployment shapes, no third: the Node one is the template (Docker
    // files included), the Worker one is the example. A packed examples/node
    // or examples/docker means a redundant scaffold grew back (#344).
    if (
      path.startsWith("examples/node/") ||
      path.startsWith("examples/docker/")
    ) {
      throw new Error(`Redundant deployment scaffold leaked into ${path}`);
    }
    if (
      path.includes("connectors/cloudflare") ||
      path.includes("storage/cloudflare")
    ) {
      throw new Error(`Platform-specific implementation leaked into ${path}`);
    }
  }
  // A stub guide says "the prior text lives in git history" — advice a package
  // consumer cannot take, because they have no history. Placeholders stay out
  // of the tarball (#346). That makes the `!documentation/...` negations in
  // `files` a list that rots, so derive the expected set from the guides
  // themselves: a stub that ships and a finished guide that does not are both
  // failures, and filling a stub in is what un-excludes it.
  for (const guide of await readdir(join(root, "documentation"))) {
    if (!guide.endsWith(".md")) continue;
    const stub = (
      await readFile(join(root, "documentation", guide), "utf8")
    ).includes("> **Stub.**");
    const packedGuide = paths.has(`documentation/${guide}`);
    if (stub && packedGuide) {
      throw new Error(
        `Placeholder guide documentation/${guide} is packed; add ` +
          `"!documentation/${guide}" to package.json "files"`,
      );
    }
    if (!stub && !packedGuide) {
      throw new Error(
        `documentation/${guide} is a written guide but is excluded from the ` +
          `package; drop "!documentation/${guide}" from package.json "files"`,
      );
    }
  }
  // Deriving the shipped set from the stub markers says which guides ship, not
  // whether the ones that ship point somewhere a consumer can follow. A packed
  // doc linking an excluded guide is the same defect one indirection out — the
  // reader clicks and lands nowhere (#346). Scoped to `documentation/` targets:
  // that is the set this exclusion list moves, and the pointers into `eval/`,
  // `test/`, and `scripts/` are repository references that predate it.
  for (const packedPath of paths) {
    if (!packedPath.endsWith(".md")) continue;
    // Release notes quote the paths that existed when they shipped; they are a
    // record, not a live pointer, which is why `check:docs` exempts them too.
    if (packedPath === "CHANGELOG.md") continue;
    const source = await readFile(join(root, packedPath), "utf8");
    const from = dirname(packedPath);
    for (const [, target] of source.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) {
        continue;
      }
      const [relativePath] = target.split("#");
      if (!relativePath) continue;
      const resolved = join(from, relativePath).split("\\").join("/");
      if (!resolved.startsWith("documentation/")) continue;
      // A trailing slash points at the directory, which the tarball carries so
      // long as anything under it ships.
      const carried = resolved.endsWith("/")
        ? [...paths].some((candidate) => candidate.startsWith(resolved))
        : paths.has(resolved);
      if (!carried) {
        throw new Error(
          `Packed ${packedPath} links "${target}", which resolves to ` +
            `${resolved} — a path the tarball does not carry`,
        );
      }
    }
  }
  await writeFile(
    join(work, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await writeFile(
    join(work, "smoke.mjs"),
    `
import { createRequire } from "node:module";

// Resolving the installed manifest is what bundler plugins and version probes
// do; without a "./package.json" entry in the exports map this throws
// ERR_PACKAGE_PATH_NOT_EXPORTED (#374).
const manifest = createRequire(import.meta.url)("@zackbart/connecta/package.json");
if (manifest.name !== "@zackbart/connecta") {
  throw new Error("resolving the installed manifest did not yield the manifest");
}
const core = await import("@zackbart/connecta");
if (typeof core.createConnecta !== "function") throw new Error("missing core");
if (typeof core.validateToolInput !== "function") {
  throw new Error("missing validateToolInput");
}
const jsonSchema = await import("@zackbart/connecta/json-schema");
if (typeof jsonSchema.Validator !== "function") {
  throw new Error("missing Validator re-export");
}
const mixpanelProvider = await import("@zackbart/connecta/providers/mixpanel");
if (typeof mixpanelProvider.mixpanel !== "function") {
  throw new Error("missing Mixpanel provider constructor");
}
const mixpanelConnection = mixpanelProvider.mixpanel("analytics", {
  purpose: "package smoke",
});
if (mixpanelConnection.id !== "analytics") {
  throw new Error("Mixpanel provider did not return a connector");
}
const stripeProvider = await import("@zackbart/connecta/providers/stripe");
if (typeof stripeProvider.stripe !== "function") {
  throw new Error("missing Stripe provider constructor");
}
const stripeConnection = stripeProvider.stripe("payments", {
  mode: "sandbox",
  purpose: "package smoke",
});
if (stripeConnection.id !== "payments") {
  throw new Error("Stripe provider did not return a connector");
}
const linearProvider = await import("@zackbart/connecta/providers/linear");
if (typeof linearProvider.linear !== "function") {
  throw new Error("missing Linear provider constructor");
}
// access is required and has no default -- omitting it throws at construction
// (#342), so the smoke declares one the way a deployment must.
const linearConnection = linearProvider.linear("tracker", {
  access: "read-write",
  purpose: "package smoke",
});
if (linearConnection.id !== "tracker") {
  throw new Error("Linear provider did not return a connector");
}
if (
  linearProvider.LINEAR_MCP_ENDPOINTS["read-only"] !==
  "https://mcp.linear.app/mcp/readonly"
) {
  throw new Error("Linear read-only endpoint drifted");
}
const notionProvider = await import("@zackbart/connecta/providers/notion");
if (typeof notionProvider.notion !== "function") {
  throw new Error("missing Notion provider constructor");
}
const notionConnection = notionProvider.notion("workspace", {
  purpose: "package smoke",
});
if (notionConnection.id !== "workspace") {
  throw new Error("Notion provider did not return a connector");
}
if (notionConnection.kind !== "api") {
  throw new Error("Notion provider is not an api() connector");
}
if (!notionConnection.staticTools?.length) {
  throw new Error("Notion provider published no tools");
}
const cloudflareProvider = await import(
  "@zackbart/connecta/providers/cloudflare"
);
if (typeof cloudflareProvider.cloudflare !== "function") {
  throw new Error("missing Cloudflare provider constructor");
}
const cloudflareConnection = cloudflareProvider.cloudflare("edge", {
  purpose: "package smoke",
});
if (cloudflareConnection.id !== "edge") {
  throw new Error("Cloudflare provider did not return a connector");
}
for (const name of [
  "clerkAuth",
  "cloudflareApi",
  "cloudflareKvStorage",
  "d1ActivityStore",
  "quickJsExecutor",
  "mixpanel",
  "MIXPANEL_MCP_ENDPOINTS",
  "stripe",
  "STRIPE_MCP_ENDPOINT",
  "linear",
  "LINEAR_MCP_ENDPOINTS",
  "notion",
  "NOTION_API_VERSION",
  "NOTION_API_BASE_URL",
  "cloudflare",
  "CLOUDFLARE_API_BASE",
  "CLOUDFLARE_DNS_RECORD_TYPES",
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
    "src/file-activity.ts",
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
  // Strip the comment with the line it annotates; leaving it orphaned above a
  // deleted executor would make the fixture read as a deliberate omission.
  const executorLine =
    "  // Required: model-written programs run in a bounded QuickJS child.\n" +
    "  executor: quickJsExecutor(),\n";
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
  const createCall = "const connecta = createConnecta({\n";
  if (!generatedSource.includes(createCall)) {
    throw new Error(
      "Generated deployment no longer opens createConnecta on its own line; " +
        "the removed-surface fixture cannot be built",
    );
  }
  await writeFile(
    join(generatedRoot, "src", "removed-surface.ts"),
    generatedSource.replace(
      createCall,
      `${createCall}  surface: "classic",\n`,
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

  // The generated deployment is also the container: `connecta init` ships the
  // Dockerfile and Compose file, so the source that just answered over tsx has
  // to answer again from `docker compose up` (#344). Docker is not a
  // prerequisite for running a release check on a laptop, but CI has it and
  // must not quietly skip the shape it is verifying.
  if (!dockerReady()) {
    if (process.env.CI) {
      throw new Error(
        "Docker is unavailable, so the generated container went untested. " +
          "CI must exercise `connecta init` + `docker compose up`.",
      );
    }
    console.log(
      "package smoke: Docker unavailable — skipped the generated-container check",
    );
  } else {
    await copyFile(archive, join(generatedRoot, packed.filename));
    generatedPackage.dependencies["@zackbart/connecta"] =
      `file:./${packed.filename}`;
    await writeFile(
      join(generatedRoot, "package.json"),
      JSON.stringify(generatedPackage, null, 2) + "\n",
    );
    // `connecta init` leaves no lockfile, and the local install above wrote one
    // pinned to a tarball outside the build context. Remove it so the image
    // resolves exactly what a freshly initialized project resolves.
    await rm(join(generatedRoot, "package-lock.json"), { force: true });
    // The pin now points at a tarball that is not on the registry yet, so the
    // build context has to carry it — the same substitution the local run
    // above makes, one line earlier in the image. Everything else about the
    // shipped Dockerfile is exercised unmodified.
    const dockerfilePath = join(generatedRoot, "Dockerfile");
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const manifestCopy = "COPY package.json package-lock.json* ./\n";
    if (!dockerfile.includes(manifestCopy)) {
      throw new Error(
        "Template Dockerfile no longer copies the manifest before installing; " +
          "the container smoke fixture cannot be built",
      );
    }
    await writeFile(
      dockerfilePath,
      dockerfile.replace(
        manifestCopy,
        `COPY ${packed.filename} ./\n${manifestCopy}`,
      ),
    );

    const containerPort = await freePort();
    const compose = ["compose", "-p", `connecta-smoke-${process.pid}`];
    const composeEnv = {
      CONNECTA_TOKEN: smokeToken,
      PORT: String(containerPort),
    };
    const composeLogs = () => {
      const logs = spawnSync(
        "docker",
        [...compose, "logs", "--no-color", "--tail", "200"],
        {
          cwd: generatedRoot,
          encoding: "utf8",
          env: { ...process.env, ...composeEnv },
        },
      );
      return `${logs.stdout ?? ""}\n${logs.stderr ?? ""}`;
    };
    try {
      run("docker", [...compose, "up", "-d", "--build"], generatedRoot, composeEnv);
      await waitForContainerHealth(
        `http://127.0.0.1:${containerPort}/health`,
        120_000,
        composeLogs,
      );
      const containerDoctor = run(
        join(
          generatedRoot,
          "node_modules",
          ".bin",
          process.platform === "win32" ? "connecta.cmd" : "connecta",
        ),
        ["doctor", "--url", `http://127.0.0.1:${containerPort}`],
        generatedRoot,
        { CONNECTA_TOKEN: smokeToken },
      );
      if (!containerDoctor.includes("QuickJS executed")) {
        throw new Error(
          `Containerized deployment did not prove execution: ${containerDoctor}`,
        );
      }
    } finally {
      spawnSync("docker", [...compose, "down", "-v", "--remove-orphans"], {
        cwd: generatedRoot,
        stdio: "inherit",
        env: { ...process.env, ...composeEnv },
      });
    }
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
  // The Cloudflare connection is hand-written fetch, not an SDK wrapper: the
  // provider SDK must be absent even as a transitive install, and smoke.mjs
  // still constructs the connector below.
  if (existsSync(join(work, "node_modules", "cloudflare"))) {
    throw new Error("Cloudflare SDK was installed with the package");
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
