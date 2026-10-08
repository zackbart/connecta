import { expect, it } from "vitest";
import { resourceUriMatchesTemplate } from "../src/connectors/resource-uri.js";

it.each([
  ["docs://manual/{id}/{id}", "docs://manual/a/a"],
  ["docs://manual/{id:1}/{id}", "docs://manual/a/abc"],
  ["docs://manual/entry{/a,b}", "docs://manual/entry/one"],
  ["docs://manual/{page}", "docs://manual/start"],
  ["docs://manual/{page}", "docs://manual/hello%20world"],
  ["docs://manual/{page}", "docs://manual/%E2%9C%93"],
  ["docs://manual/{+page}", "docs://manual/start!"],
  ["docs://manual/entry{#section}", "docs://manual/entry#summary"],
  ["docs://manual/entry{/page}", "docs://manual/entry/start"],
  ["docs://manual/entry{/a,b}", "docs://manual/entry/one/two"],
  ["docs://manual/entry{.format}", "docs://manual/entry.json"],
  ["docs://manual/entry{;format}", "docs://manual/entry;format=json"],
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
  ["docs://manual/{id:2}/{id}", "docs://manual/a/abc"],
  ["docs://manual/{page}", "docs://manual/start!"],
  ["docs://manual/{page:3}", "docs://manual/abcd"],
  ["{scheme}://manual/{page}", "http://manual/start"],
  ["docs://{host}/{page}", "docs://other/start"],
  ["docs://manual/{+page}", "docs://manual/../private"],
  ["docs://manual/{+page}", "docs://manual/a/b"],
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
  ["docs://manual/{page", "docs://manual/a"],
  ["docs://manual/{a}{b}", "docs://manual/ab"],
])("INV-3 INV-4: refuses unsafe or malformed expansion %s as %s", (template, uri) => {
  expect(resourceUriMatchesTemplate(uri, template)).toBe(false);
});
