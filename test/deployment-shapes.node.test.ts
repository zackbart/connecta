// Node-only: walks the template and example trees and runs the Node template's
// configuration, which opens a SQLite file and a QuickJS pool.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import workerConfig from "../examples/worker/src/connecta.config.js";
import { AccessTokenManager } from "../src/access-tokens.js";
import { createConnecta, customExecutor } from "../src/index.js";
import nodeConfig from "../templates/node/src/connecta.config.js";

// The Worker executor needs workerd's `cloudflare:` modules, which Node cannot
// load; this suite checks which modules the configuration switches on, not
// the sandbox, so a self-managed stand-in takes its place.
vi.mock("../src/worker.js", () => ({
  workerExecutor: () => customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
}));

// There are two deployment shapes: the Node template `connecta init` copies —
// Docker-ready, not Docker-only — and the Cloudflare Worker example.
// scripts/check-package.mjs checks their packed layout.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "templates", "node");

const WORKER = join(ROOT, "examples", "worker");

const read = (...segments: string[]) => readFileSync(join(TEMPLATE, ...segments), "utf8");
const readWorker = (...segments: string[]) => readFileSync(join(WORKER, ...segments), "utf8");

/** A syntactically valid Clerk publishable key; nothing here contacts Clerk. */
const PUBLISHABLE_KEY = "pk_test_" + Buffer.from("example.clerk.accounts.dev$", "utf8").toString("base64");
const VAULT_KEY = Buffer.alloc(32, 7).toString("base64");

describe("deployment shapes", () => {
  // Alchemy deploys the Worker; wrangler.jsonc stays for `wrangler dev`.
  it("deploys the Worker with an Alchemy stack that keeps its state and secrets", () => {
    const stack = readWorker("alchemy.run.ts");
    const code = stack
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    // The database survives `alchemy destroy`.
    expect(code).toMatch(/D1\.Database\("ConnectaDB", \{[^}]*\}\)\.pipe\(\s*Alchemy\.RemovalPolicy\.retain\(\)/);
    // Bindings match the configuration's Env; secrets are declared in-stack,
    // since each deploy deletes bindings set any other way.
    for (const binding of [
      "CONNECTA_DB: database",
      "LOADER: Cloudflare.WorkerLoader()",
      "PUBLIC_URL: Cloudflare.Worker.URL",
      "CONNECTA_MAINTAINERS:",
      'DOWNSTREAM_TOKEN: Config.Redacted("DOWNSTREAM_TOKEN")',
      'CREDENTIAL_ENCRYPTION_KEY: Config.Redacted("CREDENTIAL_ENCRYPTION_KEY")',
    ]) {
      expect(code).toContain(binding);
    }
    // Production and local development keep the same runtime opt-ins.
    const flags = [
      "nodejs_compat",
      "enable_request_signal",
      "enable_weak_ref",
      "unhandled_rejection_after_microtask_checkpoint",
    ];
    expect(code).toContain('date: "2025-01-01"');
    for (const flag of flags) {
      expect(code.match(/flags:\s*\[([^\]]*)\]/)?.[1]).toContain(`"${flag}"`);
      expect(readWorker("wrangler.jsonc").match(/"compatibility_flags":\s*\[([^\]]*)\]/)?.[1]).toContain(`"${flag}"`);
    }
    expect(readWorker("wrangler.jsonc")).toContain('"compatibility_date": "2025-01-01"');
    // Access is attached to the Worker itself, and the bypass covers only /agent/*.
    expect(code).toMatch(/Cloudflare\.Worker\("Connecta", \{[\s\S]*\n\s+access,\n/);
    expect(code).toContain("/agent/*`");
    expect(code.match(/decision: "bypass"/g)).toHaveLength(1);
    expect(code).toContain("Alchemy.localState()");
    expect(readFileSync(join(ROOT, ".gitignore"), "utf8")).toContain(".alchemy/");

    // The documented pins are the repository's own, and Effect is connecta's.
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const effect = manifest.dependencies["effect"];
    expect(effect).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.devDependencies["@effect/platform-node"]).toBe(effect);
    const readme = readWorker("README.md");
    for (const pin of [
      `alchemy@${manifest.devDependencies["alchemy"]}`,
      `effect@${effect}`,
      `@effect/platform-node@${effect}`,
    ]) {
      expect(readme).toContain(pin);
    }
    expect(readme).toContain("npx alchemy deploy --stage production");
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
          CONNECTA_MAINTAINERS: "user_one, user_two",
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
      expect(full.maintainers.map(({ id }) => id)).toEqual(["user_one", "user_two"]);
      expect(full.pools.map(({ name, members }) => ({ name, members }))).toEqual([
        { name: "local-machine", members: [{ kind: "agent", name: "local-machine" }] },
      ]);
      await on.close();
      // Clerk admits people, so startup refuses it without a maintainer.
      expect(() =>
        createConnecta({
          ...nodeConfig({ ...base(), CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY, CLERK_SECRET_KEY: "sk_test_template" }),
          logger: "silent",
        }),
      ).toThrow("ConnectaConfig.maintainers is required with inbound auth");
      // One Organization per deployment on a shared Clerk instance.
      const organizationId = `org_${"A".repeat(27)}`;
      expect(() => nodeConfig({ ...base(), CLERK_ORGANIZATION_ID: organizationId })).toThrow(
        "CLERK_ORGANIZATION_ID needs CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY",
      );
      const organization = (CLERK_ORGANIZATION_ID: string) =>
        nodeConfig({
          ...base(),
          CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
          CLERK_SECRET_KEY: "sk_test_template",
          CLERK_ORGANIZATION_ID,
          CONNECTA_MAINTAINERS: "user_one",
        });
      // The template hands the variable to clerkAuth, which checks it.
      expect(() => organization("org_typo")).toThrow("`organizationId` is not a Clerk organization ID");
      await createConnecta({ ...organization(organizationId), logger: "silent" }).close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const env = read(".env.example");
    for (const variable of [
      "CLERK_PUBLISHABLE_KEY",
      "CLERK_SECRET_KEY",
      "CLERK_ORGANIZATION_ID",
      "CONNECTA_MAINTAINERS",
      "CONNECTA_CREDENTIAL_KEY",
      "CONNECTA_DATABASE",
      "CONNECTA_ACTIVITY",
    ]) {
      expect(env).toContain(variable);
      // Compose passes every one through, or setting it would work from
      // source and silently do nothing in the container.
      expect(read("docker-compose.yml")).toContain(variable);
    }
  });

  it("switches every Worker example module on from its environment", async () => {
    // Construction and describeConfig() run no statement: tables are created
    // on first use, so a binding that answers nothing is enough here.
    const d1 = { prepare: () => ({ bind: () => ({}) }), batch: async () => [] };
    const base = {
      CONNECTA_DB: d1,
      DOWNSTREAM_TOKEN: "downstream",
      PUBLIC_URL: "https://worker.example",
      CONNECTA_MAINTAINERS: "operator@example.com",
      LOADER: { get: () => ({}) },
    };
    const env = (extra: Record<string, unknown>) =>
      ({ ...base, ...extra }) as unknown as Parameters<typeof workerConfig>[0];
    const config = workerConfig(env({}));
    // Maintainers decide management (#837); no resolver remains to configure.
    expect(config).not.toHaveProperty("identity");
    const off = createConnecta({ ...config, logger: "silent" });
    const quiet = off.describeConfig();
    expect(quiet.maintainers).toEqual([{ namespace: "cloudflare-access", id: "operator@example.com" }]);
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
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(wrangler).not.toContain("kv_namespaces");
    expect(wrangler.match(/"binding":/g)).toHaveLength(2);
    expect(wrangler).toContain('"binding": "CONNECTA_DB"');
    expect(wrangler).toContain('"binding": "LOADER"');
  });

  it("keeps empty storage fail-closed and admits only issued agent tokens (INV-4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "connecta-template-auth-"));
    const staticToken = `cta_${"A".repeat(43)}`;
    const env = { CONNECTA_DATABASE: join(dir, "state.sqlite"), CONNECTA_TOKEN: staticToken };
    const config = nodeConfig(env);
    const app = createConnecta({ ...config, logger: "silent" });
    const initialize = async (token?: string, path = "/agent/local-machine") => {
      const response = await app.fetch(
        new Request(`http://localhost:8787${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "template-test", version: "1" },
            },
          }),
        }),
      );
      await response.body?.cancel();
      return response;
    };
    try {
      expect(app.describeConfig().auth.map((provider) => provider.kind)).toEqual(["access_token"]);
      expect((await app.fetch(new Request("http://localhost:8787/health"))).status).toBe(200);
      expect((await initialize()).status).toBe(401);
      expect((await initialize(staticToken)).status).toBe(401);
      expect(config.agents).toEqual(["local-machine"]);
      const manager = new AccessTokenManager(config.storage!, { agents: config.agents ?? [] });
      const { token } = await manager.rotate("local-machine", "local-provisioning");
      expect(token).toMatch(/^cta_[A-Za-z0-9_-]{43}$/);
      expect((await initialize(token)).status).toBe(200);
      // Agents reach pools only at /agent/<pool>; human endpoints refuse cta_ (#837).
      expect((await initialize(token, "/mcp")).status).toBe(401);
      expect((await initialize(token, "/mcp/local")).status).toBe(401);
      const { token: rotated } = await manager.rotate("local-machine", "local-provisioning");
      expect((await initialize(token)).status).toBe(401);
      expect((await initialize(rotated)).status).toBe(200);
      await manager.revoke("local-machine");
      expect((await initialize(rotated)).status).toBe(401);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(read(".env.example")).toMatch(/^CONNECTA_TOKEN=\s*$/m);
    expect(read("docker-compose.yml")).not.toMatch(/^\s+CONNECTA_TOKEN:/m);
    expect(read("src", "connecta.config.ts")).not.toContain("CONNECTA_TOKEN");
  });
});
