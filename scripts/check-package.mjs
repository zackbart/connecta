import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { copyFile, lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getPlatformProxy } from "wrangler";
import { discoverProviders } from "./providers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const providers = await discoverProviders(root);
const work = await mkdtemp(join(tmpdir(), "connecta-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const templateManifest = JSON.parse(await readFile(join(root, "templates", "node", "package.json"), "utf8"));

/** Exercise the packed adapters, including absolute CAS insert and update. */
async function checkAbsoluteExpiry(storage) {
  if (storage.capabilities?.absoluteExpiry !== true) throw new Error("missing absoluteExpiry capability");
  const future = Date.now() + 60_000;
  const past = Date.now() - 60_000;
  await storage.set("absolute-set", "live", { expiresAtMs: future });
  if ((await storage.get("absolute-set")) !== "live") throw new Error("absolute set lost a live value");
  if (!(await storage.compareAndSet("absolute-cas-insert", null, "live", { expiresAtMs: future }))) {
    throw new Error("absolute CAS insert failed");
  }
  await storage.set("absolute-cas-update", "old");
  if (!(await storage.compareAndSet("absolute-cas-update", "old", "live", { expiresAtMs: future }))) {
    throw new Error("absolute CAS update failed");
  }
  if ((await storage.get("absolute-cas-insert")) !== "live" || (await storage.get("absolute-cas-update")) !== "live") {
    throw new Error("absolute CAS lost a live value");
  }
  await storage.set("expired-set", "dead", { expiresAtMs: past });
  if ((await storage.get("expired-set")) !== null) throw new Error("absolute set ignored its expiry");
  if (
    !(await storage.compareAndSet("expired-cas", null, "dead", { expiresAtMs: past })) ||
    (await storage.get("expired-cas")) !== null
  )
    throw new Error("absolute CAS insert ignored its expiry");
  await storage.set("expired-cas", "old");
  if (
    !(await storage.compareAndSet("expired-cas", "old", "dead", { expiresAtMs: past })) ||
    (await storage.get("expired-cas")) !== null
  )
    throw new Error("absolute CAS update ignored its expiry");
  return future;
}

if (templateManifest.dependencies?.["@zackbart/connecta"] !== rootManifest.version) {
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

async function assertInstallScriptsApproved(directory, manifest) {
  const lock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8"));
  const approvals = manifest.allowScripts ?? {};
  const unapproved = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path || !entry?.hasInstallScript) continue;
    const installedManifestPath = join(directory, path, "package.json");
    // Lockfiles retain optional packages for every platform. A package npm did
    // not install here cannot run a script here and has no manifest to inspect.
    if (!existsSync(installedManifestPath)) continue;
    const installedManifest = JSON.parse(await readFile(installedManifestPath, "utf8"));
    const declaresInstallScript = ["preinstall", "install", "postinstall"].some(
      (name) => typeof installedManifest.scripts?.[name] === "string",
    );
    if (!declaresInstallScript) continue;
    const marker = "node_modules/";
    const offset = path.lastIndexOf(marker);
    if (offset < 0 || typeof entry.version !== "string") {
      unapproved.push(path);
      continue;
    }
    const name = path.slice(offset + marker.length);
    if (approvals[`${name}@${entry.version}`] !== true) {
      unapproved.push(`${name}@${entry.version}`);
    }
  }
  if (unapproved.length) {
    throw new Error(`Node template has unapproved install scripts: ${unapproved.join(", ")}`);
  }
}

function expectFailure(command, args, cwd, expected, env = {}, timeout = 10_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    timeout,
    killSignal: "SIGKILL",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error || result.signal || result.status === 0 || !output.includes(expected)) {
    throw new Error(
      `Expected command failure containing ${JSON.stringify(expected)}; ` +
        `status=${String(result.status)} signal=${String(result.signal)} ` +
        `error=${String(result.error)} output=${output.slice(-2_000)}`,
    );
  }
}

// Release-order comparison over `major.minor.patch`, which is all the peer
// ranges and the registry's version list need.
function compareVersions(left, right) {
  const parse = (value) => value.split("-")[0].split(".").map(Number);
  const [a, b] = [parse(left), parse(right)];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
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
  await new Promise((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
  return address.port;
}

async function waitForHealth(url, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Generated deployment exited before health was ready:\n${output()}`);
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
  throw new Error(`Generated deployment did not become healthy within 15s:\n${output()}`);
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
  throw new Error(`Generated container did not become healthy within ${timeoutMs}ms:\n` + describe());
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
  const packed = JSON.parse(run(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", work], root))[0];
  const archive = join(work, packed.filename);
  const paths = new Set(packed.files.map((file) => file.path));
  // The generated operator UI bundle is an internal string constant no export
  // reaches, so the build prunes its declaration with every other unreachable
  // one (scripts/prune-declarations.mjs). Packed, it means pruning stopped.
  if (paths.has("dist/operator-ui/generated.d.ts")) {
    throw new Error(
      "Packed package ships dist/operator-ui/generated.d.ts; the build " + "should have pruned it as unreachable",
    );
  }

  for (const excluded of ["AGENTS.md", "CLAUDE.md", "PRINCIPLES.md"]) {
    if (paths.has(excluded)) {
      throw new Error(`Packed package ships repository-only ${excluded}`);
    }
  }

  for (const required of [
    "README.md",
    "LICENSE",
    "bin/connecta.mjs",
    "bin/version.mjs",
    "documentation/code-mode.md",
    "templates/node/.dockerignore",
    "templates/node/.env.example",
    "templates/node/AGENTS.md",
    "templates/node/Dockerfile",
    "templates/node/docker-compose.yml",
    "templates/node/package.json",
    "templates/node/src/index.ts",
    "templates/node/src/connecta.config.ts",
    "templates/node/src/provision-token.ts",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/types.d.ts",
    "dist/json-schema.js",
    "dist/json-schema.d.ts",
    "dist/executors/quickjs.js",
    "dist/executors/quickjs.d.ts",
    "dist/worker.js",
    "dist/worker.d.ts",
    "dist/executors/quickjs-child.js",
    "dist/executors/quickjs-protocol.js",
    "dist/executors/quickjs-runtime.js",
    "dist/auth/cloudflare-access.js",
    "dist/auth/cloudflare-access.d.ts",
    ...providers.flatMap(({ name }) => [`dist/providers/${name}/index.js`, `dist/providers/${name}/index.d.ts`]),
    "dist/d1.js",
    "dist/d1.d.ts",
    "dist/sqlite.js",
    "dist/sqlite.d.ts",
    "dist/storage/sql.js",
    "dist/storage/keys.js",
  ]) {
    if (!paths.has(required)) {
      throw new Error(`Packed package is missing ${required}`);
    }
  }
  for (const path of paths) {
    // The tarball is built output, not a checkout (#346). No code export
    // leaves dist/ — only the manifest data export resolves to the package
    // root (#374) — so src/ served nothing but the source and declaration
    // maps that pointed back at it, and both went with it. A packed .map is
    // therefore either dangling or a sign the build config drifted back.
    if (
      path.startsWith("src/") ||
      path.endsWith(".map") ||
      /(?:^|\/)(?:fixtures|provider\.test|provider\.node\.test)\.(?:js|d\.ts)$/.test(path) ||
      path.endsWith("provider-smoke.generated.mjs")
    ) {
      throw new Error(`Source-only file leaked into the package: ${path}`);
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
    if (path.startsWith("examples/node/") || path.startsWith("examples/docker/")) {
      throw new Error(`Redundant deployment scaffold leaked into ${path}`);
    }
    // A Cloudflare-named connector or storage path fails anywhere in the
    // package, `dist/` and `examples/` alike (#377). The supported platform
    // storage is the explicit `/d1` and `/sqlite` subpaths; Workers KV is no
    // longer supported, so no KV adapter may grow back under either tree.
    if (
      path.includes("connectors/cloudflare") ||
      path.includes("storage/cloudflare") ||
      path.includes("cloudflare-kv") ||
      path.includes("storage/file")
    ) {
      throw new Error(`Platform-specific implementation leaked into ${path}`);
    }
  }
  // Every guide that exists ships. A `!documentation/...` negation in `files`
  // is how one silently stops shipping, and an excluded guide is worse than a
  // missing one: the guides that do ship link to it, and a consumer has no git
  // history to recover it from (#346).
  for (const guide of await readdir(join(root, "documentation"))) {
    if (!guide.endsWith(".md")) continue;
    if (!paths.has(`documentation/${guide}`)) {
      throw new Error(
        `documentation/${guide} is excluded from the package; drop ` +
          `"!documentation/${guide}" from package.json "files"`,
      );
    }
  }
  // Knowing which guides ship is not knowing whether the ones that ship point
  // somewhere a consumer can follow. A packed doc linking an unpacked file is
  // the same defect one indirection out — the reader clicks and lands nowhere
  // (#346) — and so is one linking `test/`, `scripts/`, or the README hero,
  // none of which the tarball carries (#378). The rule those all answer to
  // lives in check-doc-links --packed
  // and reads the same packed list this pack just produced; a link the tarball
  // cannot satisfy either ships its target or becomes a github.com URL.
  const packedManifest = join(work, "packed-paths.txt");
  await writeFile(packedManifest, [...paths].join("\n"));
  run(
    process.execPath,
    [join(root, "scripts", "check-doc-links.mjs"), "--packed", "--root", root, "--files", packedManifest],
    root,
  );
  await writeFile(join(work, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await copyFile(join(root, "scripts", "provider-smoke.generated.mjs"), join(work, "provider-smoke.generated.mjs"));
  await writeFile(join(work, "storage-smoke.mjs"), `export ${checkAbsoluteExpiry.toString()}\n`);
  await writeFile(
    join(work, "smoke.mjs"),
    `
import { createRequire } from "node:module";
import { checkAbsoluteExpiry } from "./storage-smoke.mjs";

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
const tokenModule = await import("@zackbart/connecta/auth/access-tokens");
if (typeof tokenModule.accessTokens !== "function") throw new Error("missing managed-token module");
if ("accessTokens" in core || "AccessTokenManager" in core) throw new Error("token implementation leaked into core");
const d1Module = await import("@zackbart/connecta/d1");
if (typeof d1Module.d1Storage !== "function" || typeof d1Module.d1ActivityStore !== "function") {
  throw new Error("missing D1 storage adapters");
}
const sqliteModule = await import("@zackbart/connecta/sqlite");
const smokeDb = sqliteModule.openSqlite(":memory:");
const smokeStorage = sqliteModule.sqliteStorage(smokeDb);
if (!(await smokeStorage.compareAndSet("smoke", null, "1")) ||
    (await smokeStorage.compareAndSet("smoke", null, "2")) ||
    (await smokeStorage.get("smoke")) !== "1") {
  throw new Error("packed sqliteStorage did not compare-and-set");
}
const sqliteExpiry = await checkAbsoluteExpiry(smokeStorage);
const sqliteRows = smokeDb.prepare("SELECT expires_at_ms FROM connecta_kv WHERE key LIKE 'absolute-%'").all();
if (sqliteRows.length !== 3 || sqliteRows.some((row) => row.expires_at_ms !== sqliteExpiry)) {
  throw new Error("packed sqliteStorage did not store exact absolute set/CAS expiries");
}
await checkAbsoluteExpiry(core.memoryStorage());
const { capabilities, ...legacy } = smokeStorage;
const executor = core.customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });
let legacyRejected = false;
try { core.createConnecta({ connectors: [], executor, storage: legacy }); }
catch (error) { legacyRejected = error.message.includes("capabilities.absoluteExpiry: true"); }
if (!legacyRejected) throw new Error("packed createConnecta accepted legacy storage");
smokeDb.close();
const jsonSchema = await import("@zackbart/connecta/json-schema");
if (typeof jsonSchema.Validator !== "function") {
  throw new Error("missing Validator re-export");
}
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("provider fixture construction attempted network access"); };
try {
  const { fixtures } = await import("./provider-smoke.generated.mjs");
  const providerNames = Object.keys(manifest.exports)
    .filter((key) => key.startsWith("./providers/"))
    .map((key) => key.slice("./providers/".length)).sort();
  if (JSON.stringify(fixtures.map((fixture) => fixture.name).sort()) !== JSON.stringify(providerNames)) {
    throw new Error("packed provider exports and smoke fixtures disagree");
  }
  for (const fixture of fixtures) {
    if (typeof fixture.create !== "function" || !Array.isArray(fixture.cases) || !fixture.cases.length) {
      throw new Error(fixture.name + " needs construction smoke cases");
    }
    const providerModule = await import("@zackbart/connecta/providers/" + fixture.name);
    for (const symbol of Object.keys(providerModule)) {
      if (symbol in core) throw new Error(symbol + " from " + fixture.name + " leaked into the core entry");
    }
    for (const testCase of fixture.cases) {
      const id = "smoke-" + fixture.name;
      const connector = fixture.create(id, testCase.options);
      if (connector.id !== id || !["api", "mcp"].includes(connector.kind)) {
        throw new Error(fixture.name + " fixture did not construct a connector: " + testCase.label);
      }
      if (connector.kind === "api" && !connector.staticTools?.length) {
        throw new Error(fixture.name + " published no API tools");
      }
      if (fixture.conventions?.auth === "oauth" && typeof connector.startAuth !== "function") {
        throw new Error(fixture.name + " published no OAuth grant");
      }
      await fixture.assertSmoke?.(connector, providerModule);
    }
  }
} finally {
  globalThis.fetch = originalFetch;
}
for (const name of [
  "clerkAuth",
  "cloudflareApi",
  "cloudflareKvStorage",
  "fileStorage",
  "d1Storage",
  "d1ActivityStore",
  "sqliteStorage",
  "sqliteActivityStore",
  "openSqlite",
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
const { signJwt } = await import("@clerk/backend/jwt");
const access = await import("@zackbart/connecta/auth/cloudflare-access");
const quickjs = await import("@zackbart/connecta/quickjs");
if (typeof clerk.clerkAuth !== "function") throw new Error("missing Clerk adapter");
if (typeof access.cloudflareAccessAuth !== "function") throw new Error("missing Cloudflare Access adapter");
if (typeof quickjs.quickJsExecutor !== "function") throw new Error("missing QuickJS adapter");
// A consumer's newer Clerk version must install and authenticate through the
// bundled client. Native readers throw so using the installed SDK fails here.
const pair = await crypto.subtle.generateKey({
  name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
}, true, ["sign", "verify"]);
const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
const base = "https://connecta.test";
const frontend = "https://clerk.example.com";
const kid = crypto.randomUUID();
const now = Math.floor(Date.now() / 1000);
const token = await signJwt({
  sub: "user_package", sid: "sess_package", iss: frontend, azp: base,
  exp: now + 300, nbf: now - 5,
}, privateKey, { algorithm: "RS256", header: { typ: "JWT", kid } });
const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (input) => {
  const url = String(input);
  calls.push(url);
  let response;
  if (url === "https://api.clerk.com/v1/jwks") {
    response = new Response(JSON.stringify({ keys: [{ ...publicKey, kid, alg: "RS256", use: "sig" }] }), {
      headers: { "Content-Type": "application/connecta-package-sentinel" },
    });
  } else if (url === "https://api.clerk.com/v1/users/user_package") {
    response = Response.json({
      object: "user", id: "user_package", first_name: "Ada", last_name: "Lovelace",
      primary_email_address_id: "email_package", username: null,
      email_addresses: [{ object: "email_address", id: "email_package", email_address: "ada@example.com", linked_to: [], verification: { status: "verified" } }],
      phone_numbers: [], web3_wallets: [], external_accounts: [],
    });
  } else {
    throw new Error("Unexpected packed Clerk request: " + url);
  }
  response.json = response.text = () => { throw new Error("Native Clerk body reader used"); };
  return response;
};
try {
  const adapter = clerk.clerkAuth({
    publishableKey: "pk_test_" + btoa("clerk.example.com$"), secretKey: "sk_test_fake", publicUrl: base,
    gate: async (id, client) => {
      const user = await client.users.getUser(id);
      return user.id === id && user.fullName === "Ada Lovelace" &&
        user.emailAddresses[0]?.verification?.status === "verified";
    },
  });
  const result = await adapter.authorize(new Request(base + "/connect/service", {
    headers: { Authorization: "Bearer " + token },
  }), base);
  if (!result.ok || result.userId !== "user_package" || calls.length !== 2) {
    throw new Error("Packed bundled Clerk authentication or gate lookup failed");
  }
  // Exercise the consumer's JWT decoder too, after bundled OAuth verification.
  for (const [aud, accepted] of [[base + "/mcp", true], ["https://other.test/mcp", false]]) {
    const oauthToken = await signJwt({
      sub: "user_package", iss: frontend, client_id: "client_package",
      scope: "openid profile email", iat: now, exp: now + 300, aud,
    }, privateKey, { algorithm: "RS256", header: { typ: "at+jwt", kid } });
    const oauthResult = await adapter.authorize(new Request(base + "/mcp", {
      headers: { Authorization: "Bearer " + oauthToken },
    }), base);
    if (oauthResult.ok !== accepted) throw new Error("Packed Clerk OAuth audience check failed");
  }
} finally {
  globalThis.fetch = originalFetch;
}
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
  run(npm, ["install", "--ignore-scripts", "--omit=optional", archive], work);
  // The declarations a consumer compiles against, as installed: no Effect
  // type anywhere under dist/, reachable or not, and nothing left unpruned.
  run(
    process.execPath,
    [join(root, "scripts", "check-declarations.mjs"), "--dist", join(work, "node_modules", "@zackbart", "connecta")],
    root,
  );
  for (const declaration of ["auth/clerk.d.ts", "auth/clerk-sdk/client.d.ts"]) {
    const source = await readFile(join(work, "node_modules", "@zackbart", "connecta", "dist", declaration), "utf8");
    if (source.includes("@clerk/")) {
      throw new Error("Packed gate declarations reference consumer Clerk types: " + declaration);
    }
  }
  // One Effect, inside the declared v4 range. A second copy means two
  // runtimes whose fibers, services, and errors do not recognize each other.
  const effectRange = rootManifest.dependencies?.effect ?? "";
  const installedEffect = JSON.parse(
    await readFile(join(work, "node_modules", "effect", "package.json"), "utf8"),
  ).version;
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(effectRange);
  const installed = /^(\d+)\.(\d+)\.(\d+)$/.exec(installedEffect);
  const satisfies =
    caret &&
    installed &&
    installed[1] === caret[1] &&
    (Number(installed[2]) > Number(caret[2]) ||
      (installed[2] === caret[2] && Number(installed[3]) >= Number(caret[3])));
  if (!satisfies) {
    throw new Error(`Installed effect ${installedEffect} does not satisfy ${effectRange}`);
  }
  const consumerLock = JSON.parse(await readFile(join(work, "package-lock.json"), "utf8"));
  const nestedEffect = Object.keys(consumerLock.packages ?? {}).filter((path) => path.endsWith("/node_modules/effect"));
  if (nestedEffect.length) {
    throw new Error(`A second copy of effect was installed: ${nestedEffect.join(", ")}`);
  }
  const installedBin = join(work, "node_modules", ".bin", process.platform === "win32" ? "connecta.cmd" : "connecta");
  run(installedBin, ["init", "generated-deployment"], work);
  expectFailure(installedBin, ["init", "generated-deployment"], work, "Refusing to overwrite existing path");
  const generatedPackage = JSON.parse(await readFile(join(work, "generated-deployment", "package.json"), "utf8"));
  if (generatedPackage.dependencies?.["@zackbart/connecta"] !== packed.version) {
    throw new Error("Initializer did not pin the packed Connecta version");
  }
  for (const generated of [
    ".env.example",
    ".gitignore",
    "AGENTS.md",
    "CLAUDE.md",
    "src/index.ts",
    "src/connecta.config.ts",
    "src/provision-token.ts",
    "tsconfig.json",
  ]) {
    if (!existsSync(join(work, "generated-deployment", generated))) {
      throw new Error(`Initializer is missing ${generated}`);
    }
  }
  if (
    process.platform !== "win32" &&
    !(await lstat(join(work, "generated-deployment", "CLAUDE.md"))).isSymbolicLink()
  ) {
    throw new Error("Initializer did not link CLAUDE.md to AGENTS.md");
  }

  // Substitute the tarball under test for the registry pin, then exercise the
  // generated deployment exactly as a consumer would.
  generatedPackage.dependencies["@zackbart/connecta"] = `file:${archive}`;
  await writeFile(join(work, "generated-deployment", "package.json"), JSON.stringify(generatedPackage, null, 2) + "\n");
  const generatedRoot = join(work, "generated-deployment");
  run(npm, ["install", "--ignore-scripts"], generatedRoot);
  await assertInstallScriptsApproved(generatedRoot, generatedPackage);
  run(npm, ["run", "typecheck"], generatedRoot);
  // The published configuration contract, compiled the way a consumer
  // compiles it: ConnectaConfig is derived from one schema, so its shape is
  // checked by the type checker rather than by scraping declaration text.
  await writeFile(
    join(generatedRoot, "src", "config-contract.ts"),
    [
      'import { createConnecta, customExecutor, defineConfig, type AdmittingExecutor, type Connecta, type ConnectaCallsConfig, type ConnectaConfig, type ConnectaConfigDescription, type ConnectaDiscoveryConfig, type ExecutorLease, type KVStorage } from "@zackbart/connecta";',
      'const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });',
      "const legacyStorage = { get: async (_key: string) => null, set: async (_key: string, _value: string, _options?: { ttlSeconds?: number }) => {}, delete: async (_key: string) => {}, list: async (_prefix: string) => [], compareAndSet: async (_key: string, _expected: string | null, _next: string | null, _options?: { ttlSeconds?: number }) => true };",
      "// @ts-expect-error legacy storage lacks explicit absolute-expiry support",
      "const legacyAdapter: KVStorage = legacyStorage;",
      "// @ts-expect-error construction requires the capability too",
      "createConnecta({ connectors: [], executor, storage: legacyStorage });",
      "void legacyAdapter;",
      "const discovery: ConnectaDiscoveryConfig = { concurrency: 2, catalogTtlSeconds: 1, catalogMinTtlSeconds: 0, catalogMaxTtlSeconds: 2, probeTimeoutMs: 1 };",
      "// @ts-expect-error registry persistence was retired",
      "const retiredPersistence: ConnectaDiscoveryConfig = { persistCatalog: false };",
      "// @ts-expect-error stale catalogs were retired",
      "const retiredStale: ConnectaDiscoveryConfig = { staleCatalogSeconds: 1 };",
      "void retiredPersistence; void retiredStale;",
      "const calls: ConnectaCallsConfig = { defaultTimeoutMs: 1, maxResultBytes: 1 };",
      "const config: ConnectaConfig = { connectors: [], executor, discovery, calls, vault: undefined, activity: undefined, ui: undefined };",
      "// @ts-expect-error executor is required",
      "const missing: ConnectaConfig = { connectors: [] };",
      "// @ts-expect-error unknown nested option",
      "const typo: ConnectaConfig = { connectors: [], executor, discovery: { concurrncy: 2 } };",
      "// @ts-expect-error legacy top-level activityReadGate",
      "const legacy0: ConnectaConfig = { connectors: [], executor, activityReadGate: 1 };",
      "void legacy0;",
      "// @ts-expect-error legacy top-level activityDeploymentId",
      "const legacy1: ConnectaConfig = { connectors: [], executor, activityDeploymentId: 1 };",
      "void legacy1;",
      "// @ts-expect-error legacy top-level credentialEncryptionKey",
      "const legacy2: ConnectaConfig = { connectors: [], executor, credentialEncryptionKey: 1 };",
      "void legacy2;",
      "// @ts-expect-error legacy top-level credentialHealth",
      "const legacy3: ConnectaConfig = { connectors: [], executor, credentialHealth: 1 };",
      "void legacy3;",
      "// @ts-expect-error legacy top-level toolCacheTtlSeconds",
      "const legacy4: ConnectaConfig = { connectors: [], executor, toolCacheTtlSeconds: 1 };",
      "void legacy4;",
      "// @ts-expect-error legacy top-level persistToolCatalog",
      "const legacy5: ConnectaConfig = { connectors: [], executor, persistToolCatalog: 1 };",
      "void legacy5;",
      "// @ts-expect-error legacy top-level toolCatalogStaleSeconds",
      "const legacy6: ConnectaConfig = { connectors: [], executor, toolCatalogStaleSeconds: 1 };",
      "void legacy6;",
      "// @ts-expect-error legacy top-level probeTimeoutMs",
      "const legacy7: ConnectaConfig = { connectors: [], executor, probeTimeoutMs: 1 };",
      "void legacy7;",
      "// @ts-expect-error legacy top-level defaultToolTimeoutMs",
      "const legacy8: ConnectaConfig = { connectors: [], executor, defaultToolTimeoutMs: 1 };",
      "void legacy8;",
      "// @ts-expect-error legacy top-level maxResultBytes",
      "const legacy9: ConnectaConfig = { connectors: [], executor, maxResultBytes: 1 };",
      "void legacy9;",
      "// @ts-expect-error legacy top-level surface",
      "const legacy10: ConnectaConfig = { connectors: [], executor, surface: 1 };",
      "void legacy10;",
      "const app: Connecta = createConnecta(defineConfig((_env: { X?: string }) => config)({}));",
      "const snapshot: ConnectaConfigDescription = app.describeConfig();",
      "const close: () => Promise<void> = app.close;",
      "type Executors = [AdmittingExecutor, ExecutorLease];",
      "void missing; void typo; void snapshot; void close;",
      "export type { Executors };",
      "",
    ].join("\n"),
  );
  run(npm, ["run", "typecheck"], generatedRoot);
  const generatedTsx = join(generatedRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  expectFailure(
    generatedTsx,
    ["src/index.ts"],
    generatedRoot,
    "needs both CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY",
    { CLERK_PUBLISHABLE_KEY: "", CLERK_SECRET_KEY: "sk_test_incomplete" },
  );
  const generatedEntry = await readFile(join(generatedRoot, "src", "index.ts"), "utf8");
  const generatedConfig = await readFile(join(generatedRoot, "src", "connecta.config.ts"), "utf8");
  const configImport = 'from "./connecta.config.js"';
  if (!generatedEntry.includes(configImport)) {
    throw new Error("Generated entry no longer imports src/connecta.config.ts");
  }
  // A variant configuration beside the real one, started by a copy of the
  // entry that imports it instead.
  const writeVariant = async (name, config) => {
    await writeFile(join(generatedRoot, "src", `${name}.config.ts`), config);
    await writeFile(
      join(generatedRoot, "src", `${name}.ts`),
      generatedEntry.replace(configImport, `from "./${name}.config.js"`),
    );
    return `src/${name}.ts`;
  };
  // Strip the comment with the line it annotates; leaving it orphaned above a
  // deleted executor would make the fixture read as a deliberate omission.
  const executorLine =
    "    // Required: model-written programs run in a bounded QuickJS child.\n" + "    executor: quickJsExecutor(),\n";
  if (!generatedConfig.includes(executorLine)) {
    throw new Error("Generated deployment is missing its required executor");
  }
  expectFailure(
    generatedTsx,
    [await writeVariant("no-executor", generatedConfig.replace(executorLine, ""))],
    generatedRoot,
    "ConnectaConfig.executor is required",
    {
      CONNECTA_DATABASE: join(generatedRoot, "invalid-config.sqlite"),
      CLERK_PUBLISHABLE_KEY: "",
      CLERK_SECRET_KEY: "",
    },
  );
  expectFailure(
    generatedTsx,
    [
      await writeVariant(
        "removed-surface",
        generatedConfig.replace(executorLine, `${executorLine}    surface: "classic",\n`),
      ),
    ],
    generatedRoot,
    "ConnectaConfig.surface",
    {
      CONNECTA_DATABASE: join(generatedRoot, "invalid-config.sqlite"),
      CLERK_PUBLISHABLE_KEY: "",
      CLERK_SECRET_KEY: "",
    },
  );

  const port = await freePort();
  const staticToken = "package-smoke-static-token";
  const generatedDatabase = join(generatedRoot, "machine-state.sqlite");
  const serverEnv = {
    CONNECTA_TOKEN: staticToken,
    CONNECTA_DATABASE: generatedDatabase,
    CLERK_PUBLISHABLE_KEY: "",
    CLERK_SECRET_KEY: "",
    PUBLIC_URL: "",
    CONNECTA_CREDENTIAL_KEY: "",
    CONNECTA_ACTIVITY: "",
    PORT: String(port),
  };
  const provisionedToken = (output) => {
    const token = output.trim();
    if (!/^cta_[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new Error("Provisioning did not return one managed cta_ token");
    }
    return token;
  };
  const assertClosed = async (origin) => {
    for (const token of [undefined, staticToken, `cta_${"A".repeat(43)}`]) {
      const response = await fetch(`${origin}/mcp`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
      if (response.status !== 401) {
        throw new Error(`Generated deployment admitted an unprovisioned client: ${response.status}`);
      }
    }
  };
  let serverOutput = "";
  const deployment = spawn(generatedTsx, ["src/index.ts"], {
    cwd: generatedRoot,
    env: {
      ...process.env,
      ...serverEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const retainOutput = (chunk) => {
    serverOutput = (serverOutput + chunk.toString()).slice(-8_000);
  };
  deployment.stdout.on("data", retainOutput);
  deployment.stderr.on("data", retainOutput);
  try {
    await waitForHealth(`http://127.0.0.1:${port}/health`, deployment, () => serverOutput);
    const shell = await fetch(`http://127.0.0.1:${port}/`);
    const html = await shell.text();
    if (
      shell.status !== 200 ||
      html.length > 5000 ||
      !shell.headers.get("content-security-policy")?.startsWith("script-src 'self'")
    ) {
      throw new Error("Installed package did not serve a small same-origin operator shell");
    }
    const assets = [...html.matchAll(/(?:src|href)="(\/ui\/assets\/[^" ]+)"/g)].map((match) => match[1]);
    if (!assets.some((path) => path.endsWith(".js")) || !assets.some((path) => path.endsWith(".css")))
      throw new Error("Installed shell missing hashed assets");
    for (const path of assets) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      if (
        response.status !== 200 ||
        !response.headers.get("cache-control")?.includes("immutable") ||
        !(await response.arrayBuffer()).byteLength
      )
        throw new Error(`Installed asset failed: ${path}`);
    }
    const generatedConnecta = join(
      generatedRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "connecta.cmd" : "connecta",
    );
    await assertClosed(`http://127.0.0.1:${port}`);
    const smokeToken = provisionedToken(
      run(generatedTsx, ["src/provision-token.ts", "package-smoke-machine"], generatedRoot, serverEnv),
    );
    const doctorOutput = run(generatedConnecta, ["doctor", "--url", `http://127.0.0.1:${port}`], generatedRoot, {
      CONNECTA_TOKEN: smokeToken,
    });
    if (!doctorOutput.includes("QuickJS executed")) {
      throw new Error(`Doctor did not prove execution: ${doctorOutput}`);
    }
  } finally {
    await stopChild(deployment);
  }

  // Exercise the installed package and real QuickJS with an original v0.23
  // secret. Only the template's access-token module, over the migrated
  // database, can admit this doctor request; CONNECTA_TOKEN has no server role.
  const legacyTokens = JSON.parse(await readFile(join(root, "test", "fixtures", "access-tokens-v023.json"), "utf8"));
  // The v0.23 records arrive the way a 0.28 Node deployment kept them, in a
  // `fileStorage` JSON state file, and reach SQLite through the installed
  // CLI's one-shot migration: the upgrade path the template documents.
  const legacyStateFile = join(generatedRoot, "legacy-token-state.json");
  await writeFile(
    legacyStateFile,
    JSON.stringify(Object.fromEntries(Object.entries(legacyTokens.records).map(([key, value]) => [key, { value }]))),
  );
  const legacyState = join(generatedRoot, "legacy-token-state.sqlite");
  const migrated = run(
    join(generatedRoot, "node_modules", ".bin", process.platform === "win32" ? "connecta.cmd" : "connecta"),
    ["migrate-state", legacyStateFile, legacyState],
    generatedRoot,
  );
  const recordCount = Object.keys(legacyTokens.records).length;
  if (!migrated.includes(`Imported ${recordCount} entries`)) {
    throw new Error(`migrate-state did not import the legacy records: ${migrated}`);
  }
  const legacyPort = await freePort();
  let legacyOutput = "";
  const legacyDeployment = spawn(generatedTsx, ["src/index.ts"], {
    cwd: generatedRoot,
    env: { ...process.env, ...serverEnv, CONNECTA_DATABASE: legacyState, PORT: String(legacyPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const retainLegacyOutput = (chunk) => {
    legacyOutput = (legacyOutput + chunk.toString()).slice(-8_000);
  };
  legacyDeployment.stdout.on("data", retainLegacyOutput);
  legacyDeployment.stderr.on("data", retainLegacyOutput);
  try {
    await waitForHealth(`http://127.0.0.1:${legacyPort}/health`, legacyDeployment, () => legacyOutput);
    await assertClosed(`http://127.0.0.1:${legacyPort}`);
    const doctorOutput = run(
      join(generatedRoot, "node_modules", ".bin", process.platform === "win32" ? "connecta.cmd" : "connecta"),
      ["doctor", "--url", `http://127.0.0.1:${legacyPort}`],
      generatedRoot,
      { CONNECTA_TOKEN: legacyTokens.bound.token },
    );
    if (!doctorOutput.includes("QuickJS executed")) throw new Error("Legacy token doctor did not prove execution");
    console.log("v0.23 token compatibility: doctor passed with the original secret");
  } finally {
    await stopChild(legacyDeployment);
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
    console.log("package smoke: Docker unavailable — skipped the generated-container check");
  } else {
    await copyFile(archive, join(generatedRoot, packed.filename));
    generatedPackage.dependencies["@zackbart/connecta"] = `file:./${packed.filename}`;
    await writeFile(join(generatedRoot, "package.json"), JSON.stringify(generatedPackage, null, 2) + "\n");
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
    await writeFile(dockerfilePath, dockerfile.replace(manifestCopy, `COPY ${packed.filename} ./\n${manifestCopy}`));

    const containerPort = await freePort();
    // Inject a static value only in the smoke fixture to prove even an
    // inherited CONNECTA_TOKEN cannot become server authentication.
    const staticEnvOverride = join(generatedRoot, "static-env.override.yml");
    await writeFile(
      staticEnvOverride,
      `services:\n  connecta:\n    environment:\n      CONNECTA_TOKEN: ${staticToken}\n`,
    );
    const compose = [
      "compose",
      "-p",
      `connecta-smoke-${process.pid}`,
      "-f",
      "docker-compose.yml",
      "-f",
      staticEnvOverride,
    ];
    const composeEnv = {
      ...serverEnv,
      CONNECTA_DATABASE: "/data/connecta.sqlite",
      PORT: String(containerPort),
    };
    const composeLogs = () => {
      const logs = spawnSync("docker", [...compose, "logs", "--no-color", "--tail", "200"], {
        cwd: generatedRoot,
        encoding: "utf8",
        env: { ...process.env, ...composeEnv },
      });
      return `${logs.stdout ?? ""}\n${logs.stderr ?? ""}`;
    };
    try {
      run("docker", [...compose, "up", "-d", "--build"], generatedRoot, composeEnv);
      await waitForContainerHealth(`http://127.0.0.1:${containerPort}/health`, 120_000, composeLogs);
      await assertClosed(`http://127.0.0.1:${containerPort}`);
      // A trusted one-shot container, using the installed package API and the
      // service's named volume, exactly as the template documents.
      const containerToken = provisionedToken(
        run(
          "docker",
          [
            ...compose,
            "run",
            "--rm",
            "--no-deps",
            "-T",
            "connecta",
            "npm",
            "run",
            "--silent",
            "provision-token",
            "--",
            "container-smoke-machine",
          ],
          generatedRoot,
          composeEnv,
        ),
      );
      run("docker", [...compose, "restart", "connecta"], generatedRoot, composeEnv);
      await waitForContainerHealth(`http://127.0.0.1:${containerPort}/health`, 120_000, composeLogs);
      await assertClosed(`http://127.0.0.1:${containerPort}`);
      const containerDoctor = run(
        join(generatedRoot, "node_modules", ".bin", process.platform === "win32" ? "connecta.cmd" : "connecta"),
        ["doctor", "--url", `http://127.0.0.1:${containerPort}`],
        generatedRoot,
        { CONNECTA_TOKEN: containerToken },
      );
      if (!containerDoctor.includes("QuickJS executed")) {
        throw new Error(`Containerized deployment did not prove execution: ${containerDoctor}`);
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
    join(work, "node_modules", "@zackbart", "connecta", "dist", "index.d.ts"),
    "utf8",
  );
  for (const removedDeclaration of [
    "health?: CredentialHealthConfig",
    "checkCredentials:",
    "CredentialCheckResult",
    "CredentialHealthConfig",
    "CredentialHealthRecord",
    "ConnectaAccessTokensConfig",
    "CreatedAccessToken",
    "ConnectaCredentialsConfig",
  ]) {
    if (coreDeclarations.includes(removedDeclaration)) {
      throw new Error(`Packed core declarations still expose removed credential liveness API: ${removedDeclaration}`);
    }
  }
  const typeDeclarations = await readFile(
    join(work, "node_modules", "@zackbart", "connecta", "dist", "types.d.ts"),
    "utf8",
  );
  for (const declaration of [
    "export interface AdmittingExecutor extends Executor {",
    "export interface ExecutorLease {",
  ]) {
    if (!typeDeclarations.includes(declaration)) {
      throw new Error(`Packed executor declarations are missing: ${declaration}`);
    }
  }
  for (const dependency of [
    "@clerk/backend",
    // Declaring the Workers executor as an optional peer (#376) publishes a
    // range without putting the package in anyone's install; a default
    // install still resolves no executor at all.
    "@cloudflare/codemode",
    "quickjs-emscripten",
  ]) {
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
  if (existsSync(join(work, "node_modules", "@vercel", "sdk"))) {
    throw new Error("Vercel SDK was installed with the package");
  }
  run(process.execPath, ["smoke.mjs"], work);
  const packedD1 = await import(
    pathToFileURL(join(work, "node_modules", "@zackbart", "connecta", "dist", "d1.js")).href
  );
  const proxy = await getPlatformProxy({
    configPath: join(root, "test", "fixtures", "d1-storage", "wrangler.jsonc"),
    persist: false,
  });
  try {
    const db = proxy.env.CONNECTA_DB;
    const expiry = await checkAbsoluteExpiry(packedD1.d1Storage(db));
    const { results } = await db.prepare("SELECT expires_at_ms FROM connecta_kv WHERE key LIKE 'absolute-%'").all();
    if (results.length !== 3 || results.some((row) => row.expires_at_ms !== expiry)) {
      throw new Error("packed d1Storage did not store exact absolute set/CAS expiries");
    }
  } finally {
    await proxy.dispose();
  }

  run(npm, ["install", "--ignore-scripts", "@clerk/backend@3.23.1", "quickjs-emscripten@^0.32.0"], work);
  run(process.execPath, ["optional.mjs"], work);

  // A Workers deployment installs its executor by hand, so the peer range in
  // the manifest is the only thing that can tell it whether this release
  // supports the version it picked (#376). Prove both directions against the
  // registry rather than trusting the declaration: an unsupported version has
  // to stop the install, and a supported one has to install in silence.
  const codemodeRange = rootManifest.peerDependencies?.["@cloudflare/codemode"];
  if (!codemodeRange) {
    throw new Error(
      "@cloudflare/codemode is not declared as an optional peer, so a Workers " +
        "consumer has no published range to install against",
    );
  }
  const published = JSON.parse(run(npm, ["view", "@cloudflare/codemode", "versions", "--json"], work));
  const floor = codemodeRange
    .split("||")
    .map((arm) => arm.trim().replace(/^\^/, ""))
    .sort(compareVersions)[0];
  const unsupported = (Array.isArray(published) ? published : [published])
    .filter((version) => !version.includes("-") && compareVersions(version, floor) < 0)
    .sort(compareVersions)
    .pop();
  if (!unsupported) {
    throw new Error(
      `No published @cloudflare/codemode version sits below ${floor}, so the ` +
        "unsupported-install half of the range check cannot run",
    );
  }
  expectFailure(
    npm,
    ["install", "--ignore-scripts", `@cloudflare/codemode@${unsupported}`],
    work,
    "ERESOLVE",
    {},
    120_000,
  );
  run(
    npm,
    ["install", "--ignore-scripts", `@cloudflare/codemode@${rootManifest.devDependencies["@cloudflare/codemode"]}`],
    work,
  );
  if (!existsSync(join(work, "node_modules", "@cloudflare", "codemode"))) {
    throw new Error("A supported @cloudflare/codemode version did not install");
  }

  console.log(`package smoke passed (${packed.entryCount} files, ${packed.size} bytes)`);
} finally {
  await rm(work, { recursive: true, force: true });
}
