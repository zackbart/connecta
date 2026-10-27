import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { test as base, expect, type Page } from "@playwright/test";
import { api } from "../../src/connectors/api.js";
import { activityHistory } from "../../src/activity.js";
import { encryptedCredentialVault } from "../../src/credentials.js";
import { listen } from "../../src/node.js";
import { credentialKeys } from "../../src/storage/keys.js";
import { openSqlite, sqliteActivityStore, sqliteStorage } from "../../src/sqlite.js";
import { connectMcp, parseJson } from "../../eval/support/mcp.js";
import { createTestConnecta } from "../helpers.js";
import { fakeClerkAuth } from "../fixtures/http.js";

const TOKEN = "flows-clerk-session";
const CLERK = "https://clerk.example.test";
const CLERK_KEY = `pk_test_${Buffer.from("clerk.example.test$").toString("base64")}`;
const SECRET = "flows-vault-secret-1234";
const ACCESS_TOKEN = "flows-downstream-access";
const REFRESH_TOKEN = "flows-downstream-refresh";
const SEAL_KEY = Buffer.alloc(32, 7).toString("base64");

type RequestFact = { method: string; path: string; authorization: string | undefined };
type Deployment = {
  origin: string;
  storage: ReturnType<typeof sqliteStorage>;
  restart(): Promise<void>;
  checkScope(connected: boolean): Promise<void>;
  credentialWrites(): string[];
  refuseSave(refuse: boolean): void;
  vault: ReturnType<typeof encryptedCredentialVault>;
  requests: RequestFact[];
  exchanges: URLSearchParams[];
  downstream: string[];
  consents: URL[];
  clerkLoads: string[];
};

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

// Only identity/provider traffic is stubbed. Operator HTML, assets, API reads,
// mutations, handoffs and callbacks all cross the production Node adapter.
const test = base.extend<{ deployment: Deployment }>({
  deployment: async ({ context }, use) => {
    const directory = await mkdtemp(join(tmpdir(), "connecta-browser-"));
    const path = join(directory, "connecta.sqlite");
    let database = openSqlite(path);
    let storage = sqliteStorage(database);
    let vault = encryptedCredentialVault(storage, SEAL_KEY);
    await storage.get("warm");
    // Count actual committed rows, including accidental repeated dispatches.
    database.exec(`CREATE TABLE credential_writes (operation TEXT NOT NULL);
      CREATE TRIGGER credential_insert AFTER INSERT ON connecta_kv
      WHEN NEW.key = 'conn:vaulted:credential:v1'
      BEGIN INSERT INTO credential_writes VALUES ('insert'); END;
      CREATE TRIGGER credential_update AFTER UPDATE ON connecta_kv
      WHEN NEW.key = 'conn:vaulted:credential:v1'
      BEGIN INSERT INTO credential_writes VALUES ('update'); END;
      CREATE TRIGGER credential_delete AFTER DELETE ON connecta_kv
      WHEN OLD.key = 'conn:vaulted:credential:v1'
      BEGIN INSERT INTO credential_writes VALUES ('delete'); END;`);
    const requests: RequestFact[] = [];
    const exchanges: URLSearchParams[] = [];
    const downstream: string[] = [];
    const consents: URL[] = [];
    const clerkLoads: string[] = [];
    const violations: unknown[] = [];
    const unexpectedNetwork: string[] = [];
    const codes = new Map<string, URL>();
    const originalFetch = globalThis.fetch;

    let providerOrigin: string;
    let origin: string;
    const providerFetch = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      if (url.pathname === "/authorize" && request.method === "GET") {
        consents.push(url);
        const code = `flows-code-${consents.length}`;
        codes.set(code, url);
        return new Response(
          `<!doctype html><title>Provider consent</title>
          <h1>Allow Connecta to read records?</h1><form action="${escapeAttribute(url.searchParams.get("redirect_uri")!)}">
          <input type="hidden" name="state" value="${escapeAttribute(url.searchParams.get("state")!)}">
          <input type="hidden" name="code" value="${code}"><button>Allow access</button></form>`,
          {
            headers: {
              "Content-Type": "text/html",
              "Content-Security-Policy":
                "script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            },
          },
        );
      }
      if (url.href === `${providerOrigin}/token`) {
        const params = new URLSearchParams(await request.text());
        exchanges.push(params);
        const consent = codes.get(params.get("code") ?? "");
        const challenge = Buffer.from(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(params.get("code_verifier") ?? "")),
        ).toString("base64url");
        if (
          request.method !== "POST" ||
          !consent ||
          params.get("grant_type") !== "authorization_code" ||
          params.get("client_id") !== "flows-client" ||
          params.get("redirect_uri") !== consent.searchParams.get("redirect_uri") ||
          challenge !== consent.searchParams.get("code_challenge")
        ) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        codes.delete(params.get("code")!);
        return Response.json({
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (url.href === `${providerOrigin}/credential-check`) {
        const authorization = request.headers.get("authorization") ?? "";
        downstream.push(authorization);
        return Response.json(
          { ok: authorization === `Bearer ${SECRET}` },
          { status: authorization === `Bearer ${SECRET}` ? 200 : 401 },
        );
      }
      unexpectedNetwork.push(request.url);
      return Response.json({ error: "Unexpected provider request" }, { status: 404 });
    };

    const providerServer = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const response = await providerFetch(
        new Request(new URL(incoming.url ?? "/", providerOrigin), {
          method: incoming.method ?? "GET",
          headers: incoming.headers as HeadersInit,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    });
    providerServer.listen(0, "127.0.0.1");
    await once(providerServer, "listening");
    const providerAddress = providerServer.address();
    if (!providerAddress || typeof providerAddress === "string")
      throw new Error("Provider stub did not bind a TCP port");
    providerOrigin = `http://127.0.0.1:${providerAddress.port}`;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === providerOrigin || url.origin === origin) return originalFetch(input, init);
      unexpectedNetwork.push(url.href);
      throw new Error(`Unexpected server fetch: ${url.href}`);
    };

    const build = () =>
      createTestConnecta({
        calls: { maxResultBytes: 12_000 },
        pools: { reader: { tools: ["vaulted"], members: ["flows-operator"], readOnly: true } },
        auth: fakeClerkAuth({
          token: TOKEN,
          userId: "flows-operator",
          frontendApiUrl: CLERK,
          publishableKey: CLERK_KEY,
        }),
        storage,
        vault,
        activity: activityHistory({ store: sqliteActivityStore(database) }),
        logger: "silent",
        connectors: [
          api("oauth", {
            title: "OAuth service",
            oauth: {
              authorizationEndpoint: `${providerOrigin}/authorize`,
              tokenEndpoint: `${providerOrigin}/token`,
              clientId: "flows-client",
              scope: "records:read",
              apiOrigins: [providerOrigin],
            },
            tools: [
              { name: "read", description: "Read records", annotations: { readOnlyHint: true }, handler: () => null },
            ],
          }),
          api("vaulted", {
            title: "Vaulted service",
            credential: { label: "API token" },
            testCredential: async (value) => {
              const response = await fetch(`${providerOrigin}/credential-check`, {
                headers: { Authorization: `Bearer ${value}` },
              });
              return { ok: response.ok };
            },
            tools: [
              {
                name: "read",
                description: "Read records",
                annotations: { readOnlyHint: true },
                handler: () => ({ records: 3 }),
              },
              {
                name: "write",
                description: "Write records",
                annotations: { readOnlyHint: false },
                handler: () => {
                  downstream.push("unexpected write");
                  return null;
                },
              },
            ],
          }),
        ],
      });
    let app = build();
    // Keep the HTTP adapter and origin; replace every app/store/vault instance.
    const server = listen(
      { ...app, fetch: (...args) => app.fetch(...args) },
      { port: 0, host: "127.0.0.1", gracefulShutdown: false },
    );
    server.prependListener("request", (request) =>
      requests.push({
        method: request.method ?? "GET",
        path: request.url ?? "/",
        authorization: request.headers.authorization,
      }),
    );
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Node server did not bind a TCP port");
    origin = `http://127.0.0.1:${address.port}`;

    try {
      // The binding preserves violations across reloads and the OAuth popup.
      await context.exposeBinding("recordFlowCspViolation", (_source, violation) => {
        violations.push(violation);
      });
      await context.addInitScript(`document.addEventListener('securitypolicyviolation', event => {
        void window.recordFlowCspViolation({ url: location.href, directive: event.effectiveDirective, blockedURI: event.blockedURI });
      });`);
      await context.route(
        (url) => ["http:", "https:"].includes(url.protocol) && url.origin !== origin && url.origin !== providerOrigin,
        (route) => {
          unexpectedNetwork.push(route.request().url());
          return route.abort("blockedbyclient");
        },
      );
      await context.route(`${CLERK}/**`, async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/npm/@clerk/clerk-js@6/dist/clerk.browser.js") {
          clerkLoads.push(url.href);
          return route.fulfill({
            contentType: "text/javascript",
            body: `
            if (document.currentScript.dataset.clerkPublishableKey !== ${JSON.stringify(CLERK_KEY)}) throw new Error('Wrong test publishable key');
            const signedIn = document.cookie.split('; ').includes('__session=${TOKEN}');
            window.Clerk = {
              user: signedIn ? { id: 'flows-operator' } : null,
              session: signedIn ? { id: 'flows-session', getToken: async () => ${JSON.stringify(TOKEN)} } : null,
              load: async () => {}, addListener: () => {},
              redirectToSignIn: options => {
                const target = new URL('/sign-in', ${JSON.stringify(CLERK)});
                target.searchParams.set('redirect_url', options.signInFallbackRedirectUrl);
                location.assign(target.href);
              },
              signOut: async options => { document.cookie = '__session=; Max-Age=0; Path=/'; location.assign(options.redirectUrl); },
            };
          `,
          });
        }
        const returnUrl = url.searchParams.get("redirect_url");
        if (
          (url.pathname === "/sign-in" || url.pathname === "/fixture/session") &&
          returnUrl &&
          new URL(returnUrl).origin === origin
        ) {
          if (url.pathname === "/fixture/session") {
            await context.addCookies([{ name: "__session", value: TOKEN, url: origin, sameSite: "Lax" }]);
            return route.fulfill({ status: 302, headers: { Location: returnUrl }, body: "" });
          }
          return route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><title>Test Clerk sign-in</title>
            <h1>Test Clerk sign-in</h1><form action="/fixture/session">
            <input type="hidden" name="redirect_url" value="${escapeAttribute(returnUrl)}">
            <button>Sign in as test operator</button></form>`,
          });
        }
        unexpectedNetwork.push(url.href);
        return route.abort("blockedbyclient");
      });

      await use({
        origin,
        get storage() {
          return storage;
        },
        get vault() {
          return vault;
        },
        requests,
        exchanges,
        downstream,
        consents,
        clerkLoads,
        async checkScope(connected) {
          const client = await connectMcp(`${origin}/mcp/reader`, { Authorization: `Bearer ${TOKEN}` });
          try {
            const read = await client.call("call_tool", { address: "vaulted.read", args: {} });
            expect(read.isError, read.text).toBe(!connected);
            if (connected) expect(parseJson(read.text)).toEqual({ records: 3 });
            const refused = await client.call("call_destructive_tool", {
              address: "vaulted.write",
              args: {},
              reason: "scope check",
            });
            expect(refused.isError).toBe(true);
            expect(refused.text).toContain("read_only_endpoint");
            expect(downstream).not.toContain("unexpected write");
          } finally {
            await client.close();
          }
        },
        async restart() {
          await app.close();
          database.close();
          database = openSqlite(path);
          storage = sqliteStorage(database);
          vault = encryptedCredentialVault(storage, SEAL_KEY);
          app = build();
        },
        credentialWrites() {
          const reader = new DatabaseSync(path, { readOnly: true });
          try {
            return reader
              .prepare("SELECT operation FROM credential_writes ORDER BY rowid")
              .all()
              .map((row) => String(row.operation));
          } finally {
            reader.close();
          }
        },
        refuseSave(refuse) {
          database.exec(
            refuse
              ? `CREATE TRIGGER refuse_save BEFORE INSERT ON connecta_kv
            WHEN NEW.key = 'conn:vaulted:credential:v1'
            BEGIN SELECT RAISE(ABORT, 'private storage failure'); END`
              : "DROP TRIGGER refuse_save",
          );
        },
      });
      expect(violations, "CSP violations across every flow document").toEqual([]);
      expect(unexpectedNetwork, "Only loopback and stubbed identity/provider traffic is allowed").toEqual([]);
    } finally {
      try {
        await Promise.all([
          app.close(),
          new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
          new Promise<void>((resolve, reject) => providerServer.close((error) => (error ? reject(error) : resolve()))),
        ]);
      } finally {
        globalThis.fetch = originalFetch;
        database.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
});

async function openShell(page: Page, deployment: Deployment, path: string, signedIn = true) {
  if (signedIn) await page.context().addCookies([{ name: "__session", value: TOKEN, url: deployment.origin }]);
  const response = await page.goto(deployment.origin + path);
  expect(response!.status()).toBe(200);
  expect(response!.headers()["content-security-policy"]).toContain(
    `script-src 'self' ${CLERK} https://challenges.cloudflare.com;`,
  );
  expect(response!.headers()["content-security-policy"]).toContain(
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  // Fonts come from the unmodified hashed asset routes, never a CDN.
  await page.evaluate("document.fonts.ready");
  expect(deployment.requests.some((request) => /^\/ui\/assets\/hanken-grotesk-.+\.woff2$/.test(request.path))).toBe(
    true,
  );
}

test("INV-4: Clerk sign-in admits a session before loading real operator data", async ({ page, deployment }) => {
  await openShell(page, deployment, "/connectors", false);
  await expect(page.getByRole("button", { name: "Team sign in", exact: true })).toBeVisible();
  const script = deployment.requests.find((request) => /^\/ui\/assets\/.*\.js$/.test(request.path))!.path;
  const asset = await page.request.get(deployment.origin + script);
  expect(asset.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  const head = await page.request.head(deployment.origin + script);
  expect(head.status()).toBe(200);
  expect(await head.body()).toHaveLength(0);
  expect(head.headers().etag).toBe(asset.headers().etag);
  const cached = await page.request.get(deployment.origin + script, {
    headers: { "If-None-Match": `W/${asset.headers().etag}` },
  });
  expect(cached.status()).toBe(304);
  expect((await page.request.post(deployment.origin + script)).status()).toBe(405);
  for (const path of ["/ui/assets/missing.js", "/ui/assets/__proto__"]) {
    const missing = await page.request.get(deployment.origin + path);
    expect(missing.status()).toBe(404);
    expect(missing.headers()["cache-control"]).toBe("no-store");
  }
  await expect(page.getByRole("link", { name: "Vaulted service", exact: true })).toHaveCount(0);
  expect(deployment.requests.some((request) => request.path === "/ui/data")).toBe(false);
  expect((await page.request.get(deployment.origin + "/ui/api/config")).status()).toBe(401);

  await page.getByRole("button", { name: "Team sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Test Clerk sign-in" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("redirect_url")).toBe(deployment.origin + "/connectors");
  await page.getByRole("button", { name: "Sign in as test operator" }).click();
  await expect(page).toHaveURL(deployment.origin + "/connectors");
  await expect(page.getByRole("link", { name: "Vaulted service", exact: true })).toBeVisible();
  expect(deployment.requests).toContainEqual({ method: "GET", path: "/ui/data", authorization: `Bearer ${TOKEN}` });
  expect(deployment.requests).toContainEqual({
    method: "GET",
    path: "/ui/api/config?live=cached",
    authorization: `Bearer ${TOKEN}`,
  });
  expect(deployment.clerkLoads).toHaveLength(2);
  await page.reload();
  await expect(page.getByRole("link", { name: "Vaulted service", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Team sign in", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  const settings = page.locator("#settingsView");
  await expect(settings).toContainText("Defined in code");
  await expect(settings).toContainText("SQLite");
  await expect(settings.locator('[data-config-path="config.limits.calls.maxResultBytes"]')).toContainText("12 KB");
  await expect(settings.locator('[data-config-path="config.limits.calls.maxResultBytes"]')).toContainText(
    "set in code",
  );
  await expect(settings.locator('[data-config-path="config.limits.calls.defaultTimeoutMs"]')).toContainText("default");
  await expect(settings.locator("input, select, textarea")).toHaveCount(0);
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Team sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Vaulted service", exact: true })).toHaveCount(0);
  expect((await page.request.get(deployment.origin + "/ui/api/config")).status()).toBe(401);
});

test("INV-4 INV-5 INV-10: OAuth connect traverses signed handoff, consent and callback then rereads connected state", async ({
  page,
  deployment,
}) => {
  await openShell(page, deployment, "/connectors/oauth#auth");
  await expect(page.getByRole("button", { name: "Connect OAuth service", exact: true })).toBeVisible();
  expect(deployment.consents).toEqual([]);
  expect(deployment.exchanges).toEqual([]);

  const popup = page.waitForEvent("popup");
  const started = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/ui/oauth/oauth" && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Connect OAuth service", exact: true }).click();
  const consentPage = await popup;
  const startResponse = await started;
  expect(startResponse.status()).toBe(200);
  const handoff = new URL((await startResponse.json()).authorizationUrl);
  expect(handoff.origin).toBe(deployment.origin);
  expect(handoff.pathname).toBe("/connect/oauth");
  expect(handoff.searchParams.get("h")).toBeTruthy();
  expect(handoff.searchParams.get("start")).toBe("1");
  await expect(consentPage.getByRole("heading", { name: "Allow Connecta to read records?" })).toBeVisible();
  expect(deployment.requests.some((request) => request.path === handoff.pathname + handoff.search)).toBe(true);
  expect(deployment.consents).toHaveLength(1);
  const consent = deployment.consents[0]!;
  expect(consent.searchParams.get("redirect_uri")).toBe(deployment.origin + "/oauth/callback/oauth");
  expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
  expect(consent.searchParams.get("state")).toBeTruthy();
  expect(deployment.exchanges).toEqual([]);
  expect(await consentPage.evaluate("window.opener")).toBeNull();

  const callback = consentPage.waitForResponse(
    (response) => new URL(response.url()).pathname === "/oauth/callback/oauth",
  );
  await consentPage.getByRole("button", { name: "Allow access" }).click();
  const callbackResponse = await callback;
  expect(callbackResponse.status()).toBe(200);
  expect(callbackResponse.headers()["content-security-policy"]).toBe(
    "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  await expect(consentPage.locator('[data-oauth-callback="connected"]')).toBeVisible();
  expect(deployment.exchanges).toHaveLength(1);
  expect(deployment.exchanges[0]!.get("code_verifier")).toBeTruthy();
  await expect(consentPage.locator("body")).not.toContainText(ACCESS_TOKEN);

  const siblingReads = deployment.requests.filter((r) => r.path === "/ui/connectors/vaulted").length;
  const admissionReads = deployment.requests.filter((r) => r.path.startsWith("/ui/api/config")).length;
  const reread = page.waitForResponse((response) => new URL(response.url()).pathname === "/ui/connectors/oauth");
  await consentPage.close();
  await page.bringToFront();
  // Headless Chromium does not reliably emit focus when closing a popup.
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  const connected = await reread;
  const facts = await connected.json();
  expect(facts.status).toBe("ok");
  expect(facts.overlay.status).toBe("ok");
  expect(deployment.requests.filter((r) => r.path === "/ui/connectors/vaulted")).toHaveLength(siblingReads);
  expect(deployment.requests.filter((r) => r.path.startsWith("/ui/api/config"))).toHaveLength(admissionReads);
  expect(JSON.stringify(facts)).not.toContain(ACCESS_TOKEN);
  expect(JSON.stringify(facts)).not.toContain(REFRESH_TOKEN);
  await expect(page.getByRole("button", { name: "Disconnect OAuth service", exact: true })).toBeVisible();
  await expect(page.locator("#oauthNotice-oauth")).toHaveText("Connected.");
  expect(deployment.requests.filter((request) => request.path.startsWith("/ui/oauth/"))).toHaveLength(1);
  const stored = (
    await Promise.all((await deployment.storage.list("")).map((key) => deployment.storage.get(key)))
  ).join("\n");
  expect(stored).not.toContain(ACCESS_TOKEN);
  expect(stored).not.toContain(REFRESH_TOKEN);
  await deployment.restart();
  await page.reload();
  await expect(page.getByRole("button", { name: "Disconnect OAuth service", exact: true })).toBeVisible();
  expect(deployment.exchanges).toHaveLength(1);
  await page.getByRole("button", { name: "Disconnect OAuth service", exact: true }).click();
  await page
    .getByRole("group", { name: /Disconnect OAuth service/ })
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Connect OAuth service", exact: true })).toBeVisible();
  await deployment.restart();
  await page.reload();
  await expect(page.getByRole("button", { name: "Connect OAuth service", exact: true })).toBeVisible();
  expect(deployment.exchanges).toHaveLength(1);
});

test("INV-5: credential save encrypts the vault value and Test sends the saved secret downstream", async ({
  page,
  deployment,
}) => {
  await openShell(page, deployment, "/connectors/vaulted#auth");
  const card = page.locator("#credential-vaulted");
  await deployment.checkScope(false);
  await expect(page.getByText("Credential needed", { exact: true }).first()).toBeVisible();
  await card.getByRole("button", { name: "Add credential", exact: true }).click();
  await card.getByLabel("API token", { exact: true }).fill(SECRET);
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/ui/credentials/vaulted" && response.request().method() === "PUT",
  );
  await card.getByRole("button", { name: "Save", exact: true }).click();
  const saveResponse = await saved;
  expect(saveResponse.status()).toBe(200);
  expect(await saveResponse.text()).not.toContain(SECRET);
  await expect(card.locator("#credentialNotice-vaulted")).toHaveText("Credential saved.");
  await expect(card.getByLabel("API token", { exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Test", exact: true })).toBeVisible();
  const sealed = await deployment.storage.get(credentialKeys.credential("vaulted"));
  expect(JSON.parse(sealed!)).toMatchObject({ version: 1, algorithm: "AES-GCM", ciphertext: expect.any(String) });
  expect(sealed).not.toContain(SECRET);
  expect(await deployment.vault.get("vaulted")).toBe(SECRET);
  expect(deployment.downstream).toEqual([]);

  const tested = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/ui/credentials/vaulted/test",
  );
  await card.getByRole("button", { name: "Test", exact: true }).click();
  const testResponse = await tested;
  expect(testResponse.status()).toBe(200);
  expect(await testResponse.json()).toMatchObject({ ok: true });
  await expect(card.locator("#credentialNotice-vaulted")).toHaveText("Credential is valid.");
  expect(deployment.downstream).toEqual([`Bearer ${SECRET}`]);
  await expect(page.locator("body")).not.toContainText(SECRET);
  expect(await page.content()).not.toContain(SECRET);
  expect(deployment.requests.filter((request) => request.path.startsWith("/ui/credentials/"))).toEqual([
    { method: "PUT", path: "/ui/credentials/vaulted", authorization: `Bearer ${TOKEN}` },
    { method: "POST", path: "/ui/credentials/vaulted/test", authorization: `Bearer ${TOKEN}` },
  ]);
  expect(deployment.credentialWrites()).toEqual(["insert"]);
  await deployment.checkScope(true);
  await deployment.restart();
  await page.reload();
  await expect(card.getByRole("button", { name: "Replace", exact: true })).toBeVisible();
  await expect(page.getByText("Credential needed", { exact: true })).toHaveCount(0);
  const facts = await page.request.get(deployment.origin + "/ui/api/config", {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(facts.status()).toBe(200);
  expect(await facts.text()).not.toContain(SECRET);
  await card.getByRole("button", { name: "Replace", exact: true }).click();
  const replacement = SECRET + "-replacement";
  await card.getByLabel("API token", { exact: true }).fill(replacement);
  deployment.refuseSave(true);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.locator("#credentialNotice-vaulted")).toHaveText(
    "Not saved. A value is empty or in the wrong format.",
  );
  expect(await page.content()).not.toContain("private storage failure");
  expect(deployment.credentialWrites()).toEqual(["insert"]);
  expect(await deployment.vault.get("vaulted")).toBe(SECRET);
  deployment.refuseSave(false);
  await deployment.restart();
  await page.reload();
  await card.getByRole("button", { name: "Test", exact: true }).click();
  await expect(card.locator("#credentialNotice-vaulted")).toHaveText("Credential is valid.");
  expect(deployment.downstream).toEqual([`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
  await card.getByRole("button", { name: "Replace", exact: true }).click();
  await card.getByLabel("API token", { exact: true }).fill(replacement);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.locator("#credentialNotice-vaulted")).toHaveText("Credential saved.");
  expect(await deployment.vault.get("vaulted")).toBe(replacement);
  expect(deployment.credentialWrites()).toEqual(["insert", "update"]);
  await deployment.checkScope(true);
  expect(await page.content()).not.toContain(replacement);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await card.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(
    card
      .getByRole("group", { name: /Remove Vaulted service's credential/ })
      .getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await card
    .getByRole("group", { name: /Remove Vaulted service's credential/ })
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(card.locator("#credentialNotice-vaulted")).toHaveText("Credential removed.");
  expect(await deployment.vault.get("vaulted")).toBeNull();
  expect(deployment.credentialWrites()).toEqual(["insert", "update", "delete"]);
  await deployment.restart();
  await page.reload();
  await expect(card.getByRole("button", { name: "Add credential", exact: true })).toBeVisible();
  expect(deployment.credentialWrites()).toEqual(["insert", "update", "delete"]);
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page.locator(".activity-item.success").filter({ hasText: "vaulted.read" }).first()).toBeVisible();
  await expect(page.locator("#activityView")).not.toContainText(SECRET);
  await expect(page.locator("#activityView")).not.toContainText(replacement);
  await deployment.checkScope(false);
  expect(dialogs).toEqual([]);
});
