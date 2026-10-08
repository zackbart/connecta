import { expect, it } from "vitest";
import { resourceUriMatchesTemplate, resourceUriMatchesTemplates } from "../src/connectors/resource-uri.js";

it.each([
  ["docs://manual/{id}/{id}", "docs://manual/a/a"],
  ["docs://manual/{+id}?id={id}", "docs://manual/%20?id=%20"],
  ["docs://manual/{id:1}/{id}", "docs://manual/a/abc"],
  ["docs://manual/entry{/a,b}", "docs://manual/entry/one"],
  ["docs://manual/{page}", "docs://manual/start"],
  ["file:///{+path}", "file:///a/b/c"],
  ["file://{/p*}", "file:///a/b/c"],
  ["docs://manual/{+path}", "docs://manual/a/b/c"],
  ["docs://manual/{page}", "docs://manual/hello%20world"],
  ["docs://manual/{page}", "docs://manual/%E2%9C%93"],
  ["docs://manual/{+page}", "docs://manual/start!"],
  ["docs://manual/entry{#section}", "docs://manual/entry#summary"],
  ["docs://manual/entry{/page}", "docs://manual/entry/start"],
  ["docs://manual/entry{/a,b}", "docs://manual/entry/one/two"],
  ["docs://manual/entry{.format}", "docs://manual/entry.json"],
  ["docs://manual/entry{;format}", "docs://manual/entry;format=json"],
  ["docs://manual/entry{;format}", "docs://manual/entry;format"],
  ["docs://manual/entry{?page,format}", "docs://manual/entry?format=json"],
  ["docs://manual/entry{?page,format}", "docs://manual/entry?page=1&format=json"],
  ["docs://manual/entry?fixed=1{&format}", "docs://manual/entry?fixed=1&format=json"],
  ["docs://manual/{page:3}", "docs://manual/abc"],
  ["docs://manual/{pages*}", "docs://manual/one,two"],
  ["docs://manual/entry{?format}", "docs://manual/entry"],
])("INV-3: matches advertised RFC 6570 expansion %s as %s", (template, uri) => {
  expect(resourceUriMatchesTemplate(uri, template)).toBe(true);
});

it.each([
  ["docs://manual/{id}/{id}", "docs://manual/a/b"],
  ["docs://manual/{+id}/{id}", "docs://manual/%2520/%2520"],
  ["docs://manual/entry{;id}/{id}", "docs://manual/entry;id/a"],
  ["docs://manual/entry{#id}/{id}", "docs://manual/entry/a"],
  ["docs://manual/entry{?id}/{id}", "docs://manual/entry/a"],
  ["docs://manual/{id:2}/{id}", "docs://manual/a/abc"],
  ["docs://manual/{page}", "docs://manual/start!"],
  ["docs://manual/{page:3}", "docs://manual/abcd"],
  ["{scheme}://manual/{page}", "http://manual/start"],
  ["docs://{host}/{page}", "docs://other/start"],
  ["docs://manual/{+page}", "docs://manual/../private"],
  ["docs://manual/{+id}/{id}", "docs://manual/a/a"],
  ["docs://manual/{+page}", "docs://manual/http%3A%2F%2F127.0.0.1"],
  ["docs://manual/{page}", "docs://manual/%252fprivate"],
  ["docs://manual/{page}", "docs://manual/%2e%2e"],
  ["docs://manual/entry{.page*}", "docs://manual/entry..."],
  ["docs://manual/{page}", "docs://manual/%2e"],
  ["docs://manual/{page}", "docs://manual/start?private=1"],
  ["docs://manual/{page}", "docs://manual/start#private"],
  ["docs://manual/{page}", "docs://manual/%5cprivate"],
  ["docs://manual/{page}", "docs://manual/%0aprivate"],
  ["docs://manual/{page}", "docs://manual/%ZZ"],
  ["docs://manual/{bad:0}", "docs://manual/a"],
  ["docs://manual/{bad..name}", "docs://manual/a"],
  ["docs://manual/{page", "docs://manual/a"],
  ["docs://manual/{a}{b}", "docs://manual/ab"],
])("INV-3 INV-4: refuses unsafe or malformed expansion %s as %s", (template, uri) => {
  expect(resourceUriMatchesTemplate(uri, template)).toBe(false);
});


it.each([
  ["http:{/a}{/b}/static", "http://evil.com/static"],
  ["http:{/a,b}/static", "http://evil.com/static"],
  ["http:{+path}", "http://evil.com/static"],
  ...["%E2%80%AE", "%E2%80%8B", "%E2%80%8D", "%EF%BB%BF", "%25E2%2580%25AE"].map(value => ["docs://manual/{page}", `docs://manual/${value}`]),
  ...["../a", "a/./b", "a/../b", "a/%2e%2e/b", "a/%252e/b", "a/%5cb", "a/\\b", "/evil.com/a", "http://evil.com/a"].flatMap(value => [
    ["file:///{+path}", `file:///${value}`],
    ["file://{/p*}", `file:///${value}`],
  ]),
])("INV-3 INV-4: refuses injected authority, format marks and unsafe path segments %s as %s", (template, uri) => {
  expect(resourceUriMatchesTemplate(uri, template)).toBe(false);
});

it.each([
  "x:{a},{b},{c}!", "x:{a*},{b*}!", "x:{a}{/b}", "x:{+a}/{b}",
])("INV-3 INV-7: refuses ambiguous boundaries with a typed code in %s", uriTemplate => {
  expect(resourceUriMatchesTemplates("x:a,b,c!", [{ uriTemplate }])).toEqual({ matched: false, refusal: "resource_template_ambiguous" });
});

it.each([
  ["three list expressions", [{ uriTemplate: "x:{a},{b},{c}!" }], "resource_template_ambiguous"],
  ["two exploded expressions", [{ uriTemplate: "x:{a*},{b*}!" }], "resource_template_ambiguous"],
  ["sixteen expressions", [{ uriTemplate: "x:" + Array.from({ length: 16 }, (_, i) => `{v${i}}`).join("/") + "!" }], undefined],
  ["hundreds of same-scheme templates", Array.from({ length: 500 }, (_, i) => ({ uriTemplate: `x:{value}/literal${i}!` })), "resource_match_budget_exceeded"],
] as const)("INV-3 INV-7: bounds matching at the 8192-character URI limit with %s", (_label, templates, refusal) => {
  const uri = "x:" + ",".repeat(8189) + "?";
  const start = performance.now();
  const result = resourceUriMatchesTemplates(uri, templates);
  const elapsed = performance.now() - start;
  expect(uri.length).toBe(8192);
  expect(result).toEqual({ matched: false, ...(refusal ? { refusal } : {}) });
  expect(elapsed).toBeLessThan(50);
});

it("INV-3 INV-7: matches sixteen expressions with one forward capture per literal", () => {
  const uriTemplate = "x:" + Array.from({ length: 16 }, (_, i) => `{v${i}}`).join("/");
  const uri = "x:" + Array.from({ length: 16 }, () => "a".repeat(510)).join("/");
  const start = performance.now();
  expect(resourceUriMatchesTemplate(uri, uriTemplate)).toBe(true);
  expect(performance.now() - start).toBeLessThan(50);
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
  const result = resourceUriMatchesTemplates(uri, templates, code => refusals.push(code));
  const elapsed = performance.now() - start;
  expect(result).toEqual({ matched: false });
  expect(refusals).toEqual([]);
  expect(elapsed).toBeLessThan(50);
  expect(resourceUriMatchesTemplates(uri, [...templates, { uriTemplate }])).toEqual({ matched: false, refusal: "resource_match_budget_exceeded" });
});
