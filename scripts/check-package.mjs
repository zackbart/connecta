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

async function assertInstallScriptsApproved(directory, manifest) {
  const lock = JSON.parse(
    await readFile(join(directory, "package-lock.json"), "utf8"),
  );
  const approvals = manifest.allowScripts ?? {};
  const unapproved = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path || !entry?.hasInstallScript) continue;
    const installedManifestPath = join(directory, path, "package.json");
    // Lockfiles retain optional packages for every platform. A package npm did
    // not install here cannot run a script here and has no manifest to inspect.
    if (!existsSync(installedManifestPath)) continue;
    const installedManifest = JSON.parse(
      await readFile(installedManifestPath, "utf8"),
    );
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
    throw new Error(
      `Node template has unapproved install scripts: ${unapproved.join(", ")}`,
    );
  }
}

function expectFailure(
  command,
  args,
  cwd,
  expected,
  env = {},
  timeout = 10_000,
) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    timeout,
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
  // The generated operator UI bundle is an internal string constant no export
  // reaches, so the build prunes its declaration with every other unreachable
  // one (scripts/prune-declarations.mjs). Packed, it means pruning stopped.
  if (paths.has("dist/operator-ui/generated.d.ts")) {
    throw new Error(
      "Packed artifact ships dist/operator-ui/generated.d.ts; the build " +
        "should have pruned it as unreachable",
    );
  }

  for (const excluded of ["AGENTS.md", "CLAUDE.md", "PRINCIPLES.md"]) {
    if (paths.has(excluded)) {
      throw new Error(`Packed artifact ships repository-only ${excluded}`);
    }
  }

  for (const required of [
    "README.md",
    "LICENSE",
    "bin/connecta.mjs",
    "documentation/code-mode.md",
    "templates/node/.dockerignore",
    "templates/node/.env.example",
    "templates/node/AGENTS.md",
    "templates/node/Dockerfile",
    "templates/node/docker-compose.yml",
    "templates/node/package.json",
    "templates/node/src/index.ts",
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
    "dist/providers/mixpanel.js",
    "dist/providers/mixpanel.d.ts",
    "dist/providers/revenuecat.js",
    "dist/providers/revenuecat.d.ts",
    "dist/providers/linear.js",
    "dist/providers/linear.d.ts",
    "dist/providers/notion.js",
    "dist/providers/notion.d.ts",
    "dist/providers/stripe.js",
    "dist/providers/stripe.d.ts",
    "dist/providers/cloudflare.js",
    "dist/providers/cloudflare.d.ts",
    "dist/providers/vercel.js",
    "dist/providers/vercel.d.ts",
    "dist/providers/ccb.js",
    "dist/providers/ccb.d.ts",
    "dist/providers/planning-center.js",
    "dist/providers/planning-center.d.ts",
    "dist/providers/overflow.js",
    "dist/providers/overflow.d.ts",
    "dist/providers/tithely.js",
    "dist/providers/tithely.d.ts",
    "dist/providers/breeze.js",
    "dist/providers/breeze.d.ts",
    "dist/providers/basecamp.js",
    "dist/providers/basecamp.d.ts",
    "dist/providers/gmail.js",
    "dist/providers/gmail.d.ts",
    "dist/providers/drive.js",
    "dist/providers/drive.d.ts",
    "dist/providers/docs.js",
    "dist/providers/docs.d.ts",
    "dist/providers/sheets.js",
    "dist/providers/sheets.d.ts",
    "dist/providers/slides.js",
    "dist/providers/slides.d.ts",
    "dist/providers/forms.js",
    "dist/providers/forms.d.ts",
    "dist/artifacts.js",
    "dist/artifacts.d.ts",
    "dist/d1.js",
    "dist/d1.d.ts",
    "dist/sqlite.js",
    "dist/sqlite.d.ts",
    "dist/storage/sql.js",
    "dist/storage/keys.js",
    "examples/worker/src/r2-artifact-blobs.ts",
  ]) {
    if (!paths.has(required)) {
      throw new Error(`Packed artifact is missing ${required}`);
    }
  }
  for (const path of paths) {
    // The tarball is built output, not a checkout (#346). No code export
    // leaves dist/ — only the manifest data export resolves to the package
    // root (#374) — so src/ served nothing but the source and declaration
    // maps that pointed back at it, and both went with it. A packed .map is
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
    // A Cloudflare-named connector or storage path fails anywhere in the
    // artifact, `dist/` and `examples/` alike (#377). The supported platform
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
    [
      join(root, "scripts", "check-doc-links.mjs"),
      "--packed",
      "--root",
      root,
      "--files",
      packedManifest,
    ],
    root,
  );
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
const tokenModule = await import("@zackbart/connecta/auth/access-tokens");
if (typeof tokenModule.accessTokens !== "function") throw new Error("missing managed-token module");
if ("accessTokens" in core || "AccessTokenManager" in core) throw new Error("token implementation leaked into core");
const d1Module = await import("@zackbart/connecta/d1");
if (typeof d1Module.d1Storage !== "function" || typeof d1Module.d1ActivityStore !== "function") {
  throw new Error("missing D1 storage adapters");
}
const sqliteModule = await import("@zackbart/connecta/sqlite");
const smokeStorage = sqliteModule.sqliteStorage(sqliteModule.openSqlite(":memory:"));
if (!(await smokeStorage.compareAndSet("smoke", null, "1")) ||
    (await smokeStorage.compareAndSet("smoke", null, "2")) ||
    (await smokeStorage.get("smoke")) !== "1") {
  throw new Error("packed sqliteStorage did not compare-and-set");
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
const revenuecatProvider = await import(
  "@zackbart/connecta/providers/revenuecat"
);
if (typeof revenuecatProvider.revenuecat !== "function") {
  throw new Error("missing RevenueCat provider constructor");
}
const revenuecatConnection = revenuecatProvider.revenuecat("subscriptions", {
  purpose: "package smoke",
});
if (revenuecatConnection.id !== "subscriptions") {
  throw new Error("RevenueCat provider did not return a connector");
}
if (
  revenuecatProvider.REVENUECAT_MCP_ENDPOINT !== "https://mcp.revenuecat.ai/mcp"
) {
  throw new Error("RevenueCat endpoint drifted");
}
const basecampProvider = await import(
  "@zackbart/connecta/providers/basecamp"
);
if (typeof basecampProvider.basecamp !== "function") {
  throw new Error("missing Basecamp provider constructor");
}
// clientMetadataUrl is required -- Basecamp restricts dynamic registration for
// HTTPS callbacks -- so the smoke declares one the way a deployment must.
const basecampConnection = basecampProvider.basecamp("projects", {
  purpose: "package smoke",
  clientMetadataUrl: "https://connecta.example/oauth/basecamp-client",
});
if (basecampConnection.id !== "projects") {
  throw new Error("Basecamp provider did not return a connector");
}
if (basecampProvider.BASECAMP_MCP_ENDPOINT !== "https://mcp.basecamp.com/mcp") {
  throw new Error("Basecamp endpoint drifted");
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
const vercelProvider = await import("@zackbart/connecta/providers/vercel");
if (typeof vercelProvider.vercel !== "function") {
  throw new Error("missing Vercel provider constructor");
}
const vercelConnection = vercelProvider.vercel("hosting", {
  purpose: "package smoke",
});
if (vercelConnection.id !== "hosting" || vercelConnection.kind !== "api") {
  throw new Error("Vercel provider did not return an api() connector");
}
if (!vercelConnection.staticTools?.length) {
  throw new Error("Vercel provider published no tools");
}
const ccbProvider = await import("@zackbart/connecta/providers/ccb");
if (typeof ccbProvider.ccb !== "function") {
  throw new Error("missing CCB provider constructor");
}
const ccbConnection = ccbProvider.ccb("church", {
  purpose: "package smoke",
  environment: "sandbox",
  mode: "system",
  clientId: "smoke-client",
  clientSecret: "smoke-secret",
});
if (ccbConnection.id !== "church" || ccbConnection.kind !== "api") {
  throw new Error("CCB provider did not return an api() connector");
}
if (!ccbConnection.staticTools?.length || typeof ccbConnection.startAuth !== "function") {
  throw new Error("CCB provider published no tools or no OAuth grant");
}
const planningCenterProvider = await import(
  "@zackbart/connecta/providers/planning-center"
);
if (typeof planningCenterProvider.planningCenter !== "function") {
  throw new Error("missing Planning Center provider constructor");
}
const planningCenterConnection = planningCenterProvider.planningCenter("church", {
  purpose: "package smoke",
});
if (planningCenterConnection.id !== "church" || planningCenterConnection.kind !== "api") {
  throw new Error("Planning Center provider did not return an api() connector");
}
if (!planningCenterConnection.staticTools?.length) {
  throw new Error("Planning Center provider published no tools");
}
const overflowProvider = await import("@zackbart/connecta/providers/overflow");
if (typeof overflowProvider.overflow !== "function") {
  throw new Error("missing Overflow provider constructor");
}
const overflowConnection = overflowProvider.overflow("giving", {
  environment: "staging",
  purpose: "package smoke",
});
if (overflowConnection.id !== "giving" || overflowConnection.kind !== "api") {
  throw new Error("Overflow provider did not return an api() connector");
}
if (!overflowConnection.staticTools?.length) {
  throw new Error("Overflow provider published no tools");
}
const tithelyProvider = await import("@zackbart/connecta/providers/tithely");
if (typeof tithelyProvider.tithely !== "function") {
  throw new Error("missing Tithe.ly provider constructor");
}
const tithelyConnection = tithelyProvider.tithely("giving", {
  purpose: "package smoke",
  environment: "test",
});
if (tithelyConnection.id !== "giving" || tithelyConnection.kind !== "api") {
  throw new Error("Tithe.ly provider did not return an api() connector");
}
if (!tithelyConnection.staticTools?.length) {
  throw new Error("Tithe.ly provider published no tools");
}
const breezeProvider = await import("@zackbart/connecta/providers/breeze");
if (typeof breezeProvider.breeze !== "function") {
  throw new Error("missing Breeze provider constructor");
}
const breezeConnection = breezeProvider.breeze("church", {
  subdomain: "smoke",
  purpose: "package smoke",
});
if (breezeConnection.id !== "church" || breezeConnection.kind !== "api") {
  throw new Error("Breeze provider did not return an api() connector");
}
if (!breezeConnection.staticTools?.length) {
  throw new Error("Breeze provider published no tools");
}
const gmailProvider = await import("@zackbart/connecta/providers/gmail");
if (typeof gmailProvider.gmail !== "function") {
  throw new Error("missing Gmail provider constructor");
}
// Construction checks the key, so the smoke brings a real one.
const smokeKey = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign"],
);
const smokeDer = new Uint8Array(await crypto.subtle.exportKey("pkcs8", smokeKey.privateKey));
const gmailConnection = gmailProvider.gmail("mail", {
  purpose: "package smoke",
  serviceAccount: {
    clientEmail: "smoke@project.iam.gserviceaccount.com",
    privateKey:
      "-----BEGIN PRIVATE KEY-----" +
      btoa(String.fromCharCode(...smokeDer)) +
      "-----END PRIVATE KEY-----",
  },
  subject: () => undefined,
});
if (gmailConnection.id !== "mail" || gmailConnection.kind !== "api") {
  throw new Error("Gmail provider did not return an api() connector");
}
if (gmailConnection.staticTools?.some((tool) => /send/.test(tool.name))) {
  throw new Error("Gmail provider published a send tool");
}
const driveProvider = await import("@zackbart/connecta/providers/drive");
if (typeof driveProvider.drive !== "function") {
  throw new Error("missing Google Drive provider constructor");
}
const driveConnection = driveProvider.drive("files", {
  purpose: "package smoke",
  serviceAccount: {
    clientEmail: "smoke@project.iam.gserviceaccount.com",
    privateKey:
      "-----BEGIN PRIVATE KEY-----" +
      btoa(String.fromCharCode(...smokeDer)) +
      "-----END PRIVATE KEY-----",
  },
  subject: () => undefined,
});
if (driveConnection.id !== "files" || driveConnection.kind !== "api") {
  throw new Error("Google Drive provider did not return an api() connector");
}
if (driveConnection.staticTools?.some((tool) => /^(delete_file|empty_trash|transfer)/.test(tool.name))) {
  throw new Error("Google Drive provider published a permanent delete or ownership transfer");
}
const docsProvider = await import("@zackbart/connecta/providers/docs");
if (typeof docsProvider.docs !== "function") {
  throw new Error("missing Google Docs provider constructor");
}
const docsConnection = docsProvider.docs("docs", {
  purpose: "package smoke",
  serviceAccount: {
    clientEmail: "smoke@project.iam.gserviceaccount.com",
    privateKey:
      "-----BEGIN PRIVATE KEY-----" +
      btoa(String.fromCharCode(...smokeDer)) +
      "-----END PRIVATE KEY-----",
  },
  subject: () => undefined,
});
if (docsConnection.id !== "docs" || docsConnection.kind !== "api") {
  throw new Error("Google Docs provider did not return an api() connector");
}
const sheetsProvider = await import("@zackbart/connecta/providers/sheets");
if (typeof sheetsProvider.sheets !== "function") {
  throw new Error("missing Google Sheets provider constructor");
}
const sheetsConnection = sheetsProvider.sheets("sheets", {
  purpose: "package smoke",
  serviceAccount: {
    clientEmail: "smoke@project.iam.gserviceaccount.com",
    privateKey:
      "-----BEGIN PRIVATE KEY-----" +
      btoa(String.fromCharCode(...smokeDer)) +
      "-----END PRIVATE KEY-----",
  },
  subject: () => undefined,
});
if (sheetsConnection.id !== "sheets" || sheetsConnection.kind !== "api") {
  throw new Error("Google Sheets provider did not return an api() connector");
}
if (!sheetsConnection.staticTools?.length) {
  throw new Error("Google Sheets provider published no tools");
}
const slidesProvider = await import("@zackbart/connecta/providers/slides");
if (typeof slidesProvider.slides !== "function") {
  throw new Error("missing Google Slides provider constructor");
}
const slidesConnection = slidesProvider.slides("decks", {
  purpose: "package smoke",
  serviceAccount: {
    clientEmail: "smoke@project.iam.gserviceaccount.com",
    privateKey:
      "-----BEGIN PRIVATE KEY-----" +
      btoa(String.fromCharCode(...smokeDer)) +
      "-----END PRIVATE KEY-----",
  },
  subject: () => undefined,
});
if (slidesConnection.id !== "decks" || slidesConnection.kind !== "api") {
  throw new Error("Google Slides provider did not return an api() connector");
}
if (!slidesConnection.staticTools?.length) {
  throw new Error("Google Slides provider published no tools");
}
const formsProvider = await import("@zackbart/connecta/providers/forms");
if (typeof formsProvider.forms !== "function") {
  throw new Error("missing Google Forms provider constructor");
}
const formsConnection = formsProvider.forms("forms", {
  purpose: "package smoke",
  serviceAccount: {
    clientEmail: "smoke@project.iam.gserviceaccount.com",
    privateKey:
      "-----BEGIN PRIVATE KEY-----" +
      btoa(String.fromCharCode(...smokeDer)) +
      "-----END PRIVATE KEY-----",
  },
  subject: () => undefined,
});
if (formsConnection.id !== "forms" || formsConnection.kind !== "api") {
  throw new Error("Google Forms provider did not return an api() connector");
}
if (!formsConnection.staticTools?.length) {
  throw new Error("Google Forms provider published no tools");
}
const artifactsModule = await import("@zackbart/connecta/artifacts");
if (typeof artifactsModule.kvArtifactStore !== "function") {
  throw new Error("missing kvArtifactStore");
}
const artifactsSlot = artifactsModule.artifacts({
  store: artifactsModule.kvArtifactStore(core.memoryStorage()),
});
if (artifactsSlot.connector?.id !== "artifacts") {
  throw new Error("artifacts() did not return the artifacts connector");
}
if (!artifactsModule.validateArtifact({ kind: "markdown", source: "# smoke" }).ok) {
  throw new Error("packed validateArtifact refused a valid page");
}
for (const name of [
  "kvArtifactStore",
  "validateArtifact",
  "artifacts",
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
  "mixpanel",
  "MIXPANEL_MCP_ENDPOINTS",
  "stripe",
  "STRIPE_MCP_ENDPOINT",
  "linear",
  "LINEAR_MCP_ENDPOINTS",
  "revenuecat",
  "REVENUECAT_MCP_ENDPOINT",
  "notion",
  "NOTION_API_VERSION",
  "NOTION_API_BASE_URL",
  "cloudflare",
  "CLOUDFLARE_API_BASE",
  "CLOUDFLARE_DNS_RECORD_TYPES",
  "vercel",
  "VERCEL_API_BASE_URL",
  "ccb",
  "CCB_ENVIRONMENTS",
  "CCB_READ_SCOPES",
  "planningCenter",
  "PLANNING_CENTER_API_BASE_URL",
  "PLANNING_CENTER_API_VERSIONS",
  "overflow",
  "OVERFLOW_API_BASE_URLS",
  "tithely",
  "TITHELY_API_BASE_URLS",
  "breeze",
  "BREEZE_HOST_SUFFIX",
  "basecamp",
  "BASECAMP_MCP_ENDPOINT",
  "gmail",
  "GMAIL_API_BASE_URL",
  "GMAIL_SCOPES",
  "drive",
  "DRIVE_API_BASE_URL",
  "DRIVE_SCOPES",
  "docs",
  "DOCS_API_BASE_URL",
  "DOCS_SCOPES",
  "sheets",
  "SHEETS_API_BASE_URL",
  "SHEETS_SCOPES",
  "slides",
  "SLIDES_API_BASE_URL",
  "SLIDES_SCOPES",
  "forms",
  "FORMS_API_BASE_URL",
  "FORMS_SCOPES",
]) {
  if (name in core) throw new Error(name + " leaked into the core entry");
}
`,
  );
  await writeFile(
    join(work, "optional.mjs"),
    `
const clerk = await import("@zackbart/connecta/auth/clerk");
const access = await import("@zackbart/connecta/auth/cloudflare-access");
const quickjs = await import("@zackbart/connecta/quickjs");
if (typeof clerk.clerkAuth !== "function") throw new Error("missing Clerk adapter");
if (typeof access.cloudflareAccessAuth !== "function") throw new Error("missing Cloudflare Access adapter");
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
  // The declarations a consumer compiles against, as installed: no Effect
  // type anywhere under dist/, reachable or not, and nothing left unpruned.
  run(
    process.execPath,
    [
      join(root, "scripts", "check-declarations.mjs"),
      "--dist",
      join(work, "node_modules", "@zackbart", "connecta"),
    ],
    root,
  );
  // One Effect, at exactly the pinned version. A second copy means two
  // runtimes whose fibers, services, and errors do not recognize each other.
  const effectPin = rootManifest.dependencies?.effect;
  const installedEffect = JSON.parse(
    await readFile(join(work, "node_modules", "effect", "package.json"), "utf8"),
  ).version;
  if (installedEffect !== effectPin) {
    throw new Error(
      `Installed effect ${installedEffect} does not match the pin ${effectPin}`,
    );
  }
  const consumerLock = JSON.parse(
    await readFile(join(work, "package-lock.json"), "utf8"),
  );
  const nestedEffect = Object.keys(consumerLock.packages ?? {}).filter((path) =>
    path.endsWith("/node_modules/effect"),
  );
  if (nestedEffect.length) {
    throw new Error(
      `A second copy of effect was installed: ${nestedEffect.join(", ")}`,
    );
  }
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
  await assertInstallScriptsApproved(generatedRoot, generatedPackage);
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
    "ConnectaConfig.surface",
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

  // Exercise the installed package and real QuickJS with an original v0.23
  // secret. The configured static bearer is different, so only the restored
  // module can admit this doctor request.
  const legacyTokens = JSON.parse(await readFile(
    join(root, "test", "fixtures", "access-tokens-v023.json"), "utf8",
  ));
  // The v0.23 records arrive the way a 0.28 Node deployment kept them, in a
  // `fileStorage` JSON state file, and reach SQLite through the installed
  // CLI's one-shot migration: the upgrade path the template documents.
  const legacyStateFile = join(generatedRoot, "legacy-token-state.json");
  await writeFile(legacyStateFile, JSON.stringify(Object.fromEntries(
    Object.entries(legacyTokens.records).map(([key, value]) => [key, { value }]),
  )));
  const legacyState = join(generatedRoot, "legacy-token-state.sqlite");
  const migrated = run(
    join(generatedRoot, "node_modules", ".bin", process.platform === "win32" ? "connecta.cmd" : "connecta"),
    ["migrate-state", legacyStateFile, legacyState], generatedRoot,
  );
  const recordCount = Object.keys(legacyTokens.records).length;
  if (!migrated.includes(`Imported ${recordCount} entries`)) {
    throw new Error(`migrate-state did not import the legacy records: ${migrated}`);
  }
  await writeFile(join(generatedRoot, "src", "managed-tokens.ts"),
    'import { accessTokens } from "@zackbart/connecta/auth/access-tokens";\n' +
    generatedSource.replace(createCall, createCall + '  accessTokens: accessTokens(storage),\n'),
  );
  const legacyPort = await freePort();
  let legacyOutput = "";
  const legacyDeployment = spawn(generatedTsx, ["src/managed-tokens.ts"], {
    cwd: generatedRoot,
    env: { ...process.env, CONNECTA_TOKEN: smokeToken, CONNECTA_DATABASE: legacyState, PORT: String(legacyPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const retainLegacyOutput = chunk => { legacyOutput = (legacyOutput + chunk.toString()).slice(-8_000); };
  legacyDeployment.stdout.on("data", retainLegacyOutput);
  legacyDeployment.stderr.on("data", retainLegacyOutput);
  try {
    await waitForHealth(`http://127.0.0.1:${legacyPort}/health`, legacyDeployment, () => legacyOutput);
    const doctorOutput = run(
      join(generatedRoot, "node_modules", ".bin", process.platform === "win32" ? "connecta.cmd" : "connecta"),
      ["doctor", "--url", `http://127.0.0.1:${legacyPort}`], generatedRoot,
      { CONNECTA_TOKEN: legacyTokens.bound.token },
    );
    if (!doctorOutput.includes("QuickJS executed")) throw new Error("Legacy token doctor did not prove execution");
    console.log("v0.23 token compatibility: doctor passed with the original secret");
  } finally { await stopChild(legacyDeployment); }

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
    "export interface ConnectaDiscoveryConfig {",
    "    catalogTtlSeconds?: number;",
    "    persistCatalog?: boolean;",
    "    staleCatalogSeconds?: number;",
    "    probeTimeoutMs?: number;",
    "export interface ConnectaCallsConfig {",
    "    defaultTimeoutMs?: number;",
    "    maxResultBytes?: number;",
    "    activity?: ActivityModule;",
    "    vault?: CredentialVault;",
    "    ui?: OperatorSurface;",
    "    artifacts?: ArtifactsModule;",
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
    "ConnectaAccessTokensConfig", "CreatedAccessToken", "ConnectaCredentialsConfig",
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
  const published = JSON.parse(
    run(npm, ["view", "@cloudflare/codemode", "versions", "--json"], work),
  );
  const floor = codemodeRange
    .split("||")
    .map((arm) => arm.trim().replace(/^\^/, ""))
    .sort(compareVersions)[0];
  const unsupported = (Array.isArray(published) ? published : [published])
    .filter(
      (version) => !version.includes("-") && compareVersions(version, floor) < 0,
    )
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
    [
      "install",
      "--ignore-scripts",
      `@cloudflare/codemode@${rootManifest.devDependencies["@cloudflare/codemode"]}`,
    ],
    work,
  );
  if (!existsSync(join(work, "node_modules", "@cloudflare", "codemode"))) {
    throw new Error("A supported @cloudflare/codemode version did not install");
  }

  console.log(
    `package smoke passed (${packed.entryCount} files, ${packed.size} bytes)`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
