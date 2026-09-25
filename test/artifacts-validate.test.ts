import { describe, expect, it } from "vitest";
import { validateArtifact } from "../src/artifacts.js";
import { decodeEntities, scanHtml } from "../src/artifacts/html-scan.js";

const wrap = (body: string, head = "") =>
  `<!doctype html>\n<html><head>${head}</head><body>\n<main id="artifact-root">\n${body}\n</main>\n</body></html>`;

const html = (source: string, documents?: Record<string, unknown>) =>
  validateArtifact({ kind: "html", source, ...(documents ? { documents } : {}) });

const messages = (source: string, documents?: Record<string, unknown>) => {
  const result = html(source, documents);
  return {
    errors: result.errors.map((issue) => issue.message),
    warnings: result.warnings.map((issue) => issue.message),
  };
};

describe("validateArtifact: the page root", () => {
  it("accepts a minimal page", () => {
    expect(html(wrap("<h1>Hello</h1>"))).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it("names the fix when the root is missing or repeated", () => {
    expect(messages("<!doctype html><p>hi</p>").errors).toEqual([
      'No element has id="artifact-root". Wrap the page in <main id="artifact-root">…</main>.',
    ]);
    expect(
      messages(`<!doctype html>\n<div id="artifact-root"></div>\n\n<div id="artifact-root"></div>`).errors,
    ).toEqual(['Line 4: id="artifact-root" appears 2 times (lines 2, 4). Keep exactly one.']);
  });

  it("sees the root through character references but not in comments or scripts", () => {
    expect(html(`<!doctype html><main id="artifact&#45;root"></main>`).ok).toBe(true);
    expect(html(`<!doctype html><!-- <main id="artifact-root"> -->`).ok).toBe(false);
    expect(html(`<!doctype html><script>'<main id="artifact-root">'</script>`).ok).toBe(false);
  });

  it("warns when there is no doctype", () => {
    expect(messages(`<main id="artifact-root"></main>`).warnings).toEqual([
      "The page has no <!doctype html>, so it renders in quirks mode. Start it with <!doctype html>.",
    ]);
  });
});

describe("validateArtifact: elements and attributes", () => {
  const cases: [string, string][] = [
    ["<iframe src=\"https://x.test\"></iframe>", "Line 4: <iframe> is not allowed; pages cannot embed other pages. Remove it."],
    ["<object data=\"x\"></object>", "Line 4: <object> is not allowed; pages cannot embed plugins or other documents. Remove it."],
    ["<form><input></form>", "Line 4: <form> is not allowed; pages cannot submit forms; use inputs without a <form> and read them from a script. Remove it."],
    ["<base href=\"https://x.test/\">", "Line 4: <base> is not allowed; it would change how every URL on the page resolves. Remove it."],
    ["<meta http-equiv=\"refresh\" content=\"0\">", "Line 4: <meta http-equiv> is not allowed; the viewer sets the page's headers. Remove it."],
    ["<a ping=\"https://x.test\" href=\"#top\">x</a>", "Line 4: the ping attribute on <a> is not allowed; it sends a request when a link is followed, and pages have no network. Remove it."],
    ["<button formaction=\"https://x.test\">x</button>", "Line 4: the formaction attribute on <button> is not allowed; pages cannot submit forms. Remove it."],
  ];
  it.each(cases)("%s", (body, message) => {
    expect(messages(wrap(body)).errors).toEqual([message]);
  });

  it("reports srcset candidates that cannot load", () => {
    expect(messages(wrap('<img src="data:image/png;base64,AA" srcset="data:image/png;base64,AA 1x, https://x.test/a.png 2x">')).errors).toEqual([
      "Line 4: <img srcset> names https://x.test/a.png, which cannot load; pages have no network. Use a single src with a data: URL.",
    ]);
  });
});

describe("validateArtifact: URLs", () => {
  it("explains relative, network, and executable resource URLs", () => {
    expect(
      messages(
        wrap(
          [
            '<img src="logo.png">',
            '<img src="https://example.com/logo.png">',
            '<video poster="javascript:alert(1)"></video>',
            '<img src="data:image/png;base64,AAAA">',
            '<svg><use href="#icon"></use></svg>',
          ].join("\n"),
        ),
      ).errors,
    ).toEqual([
      'Line 4: <img src="logo.png"> is relative; pages have no files beside them. Embed it as a data: URL.',
      'Line 5: <img src="https://example.com/logo.png"> loads from the network, and pages have no network. Embed it as a data: URL.',
      'Line 6: <video poster="javascript:alert(1)"> uses javascript:, which pages cannot load. Embed it as a data: URL.',
    ]);
  });

  it("allows https, mailto, and fragment links, warns once that they leave the page, and names the rest", () => {
    const result = messages(
      wrap(
        [
          '<a href="https://example.com">a</a>',
          '<a href="mailto:x@example.com">b</a>',
          '<a href="#section">c</a>',
          '<a href="/relative">d</a>',
          '<a href="http://example.com">e</a>',
          '<a href="java&#x09;script&colon;alert(1)">f</a>',
        ].join("\n"),
      ),
    );
    expect(result.errors).toEqual([
      'Line 7: <a href="/relative"> is relative; pages have no files beside them. Link an https: URL or a #fragment.',
      'Line 8: <a href="http://example.com"> uses http:. Link the https: URL instead.',
      'Line 9: <a href="java\tscript:alert(1)"> uses javascript:. Attach a click handler from a <script> instead.',
    ]);
    expect(result.warnings).toEqual([
      "Line 4: 2 links leave the page when clicked: they navigate the artifact's own frame, and pages cannot open new windows. " +
        "Show the URL as text if readers need it elsewhere.",
    ]);
  });

  it("checks CSS url() and @import in style elements and attributes", () => {
    const result = messages(
      wrap(
        '<div style="background: url(bg.png)"></div>',
        "<style>@import url(https://evil.example/x.css);\n" +
          "@font-face { src: url(https://fonts.gstatic.com/s/x.woff2) }\n" +
          ".a { background: url('data:image/png;base64,AA') }\n" +
          ".b { background: url(\"https://example.com/b.png\") }</style>",
      ),
    );
    expect(result.errors).toEqual([
      "Line 2: <style> @import https://evil.example/x.css loads from outside the style allowlist " +
        "(https://cdn.jsdelivr.net, https://cdnjs.cloudflare.com, https://fonts.googleapis.com, https://unpkg.com). " +
        "Inline the CSS, or import from one of those.",
      "Line 5: <style> url(https://example.com/b.png) loads from the network, and pages have no network. Use a data: URL.",
      "Line 7: <div style> url(bg.png) is relative; pages have no files beside them. Use a data: URL.",
    ]);
  });
});

describe("validateArtifact: scripts and styles", () => {
  it("allows pinned scripts from the allowlist and explains the rest", () => {
    const result = messages(
      wrap(
        "",
        [
          '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>',
          '<script src="https://example.com/c.js"></script>',
          '<script src="chart.js"></script>',
          '<script src="https://user:pw@cdn.jsdelivr.net/npm/x@1"></script>',
          '<script src="https://unpkg.com/d3"></script>',
          '<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>',
        ].join("\n"),
      ),
    );
    const allowlist =
      "(https://cdn.jsdelivr.net, https://cdnjs.cloudflare.com, https://esm.sh, https://unpkg.com). " +
      "Load it from one of those, pinned, e.g. https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js.";
    expect(result.errors).toEqual([
      `Line 3: <script src="https://example.com/c.js"> loads from outside the allowlist ${allowlist}`,
      `Line 4: <script src="chart.js"> is relative, and pages have no files beside them ${allowlist}`,
      `Line 5: <script src="https://user:pw@cdn.jsdelivr.net/npm/x@1"> carries credentials ${allowlist}`,
    ]);
    expect(result.warnings).toEqual([
      'Line 6: <script src="https://unpkg.com/d3"> names no exact version, so the page can change or break when the library does. ' +
        "Pin one, e.g. https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js.",
    ]);
  });

  it("allows stylesheets and preconnects to the style allowlist only", () => {
    const result = messages(
      wrap(
        "",
        [
          '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
          '<link rel="preconnect" href="https://fonts.gstatic.com">',
          '<link rel="stylesheet" href="https://example.com/x.css">',
          '<link rel="icon" href="data:image/png;base64,AA">',
        ].join("\n"),
      ),
    );
    expect(result.errors).toEqual([
      'Line 4: <link rel="stylesheet" href="https://example.com/x.css"> loads from outside the style allowlist ' +
        "(https://cdn.jsdelivr.net, https://cdnjs.cloudflare.com, https://fonts.googleapis.com, https://unpkg.com). " +
        "Inline the CSS in a <style> element, or load it from one of those.",
      'Line 5: <link rel="icon" href="data:image/png;base64,AA"> is not allowed; only rel="stylesheet" and rel="preconnect" links load. Remove it.',
    ]);
  });

  it("warns about network calls and data names the page will not get", () => {
    const result = messages(
      wrap("<script>\nconst rows = window.artifact.data.rows;\nfetch('/api');\nconst x = artifact.data['mrr'];\n</script>"),
      { rows: [] },
    );
    expect(result.warnings).toEqual([
      "Line 6: the script calls fetch, but pages have no network. Read window.artifact.data instead.",
      "Line 7: the script reads artifact.data.mrr, but the page gets no document named mrr (it has: rows). " +
        "Save it with artifacts.set_documents, or read a name that exists.",
    ]);
  });

  it("uses a deployment's own allowlist", () => {
    const result = validateArtifact(
      {
        kind: "html",
        source: wrap("", '<script src="https://cdn.example.com/lib@1.0.0/x.js"></script>'),
      },
      { allowlist: { scripts: ["https://cdn.example.com"] } },
    );
    expect(result.ok).toBe(true);
    expect(() => validateArtifact({ kind: "html", source: "x" }, { allowlist: { scripts: ["https://x.test/"] } })).toThrow(
      /exact https: origins/,
    );
  });
});

describe("validateArtifact: sizes, documents, and kinds", () => {
  it("names the byte limits", () => {
    expect(messages("").errors).toEqual([
      'The source is empty. Write a complete page, e.g. <!doctype html><main id="artifact-root">…</main>.',
    ]);
    const big = validateArtifact({ kind: "html", source: wrap("x".repeat(1024 * 1024)) });
    expect(big.errors[0]?.message).toMatch(/^The source is 1,048,\d{3} bytes; the limit is 1,048,576 \(1 MiB\)\. Move data into documents, or trim the page\.$/);
  });

  it("caps errors at 20 and says how many more there were", () => {
    const result = html(wrap(Array.from({ length: 25 }, () => "<iframe></iframe>").join("\n")));
    expect(result.errors).toHaveLength(20);
    expect(result.errorsOmitted).toBe(5);
  });

  it("validates sample documents", () => {
    const result = validateArtifact({
      kind: "html",
      source: wrap(""),
      documents: { good: [1], "bad-name": 1, nan: Number.POSITIVE_INFINITY },
    });
    expect(result.errors.map((issue) => issue.code)).toEqual(["E_DOCUMENT", "E_DOCUMENT"]);
  });

  it("checks Markdown for size and images, never for HTML rules", () => {
    expect(validateArtifact({ kind: "markdown", source: "# Title\n\n<iframe>" }).ok).toBe(true);
    expect(
      validateArtifact({ kind: "markdown", source: "# T\n\n![chart](https://x.test/c.png)" }).warnings[0]?.message,
    ).toBe("Line 3: the image https://x.test/c.png will not load; pages have no network. Embed it as a data:image/png;base64,… URL.");
    expect(validateArtifact({ kind: "text" as "html", source: "x" }).errors[0]?.code).toBe("E_KIND");
  });
});

describe("scanHtml", () => {
  const names = (source: string) =>
    scanHtml(source).flatMap((token) =>
      token.type === "start" ? [token.name] : token.type === "end" ? [`/${token.name}`] : []);

  it("treats raw-text elements as text until their end tag", () => {
    expect(names("<script>if (a<b) '<iframe>'</script><p>")).toEqual(["script", "/script", "p"]);
    expect(names("<style>p{}</style ><textarea><b></textarea>")).toEqual(["style", "/style", "textarea", "/textarea"]);
    expect(names("<title><iframe></title>")).toEqual(["title", "/title"]);
  });

  it("follows script escapes: a </script> inside <!-- <script> does not end it", () => {
    expect(names("<script><!-- <script> x </script> y --></script><p>")).toEqual(["script", "/script", "p"]);
    const text = scanHtml("<script><!-- <script> x </script> y --></script>").find((token) => token.type === "text");
    expect(text && "<script><!-- <script> x </script> y --></script>".slice(text.start, text.end)).toBe(
      "<!-- <script> x </script> y -->",
    );
  });

  it("reads quoted, unquoted, bare, and repeated attributes the way a browser does", () => {
    const [token] = scanHtml(`<a HREF=one b='two' c="th&quot;ree" d e = f href="dup">`);
    expect(token?.type === "start" && token.attrs.map((attr) => [attr.name, attr.value])).toEqual([
      ["href", "one"],
      ["b", "two"],
      ["c", 'th"ree'],
      ["d", ""],
      ["e", "f"],
    ]);
  });

  it("drops a tag cut off by the end of input, and keeps comments and doctypes out of the element stream", () => {
    expect(names("<p>text <a href='x")).toEqual(["p"]);
    expect(names("<!DOCTYPE html><!-- <iframe> --><![CDATA[<iframe>]]><?x <iframe>?><p>")).toEqual(["p"]);
    expect(names("a < b and </> c")).toEqual([]);
  });

  it("handles plaintext and uppercase-only lowercasing without shifting offsets", () => {
    const source = "İ<SCRIPT>x</SCRIPT><plaintext><iframe>";
    expect(names(source)).toEqual(["script", "/script", "plaintext"]);
  });

  it("decodes the character references a scheme can hide behind", () => {
    expect(decodeEntities("java&#x09;script&colon;x&#0;&#1114112;&amp;&unknown;")).toBe(
      "java\tscript:x��&&unknown;",
    );
  });
});
