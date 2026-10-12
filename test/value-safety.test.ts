// The shared value-safety engine (decision 0005, "Value safety"): one path
// language, one heuristic that is the union of the two former vendor engines,
// and one error policy, for every REST vendor.
import { describe, expect, it } from "vitest";
import { OperationIndex, type OpenApiData } from "../src/providers/_shared/rest/operation-index.js";
import {
  REDACTED,
  redact,
  refuse,
  safe,
  sanitizeEmbeddedUrls,
  sanitizeEmbeddedUrlsIn,
  validPath,
  valueSafety,
  vendorErrors,
  type ValueSafetyTable,
} from "../src/providers/_shared/rest/value-safety.js";

const DATA: OpenApiData = {
  source: "https://vendor.example/openapi.json",
  revision: "r1",
  digest: "sha256:0",
  version: "1",
  servers: ["https://api.vendor.example"],
  tags: ["things"],
  ops: [
    ["GET", "/v1/things", "ListThings", "List things", 0],
    ["POST", "/v1/things", "CreateThing", "Create a thing", 0],
    ["POST", "/v1/hooks", "CreateHook", "Create a hook", 0],
    ["POST", "/v1/keys", "CreateKey", "Create a key", 0],
  ],
  details: JSON.stringify({
    d: [],
    o: [
      0,
      [[], ["application/json", { t: "object", p: { name: { t: "string" } } }]],
      [[], ["application/json", { t: "object", p: { headers: { t: "object" } } }]],
      0,
    ],
  }),
};
const index = new OperationIndex(DATA, { vendor: "acme", title: "Acme" });
const engine = (table: Omit<ValueSafetyTable, "title">) => valueSafety({ title: "Acme", ...table }, () => index);

describe("value-safety engine", () => {
  it("INV-3: refuses a refuse verdict by operation, naming it and the reason", () => {
    const safety = engine({ operations: { "POST /v1/keys": refuse("It mints a key.") } });
    expect(safety.refusal("POST", "/v1/keys")).toBe("Connecta refuses POST /v1/keys. It mints a key.");
    expect(safety.refusal("GET", "/v1/things")).toBeUndefined();
  });

  it("INV-5: applies reviewed paths through lists, maps, keys, and URL directives", () => {
    const safety = engine({
      operations: {
        "GET /v1/things": redact("Things carry hooks.", [
          "items.hook",
          "env.*.value",
          "shares@keys",
          "origin:delivery",
          "dest#url",
          "url:link",
          "rules[?header].value",
        ]),
      },
    });
    const out = safety.redact(
      {
        items: [{ hook: "h1", id: "t1" }, { id: "t2" }],
        env: { A: { value: "v", type: "plain" } },
        shares: { "secret-key": { scope: "x" } },
        delivery: { traces: "https://otel.example/v1/abc", logs: "https://logs.example/" },
        dest: "s3://bucket/path?k=1",
        link: "https://user:pw@example.com/doc?token=t&page=2",
        rules: [
          { type: "header", key: "X-Mode", value: "on" },
          { type: "path", value: "/kept" },
        ],
      },
      "GET",
      "/v1/things",
    ) as Record<string, any>;
    expect(out["items"]).toEqual([{ hook: REDACTED, id: "t1" }, { id: "t2" }]);
    expect(out["env"]).toEqual({ A: { value: REDACTED, type: "plain" } });
    expect(Object.keys(out["shares"])).toEqual([`${REDACTED} 1`]);
    expect(out["delivery"]).toEqual({ traces: `https://otel.example/${REDACTED}`, logs: "https://logs.example" });
    expect(out["dest"]).toBe(`s3://bucket/${REDACTED}`);
    expect(out["link"]).toBe("https://redacted@example.com/doc?token=%5Bredacted%5D&page=2");
    expect(out["rules"]).toEqual([
      { type: "header", key: "X-Mode", value: REDACTED },
      { type: "path", value: "/kept" },
    ]);
    for (const path of ["a.b", "a[].b", "a{}.b", "a.*.b", "a@keys", "origin:a.b", "a.b#url", "a[?env].value"]) {
      expect(validPath(path), path).toBe(true);
    }
    expect(validPath("a[?nope].b")).toBe(false);
  });

  it("INV-5: removes whatever either former heuristic removed, and keeps only reviewed metadata", () => {
    const safety = engine({
      operations: { "GET /v1/things": safe("Things.", ["kept_token"]) },
      fields: {
        next_page_token: { verdict: "keep", reason: "A cursor." },
        signature: { verdict: "redact", reason: "x" },
      },
    });
    const out = safety.redact(
      {
        // Containment (a credential word in a non-metadata name): the value goes whole.
        apiKeyHash: { a: "1", b: 2 },
        refresh_token_options: { lifetime: "1h" },
        // A credential suffix alone (`…tokens`): strings go, the shape and numbers stay.
        input_tokens: 12,
        tokenId: "tok_1",
        usedAppToken: true,
        kept_token: "public-beacon",
        next_page_token: "cursor-1",
        signature: "SHA256WithRSA",
        // Labelled and typed secrets, environment containers, and destination headers.
        vars: [
          { key: "API_SECRET", value: "s1" },
          { name: "Authorization", text: "Bearer x" },
          { type: "secret_text", text: "s2" },
          { key: "theme", value: "dark" },
        ],
        env: [{ key: "DB", value: "postgres://x", nested: { token: "t" } }, "NAME=value"],
        endpoint: "https://drain.example/",
        headers: { "X-Key": "k" },
        url: "https://example.com/a?signature=s&X-Amz-Credential=c&ok=1#access_token=t",
      },
      "GET",
      "/v1/things",
    ) as Record<string, any>;
    expect(out["apiKeyHash"]).toBe(REDACTED);
    expect(out["refresh_token_options"]).toBe(REDACTED);
    expect(out["input_tokens"]).toBe(12);
    expect(out["tokenId"]).toBe("tok_1");
    expect(out["usedAppToken"]).toBe(true);
    expect(out["kept_token"]).toBe("public-beacon");
    expect(out["next_page_token"]).toBe("cursor-1");
    expect(out["signature"]).toBe(REDACTED);
    expect(out["vars"]).toEqual([
      { key: "API_SECRET", value: REDACTED },
      { name: "Authorization", text: REDACTED },
      { type: "secret_text", text: REDACTED },
      { key: "theme", value: "dark" },
    ]);
    expect(out["env"]).toEqual([{ key: "DB", value: REDACTED, nested: { token: REDACTED } }, REDACTED]);
    expect(out["headers"]).toEqual({ "X-Key": REDACTED });
    expect(out["url"]).toBe("https://example.com/a?signature=%5Bredacted%5D&X-Amz-Credential=%5Bredacted%5D&ok=1");
  });

  it("INV-5: applies resource rules wherever the object sits, and keeps a reviewed URL only while its condition does not hold", () => {
    const checkout = "https://checkout.example.com/c/pay/cs_1#fidkey";
    const safety = engine({
      operations: {},
      resources: {
        key: "object",
        partials: ["previous_attributes"],
        rules: {
          file_link: { reason: "A bearer download.", paths: ["origin:url"] },
          session: {
            reason: "A payer page; bound to a customer it is a capability.",
            paths: ["client_secret"],
            verbatim: ["url"],
            guest: { bindings: { customer: [] }, unbound: {} },
            withheld: ["origin:url"],
          },
        },
      },
    });
    const link = { object: "file_link", url: "https://files.example.com/links/BEARER" };
    expect(
      JSON.stringify(
        safety.redact(
          {
            object: "file",
            links: { object: "list", data: [link] },
            dispute: { evidence: { receipt: { object: "file", links: { data: [link] } } } },
          },
          "GET",
          "/v1/files/f1",
        ),
      ),
    ).not.toContain("BEARER");
    const event = safety.redact(
      { object: "event", data: { object: link, previous_attributes: { url: "https://files.example.com/links/OLD" } } },
      "GET",
      "/v1/events/evt_1",
    );
    expect(JSON.stringify(event)).not.toMatch(/BEARER|OLD/);
    // A guest session keeps its page whole (a fragment the URL rule would otherwise strip); a bound one does not.
    expect(safety.redact({ object: "session", url: checkout, client_secret: "S" }, "GET", "/")).toEqual({
      object: "session",
      url: checkout,
      client_secret: REDACTED,
    });
    expect(safety.redact({ object: "session", customer: "cus_1", url: checkout }, "GET", "/")).toEqual({
      object: "session",
      customer: "cus_1",
      url: `https://checkout.example.com/${REDACTED}`,
    });
    // Anywhere else, the same URL is sanitized.
    expect(safety.redact({ url: checkout }, "GET", "/")).toEqual({ url: "https://checkout.example.com/c/pay/cs_1" });
  });

  it("INV-5: withholds error text for reviewed operations and credential inputs unless the review says vendor", () => {
    const safety = engine({
      operations: {
        "GET /v1/things": safe("Things."),
        "POST /v1/things": vendorErrors(safe("Things.")),
      },
    });
    const op = (method: string, path: string) => index.operation(method, path)!;
    expect(safety.withholdsErrors(op("GET", "/v1/things"))).toBe(true);
    expect(safety.withholdsErrors(op("POST", "/v1/things"))).toBe(false);
    // Unreviewed: withheld only when the request accepts a credential-named field (headers here).
    expect(safety.withholdsErrors(op("POST", "/v1/hooks"))).toBe(true);
    expect(safety.withholdsErrors(op("POST", "/v1/keys"))).toBe(false);
  });
});

describe("embedded URLs in free text", () => {
  const S3 = "https://prod-files-secure.s3.us-west-2.amazonaws.com";
  const SIGNED = ["amazonaws.com", "file.notion.so"];
  const query = "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAEXAMPLE&X-Amz-Signature=FAKE_SIGNATURE";
  const leaks = (text: string) => ["ASIAEXAMPLE", "FAKE_SIGNATURE"].filter((secret) => text.includes(secret));

  it.each([
    ["a filename with parentheses", `![a](${S3}/ws/file(1).png?${query})`, `![a](${S3}/ws/file(1).png?${REDACTED})`],
    [
      "an escaped Markdown parenthesis",
      `![a](${S3}/ws/file\\(1\\).png?${query})`,
      `![a](${S3}/ws/file\\(1\\).png?${REDACTED})`,
    ],
    [
      "a quoted attribute with parentheses",
      `<file src="${S3}/ws/file(1).pdf?${query}">Report</file>`,
      `<file src="${S3}/ws/file(1).pdf?${REDACTED}">Report</file>`,
    ],
    [
      "a decimal character reference",
      `<file src="https://cdn.example/a.pdf?X-Amz-Algorithm=A&#38;X-Amz-Credential=ASIAEXAMPLE&#38;X-Amz-Signature=FAKE_SIGNATURE"></file>`,
      `<file src="https://cdn.example/a.pdf?${REDACTED}"></file>`,
    ],
    [
      "a hex character reference",
      `<file src='https://cdn.example/a.pdf?a=1&#x26;X-Amz-Signature=FAKE_SIGNATURE&#X26;c=ASIAEXAMPLE'>`,
      `<file src='https://cdn.example/a.pdf?${REDACTED}'>`,
    ],
    [
      "a percent-encoded parameter name",
      "see https://cdn.example/a.pdf?X%2DAmz%2DSignature=FAKE_SIGNATURE&c=ASIAEXAMPLE now",
      `see https://cdn.example/a.pdf?${REDACTED} now`,
    ],
    ["an autolink", `<${S3}/ws/a.png?${query}>`, `<${S3}/ws/a.png?${REDACTED}>`],
    ["a Markdown title", `[a](${S3}/a.png?${query} "Title")`, `[a](${S3}/a.png?${REDACTED} "Title")`],
    [
      "a signed host with innocuous names",
      "![a](https://file.notion.so/f/f/ws/a.png?table=block&id=ASIAEXAMPLE&expirationTimestamp=1)",
      `![a](https://file.notion.so/f/f/ws/a.png?${REDACTED})`,
    ],
    [
      "a signed link inside another link's query",
      `[go](https://example.com/r?to=${encodeURIComponent(`${S3}/a.png?${query}`)})`,
      `[go](https://example.com/r?${REDACTED})`,
    ],
    ["a credential in the path", "https://cdn.example/api_key=FAKE_SIGNATURE/a.png", `https://cdn.example/${REDACTED}`],
    [
      "a token in a fragment",
      "https://app.example/cb#access_token=FAKE_SIGNATURE",
      `https://app.example/cb#${REDACTED}`,
    ],
    ["userinfo", "https://ASIAEXAMPLE:pw@host.example/a", "https://redacted@host.example/a"],
  ])("INV-5: withholds a signed link in %s and keeps the syntax around it", (_, text, expected) => {
    const clean = sanitizeEmbeddedUrls(text, SIGNED);
    expect(leaks(clean)).toEqual([]);
    expect(clean).toBe(expected);
  });

  it("INV-5: returns ordinary links and their surroundings byte for byte", () => {
    const text = [
      "# Notes (draft)",
      "See [the docs](https://developers.notion.com/reference?topic=markdown) and <https://example.com/a(b)>.",
      "![a](https://example.com/file(1).png?width=200&amp;height=100) [Page](https://www.notion.so/Page-abc?pvs=4)",
      "a // comment, a://b, and a bare // pair",
    ].join("\n");
    expect(sanitizeEmbeddedUrls(text, SIGNED)).toBe(text);
  });

  it("INV-5: scans every string of a JSON value and keeps unchanged values' identity", () => {
    const untouched = { title: "plain", links: ["https://example.com/?q=1"] };
    const value = { untouched, nested: [{ result: { markdown: `![a](${S3}/a.png?${query})` } }] };
    const clean = sanitizeEmbeddedUrlsIn(value, SIGNED) as typeof value;
    expect(clean.untouched).toBe(untouched);
    expect(clean.nested[0]!.result.markdown).toBe(`![a](${S3}/a.png?${REDACTED})`);
    expect(sanitizeEmbeddedUrlsIn(untouched, SIGNED)).toBe(untouched);
  });

  // workerd freezes its clocks during synchronous work, so the bound is
  // measured on Node; in workerd the scan must still finish within the test's
  // timeout. The former regex took about a second for 40,000 letters.
  it.each([
    ["5 MiB of text without a URL", "a".repeat(5 * 1024 * 1024)],
    ["near-URL letters", "abc:/".repeat(400_000)],
    ["empty authorities", "// ".repeat(400_000)],
    ["one long link of separators", `https://h/?${"&#38;(%25[".repeat(200_000)}`],
    ["many short links", "https://h/a?sig=1 ".repeat(100_000)],
  ])("INV-5: scans %s in linear time", (_, text) => {
    const started = performance.now();
    const clean = sanitizeEmbeddedUrls(text, SIGNED);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(clean.length).toBeGreaterThan(0);
  });
});
