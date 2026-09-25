// Artifact pages at the route level: the shells, the JSON API behind them,
// the sandboxed frame, who may view, and what an omitted UI leaves behind.
// test/browser/artifacts.spec.ts drives the same routes in Chromium.

import { describe, expect, it, vi } from "vitest";
import { artifacts, kvArtifactStore } from "../src/artifacts.js";
import { bearerToken } from "../src/auth/bearer.js";
import { createConnecta, type ConnectaConfig } from "../src/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import { operatorUi } from "../src/ui.js";
import type { InboundAuth } from "../src/types.js";
import { mcpRpc } from "./fixtures/http.js";

const BASE = "https://connecta.test";
const TOKEN = "viewer-token";
const executor = { execute: async () => ({ result: null }) };

const page = (body: string) => `<!doctype html>\n<main id="artifact-root">${body}</main>\n`;

async function deploy(config: Partial<ConnectaConfig> = {}) {
  const module = artifacts({ store: kvArtifactStore(memoryStorage()) });
  const app = createConnecta({
    connectors: [],
    executor,
    logger: "silent",
    publicUrl: BASE,
    auth: bearerToken(TOKEN, { subjectId: "viewer" }),
    ui: operatorUi(),
    artifacts: module,
    ...config,
  });
  const ctx = { storage: memoryStorage(), logger: console, baseUrl: BASE };
  const call = (name: string, args: Record<string, unknown>) =>
    module.connector.callTool(name, args, ctx) as Promise<Record<string, any>>;
  await call("create_artifact", {
    id: "q3-bugs",
    title: "Q3 bugs",
    kind: "html",
    source: page("<h1>Bugs by team</h1>"),
    documents: { data: { rows: [1, 2], trap: "</script><script>alert(1)</script>" } },
  });
  await call("update_artifact", { id: "q3-bugs", baseVersion: 1, source: page("<h1>Now</h1>") });
  await call("set_documents", { id: "q3-bugs", documents: { data: { baseVersion: 1, value: { rows: [3] } } } });
  await call("create_artifact", { id: "notes", title: "Planning notes", kind: "markdown", source: "# Notes" });
  const get = (path: string, token: string | null = TOKEN, init: RequestInit = {}) =>
    app.fetch(
      new Request(`${BASE}${path}`, {
        ...init,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers as object) },
      }),
    );
  return { app, get, call };
}

describe("artifact page shells", () => {
  it("serves the library, viewer, and snapshot shells open, data-free, and framed off", async () => {
    const { get } = await deploy();
    for (const path of ["/artifacts", "/artifacts/q3-bugs", "/artifacts/q3-bugs/v/1"]) {
      const response = await get(path, null);
      const body = await response.text();
      expect(response.status, path).toBe(200);
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      const csp = response.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("frame-src 'self'");
      expect(body).not.toContain("Bugs by team");
      expect(body).not.toContain("Q3 bugs");
    }
    const connections = await get("/", null);
    expect(connections.headers.get("Content-Security-Policy")).not.toContain("frame-src");
  });

  it("answers anything else under /artifacts with 404", async () => {
    const { get } = await deploy();
    for (const path of ["/artifacts/", "/artifacts/Bad", "/artifacts/q3-bugs/extra", "/artifacts/_api/nope", "/artifacts/_api/view/_frame"]) {
      expect((await get(path)).status, path).toBe(404);
    }
  });
});

describe("the sandboxed frame", () => {
  it("serves a constant bootstrap to anyone, under a sandboxing CSP it can be framed only by itself", async () => {
    const { get } = await deploy();
    const response = await get("/artifacts/_frame", null);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "sandbox allow-scripts; default-src 'none'; " +
        "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://esm.sh https://unpkg.com; " +
        "style-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com https://unpkg.com; " +
        "font-src data: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.gstatic.com https://unpkg.com; " +
        "img-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; " +
        "manifest-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(response.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    expect(response.headers.get("X-Frame-Options")).toBeNull();
    expect(body).toContain(`const expected = "${BASE}"`);
    expect(body).not.toContain("Q3");
    expect(body).not.toContain("rows");
    expect(await (await get("/artifacts/_frame", TOKEN)).text()).toBe(body);
    expect((await get("/artifacts/_frame", null, { method: "POST" })).status).toBe(405);
  });
});

describe("the artifact API", () => {
  it("lists artifacts privately, with fixed facts and a resolved actor label", async () => {
    const labelled: InboundAuth = {
      ...bearerToken(TOKEN, { subjectId: "viewer" }),
      activityActorLabel: (id) => (id === "viewer" ? "Vera Viewer" : undefined),
    };
    const { get } = await deploy({ auth: labelled });
    const response = await get("/artifacts/_api/list");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const listed = (await response.json()) as { artifacts: Record<string, unknown>[] };
    expect(listed.artifacts.map((row) => row.id)).toEqual(["notes", "q3-bugs"]);
    expect(listed.artifacts[1]).toEqual({
      id: "q3-bugs",
      title: "Q3 bugs",
      kind: "html",
      viewVersion: 2,
      updatedAt: expect.any(String),
      updatedBy: { label: "unknown" },
      archived: false,
    });
    const searched = (await (await get("/artifacts/_api/list?q=planning")).json()) as { artifacts: { id: string }[] };
    expect(searched.artifacts.map((row) => row.id)).toEqual(["notes"]);
  });

  it("labels the person who last changed an artifact from their auth provider", async () => {
    const labelled: InboundAuth = {
      ...bearerToken(TOKEN, { subjectId: "viewer" }),
      activityActorLabel: (id) => (id === "viewer" ? "Vera Viewer" : undefined),
    };
    const { app, get } = await deploy({ auth: labelled });
    await mcpRpc(app, "tools/call", {
      name: "call_destructive_tool",
      arguments: {
        address: "artifacts.archive_artifact",
        args: { id: "notes", baseRevision: 1 },
      },
    }, { baseUrl: BASE, token: TOKEN });
    const listed = (await (await get("/artifacts/_api/list?archived=1")).json()) as {
      artifacts: { id: string; updatedBy: { label: string }; archived: boolean }[];
    };
    expect(listed.artifacts.find((row) => row.id === "notes")).toMatchObject({
      archived: true,
      updatedBy: { label: "Vera Viewer" },
    });
    const visible = (await (await get("/artifacts/_api/list")).json()) as { artifacts: { id: string }[] };
    expect(visible.artifacts.map((row) => row.id)).toEqual(["q3-bugs"]);
  });

  it("serves the current page and exact snapshots as one frame document", async () => {
    const { get } = await deploy();
    const current = (await (await get("/artifacts/_api/view/q3-bugs")).json()) as Record<string, any>;
    expect(current).toMatchObject({
      id: "q3-bugs",
      title: "Q3 bugs",
      snapshot: false,
      latestViewVersion: 2,
      view: { version: 2, by: { label: "unknown" } },
      documents: [{ name: "data", version: 2 }],
      url: `${BASE}/artifacts/q3-bugs`,
      snapshotUrl: `${BASE}/artifacts/q3-bugs/v/2?d=data:2`,
    });
    expect(current.document.startsWith("<!doctype html><script>")).toBe(true);
    expect(current.document).toContain('"data":{"data":{"rows":[3]}}');
    expect(current.document).toContain("<h1>Now</h1>");

    const pinned = (await (await get("/artifacts/_api/view/q3-bugs?v=1&d=data:1")).json()) as Record<string, any>;
    expect(pinned).toMatchObject({ snapshot: true, view: { version: 1 }, documents: [{ name: "data", version: 1 }] });
    expect(pinned.document).toContain("<h1>Bugs by team</h1>");
    expect(pinned.document).toContain('"rows":[1,2]');
    // The page's own data cannot close the script it is injected into.
    expect(pinned.document).not.toContain("</script><script>alert(1)");
    expect(pinned.document).toContain("\\u003c/script>");

    const bare = (await (await get("/artifacts/_api/view/q3-bugs?v=1")).json()) as Record<string, any>;
    expect(bare.documents).toEqual([]);
    expect(bare.document).toContain('"data":{}');
    for (const path of [
      "/artifacts/_api/view/nope",
      "/artifacts/_api/view/q3-bugs?v=9",
      "/artifacts/_api/view/q3-bugs?v=1&d=data:9",
      "/artifacts/_api/view/q3-bugs?v=1&d=__proto__:1",
      "/artifacts/_api/view/q3-bugs?v=x",
    ]) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  it("refuses the unauthenticated, hides pages from identities without the connector, and refuses writes", async () => {
    const { get } = await deploy();
    expect((await get("/artifacts/_api/list", null)).status).toBe(401);
    expect((await get("/artifacts/_api/view/q3-bugs", "wrong")).status).toBe(401);
    expect((await get("/artifacts/_api/list", TOKEN, { method: "POST" })).status).toBe(405);

    const hidden = await deploy({ identity: { connectorAccess: () => [] } });
    expect((await hidden.get("/artifacts/_api/list")).status).toBe(404);
    expect((await hidden.get("/artifacts/_api/view/q3-bugs")).status).toBe(404);
    const readerOnly = await deploy({ identity: { connectorAccess: () => ["artifacts.list_artifacts"] } });
    expect((await readerOnly.get("/artifacts/_api/view/q3-bugs")).status).toBe(404);
    const viewer = await deploy({ identity: { connectorAccess: () => ["artifacts.get_artifact"] } });
    expect((await viewer.get("/artifacts/_api/view/q3-bugs")).status).toBe(200);
  });

  it("refuses every page request on an open deployment", async () => {
    const { get } = await deploy({ auth: [] });
    const response = await get("/artifacts/_api/list", null);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "artifact pages need inbound authentication" });
  });

  it("tells the Connections page whether this identity may open artifacts", async () => {
    const { get } = await deploy();
    expect(await (await get("/ui/data")).json()).toMatchObject({ artifactsEnabled: true });
    const hidden = await deploy({ identity: { connectorAccess: () => [] } });
    expect(await (await hidden.get("/ui/data")).json()).not.toHaveProperty("artifactsEnabled");
  });
});

describe("mounting", () => {
  it("serves no artifact route without the operator UI, and warns that links have no viewer", async () => {
    const logger = { debug() {}, info() {}, warn: vi.fn(), error() {} };
    const { get } = await deploy({ ui: undefined, logger });
    for (const path of ["/artifacts", "/artifacts/q3-bugs", "/artifacts/_frame", "/artifacts/_api/list"]) {
      expect((await get(path)).status, path).toBe(404);
    }
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/without ui: .* no viewer/));
  });

  it("reserves the artifact routes in /health only when both modules are mounted", async () => {
    const { get } = await deploy();
    const health = (await (await get("/health", null)).json()) as { admission: { reservedRoutes: string[] } };
    expect(health.admission.reservedRoutes).toEqual(expect.arrayContaining(["/artifacts", "/artifacts/*"]));
    const bare = await deploy({ ui: undefined });
    const bareHealth = (await (await bare.get("/health", null)).json()) as { admission: { reservedRoutes: string[] } };
    expect(bareHealth.admission.reservedRoutes.filter((route) => route.startsWith("/artifacts"))).toEqual([]);
  });

  it("warns that an open deployment's pages refuse every request", async () => {
    const logger = { debug() {}, info() {}, warn: vi.fn(), error() {} };
    await deploy({ auth: [], logger });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/pages refuse every request/));
  });
});
