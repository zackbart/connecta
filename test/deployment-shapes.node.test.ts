// Node-only: walks the template and example trees and runs the Node template's
// configuration, which opens a SQLite file and a QuickJS pool.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createConnecta, customExecutor } from "../src/index.js";
import { AccessTokenManager } from "../src/access-tokens.js";
import nodeConfig from "../templates/node/src/connecta.config.js";
import workerConfig from "../examples/worker/src/connecta.config.js";

// The Worker executor needs workerd's `cloudflare:` modules, which Node cannot
// load; this suite checks which modules the configuration switches on, not
// the sandbox, so a self-managed stand-in takes its place.
vi.mock("../src/worker.js", () => ({
  workerExecutor: () =>
    customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
}));

// There are two deployment shapes: the Node template `connecta init` copies —
// Docker-ready, not Docker-only — and the Cloudflare Worker example. Three
// near-identical Node scaffolds were the shape #344 deleted, and a new one
// arrives as a copy of an existing one, so the guard is a layout assertion.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "templates", "node");

const WORKER = join(ROOT, "examples", "worker");

const read = (...segments: string[]) =>
  readFileSync(join(TEMPLATE, ...segments), "utf8");
const readWorker = (...segments: string[]) =>
  readFileSync(join(WORKER, ...segments), "utf8");

/** A syntactically valid Clerk publishable key; nothing here contacts Clerk. */
const PUBLISHABLE_KEY =
  "pk_test_" + Buffer.from("example.clerk.accounts.dev$", "utf8").toString("base64");
const VAULT_KEY = Buffer.alloc(32, 7).toString("base64");

describe("deployment shapes", () => {
  it("keeps the Worker as the only example", () => {
    expect(readdirSync(join(ROOT, "examples")).sort()).toEqual(["worker"]);
  });

  it("keeps the Worker sandbox loader-only", () => {
    const options = [...readWorker("src", "connecta.config.ts").matchAll(
      /workerExecutor\(\{([^}]*)\}\)/g,
    )].map((match) => match[1]?.trim());
    expect(options).toEqual(["loader: env.LOADER"]);
  });

  // Configuration lives in each shape's connecta.config.ts as
  // defineConfig((env) => …); the entry only starts it, so it stays short
  // enough to review at a glance.
  it("keeps both entries under 30 lines that only start their configuration", () => {
    for (const entry of [join(TEMPLATE, "src", "index.ts"), join(WORKER, "src", "index.ts")]) {
      const source = readFileSync(entry, "utf8");
      expect(source.trimEnd().split("\n").length, entry).toBeLessThan(30);
      expect(source, entry).toContain('from "./connecta.config.js"');
      expect(source, entry).toContain("createConnecta(config)");
    }
    for (const config of [join(TEMPLATE, "src", "connecta.config.ts"), join(WORKER, "src", "connecta.config.ts")]) {
      expect(readFileSync(config, "utf8"), config).toContain("export default defineConfig((env: Env) =>");
    }
  });

  it("pins hosted MCP callbacks in the Worker deployment instructions", () => {
    const agents = readWorker("AGENTS.md");
    const readme = readWorker("README.md");
    const source = readWorker("src", "connecta.config.ts");
    const callbacks = [
      "https://claude.ai/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector/oauth/*",
    ];
    for (const callback of callbacks) {
      expect(agents).toContain(callback);
      expect(readme).toContain(callback);
      expect(source).toContain(callback);
    }
    expect(agents).toContain(
      "oauth_configuration.dynamic_client_registration.allowed_uris",
    );
    expect(readme).toContain(
      '"dynamic_client_registration": {',
    );
    expect(readme).toContain('"allowed_uris": [');
  });

  it("ships one Node deployment that is also its own container", () => {
    expect(readdirSync(TEMPLATE).sort()).toEqual([
      ".dockerignore",
      ".env.example",
      ".gitignore",
      "AGENTS.md",
      "CLAUDE.md",
      "Dockerfile",
      "README.md",
      "docker-compose.yml",
      "package.json",
      "src",
      "tsconfig.json",
    ]);
    // The container builds this deployment, never the Connecta repository:
    // its build context is the generated project itself.
    expect(read("docker-compose.yml")).toContain("build: .");
    expect(read("Dockerfile")).not.toContain("npm run build");
  });

  it("runs the same source locally and in the container", () => {
    const dockerfile = read("Dockerfile");
    const manifest = JSON.parse(read("package.json"));
    expect(dockerfile).toContain("src/index.ts");
    expect(manifest.scripts.start).toBe("tsx src/index.ts");
    expect(manifest.allowScripts).toEqual({ "esbuild@0.28.2": true });
    expect(read("README.md")).toContain(
      "do not replace the pinned entry with a broad\npackage-name approval",
    );
    // No lockfile ships with the template — init rewrites the version pin, so
    // a committed lockfile would disagree with it on the first build.
    expect(readdirSync(TEMPLATE)).not.toContain("package-lock.json");
    expect(dockerfile).toContain("npm ci");
    expect(dockerfile).toContain("npm install");
  });

  it("configures the container's origin, state, and health from the source", () => {
    const source = read("src", "connecta.config.ts");
    expect(source).toContain('set("PUBLIC_URL")');
    expect(source).toContain('set("CONNECTA_DATABASE")');
    // The database belongs on the volume.
    expect(read("Dockerfile")).toContain("ENV CONNECTA_DATABASE=/data/connecta.sqlite");
    expect(read(".gitignore")).toContain(".connecta.sqlite*");
    expect(read("Dockerfile")).toContain("HEALTHCHECK");
    // State belongs on the mounted volume, owned by the non-root user.
    expect(read("Dockerfile")).toContain("chown -R node:node /data");
    expect(read("docker-compose.yml")).toContain("connecta-state:/data");
  });

  // Both shapes carry the whole operator feature set — sign-in, vault, access
  // tokens, activity — as type-checked code that the environment
  // switches on (#345). A shape that quietly drops one is a deployment whose
  // operator pages exist for things it cannot do; running the configuration
  // proves each module is wired rather than described.
  it("switches every Node template module on from the environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "connecta-template-"));
    // Each configuration opens its own database, as separate deployments would.
    let files = 0;
    const base = () => ({ CONNECTA_DATABASE: join(dir, `state-${++files}.sqlite`) });
    try {
      expect(() => nodeConfig({ ...base(), CLERK_SECRET_KEY: "sk_test_only" })).toThrow(
        "needs both CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY",
      );
      expect(() => nodeConfig({ ...base(), CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY })).toThrow(
        "needs both CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY",
      );
      // Compose passes an unset variable through as "", which is unset too.
      const off = createConnecta({ ...nodeConfig({ ...base(), CONNECTA_CREDENTIAL_KEY: "" }), logger: "silent" });
      const quiet = off.describeConfig();
      expect(quiet.auth.map((provider) => provider.kind)).toEqual(["access_token"]);
      expect(quiet.modules).toMatchObject({
        ui: { enabled: true },
        accessTokens: { enabled: true },
        vault: { enabled: false },
        activity: { enabled: false },
      });
      expect(quiet.storage).toEqual({ configured: true, kind: "sqlite" });
      await off.close();

      const on = createConnecta({
        ...nodeConfig({
          ...base(),
          PUBLIC_URL: "https://connecta.example",
          CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
          CLERK_SECRET_KEY: "sk_test_template",
          CONNECTA_CREDENTIAL_KEY: VAULT_KEY,
          CONNECTA_ACTIVITY: "on",
        }),
        logger: "silent",
      });
      const full = on.describeConfig();
      expect(full.auth.map((provider) => provider.kind)).toEqual(["access_token", "clerk"]);
      expect(full.modules).toMatchObject({
        vault: { enabled: true, sealsOAuth: true },
        // Activity shares the one SQLite file, pruned on write.
        activity: {
          enabled: true,
          readable: true,
          deploymentId: "production",
          store: { kind: "sqlite", retentionDays: 90 },
        },
      });
      expect(full.connectors.map((connector) => connector.id)).toEqual(["time"]);
      await on.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const env = read(".env.example");
    for (const variable of [
      "CLERK_PUBLISHABLE_KEY",
      "CLERK_SECRET_KEY",
      "CONNECTA_CREDENTIAL_KEY",
      "CONNECTA_DATABASE",
      "CONNECTA_ACTIVITY",
    ]) {
      expect(env).toContain(variable);
      // Compose passes every one through, or setting it would work from
      // source and silently do nothing in the container.
      expect(read("docker-compose.yml")).toContain(variable);
    }
    expect(read("README.md")).toContain("## Select optional modules");
    // Storage and activity come from the package; the template copies no adapter.
    expect(readdirSync(join(TEMPLATE, "src")).sort()).toEqual(["connecta.config.ts", "index.ts", "provision-token.ts"]);
  });

  it("switches every Worker example module on from its environment", async () => {
    // Construction and describeConfig() run no statement: tables are created
    // on first use, so a binding that answers nothing is enough here.
    const d1 = { prepare: () => ({ bind: () => ({}) }), batch: async () => [] };
    const base = { CONNECTA_DB: d1, DOWNSTREAM_TOKEN: "downstream", PUBLIC_URL: "https://worker.example", LOADER: { get: () => ({}) } };
    const env = (extra: Record<string, unknown>) => ({ ...base, ...extra }) as unknown as Parameters<typeof workerConfig>[0];
    const config = workerConfig(env({}));
    expect(config.identity?.accessTokenManagement?.({ interactive: true, actor: { kind: "cloudflare-access", id: "operator" } })).toBe(true);
    const off = createConnecta({ ...config, logger: "silent" });
    const quiet = off.describeConfig();
    expect(quiet.auth).toEqual([
      { kind: "access_token", interactive: false },
      { kind: "cloudflare-access", interactive: true, ui: "cloudflare-access" },
    ]);
    expect(quiet.modules).toMatchObject({
      ui: { enabled: true },
      accessTokens: { enabled: true },
      vault: { enabled: false },
      activity: { enabled: false },
    });
    expect(quiet.storage).toEqual({ configured: true, kind: "d1" });
    await off.close();
    const on = createConnecta({
      ...workerConfig(env({ CREDENTIAL_ENCRYPTION_KEY: VAULT_KEY, CONNECTA_ACTIVITY: "on" })),
      logger: "silent",
    });
    expect(on.describeConfig().modules).toMatchObject({
      accessTokens: { enabled: true },
      vault: { enabled: true },
      activity: { enabled: true, deploymentId: "production", store: { kind: "d1", retentionDays: 90 } },
    });
    await on.close();
    // One D1 database, one Worker Loader, and nothing else: no KV, no second
    // database, no copied adapter.
    const wrangler = readWorker("wrangler.jsonc")
      .split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
    expect(wrangler).not.toContain("kv_namespaces");
    expect(wrangler.match(/"binding":/g)).toHaveLength(2);
    expect(wrangler).toContain('"binding": "CONNECTA_DB"');
    expect(wrangler).toContain('"binding": "LOADER"');
    // The vars that switch the modules on stay one uncommented line away.
    expect(readWorker("wrangler.jsonc")).toContain('// "CONNECTA_ACTIVITY": "on",');
    expect(readdirSync(join(WORKER, "src")).sort()).toEqual(["connecta.config.ts", "index.ts"]);
    const workerReadme = readWorker("README.md");
    expect(workerReadme).toContain("## Select optional modules");
    expect(workerReadme).toContain("Connections");
    expect(workerReadme).toContain("Authorization: Bearer <stored-cta-token>");
    for (const variable of ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "CONNECTA_TOKEN"]) {
      expect(workerReadme).toContain(variable);
      expect(readWorker("AGENTS.md")).toContain(variable);
    }
    expect(workerReadme).not.toContain(
      "checking that Credentials, Tokens, and Activity are live",
    );
  });

  it("keeps empty storage fail-closed and admits only provisioned machine tokens (INV-4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "connecta-template-auth-"));
    const staticToken = `cta_${"A".repeat(43)}`;
    const env = { CONNECTA_DATABASE: join(dir, "state.sqlite"), CONNECTA_TOKEN: staticToken };
    const config = nodeConfig(env);
    const app = createConnecta({ ...config, logger: "silent" });
    const initialize = async (token?: string) => {
      const response = await app.fetch(new Request("http://localhost:8787/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "template-test", version: "1" },
        } }),
      }));
      await response.body?.cancel();
      return response;
    };
    try {
      expect(app.describeConfig().auth.map(provider => provider.kind)).toEqual(["access_token"]);
      expect((await app.fetch(new Request("http://localhost:8787/health"))).status).toBe(200);
      expect((await initialize()).status).toBe(401);
      expect((await initialize(staticToken)).status).toBe(401);
      const manager = new AccessTokenManager(config.storage!);
      const { token, accessToken } = await manager.create("template-machine", "local-provisioning");
      expect(token).toMatch(/^cta_[A-Za-z0-9_-]{43}$/);
      expect((await initialize(token)).status).toBe(200);
      await manager.revoke(accessToken.id, "local-provisioning");
      expect((await initialize(token)).status).toBe(401);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(read(".env.example")).toMatch(/^CONNECTA_TOKEN=\s*$/m);
    expect(read("docker-compose.yml")).not.toMatch(/^\s+CONNECTA_TOKEN:/m);
    expect(read("src", "connecta.config.ts")).not.toContain("CONNECTA_TOKEN");
    expect(read("src", "provision-token.ts")).toContain('manager.create(name, "local-provisioning")');
    expect(read("package.json")).toContain('"provision-token": "tsx src/provision-token.ts"');
    expect(read("README.md")).toContain('docker compose run --rm --no-deps connecta npm run --silent provision-token -- "container-machine"');
  });

  // A copied deployment installs its own dependencies, and an optional peer
  // that never installs with connecta breaks the build if the README that
  // calls this example a starting template does not name it (#367).
  it("names every optional peer the Worker example imports", () => {
    const source = readWorker("src", "connecta.config.ts") + readWorker("src", "index.ts");
    const readme = readWorker("README.md");
    const peers: Record<string, string> = {
      "@zackbart/connecta/auth/clerk": "@clerk/backend",
      "@cloudflare/codemode": "@cloudflare/codemode",
    };
    for (const [specifier, packageName] of Object.entries(peers)) {
      if (!source.includes(`from "${specifier}"`)) continue;
      expect(readme).toMatch(
        new RegExp(`npm install[^\\n]*${packageName.replace("/", "\\/")}`),
      );
    }
  });

  it("keeps the initializer's .gitignore in step with the template's", () => {
    // `connecta init` writes this file itself, because npm strips .gitignore
    // from a packed dependency. Two copies drift; this is the seam.
    const written = readFileSync(join(ROOT, "bin", "connecta.mjs"), "utf8");
    for (const entry of read(".gitignore").split("\n").filter(Boolean)) {
      expect(written).toContain(entry);
    }
  });

  it("packs the container files with the template", () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { files: string[] };
    const files = manifest.files;
    expect(files).toContain("templates");
    expect(files).not.toContain("examples/node");
    expect(files).not.toContain("examples/docker");
  });
});
