import { describe, expect, it, vi } from "vitest";
import { activityHistory } from "../src/activity.js";
import { droppedThemeTokens, renderPage, resolveTheme, themeCss } from "../src/branding.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectaBranding, ConnectaTheme, Logger } from "../src/types.js";
import { operatorUi, resolveBranding } from "../src/ui.js";
import { calcApi, makeDeployment } from "./fixtures/http.js";
import { machineAuth } from "./helpers/machine-auth.js";

const BASE = "https://connecta.test";

/** Every branded operator shell plus the OAuth result page. */
const PAGES = ["/", "/activity", "/oauth/callback/unknown-connector"];

function brandingConfig(branding?: ConnectaBranding, extra?: { logger?: Logger }) {
  return {
    connectors: [calcApi({ empty: true })],
    auth: machineAuth("test-token-123"),
    storage: memoryStorage(),
    publicUrl: BASE,
    ui: operatorUi(branding ? { branding } : {}),
    activity: activityHistory({
      store: {
        record() {},
        async list() {
          return { events: [] };
        },
      },
    }),
    ...extra,
  };
}

function spyLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function warnings(logger: Logger): string {
  return (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((call) => call.join(" ")).join("\n");
}

/**
 * Assert on the href a page actually renders rather than on a substring of the
 * whole body: the body legitimately contains the word "javascript:" (a comment
 * in the inline dashboard script), and a whole-body match also couples the test
 * to the attribute's quoting style.
 */
function hrefs(body: string): string[] {
  return [...body.matchAll(/<(?:a|link)\b[^>]*?\bhref="([^"]*)"/g)].map((m) => m[1] as string);
}

/** The href of the page's `<link rel="icon">`, or undefined when absent. */
function iconHref(body: string): string | undefined {
  const tag = /<link\b[^>]*\brel="icon"[^>]*>/.exec(body)?.[0];
  return tag ? /\bhref="([^"]*)"/.exec(tag)?.[1] : undefined;
}

describe("branding defaults", () => {
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
    for (const href of ["javascript:alert(1)", "data:image/svg+xml,<svg/>", "//evil.example/icon.svg", "icon.svg"]) {
      expect(resolveBranding({ favicon: { href } }).faviconHref).toBe("/favicon.svg");
    }
  });
});

describe("the shared page layout", () => {
  const layout = { title: "T", uiMounted: true, body: "<main>body</main>" };

  it("escapes every branding value it interpolates", () => {
    const page = renderPage(
      {
        productName: '"><script>x</script>',
        description: "</title><script>y</script>",
      },
      { ...layout, title: "<b>t</b>" },
    );
    expect(page).not.toContain("<script>");
    expect(page).toContain("<title>&lt;b&gt;t&lt;/b&gt;</title>");
  });
});

describe("operator theme tokens", () => {
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
});

describe("branding is not an injection vector", () => {
  it.each([
    [
      "cannot break out of the dashboard's script block",
      async () => {
        const body = await (
          await makeDeployment(brandingConfig({ productName: "</script><img src=x onerror=alert(1)>" })).fetch(
            new Request(`${BASE}/`),
          )
        ).text();
        expect(body).not.toContain("</script><img");
        const config = /<script id="operatorConfig" type="application\/json">([^<]*)<\/script>/.exec(body)![1]!;
        expect(config).not.toContain("<");
        expect(JSON.parse(config).productName).toBe("</script><img src=x onerror=alert(1)>");
      },
    ],

    [
      "never renders a javascript: favicon href on either page",
      async () => {
        const c = makeDeployment(
          brandingConfig({
            productName: "Acme MCP",
            favicon: { href: "javascript:alert(1)" },
          }),
        );
        for (const path of PAGES) {
          const body = await (await c.fetch(new Request(`${BASE}${path}`))).text();
          expect(iconHref(body)).toBe("/favicon.svg");
        }
      },
    ],

    [
      "never renders a javascript: product or owner link",
      async () => {
        const c = makeDeployment(
          brandingConfig({
            productName: "Acme MCP",
            productUrl: "javascript:alert(1)",
            ownerName: "Acme Inc",
            ownerUrl: "javascript:alert(2)",
          }),
        );
        for (const path of PAGES) {
          const body = await (await c.fetch(new Request(`${BASE}${path}`))).text();
          expect(hrefs(body).filter((h) => h.toLowerCase().startsWith("javascript:"))).toEqual([]);
          expect(body).toContain('<span class="brand">Acme Inc</span>');
        }
      },
    ],

    [
      "never renders a same-origin-looking favicon href with an authority",
      async () => {
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
      },
    ],

    [
      "survives a non-string favicon href instead of failing construction",
      async () => {
        const logger = spyLogger();
        const c = makeDeployment(brandingConfig({ favicon: { href: 42 as unknown as string } }, { logger }));
        for (const path of PAGES) {
          const body = await (await c.fetch(new Request(`${BASE}${path}`))).text();
          expect(iconHref(body)).toBe("/favicon.svg");
        }
        expect(warnings(logger)).toContain("branding favicon.href dropped");
      },
    ],

    [
      "serves an active-content favicon SVG inertly instead of rejecting it",
      async () => {
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
      },
    ],

    [
      "escapes branding in HTML attribute and text positions",
      async () => {
        const body = await (
          await makeDeployment(
            brandingConfig({
              productName: 'Acme" onload="alert(1)',
              ownerName: "<b>owner</b>",
            }),
          ).fetch(new Request(`${BASE}/`))
        ).text();
        expect(body).not.toContain('onload="alert(1)"');
        expect(body).not.toContain("<b>owner</b>");
      },
    ],
  ] as const)("%s", async (_name, run) => run());
});
