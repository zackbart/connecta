import { operatorUi } from "../src/ui.js";
import { activityHistory } from "../src/activity.js";
import { describe, expect, it, vi } from "vitest";
import { machineAuth } from "./helpers/machine-auth.js";
import { memoryStorage } from "../src/storage/memory.js";
import { resolveBranding } from "../src/ui.js";
import { droppedThemeTokens, renderPage, resolveTheme, themeCss } from "../src/branding.js";
import { PAGE_CSS, TOKENS_CSS } from "../src/page-styles.js";
import type { ConnectaBranding, ConnectaTheme, Logger } from "../src/types.js";
import { calcApi, makeDeployment } from "./fixtures/http.js";

const BASE = "https://connecta.test";

/** Every branded operator shell plus the OAuth result page. */
const PAGES = [
  "/",
  "/activity",
  "/oauth/callback/unknown-connector",
];

function brandingConfig(
  branding?: ConnectaBranding,
  extra?: { logger?: Logger },
) {
  return {
    connectors: [calcApi({ empty: true })],
    auth: machineAuth("test-token-123"),
    storage: memoryStorage(),
    publicUrl: BASE,
    ui: operatorUi(branding ? { branding } : {}),
    activity: activityHistory({ store: { record() {}, async list() { return { events: [] }; } } }),
    ...extra,
  };
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

describe("the shared page layout", () => {
  const layout = { title: "T", uiMounted: true, body: "<main>body</main>" };

  it("carries the doctype, the shared tokens, the theme after them, and the masthead", () => {
    const page = renderPage({
      productName: "Acme MCP",
      ownerName: "Acme & Co.",
      ownerUrl: "https://acme.example",
      theme: { accent: "#0a7d55", radius: 4 },
    }, layout);
    expect(page.startsWith('<!doctype html>\n<html lang="en">\n')).toBe(true);
    expect(page).toContain("<title>T</title>");
    expect(page).toContain(TOKENS_CSS + PAGE_CSS + ":root{--accent:#0a7d55;--radius:4px}</style>");
    expect(page).toContain('<a class="brand navlink" href="https://acme.example">Acme &amp; Co.</a>');
    expect(page).toContain('<span class="product">Acme MCP</span>');
    expect(page).toContain("<main>body</main>");
  });

  it("sets data-scheme only for a pinned scheme, with a matching theme color", () => {
    const system = renderPage(undefined, layout);
    expect(system).toContain('<html lang="en">');
    expect(system).toContain('<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">');
    expect(system).toContain('<meta name="theme-color" content="#151a21" media="(prefers-color-scheme: dark)">');
    const dark = renderPage({ theme: { colorScheme: "dark" } }, layout);
    expect(dark).toContain('<html lang="en" data-scheme="dark">');
    expect(dark).toContain('<meta name="theme-color" content="#151a21">');
    expect(dark).not.toContain("prefers-color-scheme: light");
    const configured = renderPage({ themeColor: "#101010", theme: { colorScheme: "dark" } }, layout);
    expect(configured).toContain('<meta name="theme-color" content="#101010">');
    expect(configured.match(/name="theme-color"/g)).toHaveLength(1);
  });

  it("links the default favicon only when the UI serves it, and a configured one always", () => {
    expect(renderPage(undefined, layout)).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n<link rel="shortcut icon" href="/favicon.ico">');
    const headless = renderPage(undefined, { ...layout, uiMounted: false });
    expect(headless).not.toContain("favicon");
    expect(headless).not.toContain('rel="icon"');
    const hosted = renderPage({ favicon: { href: "https://cdn.acme.example/i.svg" } }, { ...layout, uiMounted: false });
    expect(hosted).toContain('<link rel="icon" href="https://cdn.acme.example/i.svg" type="image/svg+xml">');
    expect(hosted).not.toContain("/favicon.ico");
    // A page rendered on another host points its icons at the one that serves them.
    const elsewhere = renderPage(undefined, { ...layout, iconOrigin: "https://main.example/base" });
    expect(elsewhere).toContain('<link rel="icon" href="https://main.example/favicon.svg" type="image/svg+xml">');
    expect(elsewhere).toContain('<link rel="shortcut icon" href="https://main.example/favicon.ico">');
    const custom = renderPage({ favicon: { href: "/assets/acme.svg" } }, { ...layout, iconOrigin: "https://main.example" });
    expect(custom).toContain('href="https://main.example/assets/acme.svg"');
    const absolute = renderPage({ favicon: { href: "https://cdn.acme.example/i.svg" } }, { ...layout, iconOrigin: "https://main.example" });
    expect(absolute).toContain('href="https://cdn.acme.example/i.svg"');
  });

  it("reads a configured theme color the one way resolveBranding does", () => {
    const page = renderPage({ themeColor: "  #101010  " }, layout);
    expect(page).toContain('<meta name="theme-color" content="#101010">');
    expect(resolveBranding({ themeColor: "  #101010  " }).themeColor).toBe("#101010");
    expect(renderPage({ themeColor: "   " }, layout)).toContain('media="(prefers-color-scheme: dark)"');
  });

  it("escapes every branding value it interpolates", () => {
    const page = renderPage({
      productName: '"><script>x</script>',
      description: "</title><script>y</script>",
    }, { ...layout, title: "<b>t</b>" });
    expect(page).not.toContain("<script>");
    expect(page).toContain("<title>&lt;b&gt;t&lt;/b&gt;</title>");
  });
});

describe("operator theme tokens", () => {
  it("defaults to the stylesheet's own tokens and the OS color scheme", () => {
    const theme = resolveTheme();
    expect(theme).toEqual({ colorScheme: "system" });
    expect(themeCss(theme)).toBe("");
    expect(droppedThemeTokens()).toEqual([]);
  });

  it("keeps the values a deployment is allowed to set", () => {
    const theme = resolveTheme({
      accent: "#7C3AED",
      radius: 4,
      fontFamily: "Inter, system-ui, sans-serif",
      monoFamily: '"JetBrains Mono", monospace',
      colorScheme: "dark",
    });
    expect(theme).toEqual({
      accent: "#7C3AED",
      radius: "4px",
      fontFamily: "Inter, system-ui, sans-serif",
      monoFamily: '"JetBrains Mono", monospace',
      colorScheme: "dark",
    });
    expect(themeCss(theme)).toBe(
      ':root{--accent:#7C3AED;--radius:4px;--sans:Inter, system-ui, sans-serif;' +
        '--mono:"JetBrains Mono", monospace}',
    );
    expect(droppedThemeTokens({ accent: "#7C3AED", radius: 4 })).toEqual([]);
  });

  // The resolver trims before reading, so the warning must too: a value that
  // was applied and a value that was dropped cannot both print as dropped.
  it("does not report a padded value the resolver accepted", () => {
    const theme = { colorScheme: " dark " as NonNullable<ConnectaTheme["colorScheme"]> };
    expect(resolveTheme(theme).colorScheme).toBe("dark");
    expect(droppedThemeTokens(theme)).toEqual([]);
  });

  it("reads radius as pixels only when the operator left off the unit", () => {
    expect(resolveTheme({ radius: "0.5rem" }).radius).toBe("0.5rem");
    expect(resolveTheme({ radius: "12" }).radius).toBe("12px");
    expect(resolveTheme({ radius: 0 }).radius).toBe("0px");
    expect(resolveTheme({ radius: -1 }).radius).toBeUndefined();
  });

  // Every token lands in a `:root` block, so the gates reject anything that
  // could close a declaration, open a function, or leave a string open.
  it.each([
    ["accent", "red"],
    ["accent", "#12"],
    ["accent", "var(--x)"],
    ["accent", "#fff;} html{display:none"],
    ["fontFamily", "Inter; } html { display: none }"],
    ["fontFamily", "url(https://evil.example/f.css)"],
    ["fontFamily", 'Inter", x: expression(alert(1))'],
    ["monoFamily", "Menlo /* comment */"],
    ["colorScheme", "invert"],
  ] as const)("drops a hostile %s (%s)", (token, value) => {
    // Untyped on purpose: a JS call site is where a value this shape arrives.
    const theme = { [token]: value } as ConnectaTheme;
    const resolved = resolveTheme(theme) as unknown as Record<string, unknown>;
    if (token === "colorScheme") expect(resolved.colorScheme).toBe("system");
    else expect(resolved[token]).toBeUndefined();
    expect(droppedThemeTokens(theme)).toEqual([`theme.${token}`]);
    expect(themeCss(resolveTheme(theme))).not.toContain(value);
  });

  it("pins the page's color scheme and appends the token block", async () => {
    const body = await (
      await makeDeployment(
        brandingConfig({ theme: { accent: "#123456", colorScheme: "dark" } }),
      ).fetch(new Request(`${BASE}/`))
    ).text();
    expect(body).toContain('<html lang="en" data-scheme="dark">');
    expect(body).toContain(":root{--accent:#123456}</style>");
  });

  it("leaves the html element alone when the scheme follows the OS", async () => {
    const body = await (
      await makeDeployment(brandingConfig({ theme: { accent: "#123456" } }))
        .fetch(new Request(`${BASE}/`))
    ).text();
    // The stylesheet still carries its `[data-scheme]` selectors; what an
    // unpinned deployment must not carry is the attribute that triggers them.
    expect(body).toContain('<html lang="en">');
    expect(body).not.toContain('<html lang="en" data-scheme');
  });

  it("warns once, naming every theme token it dropped", async () => {
    const logger = spyLogger();
    makeDeployment(
      brandingConfig(
        {
          theme: {
            accent: "red",
            radius: "wide",
            colorScheme: "neon" as NonNullable<ConnectaTheme["colorScheme"]>,
          },
        },
        { logger },
      ),
    );
    const warned = warnings(logger);
    expect(warned).toContain("theme.accent");
    expect(warned).toContain("theme.radius");
    expect(warned).toContain("theme.colorScheme");
  });
});

describe("branding in served pages", () => {
  it("renames the page and drops every default Connecta label", async () => {
    const res = await makeDeployment(brandingConfig({
      productName: "Acme MCP",
      ownerName: "Acme Inc",
      ownerUrl: "https://acme.example",
      themeColor: "#101010",
    })).fetch(new Request(`${BASE}/`));
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
      await makeDeployment(brandingConfig({
        productName: "Acme MCP",
        productUrl: "https://acme.example/docs",
      })).fetch(new Request(`${BASE}/`))
    ).text();
    expect(body).toContain(
      '<a class="brand navlink" href="https://acme.example/docs">Acme MCP</a>',
    );
  });

  it("serves a custom favicon and points the page at a custom href", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const ico = new Uint8Array([0, 0, 1, 0]);
    const c = makeDeployment(brandingConfig({
      productName: "Acme MCP",
      favicon: { svg, ico, href: "https://cdn.acme.example/icon.svg" },
    }));
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
      const c = makeDeployment(brandingConfig({ productName: "Acme MCP", favicon: { href } }));
      for (const path of PAGES) {
        const body = await (await c.fetch(new Request(`${BASE}${path}`))).text();
        expect(iconHref(body)).toBe(href);
      }
    }
  });

  it("keeps the default mark for a format the deployment does not override", async () => {
    const c = makeDeployment(brandingConfig({ favicon: { svg: "<svg/>" } }));
    const icoRes = await c.fetch(new Request(`${BASE}/favicon.ico`));
    expect(icoRes.status).toBe(200);
    expect((await icoRes.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("brands the OAuth result page too", async () => {
    const body = await (
      await makeDeployment(brandingConfig({ productName: "Acme MCP" })).fetch(
        new Request(`${BASE}/oauth/callback/unknown-connector`),
      )
    ).text();
    expect(body).toContain("<title>Authorization could not be completed — Acme MCP</title>");
    expect(body).toContain("Start authorization again from Acme MCP.");
    expect(body).not.toContain("Connecta");
  });
});

describe("branding is not an injection vector", () => {
  it.each([
    ["cannot break out of the dashboard's script block", async () => {
      const body = await (
        await makeDeployment(brandingConfig({ productName: '</script><img src=x onerror=alert(1)>' })).fetch(
          new Request(`${BASE}/`),
        )
      ).text();
      expect(body).not.toContain("</script><img");
      const config = /<script id="operatorConfig" type="application\/json">([^<]*)<\/script>/.exec(body)![1]!;
      expect(config).not.toContain("<");
      expect(JSON.parse(config).productName).toBe('</script><img src=x onerror=alert(1)>');
    }],

    ["never renders a javascript: favicon href on either page", async () => {
      const c = makeDeployment(brandingConfig({
        productName: "Acme MCP",
        favicon: { href: "javascript:alert(1)" },
      }));
      for (const path of PAGES) {
        const body = await (await c.fetch(new Request(`${BASE}${path}`))).text();
        expect(iconHref(body)).toBe("/favicon.svg");
      }
    }],

    ["never renders a javascript: product or owner link", async () => {
      const c = makeDeployment(brandingConfig({
        productName: "Acme MCP",
        productUrl: "javascript:alert(1)",
        ownerName: "Acme Inc",
        ownerUrl: "javascript:alert(2)",
      }));
      for (const path of PAGES) {
        const body = await (await c.fetch(new Request(`${BASE}${path}`))).text();
        expect(
          hrefs(body).filter((h) => h.toLowerCase().startsWith("javascript:")),
        ).toEqual([]);
        expect(body).toContain('<span class="brand">Acme Inc</span>');
      }
    }],

    ["never renders a same-origin-looking favicon href with an authority", async () => {
      for (const href of [
        "//connecta.invalid/x.svg",
        "//CONNECTA.INVALID/x",
        "/\\connecta.invalid/x",
        "//connecta.invalid:443/x",
        "//user@connecta.invalid/x",
        "//evil.example/icon.svg",
      ]) {
        const c = makeDeployment(brandingConfig({ favicon: { href } }));
        for (const path of PAGES) {
          const body = await (await c.fetch(new Request(`${BASE}${path}`))).text();
          expect(iconHref(body)).toBe("/favicon.svg");
        }
      }
    }],

    ["survives a non-string favicon href instead of failing construction", async () => {
      const logger = spyLogger();
      const c = makeDeployment(brandingConfig(
        { favicon: { href: 42 as unknown as string } },
        { logger },
      ));
      for (const path of PAGES) {
        const body = await (await c.fetch(new Request(`${BASE}${path}`))).text();
        expect(iconHref(body)).toBe("/favicon.svg");
      }
      expect(warnings(logger)).toContain("branding favicon.href dropped");
    }],

    ["serves an active-content favicon SVG inertly instead of rejecting it", async () => {
      const hostile =
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
        "<script>alert(1)</script>" +
        '<foreignObject><iframe src="https://evil.example"></iframe></foreignObject>' +
        "</svg>";
      const res = await makeDeployment(brandingConfig({ favicon: { svg: hostile } })).fetch(
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
    }],

    ["escapes branding in HTML attribute and text positions", async () => {
      const body = await (
        await makeDeployment(brandingConfig({
          productName: 'Acme" onload="alert(1)',
          ownerName: "<b>owner</b>",
        })).fetch(new Request(`${BASE}/`))
      ).text();
      expect(body).not.toContain('onload="alert(1)"');
      expect(body).not.toContain("<b>owner</b>");
    }],
  ] as const)("%s", async (_name, run) => run());
});
