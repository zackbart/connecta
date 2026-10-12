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
  validPath,
  valueSafety,
  vendorErrors,
  withholdSignedLinks,
  withholdSignedLinksIn,
  carriesWithheldLink,
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

describe("pre-signed links in free text", () => {
  const HOSTS = {
    domains: ["file.notion.so", "secure.notion-static.com", "notionusercontent.com"],
    buckets: ["prod-files-secure", "secure.notion-static.com"],
  };
  const HOST = "prod-files-secure.s3.us-west-2.amazonaws.com";
  const S3 = `https://${HOST}`;
  const query = "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAEXAMPLE&X-Amz-Signature=FAKE_SIGNATURE";
  const leaks = (text: string) => ["ASIAEXAMPLE", "FAKE_SIGNATURE"].filter((secret) => text.includes(secret));
  const withheld = (text: string) => withholdSignedLinks(text, HOSTS);

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
    // Review round 2, finding 1: an unmatched `)` or `]` does not end the link.
    [
      "a quoted attribute with an unmatched parenthesis",
      `<file src="${S3}/ws/file).pdf?X-Amz-Signature=FAKE_SIGNATURE">f</file>`,
      `<file src="${S3}/ws/file).pdf?${REDACTED}">f</file>`,
    ],
    [
      "a bracket-bearing query value",
      `<file src="${S3}/ws/file.pdf?name=a)b&X-Amz-Signature=FAKE_SIGNATURE">f</file>`,
      `<file src="${S3}/ws/file.pdf?${REDACTED}">f</file>`,
    ],
    [
      "an angle autolink with an unmatched parenthesis",
      `<${S3}/ws/file).pdf?${query}>`,
      `<${S3}/ws/file).pdf?${REDACTED}>`,
    ],
    [
      "a quoted filename with a bracket",
      `<file src='${S3}/ws/a]b.pdf?${query}'>f</file>`,
      `<file src='${S3}/ws/a]b.pdf?${REDACTED}'>f</file>`,
    ],
    // Review round 2, finding 2: the host anchors, however the slashes are spelled.
    [
      "numeric slash references",
      `<file src="https:&#47;&#47;${HOST}/ws/file.png?${query}">`,
      `<file src="https:&#47;&#47;${HOST}/ws/file.png?${REDACTED}">`,
    ],
    [
      "Markdown slash escapes",
      `[a](https:\\/\\/${HOST}/ws/file.png?${query})`,
      `[a](https:\\/\\/${HOST}/ws/file.png?${REDACTED})`,
    ],
    [
      "JSON text inside a string",
      JSON.stringify({ url: `${S3}/ws/a.png?${query}` }).replaceAll("/", "\\/"),
      `{"url":"https:\\/\\/${HOST}\\/ws\\/a.png?${REDACTED}"}`,
    ],
    [
      "a percent-encoded whole link",
      `see ${encodeURIComponent(`${S3}/ws/a.png?${query}`)} now`,
      `see https%3A%2F%2F${HOST}%2Fws%2Fa.png?${REDACTED} now`,
    ],
    ["no scheme", `${HOST}/ws/a.png?${query}`, `${HOST}/ws/a.png?${REDACTED}`],
    [
      "an uppercase host",
      `HTTPS://${HOST.toUpperCase()}/A.PNG?${query}`,
      `HTTPS://${HOST.toUpperCase()}/A.PNG?${REDACTED}`,
    ],
    [
      "an entity-encoded query opener",
      `<file src="${S3}/ws/a.png&#63;${query}">`,
      `<file src="${S3}/ws/a.png?${REDACTED}">`,
    ],
    ["a \\u-escaped query opener", `${S3}/ws/a.png\\u003f${query}`, `${S3}/ws/a.png?${REDACTED}`],
    [
      "a path-style Notion bucket",
      `![a](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/u/a.png?${query})`,
      `![a](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/u/a.png?${REDACTED})`,
    ],
    [
      "Notion's own file host with innocuous names",
      "![a](https://file.notion.so/f/f/ws/a.png?table=block&id=ASIAEXAMPLE&expirationTimestamp=1)",
      `![a](https://file.notion.so/f/f/ws/a.png?${REDACTED})`,
    ],
    [
      "a fragment on a file host",
      "https://img.notionusercontent.com/s/a.png#sig=FAKE_SIGNATURE",
      `https://img.notionusercontent.com/s/a.png#${REDACTED}`,
    ],
    [
      "a signed link inside another link's query",
      `[go](https://example.com/r?to=${encodeURIComponent(`${S3}/a.png?${query}`)})`,
      `[go](https://example.com/r?to=https%3A%2F%2F${HOST}%2Fa.png?${REDACTED})`,
    ],
    [
      "a link followed by prose punctuation",
      `See ${S3}/a.png?${query}, then stop.`,
      `See ${S3}/a.png?${REDACTED}, then stop.`,
    ],
    [
      "a signing parameter on any host, behind a character reference",
      `<file src="https://cdn.example/a.pdf?a=1&#38;X-Amz-Signature=FAKE_SIGNATURE&#x26;X-Amz-Credential=ASIAEXAMPLE">`,
      `<file src="https://cdn.example/a.pdf?a=1&#38;X-Amz-Signature=${REDACTED}&#x26;X-Amz-Credential=${REDACTED}">`,
    ],
    [
      "a signing parameter with an encoded equals sign",
      "https://storage.example/o?X-Goog-Signature%3DFAKE_SIGNATURE&x=1",
      `https://storage.example/o?X-Goog-Signature%3D${REDACTED}&x=1`,
    ],
  ])("INV-5: withholds a signed link in %s and keeps the syntax around it", (_, text, expected) => {
    const clean = withheld(text);
    expect(leaks(clean)).toEqual([]);
    expect(clean).toBe(expected);
  });

  it("INV-5: returns a person's own links byte for byte, generic parameter names and AWS hosts included", () => {
    const text = [
      "# Notes (draft)",
      "See [the docs](https://developers.notion.com/reference?topic=markdown) and <https://example.com/a(b)>.",
      "![a](https://example.com/file(1).png?width=200&amp;height=100) [Page](https://www.notion.so/Page-abc?pvs=4)",
      "[login](https://app.example/cb?code=abc&token=def&name=x#access_token=t) https://ASIAEXAMPLE:pw@host.example/a",
      "https://api-id.execute-api.us-east-1.amazonaws.com/prod/report?reportId=42",
      "https://bucket.s3.us-east-1.amazonaws.com/public.png?versionId=3 and the prod-files-secure bucket? Yes.",
      "a // comment, a://b, file.notion.solutions/?q=1, and a bare // pair",
    ].join("\n");
    expect(withheld(text)).toBe(text);
  });

  // Review round 3, finding 2: only a reviewed host, its subdomain, or a
  // reviewed bucket on an S3 endpoint anchors; a name inside another host or
  // an arbitrary path does not.
  it.each([
    "https://file.notion.so.example.com/report?reportId=42",
    "https://my-prod-files-secure.example.com/report?reportId=42",
    "https://example.com/prod-files-secure?reportId=42",
    "https://myfile.notion.so/report?reportId=42",
    "https://img.notionusercontent.com.example.com/a.png?width=2",
    "https://prod-files-secure.example.com/report?reportId=42",
    "https://example.com/file.notion.so/report?reportId=42",
    "https://example.com/s3.us-west-2.amazonaws.com/prod-files-secure/a.png?v=1",
    "https://other.s3.us-west-2.amazonaws.com/prod-files-secure/a.png?v=1",
    "https://s3.us-west-2.amazonaws.com/my-bucket/prod-files-secure/a.png?v=1",
    "https://s3.us-west-2.amazonaws.com/prod-files-secure-archive/a.png?v=1",
    "https://s3.us-west-2.amazonaws.com.example.com/prod-files-secure/a.png?v=1",
    "https://prod-files-secure.s3.us-west-2.amazonaws.com.example.com/a.png?v=1",
    `![a](https:&#47;example.com&#47;prod-files-secure?reportId=42)`,
    `{"url":"https:\\/\\/example.com\\/file.notion.so?reportId=42"}`,
  ])("INV-5: returns a link at a host or path that only contains a reviewed name byte for byte: %s", (link) => {
    for (const text of [link, `[r](${link})`, `<file src="${link}">f</file>`]) {
      expect(withheld(text)).toBe(text);
      expect(carriesWithheldLink(`${text.replace("?", `?${REDACTED}&`)}`, HOSTS)).toBe(false);
    }
  });

  it.each([
    [
      "a subdomain of a file host",
      "https://x.file.notion.so/a.png?sig=1",
      `https://x.file.notion.so/a.png?${REDACTED}`,
    ],
    [
      "a dash-region path-style bucket",
      `https://s3-us-west-2.amazonaws.com/prod-files-secure/a.png?v=1`,
      `https://s3-us-west-2.amazonaws.com/prod-files-secure/a.png?${REDACTED}`,
    ],
    [
      "a global virtual-hosted bucket",
      "https://prod-files-secure.s3.amazonaws.com/a.png?v=1",
      `https://prod-files-secure.s3.amazonaws.com/a.png?${REDACTED}`,
    ],
    [
      "a dual-stack path-style bucket",
      "https://s3.dualstack.us-west-2.amazonaws.com/secure.notion-static.com/a.png?v=1",
      `https://s3.dualstack.us-west-2.amazonaws.com/secure.notion-static.com/a.png?${REDACTED}`,
    ],
    [
      "a JSON-escaped path-style bucket",
      "https:\\/\\/s3.us-west-2.amazonaws.com\\/prod-files-secure\\/a.png?v=1",
      `https:\\/\\/s3.us-west-2.amazonaws.com\\/prod-files-secure\\/a.png?${REDACTED}`,
    ],
    [
      "a file host at a sentence's end",
      "Open https://file.notion.so./a.png?v=1",
      `Open https://file.notion.so./a.png?${REDACTED}`,
    ],
    ["a file host behind userinfo", "https://u@file.notion.so/a.png?v=1", `https://u@file.notion.so/a.png?${REDACTED}`],
  ])("INV-5: withholds a link at %s", (_, text, expected) => {
    expect(withheld(text)).toBe(expected);
  });

  it("INV-5: scans every string of a JSON value and keeps unchanged values' identity", () => {
    const untouched = { title: "plain", links: ["https://example.com/?q=1"] };
    const value = { untouched, nested: [{ result: { markdown: `![a](${S3}/a.png?${query})` } }] };
    const clean = withholdSignedLinksIn(value, HOSTS) as typeof value;
    expect(clean.untouched).toBe(untouched);
    expect(clean.nested[0]!.result.markdown).toBe(`![a](${S3}/a.png?${REDACTED})`);
    expect(withholdSignedLinksIn(untouched, HOSTS)).toBe(untouched);
  });

  it("INV-5: finds a withheld file link in a request, plain or encoded, and nothing else", () => {
    for (const text of [
      `![a](${S3}/a.png?${REDACTED})`,
      `<file src="${S3}/a.png?X-Amz-Signature=%5Bredacted%5D">`,
      `https:&#47;&#47;${HOST}/a.png&#63;&#91;redacted&#93;`,
    ]) {
      expect(carriesWithheldLink({ body: [{ text }] }, HOSTS)).toBe(true);
    }
    for (const text of [`![a](${S3}/a.png)`, `https://example.com/?q=${REDACTED}`, `${REDACTED} ${S3}/a.png`]) {
      expect(carriesWithheldLink({ text }, HOSTS)).toBe(false);
    }
  });

  // Review round 3, finding 3: the exact placeholder, decoded, and never the word.
  it.each([
    "https://file.notion.so/f/f/a.png?%5B%72%65%64%61%63%74%65%64%5D",
    "https://file.notion.so/f/f/a.png?&#91;redac&#116;ed&#93;",
    "https://file.notion.so/f/f/a.png?&#x5b;redacted&#x5D;",
    "https://file.notion.so/f/f/a.png?&lbrack;redacted&rbrack;",
    "https://file.notion.so/f/f/a.png?%255Bredacted%255D",
    "https://file.notion.so/f/f/a.png?&amp;#91;redacted&amp;#93;",
    "https://file.notion.so/f/f/a.png?\\u005bredacted\\u005d",
    "https://file.notion.so/f/f/a.png?id=1#%5Bredacted%5D",
  ])("INV-5: finds the placeholder however it is encoded in %s", (text) => {
    expect(carriesWithheldLink({ text }, HOSTS)).toBe(true);
  });

  it.each([
    "https://file.notion.so/f/f/a.png?label=unredacted",
    "https://file.notion.so/f/f/redacted-report.png?table=block",
    "https://file.notion.so/f/f/a.png?name=redacted-report",
    "https://file.notion.so/f/f/a.png?name=%5Bredacted",
    "https://file.notion.so/f/f/a.png?name=REDACTED",
    "[redacted] is how a withheld value reads; see https://file.notion.so/f/f/a.png",
    `${REDACTED} https://file.notion.so/f/f/a.png?v=1`,
  ])("INV-5: admits %s", (text) => {
    expect(carriesWithheldLink({ text }, HOSTS)).toBe(false);
  });

  // workerd freezes its clocks during synchronous work, so the bound is
  // measured on Node; in workerd the scan must still finish within the test's
  // timeout.
  it.each([
    ["5 MiB of text without a URL", "a".repeat(5 * 1024 * 1024)],
    ["near-URL letters", "abc:/".repeat(400_000)],
    ["empty authorities", "// ".repeat(400_000)],
    ["one long link of separators", `https://${HOST}/${"&#38;(%25[\\".repeat(200_000)}`],
    ["host names in one unbroken link", `https://${"file.notion.so/".repeat(200_000)}`],
    ["host names behind one query", `https://${HOST}/?${"file.notion.so&#35;%3f".repeat(100_000)}`],
    ["many short links", `${S3}/a?sig=1 `.repeat(50_000)],
    ["signing names without values", "X-Amz-Signature=&".repeat(200_000)],
    ["look-alike hosts", "my-file.notion.so.x/".repeat(200_000)],
    ["S3 endpoints without a reviewed bucket", "//s3.us-west-2.amazonaws.com/prod-files-secure-x".repeat(100_000)],
    ["encoded slashes before names", "%252F%252Fx.prod-files-secure".repeat(100_000)],
    ["one link of encoded placeholders", `https://file.notion.so/?${"%255B&amp;#91;\\u005d".repeat(200_000)}`],
  ])("INV-5: scans %s in linear time", (_, text) => {
    const started = performance.now();
    const clean = withheld(text);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(clean.length).toBeGreaterThan(0);
    expect(carriesWithheldLink(text, HOSTS)).toBeTypeOf("boolean");
  });
});
