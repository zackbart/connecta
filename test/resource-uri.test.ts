import { expect, it } from "vitest";
import { resourceUriMatchesTemplates } from "../src/connectors/resource-uri.js";

it.each([
  ["docs://manual/{id}/{id}", "docs://manual/a/a"],
  ["docs://manual/{id:1}/{id}", "docs://manual/a/abc"],
  ["file://{/p*}", "file:///a/b/c"],
  ["docs://manual/{+path}", "docs://manual/a/b/c"],
  ["docs://manual/entry{#section}", "docs://manual/entry#summary"],
  ["docs://manual/entry{.format}", "docs://manual/entry.json"],
  ["docs://manual/entry{;format}", "docs://manual/entry;format=json"],
  ["docs://manual/entry{?page,format}", "docs://manual/entry?page=1&format=json"],
  ["docs://manual/entry?fixed=1{&format}", "docs://manual/entry?fixed=1&format=json"],
  ["docs://manual/{pages*}", "docs://manual/one,two"],
  ["https://h{/x}.evil.com:8443/", "https://h/safe.evil.com:8443/"],
  ["https://h{/x}@evil.com:1/", "https://h/safe@evil.com:1/"],
  ["https://[::1]:8443{/x}", "https://[::1]:8443/safe"],
  ["x:{value}", "x:safe"],
  ["docs://manual/{page}", "docs://manual/%25E2%259C%2593"],
  ["docs://manual{/pages*}", "docs://manual/caf%C3%A9/%E2%9C%93"],
  ["https://h/.{x}/", "https://h/.safe/"],
  ["docs://manual/{x}?literal=/../", "docs://manual/safe?literal=/../"],
])("INV-3: matches advertised RFC 6570 expansion %s as %s", (template, uri) => {
  expect(resourceUriMatchesTemplate(uri, template)).toBe(true);
});

it.each([
  ["https://h/100%25/{p}", "https://h/100%25/a"],
  ["https://h/{p}", "https://h/50%2525off"],
  ["https://h/{p:3}/{p}", "https://h/50%25/50%25off"],
])("INV-3: preserves encoded-percent data in template literals and values %s as %s", (template, uri) => {
  expect(resourceUriMatchesTemplate(uri, template)).toBe(true);
  expect(resourceUriMatchesTemplates(uri, [{ uriTemplate: template }])).toEqual({ matched: true });
});

it.each(["%252E%252E", "%25EF%25BC%258F", "%25FF"])(
  "INV-3 INV-4: encoded-percent data cannot hide nested unsafe escapes %s",
  (encoded) => {
    for (const [template, uri] of [
      ["https://h/{p}", `https://h/${encoded}`],
      ["https://h/50%25off/{p}", `https://h/50%25off/${encoded}`],
      [`https://h/50%25off/${encoded}/{p}`, `https://h/50%25off/${encoded}/a`],
      ["https://h/{+p}", `https://h/50%25off/${encoded}`],
    ] as const) {
      expect(resourceUriMatchesTemplate(uri, template)).toBe(false);
    }
  },
);

it.each([
  ["docs://manual/{id}/{id}", "docs://manual/a/b"],
  ["docs://manual/{id:2}/{id}", "docs://manual/a/abc"],
  ["{scheme}://manual/{page}", "http://manual/start"],
  ["docs://manual/{+page}", "docs://manual/../private"],
  ["docs://manual/{+id}/{id}", "docs://manual/a/a"],
  ["docs://manual/{+page}", "docs://manual/http%3A%2F%2F127.0.0.1"],
  ["docs://manual/{page}", "docs://manual/%252fprivate"],
  ["docs://manual/entry{.page*}", "docs://manual/entry..."],
  ["docs://manual/{page}", "docs://manual/start?private=1"],
  ["docs://manual/{page}", "docs://manual/%ZZ"],
  ["docs://manual/{bad:0}", "docs://manual/a"],
  ["docs://manual/{a}{b}", "docs://manual/ab"],
])("INV-3 INV-4: refuses unsafe or malformed expansion %s as %s", (template, uri) => {
  expect(resourceUriMatchesTemplate(uri, template)).toBe(false);
});

it.each([
  ["https://h{/x}.evil.com:8443/", "https://h.evil.com:8443/"],
  ["https://h{/x}@evil.com:1/", "https://h@evil.com:1/"],
  ["https://h{?x}.evil.com/", "https://h.evil.com/"],
])("INV-3 INV-4: re-checks the literal authority after empty expansion %s as %s", (template, uri) => {
  expect(resourceUriMatchesTemplate(uri, template)).toBe(false);
  expect(resourceUriMatchesTemplates(uri, [{ uriTemplate: template }])).toEqual({ matched: false });
});

it.each(["https"])("INV-3 INV-4: refuses a WHATWG host absent from the RFC 3986 %s template", (scheme) => {
  // The final ! makes the capture boundary deterministic, so host checking
  // must refuse this after expansion rather than at template parsing.
  const uri = `${scheme}:/evil.com/static!`;
  const uriTemplate = `${scheme}:{/a}/static!`;
  expect(new URL(uri).host).toBe("evil.com");
  expect(resourceUriMatchesTemplate(uri, uriTemplate)).toBe(false);
  expect(resourceUriMatchesTemplates(uri, [{ uriTemplate }])).toEqual({ matched: false });
  expect(resourceUriMatchesTemplate(`${scheme}:/evil.com/static`, `${scheme}:{/a}/static`)).toBe(false);
});

it("INV-3 INV-4: refuses backslash normalization in a literal authority", () => {
  expect(resourceUriMatchesTemplate("https://h\\evil.com/safe", "https://h\\evil.com{/x}")).toBe(false);
});

it.each(["%E2%80%A8", "%EF%BC%8F", "%EF%BC%85"])(
  "INV-3 INV-4: refuses Unicode separators and URI syntax lookalikes at each decoding layer %s",
  (encoded) => {
    for (const expression of ["{page}", "{+page}", "{/page*}", "{?page}"]) {
      const template = "docs://manual/entry" + expression;
      for (let depth = 0, value = decodeURIComponent(encoded); depth < 8; depth++) {
        const uri =
          "docs://manual/entry" + (expression === "{/page*}" ? "/" : expression === "{?page}" ? "?page=" : "") + value;
        expect(resourceUriMatchesTemplate(uri, template)).toBe(false);
        expect(resourceUriMatchesTemplates(uri, [{ uriTemplate: template }])).toEqual({ matched: false });
        value = encodeURIComponent(value);
      }
    }
  },
);

it.each([
  ["https://h/.{x}/", "https://h/./"],
  ["https://h/{x}%252e/y", "https://h/%252e/y"],
  ["docs://manual/%25C2%25A0{x}", "docs://manual/%25C2%25A0"],
])("INV-3 INV-4: checks final path segments formed by literals and empty captures %s as %s", (template, uri) => {
  expect(resourceUriMatchesTemplate(uri, template)).toBe(false);
  expect(resourceUriMatchesTemplates(uri, [{ uriTemplate: template }])).toEqual({ matched: false });
});

it.each([
  ["http:{/a}{/b}/static", "http://evil.com/static"],
  ["http:{/a,b}/static", "http://evil.com/static"],
  ["http:{+path}", "http://evil.com/static"],
  ...["%E2%80%AE", "%E2%80%8B", "%E2%80%8D", "%EF%BB%BF", "%25E2%2580%25AE"].map((value) => [
    "docs://manual/{page}",
    `docs://manual/${value}`,
  ]),
  ...[
    "../a",
    "a/./b",
    "a/../b",
    "a/%2e%2e/b",
    "a/%252e/b",
    "a/%5cb",
    "a/\\b",
    "/evil.com/a",
    "http://evil.com/a",
  ].flatMap((value) => [
    ["file:///{+path}", `file:///${value}`],
    ["file://{/p*}", `file:///${value}`],
  ]),
])("INV-3 INV-4: refuses injected authority, format marks and unsafe path segments %s as %s", (template, uri) => {
  expect(resourceUriMatchesTemplate(uri, template)).toBe(false);
});

it.each(["x:{a},{b},{c}!", "x:{a*},{b*}!", "x:{a}{/b}", "x:{+a}/{b}"])(
  "INV-3 INV-7: refuses ambiguous boundaries with a typed code in %s",
  (uriTemplate) => {
    expect(resourceUriMatchesTemplates("x:a,b,c!", [{ uriTemplate }])).toEqual({
      matched: false,
      refusal: "resource_template_ambiguous",
    });
  },
);

it.each([
  ["three list expressions", [{ uriTemplate: "x:{a},{b},{c}!" }], "resource_template_ambiguous"],
  ["two exploded expressions", [{ uriTemplate: "x:{a*},{b*}!" }], "resource_template_ambiguous"],
  [
    "sixteen expressions",
    [{ uriTemplate: "x:" + Array.from({ length: 16 }, (_, i) => `{v${i}}`).join("/") + "!" }],
    undefined,
  ],
  [
    "hundreds of same-scheme templates",
    Array.from({ length: 500 }, (_, i) => ({ uriTemplate: `x:{value}/literal${i}!` })),
    "resource_match_budget_exceeded",
  ],
] as const)("INV-3 INV-7: bounds matching at the 8192-character URI limit with %s", (_label, templates, refusal) => {
  const uri = "x:" + ",".repeat(8189) + "?";
  const start = performance.now();
  const result = resourceUriMatchesTemplates(uri, templates);
  const elapsed = performance.now() - start;
  expect(uri.length).toBe(8192);
  expect(result).toEqual({ matched: false, ...(refusal ? { refusal } : {}) });
  expect(elapsed).toBeLessThan(50);
});

it("INV-3 INV-7: scans almost the full match budget before an end-of-URI mismatch", () => {
  const uriTemplate = "x:{v*}";
  const templates = Array.from({ length: 31 }, () => ({ uriTemplate }));
  const uri = "x:" + "a".repeat(8189) + "?";
  // Each template parses and captures the entire URI before the last character
  // refuses the value. 31 full scans charge 254,138 of the 262,144 work budget.
  expect(resourceUriMatchesTemplate(uri.slice(0, -1) + "a", uriTemplate)).toBe(true);
  expect(uri.length).toBe(8192);
  expect(templates.length * (uri.length + uriTemplate.length)).toBe(254_138);
  const refusals: string[] = [];
  const start = performance.now();
  const result = resourceUriMatchesTemplates(uri, templates, (code) => refusals.push(code));
  const elapsed = performance.now() - start;
  expect(result).toEqual({ matched: false });
  expect(refusals).toEqual([]);
  expect(elapsed).toBeLessThan(50);
  expect(resourceUriMatchesTemplates(uri, [...templates, { uriTemplate }])).toEqual({
    matched: false,
    refusal: "resource_match_budget_exceeded",
  });
});

function resourceUriMatchesTemplate(uri: string, uriTemplate: string): boolean {
  return resourceUriMatchesTemplates(uri, [{ uriTemplate }]).matched;
}
