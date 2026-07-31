import { describe, expect, it, vi } from "vitest";
import { createTestConnecta } from "./helpers.js";
import { bearerToken } from "../src/auth/bearer.js";
import { memoryStorage } from "../src/storage/memory.js";
import { api } from "../src/connectors/api.js";
import { resolveBranding } from "../src/ui.js";
import type { ConnectaBranding, Logger } from "../src/types.js";

const BASE = "https://connecta.test";

/** Every branded operator shell plus the OAuth result page. */
const PAGES = [
  "/",
  "/credentials",
  "/activity",
  "/oauth/callback/unknown-connector",
];

function make(branding?: ConnectaBranding, extra?: { logger?: Logger }) {
  return createTestConnecta({
    connectors: [api("calc", { description: "Calculator", tools: [] })],
    auth: bearerToken("test-token-123"),
    storage: memoryStorage(),
    publicUrl: BASE,
    ...(branding ? { branding } : {}),
    ...extra,
  });
}

function spyLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function warnings(logger: Logger): string {
  return (logger.warn as ReturnType<typeof vi.fn>).mock.calls
    .map((call) => call.join(" "))
    .join("\n");
}

/**
 * Assert on the href a page actually renders rather than on a substring of the
 * whole body: the body legitimately contains the word "javascript:" (a comment
 * in the inline dashboard script), and a whole-body match also couples the test
 * to the attribute's quoting style.
 */
function hrefs(body: string): string[] {
  return [...body.matchAll(/<(?:a|link)\b[^>]*?\bhref="([^"]*)"/g)].map(
    (m) => m[1] as string,
  );
}

/** The href of the page's `<link rel="icon">`, or undefined when absent. */
function iconHref(body: string): string | undefined {
  const tag = /<link\b[^>]*\brel="icon"[^>]*>/.exec(body)?.[0];
  return tag ? /\bhref="([^"]*)"/.exec(tag)?.[1] : undefined;
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
    }).fetch(new Request(`${BASE}/`));
    const body = await res.text();
    expect(body).toContain(
      "<title>Connections — Acme MCP — Acme Inc</title>",
    );
    expect(body).toContain('content="#101010"');
    expect(body).toContain('href="https://acme.example"');
    expect(body).not.toContain("Connecta");
  });

  it("links the product label when only productUrl is set", async () => {
    const body = await (
      await make({
        productName: "Acme MCP",
        productUrl: "https://acme.example/docs",
      }).fetch(new Request(`${BASE}/`))
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
    const ui = await (await c.fetch(new Request(`${BASE}/`))).text();
    expect(ui).toContain('href="https://cdn.acme.example/icon.svg"');
  });

  it("renders an accepted favicon href on both branded surfaces", async () => {
    for (const href of ["https://cdn.acme.example/icon.svg", "/assets/acme.svg"]) {
      const c = make({ productName: "Acme MCP", favicon: { href } });
      for (const path of PAGES) {
        const body = await (await c.fetch(new Request(`${BASE}${path}`))).text();
        expect(iconHref(body)).toBe(href);
      }
    }
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
        new Request(`${BASE}/`),
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
    for (const path of PAGES) {
      const body = await (await c.fetch(new Request(`${BASE}${path}`))).text();
      expect(iconHref(body)).toBe("/favicon.svg");
    }
  });

  it("never renders a javascript: product or owner link", async () => {
    const c = make({
      productName: "Acme MCP",
      productUrl: "javascript:alert(1)",
      ownerName: "Acme Inc",
      ownerUrl: "javascript:alert(2)",
    });
    for (const path of PAGES) {
      const body = await (await c.fetch(new Request(`${BASE}${path}`))).text();
      expect(
        hrefs(body).filter((h) => h.toLowerCase().startsWith("javascript:")),
      ).toEqual([]);
      expect(body).toContain('<span class="brand">Acme Inc</span>');
    }
  });

  it("never renders a same-origin-looking favicon href with an authority", async () => {
    for (const href of [
      "//connecta.invalid/x.svg",
      "//CONNECTA.INVALID/x",
      "/\\connecta.invalid/x",
      "//connecta.invalid:443/x",
      "//user@connecta.invalid/x",
      "//evil.example/icon.svg",
    ]) {
      const c = make({ favicon: { href } });
      for (const path of PAGES) {
        const body = await (await c.fetch(new Request(`${BASE}${path}`))).text();
        expect(iconHref(body)).toBe("/favicon.svg");
      }
    }
  });

  it("survives a non-string favicon href instead of failing construction", async () => {
    const logger = spyLogger();
    const c = make(
      { favicon: { href: 42 as unknown as string } },
      { logger },
    );
    for (const path of PAGES) {
      const body = await (await c.fetch(new Request(`${BASE}${path}`))).text();
      expect(iconHref(body)).toBe("/favicon.svg");
    }
    expect(warnings(logger)).toContain("branding favicon.href dropped");
  });

  it("serves an active-content favicon SVG inertly instead of rejecting it", async () => {
    const hostile =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
      "<script>alert(1)</script>" +
      '<foreignObject><iframe src="https://evil.example"></iframe></foreignObject>' +
      "</svg>";
    const res = await make({ favicon: { svg: hostile } }).fetch(
      new Request(`${BASE}/favicon.svg`),
    );
    const csp = res.headers.get("content-security-policy") ?? "";

    // Neutralized by the response, not by inspecting the body: `sandbox` puts
    // the document in an opaque origin with scripting off and `default-src
    // 'none'` denies script and the framed subresource, so navigating straight
    // to /favicon.svg cannot run this on the deployment origin.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox");
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    // The body itself is untouched, which is what keeps valid SVGs byte-exact.
    expect(await res.text()).toBe(hostile);
  });

  it("escapes branding in HTML attribute and text positions", async () => {
    const body = await (
      await make({
        productName: 'Acme" onload="alert(1)',
        ownerName: "<b>owner</b>",
      }).fetch(new Request(`${BASE}/`))
    ).text();
    expect(body).not.toContain('onload="alert(1)"');
    expect(body).not.toContain("<b>owner</b>");
  });
});
