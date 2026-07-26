import { describe, expect, it } from "vitest";
import { createConnecta } from "../src/index.js";
import { bearerToken } from "../src/auth/bearer.js";
import { memoryStorage } from "../src/storage/memory.js";
import { api } from "../src/connectors/api.js";
import { resolveBranding } from "../src/ui.js";
import type { ConnectaBranding } from "../src/types.js";

const BASE = "https://connecta.test";

function make(branding?: ConnectaBranding) {
  return createConnecta({
    connectors: [api("calc", { description: "Calculator", tools: [] })],
    auth: bearerToken("test-token-123"),
    storage: memoryStorage(),
    publicUrl: BASE,
    ...(branding ? { branding } : {}),
  });
}

describe("branding defaults", () => {
  it("falls back to Connecta's own labels", () => {
    const brand = resolveBranding();
    expect(brand.productName).toBe("Connecta");
    expect(brand.pageTitle).toBe("Connecta");
    expect(brand.faviconHref).toBe("/favicon.svg");
    expect(brand.themeColor).toBe("#ffffff");
    expect(brand.ownerName).toBeUndefined();
    expect(brand.productUrl).toBeUndefined();
  });

  it("derives a page title from product and owner", () => {
    expect(resolveBranding({ productName: "Acme MCP" }).pageTitle).toBe(
      "Acme MCP",
    );
    expect(
      resolveBranding({ productName: "Acme MCP", ownerName: "Acme Inc" })
        .pageTitle,
    ).toBe("Acme MCP — Acme Inc");
  });

  it("lets pageTitle override the derived title", () => {
    expect(
      resolveBranding({
        productName: "Acme MCP",
        ownerName: "Acme Inc",
        pageTitle: "Acme Tools",
      }).pageTitle,
    ).toBe("Acme Tools");
  });

  it("scopes the default description to the product name", () => {
    expect(resolveBranding({ productName: "Acme MCP" }).description).toContain(
      "Acme MCP",
    );
  });

  it("omits branding link URLs that are not safe http(s) URLs", () => {
    const dangerous = resolveBranding({
      productUrl: "javascript:alert(1)",
      ownerUrl: "javascript:alert(1)",
    });
    expect(dangerous.productUrl).toBeUndefined();
    expect(dangerous.ownerUrl).toBeUndefined();

    const safe = resolveBranding({
      productUrl: "https://acme.example/docs",
      ownerUrl: "https://acme.example",
    });
    expect(safe.productUrl).toBe("https://acme.example/docs");
    expect(safe.ownerUrl).toBe("https://acme.example");
  });

  it("falls back to the default mark for an unsafe favicon href", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:image/svg+xml,<svg/>",
      "//evil.example/icon.svg",
      "icon.svg",
    ]) {
      expect(resolveBranding({ favicon: { href } }).faviconHref).toBe(
        "/favicon.svg",
      );
    }
  });

  it("keeps absolute http(s) and root-relative favicon hrefs", () => {
    expect(
      resolveBranding({ favicon: { href: "https://cdn.acme.example/icon.svg" } })
        .faviconHref,
    ).toBe("https://cdn.acme.example/icon.svg");
    expect(
      resolveBranding({ favicon: { href: "/assets/acme.svg" } }).faviconHref,
    ).toBe("/assets/acme.svg");
  });
});

describe("branding in served pages", () => {
  it("renames the page and drops every default Connecta label", async () => {
    const res = await make({
      productName: "Acme MCP",
      ownerName: "Acme Inc",
      ownerUrl: "https://acme.example",
      themeColor: "#101010",
    }).fetch(new Request(`${BASE}/ui`));
    const body = await res.text();
    expect(body).toContain("<title>Acme MCP — Acme Inc</title>");
    expect(body).toContain('content="#101010"');
    expect(body).toContain('href="https://acme.example"');
    expect(body).not.toContain("Connecta");
  });

  it("links the product label when only productUrl is set", async () => {
    const body = await (
      await make({
        productName: "Acme MCP",
        productUrl: "https://acme.example/docs",
      }).fetch(new Request(`${BASE}/ui`))
    ).text();
    expect(body).toContain(
      '<a class="brand navlink" href="https://acme.example/docs">Acme MCP</a>',
    );
  });

  it("serves a custom favicon and points the page at a custom href", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const ico = new Uint8Array([0, 0, 1, 0]);
    const c = make({
      productName: "Acme MCP",
      favicon: { svg, ico, href: "https://cdn.acme.example/icon.svg" },
    });
    expect(await (await c.fetch(new Request(`${BASE}/favicon.svg`))).text()).toBe(
      svg,
    );
    const icoRes = await c.fetch(new Request(`${BASE}/favicon.ico`));
    expect(new Uint8Array(await icoRes.arrayBuffer())).toEqual(ico);
    const ui = await (await c.fetch(new Request(`${BASE}/ui`))).text();
    expect(ui).toContain('href="https://cdn.acme.example/icon.svg"');
  });

  it("keeps the default mark for a format the deployment does not override", async () => {
    const c = make({ favicon: { svg: "<svg/>" } });
    const icoRes = await c.fetch(new Request(`${BASE}/favicon.ico`));
    expect(icoRes.status).toBe(200);
    expect((await icoRes.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("brands the OAuth result page too", async () => {
    const body = await (
      await make({ productName: "Acme MCP" }).fetch(
        new Request(`${BASE}/oauth/callback/unknown-connector`),
      )
    ).text();
    expect(body).toContain("<title>Acme MCP</title>");
    expect(body).not.toContain("Connecta");
  });
});

describe("branding is not an injection vector", () => {
  it("cannot break out of the dashboard's script block", async () => {
    const body = await (
      await make({ productName: '</script><img src=x onerror=alert(1)>' }).fetch(
        new Request(`${BASE}/ui`),
      )
    ).text();
    expect(body).not.toContain("</script><img");
    expect(body).toContain("<\\/script>");
  });

  it("never renders a javascript: favicon href on either page", async () => {
    const c = make({
      productName: "Acme MCP",
      favicon: { href: "javascript:alert(1)" },
    });
    for (const path of ["/ui", "/oauth/callback/unknown-connector"]) {
      const body = await (await c.fetch(new Request(`${BASE}${path}`))).text();
      expect(body).not.toContain('href="javascript:');
      expect(body).toContain('<link rel="icon" href="/favicon.svg"');
    }
  });

  it("never renders a javascript: product or owner link", async () => {
    const c = make({
      productName: "Acme MCP",
      productUrl: "javascript:alert(1)",
      ownerName: "Acme Inc",
      ownerUrl: "javascript:alert(2)",
    });
    for (const path of ["/ui", "/oauth/callback/unknown-connector"]) {
      const body = await (await c.fetch(new Request(`${BASE}${path}`))).text();
      expect(body).not.toContain('href="javascript:');
      expect(body).toContain('<span class="brand">Acme Inc</span>');
    }
  });

  it("escapes branding in HTML attribute and text positions", async () => {
    const body = await (
      await make({
        productName: 'Acme" onload="alert(1)',
        ownerName: "<b>owner</b>",
      }).fetch(new Request(`${BASE}/ui`))
    ).text();
    expect(body).not.toContain('onload="alert(1)"');
    expect(body).not.toContain("<b>owner</b>");
  });
});
