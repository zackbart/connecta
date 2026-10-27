// Real operator routes and production assets with trusted Worker Access context.
import { expect, test, type Page } from "@playwright/test";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { cloudflareAccessAuth } from "../../src/auth/cloudflare-access.js";
import { CredentialVault, encryptedCredentialVault } from "../../src/credentials.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { createTestConnecta } from "../helpers.js";

let server: Server;
let origin: string;
let app: ReturnType<typeof createTestConnecta>;
let connected = false;
let failIdentityPath: string | undefined;
let omitShellContext = false;
let rejectIdentity = false;
let persistIdentityFailure = false;
let reads: string[] = [];
let failMetadata = false;
let oauthFailed = false;

test.beforeAll(async () => {
  server = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", origin);
    reads.push(url.pathname);
    const fail = failIdentityPath === url.pathname || (persistIdentityFailure && url.pathname === "/ui/data");
    if (fail) failIdentityPath = undefined;
    const omit = omitShellContext && url.pathname === "/connectors/oauth";
    if (omit) omitShellContext = false;
    const response = await app.fetch(
      new Request(url, { method: incoming.method ?? "GET", headers: incoming.headers as Record<string, string> }),
      undefined,
      {
        waitUntil() {},
        ...(!omit
          ? {
              access: {
                aud: "trusted-worker-app",
                async getIdentity() {
                  if (fail && rejectIdentity) return undefined;
                  if (fail) throw new Error("Transient trusted identity lookup failure");
                  return { user_uuid: "operator" };
                },
              },
            }
          : {}),
      },
    );
    const body = Buffer.from(await response.arrayBuffer());
    const headers = Object.fromEntries(response.headers);
    delete headers["content-length"];
    outgoing.writeHead(response.status, headers);
    outgoing.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.beforeEach(async () => {
  connected = false;
  failIdentityPath = undefined;
  omitShellContext = false;
  reads = [];
  failMetadata = false;
  rejectIdentity = false;
  persistIdentityFailure = false;
  oauthFailed = false;
  const storage = memoryStorage();
  const key = Buffer.alloc(32, 7).toString("base64");
  await new CredentialVault(storage, key).set("key", "saved-test-key", "operator");
  const vault = encryptedCredentialVault(storage, key);
  const metadata = vault.metadata.bind(vault);
  vault.metadata = async (...args) => {
    if (failMetadata) throw new Error("Temporary metadata failure");
    return metadata(...args);
  };
  app = createTestConnecta({
    logger: "silent",
    auth: cloudflareAccessAuth(),
    // The Access identity below; operator routes serve maintainers only (#837).
    maintainers: ["operator"],
    storage,
    vault,
    connectors: [
      {
        id: "key",
        title: "Key service",
        kind: "api",
        credential: { label: "API key" },
        listTools: async () => [],
        callTool: async () => null,
        status: async () => ({ state: "ok" }),
      },
      {
        id: "oauth",
        title: "CRM",
        kind: "mcp",
        listTools: async () => [],
        callTool: async () => null,
        status: async () => ({ state: oauthFailed ? "error" : connected ? "ok" : "auth_required" }),
        startAuth: async () => ({ state: "auth_required", authorizationUrl: `${origin}/consent` }),
        disconnectAuth: async () => {},
        finishAuth: async () => {},
        verifyState: async () => true,
      },
    ],
  });
});

test.afterEach(async () => app.close());
test.afterAll(async () => new Promise<void>((resolve) => server.close(() => resolve())));

async function open(page: Page) {
  await page.goto(`${origin}/connectors/oauth#connection`);
}

test("INV-4: retries a transient Access failure on /ui/data without reload", async ({ page }) => {
  failIdentityPath = "/ui/data";
  await open(page);
  await expect(page.locator("#connectorView .conn-head")).toContainText("Authorization needed");
  expect(reads.filter((p) => p === "/ui/data").length).toBeGreaterThan(1);
  await expect(page.locator("#gate")).toHaveCount(0);
});

test("INV-4 INV-9: explicit Access Retry recovers and navigation sends only reads", async ({ page }) => {
  persistIdentityFailure = true;
  await page.clock.install();
  await open(page);
  await expect(page.locator("#gate")).toContainText("Cloudflare Access identity is unavailable");
  const document = page.url();
  const documents = reads.filter((path) => path === "/connectors/oauth").length;
  persistIdentityFailure = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connect CRM", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("button", { name: "Connect CRM", exact: true })).toBeVisible();
  expect(page.url()).toBe(document);
  expect(reads.filter((path) => path === "/connectors/oauth")).toHaveLength(documents);
  expect(reads.some((path) => path.startsWith("/ui/oauth/"))).toBe(false);
});
