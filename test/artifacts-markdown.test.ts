import { describe, expect, it } from "vitest";
import { markdownPage, renderMarkdown } from "../src/artifacts/markdown.js";

describe("renderMarkdown", () => {
  it("renders headings, paragraphs, emphasis, code, and breaks", () => {
    expect(
      renderMarkdown(
        "# Title #\n\nSome *em*, **strong**, __also__, _em_, ~~gone~~, and `a < b`.\nNext line  \nhard\\\nbreak",
      ),
    ).toBe(
      "<h1>Title</h1>\n<p>Some <em>em</em>, <strong>strong</strong>, <strong>also</strong>, <em>em</em>, " +
        "<del>gone</del>, and <code>a &lt; b</code>.\nNext line<br>\nhard<br>\nbreak</p>",
    );
  });

  it("escapes raw HTML as text", () => {
    expect(renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="y">')).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n<p>&lt;img src=x onerror=&quot;y&quot;&gt;</p>",
    );
  });

  it("keeps only link and image URLs a sandboxed page can use", () => {
    expect(
      renderMarkdown(
        "[ok](https://example.com \"t\") [js](javascript:alert(1)) [rel](/x) [frag](#s) <https://a.test/b> " +
          "![pic](data:image/png;base64,AAAA) ![remote](https://example.com/a.png)",
      ),
    ).toBe(
      '<p><a href="https://example.com" title="t">ok</a> js rel <a href="#s">frag</a> ' +
        '<a href="https://a.test/b">https://a.test/b</a> <img src="data:image/png;base64,AAAA" alt="pic"> remote</p>',
    );
  });

  it("renders fences, quotes, rules, and nested lists", () => {
    expect(
      renderMarkdown(
        "```js\nconst a = '<b>';\n```\n\n> quoted **text**\n> more\n\n---\n\n- one\n- two\n  - nested\n- three\n\n3. c\n4. d",
      ),
    ).toBe(
      '<pre><code class="language-js">const a = &#39;&lt;b&gt;&#39;;\n</code></pre>\n' +
        "<blockquote>\n<p>quoted <strong>text</strong>\nmore</p>\n</blockquote>\n<hr>\n" +
        "<ul>\n<li>one</li>\n<li>two\n<ul>\n<li>nested</li>\n</ul></li>\n<li>three</li>\n</ul>\n" +
        '<ol start="3">\n<li>c</li>\n<li>d</li>\n</ol>',
    );
  });

  it("renders GFM tables with alignment", () => {
    expect(renderMarkdown("| Team | Bugs |\n| :--- | ---: |\n| core | 3 |\n| ui \\| web | 5 |")).toBe(
      "<table>\n<thead><tr><th style=\"text-align:left\">Team</th><th style=\"text-align:right\">Bugs</th></tr></thead>\n" +
        "<tbody>\n<tr><td style=\"text-align:left\">core</td><td style=\"text-align:right\">3</td></tr>\n" +
        "<tr><td style=\"text-align:left\">ui | web</td><td style=\"text-align:right\">5</td></tr>\n</tbody>\n</table>",
    );
  });

  it("stays linear on hostile input", () => {
    const started = performance.now();
    renderMarkdown("[".repeat(200_000));
    renderMarkdown("*a ".repeat(100_000));
    renderMarkdown("`".repeat(50_000) + "x" + "``".repeat(10_000));
    renderMarkdown("**".repeat(100_000));
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("wraps the body in the page root with the title escaped", () => {
    const page = markdownPage("# Hi", "Q3 <bugs>");
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain("<title>Q3 &lt;bugs&gt;</title>");
    expect(page).toContain('<main id="artifact-root">\n<h1>Hi</h1>\n</main>');
  });
});
