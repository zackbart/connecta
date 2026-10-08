import { describe, expect, it } from "vitest";
import { createTestConnecta } from "./helpers.js";
import { bearerToken } from "../src/auth/bearer.js";
import { memoryStorage } from "../src/storage/memory.js";
import { OPERATOR_UI_ASSETS, OPERATOR_UI_SCRIPT_PATH, OPERATOR_UI_STYLE_PATH } from "../src/operator-ui/generated.js";
import { renderUiHtml } from "../src/ui.js";

const BASE = "https://connecta.test";
const deployment = () => createTestConnecta({ connectors: [], auth: bearerToken("test"), storage: memoryStorage(), publicUrl: BASE });

describe("operator assets on both runtimes", () => {
  it("serves exact hashed assets without authentication, with immutable caching and conditional HEAD", async () => {
    const c = deployment();
    for (const [path, asset] of Object.entries(OPERATOR_UI_ASSETS)) {
      expect(path).toMatch(/^\/ui\/assets\/.+-[A-Za-z0-9]{8,16}\.(js|css|woff2|txt)$/);
      const get = await c.fetch(new Request(BASE + path));
      expect(get.status).toBe(200);
      expect(get.headers.get("content-type")).toBe(asset.type);
      expect(get.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(get.headers.get("x-content-type-options")).toBe("nosniff");
      const expected = asset.binary ? Uint8Array.from(atob(asset.body), char => char.charCodeAt(0)) : new TextEncoder().encode(asset.body);
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(expected);
      const head = await c.fetch(new Request(BASE + path, { method: "HEAD" }));
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(head.headers.get("etag")).toBe(get.headers.get("etag"));
      const conditional = await c.fetch(new Request(BASE + path, { headers: { "If-None-Match": `"older", W/${get.headers.get("etag")}` } }));
      expect(conditional.status).toBe(304);
      expect(await conditional.text()).toBe("");
    }
  });

  it("refuses unknown assets and mutations without long-lived caching", async () => {
    const c = deployment();
    for (const path of ["/ui/assets/missing.js", "/ui/assets/__proto__"]) {
      const response = await c.fetch(new Request(BASE + path));
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const response = await c.fetch(new Request(BASE + OPERATOR_UI_SCRIPT_PATH, { method: "POST" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("keeps the open shell small and hosts Inter in its hashed stylesheet", () => {
    const html = renderUiHtml();
    expect(html.length).toBeLessThan(5000);
    expect(html).toContain(OPERATOR_UI_SCRIPT_PATH);
    expect(html).toContain(OPERATOR_UI_STYLE_PATH);
    const css = OPERATOR_UI_ASSETS[OPERATOR_UI_STYLE_PATH]!.body;
    const font = Object.keys(OPERATOR_UI_ASSETS).find(path => path.endsWith(".woff2"));
    expect(font).toBeTruthy();
    expect(css).toContain(font);
    expect(html).not.toContain("https://fonts.");
  });
});
