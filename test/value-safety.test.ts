// The shared value-safety engine (decision 0005, "Value safety"): one path
// language, one heuristic that is the union of the two former vendor engines,
// and one error policy, for every REST vendor.
import { describe, expect, it } from "vitest";
import { OperationIndex, type OpenApiData } from "../src/providers/_shared/rest/operation-index.js";
import {
  REDACTED,
  carriesWithheldLink,
  refuseWithheldLinks,
  refuseWithheldUpload,
  refuseWithheldBase64,
  withholdEmbeddedUrls,
  withholdEmbeddedUrlsIn,
  withholdSignedLinks,
  withholdSignedLinksIn,
  redact,
  refuse,
  safe,
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

// Multi-MiB CPU work can be delayed or slowed by instrumentation and load.
// This is only a hang guard; character-work counts enforce the actual bound.
const SCAN_HANG_GUARD_MS = 20_000;

/**
 * Count explicit character reads and code units scanned/copied by the real
 * scanner's string operations. Avoid spy call histories for multi-MiB inputs.
 * Capture is synchronous and restores every descriptor even on failure, so
 * neither other tests nor output assertions run with instrumented methods.
 * Native regexp backtracking remains subject to the runner's hang guard.
 */
function stringWork<T>(work: () => T): { value: T; units: number } {
  const native = {
    charCodeAt: String.prototype.charCodeAt,
    slice: String.prototype.slice,
    replace: String.prototype.replace,
    toLowerCase: String.prototype.toLowerCase,
  };
  let units = 0;
  // Keep per-character reads allocation-free; recording arguments or creating
  // a rest array for each read would make the measurement dominate the scan.
  const counted = {
    charCodeAt(this: string, index: number) {
      units++;
      return native.charCodeAt.call(this, index);
    },
    slice(this: string, start?: number, end?: number) {
      const result = native.slice.call(this, start, end);
      units += result.length;
      return result;
    },
    replace(this: string, ...args: unknown[]) {
      units += this.length;
      return Reflect.apply(native.replace, this, args);
    },
    toLowerCase(this: string) {
      units += this.length;
      return native.toLowerCase.call(this);
    },
  };
  const originals = (Object.keys(native) as Array<keyof typeof native>).map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(String.prototype, name);
    if (!descriptor) throw new Error(`Missing String.${name}`);
    return { name, descriptor };
  });
  try {
    for (const { name, descriptor } of originals)
      Object.defineProperty(String.prototype, name, { ...descriptor, value: counted[name] });
    const value = work();
    return { value, units };
  } finally {
    for (const { name, descriptor } of originals) Object.defineProperty(String.prototype, name, descriptor);
  }
}

/** Bound observed character work by a fixed number of passes over the input. */
function linearWork<T>(input: string, work: (text: string) => T): T {
  const { value, units } = stringWork(() => work(input));
  expect(units, "the scanner must exercise the work counter").toBeGreaterThan(0);
  // Include the destination scan, copies and up to four decoding layers,
  // with fixed setup headroom for the reviewed host policy.
  expect(units).toBeLessThanOrEqual(input.length * 64 + 1_000);
  return value;
}

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
      "a named colon and slashes",
      `<file src="https&colon;&sol;&sol;${HOST}/ws/file.png?${query}">`,
      `<file src="https&colon;&sol;&sol;${HOST}/ws/file.png?${REDACTED}">`,
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
    ["a scheme-less authority", `src=//${HOST}/ws/a.png?${query}`, `src=//${HOST}/ws/a.png?${REDACTED}`],
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
      "signing values inside another link's encoded query",
      `[go](https://example.com/r?to=${encodeURIComponent(`${S3}/a.png?${query}`)})`,
      `[go](https://example.com/r?to=https%3A%2F%2F${HOST}%2Fa.png%3FX-Amz-Algorithm%3DAWS4-HMAC-SHA256%26X-Amz-Credential%3D${REDACTED})`,
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

  // Reviewed names must occupy the actual host or the first S3 bucket segment.
  it.each([
    "https://file.notion.so.example.com/report?reportId=42",
    "https://file.notion.so@evil.com/report?reportId=42",
    "https://s3.us-west-2.amazonaws.com/my-bucket/prod-files-secure/a.png?v=1",
    `{"url":"https:\\/\\/example.com\\/file.notion.so?reportId=42"}`,
    "https://example.com//file.notion.so/report?reportId=42",
  ])("INV-5: returns a link at a host or path that only contains a reviewed name byte for byte: %s", (link) => {
    expect(withheld(link)).toBe(link);
    expect(carriesWithheldLink(link.replace("?", `?${REDACTED}&`), HOSTS)).toBe(false);
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
    ["a file host with a port", "https://file.notion.so:443/a.png?v=1", `https://file.notion.so:443/a.png?${REDACTED}`],
    [
      "a path-style bucket on a port, ending its link",
      "https://s3.amazonaws.com:443/prod-files-secure?v=1",
      `https://s3.amazonaws.com:443/prod-files-secure?${REDACTED}`,
    ],
    [
      "a dual-stack virtual-hosted bucket with an encoded query",
      "https://prod-files-secure.s3.dualstack.us-west-2.amazonaws.com/a.png%3Fv=1",
      `https://prod-files-secure.s3.dualstack.us-west-2.amazonaws.com/a.png?${REDACTED}`,
    ],
    [
      "a subdomain behind encoded slashes",
      "https%3A%2F%2Fimg.notionusercontent.com%2Fs%2Fa.png%3Fv%3D1",
      `https%3A%2F%2Fimg.notionusercontent.com%2Fs%2Fa.png?${REDACTED}`,
    ],
  ])("INV-5: withholds a link at %s", (_, text, expected) => {
    expect(withheld(text)).toBe(expected);
  });

  it("INV-5: scans every string of a JSON value and keeps unchanged values' identity", () => {
    const untouched = { title: "plain", links: ["https://example.com/?q=1"] };
    const value = {
      untouched,
      nested: [{ result: { markdown: `![a](${S3}/a.png?${query})` } }],
    };
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
    // Review round 4, finding 2: the destination still holds it.
    "![a](https://file.notion.so/f/f/a(1).png?[redacted])",
    "![a](https://file.notion.so/f/f/a\\).png?[redacted])",
    '[a](https://file.notion.so/f/f/a.png?[redacted] "title")',
    "[a](<https://file.notion.so/f/f/a).png?[redacted]>)",
    '<file src="https://file.notion.so/f/f/a).pdf?[redacted]">f</file>',
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
    // Review round 4, finding 2: text after a Markdown link's closing parenthesis is not its query.
    "[file](https://file.notion.so/f/f/a.png?label=unredacted)[redacted]",
    "![a](https://file.notion.so/f/f/a(1).png?v=1)[redacted]",
    "[a](https://file.notion.so/f/f/a.png)?[redacted]",
    "[a](https://file.notion.so/f/f/a.png#top) and [redacted]",
  ])("INV-5: admits %s", (text) => {
    expect(carriesWithheldLink({ text }, HOSTS)).toBe(false);
  });

  it("INV-5: inspects the adjacent Markdown destination after a parenthesized filename", () => {
    const text = `![first](https://file.notion.so/f/a(1).png?label=unredacted)[second](${S3}/b.png?%5Bredacted%5D)`;
    expect(carriesWithheldLink(text, HOSTS)).toBe(true);
  });

  it("INV-5: bounds an inline destination after leading whitespace", () => {
    const start = `[f](\thttps://file.notion.so/f/a\\).png`;
    expect(carriesWithheldLink(`${start}?label=unredacted)[redacted]`, HOSTS)).toBe(false);
    expect(carriesWithheldLink(`${start})?[redacted]`, HOSTS)).toBe(false);
    expect(carriesWithheldLink(`${start}?%5Bredacted%5D)`, HOSTS)).toBe(true);
  });

  const PROXIES = [
    "https://example.com/image?url=https://file.notion.so/f/a.png?table=block&id=42&width=400",
    "https://example.com/image?url=//file.notion.so/f/a.png?table=block&id=42",
    "https://example.com/proxy/https://file.notion.so/f/a.png?id=42",
    "/proxy/https://file.notion.so/f/a.png?id=42",
    "image?url=//file.notion.so/f/a.png?id=42",
    "https://example.com/image?url=https%3A%2F%2Ffile.notion.so%2Fa.png%3Fid%3D42",
    "/proxy/https:&#47;&#47;file.notion.so/f/a.png?id=42",
    "/proxy/https:\\/\\/file.notion.so/f/a.png?id=42",
    `https://example.com/image?url=https://${HOST}/a.png?id=42`,
    "https://example.com/image?url=https://s3.amazonaws.com/prod-files-secure/a.png?id=42",
  ];

  it.each(PROXIES)("INV-5: keeps a proxy's actual authority and every ordinary byte in %s", (link) => {
    for (const marker of ["42", "%5Bredacted%5D"]) {
      const url = link.replace("42", marker);
      for (const text of [url, `[f](${url})`, `![f]( \t${url})`, `<file src="${url}">f</file>`]) {
        expect(withheld(text)).toBe(text);
        expect(carriesWithheldLink(text, HOSTS)).toBe(false);
      }
    }
  });

  it.each([
    "X-Amz-Signature",
    "X-Amz-Credential",
    "X-Amz-Security-Token",
    "X-Goog-Signature",
    "X-Goog-Credential",
    "X-Goog-Security-Token",
  ])("INV-5: still withholds %s inside a proxy path or query", (name) => {
    for (const proxy of PROXIES) {
      const text = `[f](${proxy}&${name}=FAKE_SIGNATURE&width=400)`;
      expect(withheld(text)).toBe(text.replace("FAKE_SIGNATURE", REDACTED));
    }
  });

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
    ["file host names as one long label run", "file.notion.so.".repeat(350_000)],
    ["S3 endpoints as one long label run", "s3.amazonaws.com.".repeat(300_000)],
    ["subdomains behind escaped slashes", "%2F%2Fx.file.notion.so%2F".repeat(200_000)],
    ["file hosts before userinfo", "https://x.file.notion.so@".repeat(200_000)],
    ["one Markdown destination of open parentheses", `[a](https://file.notion.so/${"(".repeat(2_000_000)}`],
    [
      "adjacent Markdown destinations",
      "![a](https://file.notion.so/a(1)?label=ok),[b](https://file.notion.so/b#top)".repeat(50_000),
    ],
    ["external proxy authorities", "[a](https://example.com/?url=https://file.notion.so/a?id=42)".repeat(100_000)],
    ["leading Markdown whitespace", `[a](${" ".repeat(2_000_000)}https://file.notion.so/a?b)[redacted]`],
    ["Markdown links followed by the placeholder", "[a](https://file.notion.so/a?b)[redacted]".repeat(100_000)],
  ])(
    "INV-5: scans %s in linear time",
    (_, text) => {
      const clean = linearWork(text, withheld);
      expect(clean.length).toBeGreaterThan(0);
      expect(linearWork(text, (input) => carriesWithheldLink(input, HOSTS))).toBeTypeOf("boolean");
    },
    SCAN_HANG_GUARD_MS,
  );
});

describe("global embedded REST URL policy (#812)", () => {
  it.each([
    [
      "Markdown",
      "[download](https://files.example/a?token=PRIVATE&width=400)",
      "[download](https://files.example/a?[redacted])",
    ],
    [
      "HTML",
      '<a href="https://files.example/a?width=400&amp;api_key=PRIVATE">file</a>',
      '<a href="https://files.example/a?[redacted]">file</a>',
    ],
    ["scheme-less URL", "download //files.example/a?sig=PRIVATE now", "download //files.example/a?[redacted] now"],
    [
      "escaped URL",
      String.raw`see https:\/\/files.example/a\u003ftoken%3DPRIVATE now`,
      String.raw`see https:\/\/files.example/a?[redacted] now`,
    ],
    [
      "encoded URL",
      "see https%3A%2F%2Ffiles.example%2Fa%3Ftoken%3DPRIVATE now",
      "see https%3A%2F%2Ffiles.example%2Fa?[redacted] now",
    ],
    ["fragment", "[file](https://files.example/a#access_token=PRIVATE)", "[file](https://files.example/a#[redacted])"],
    [
      "adjacent links",
      "[a](https://example.com/a?width=400)[b](https://files.example/b?secret=PRIVATE)[c](https://example.com/c?x=1)",
      "[a](https://example.com/a?width=400)[b](https://files.example/b?[redacted])[c](https://example.com/c?x=1)",
    ],
    [
      "unmatched filename parentheses in HTML",
      '<img src="https://files.example/a)b?sig=PRIVATE">',
      '<img src="https://files.example/a)b?[redacted]">',
    ],
    [
      "literal signing name",
      "download https://files.example/a?X-Amz-Signature=PRIVATE",
      "download https://files.example/a?[redacted]",
    ],
    ["signing name outside a URL", "X-Goog-Credential=PRIVATE", "X-Goog-Credential=[redacted]"],
    ["log labels", "download:https://files.example/a?api_key=PRIVATE", "download:https://files.example/a?[redacted]"],
    [
      "credential after a placeholder",
      "see https://files.example/a?token=[redacted]PRIVATE",
      "see https://files.example/a?[redacted]",
    ],
  ])("INV-5: withholds credential queries in %s", (_, input, expected) => {
    expect(withholdEmbeddedUrls(input)).toBe(expected);
    expect(withholdEmbeddedUrls(expected)).toBe(expected);
  });

  it.each([
    "A token=ordinary assignment and code=42 in prose",
    "[user](https://EXAMPLE.com/a%2fb?width=400&x=%2f#section)",
    "[proxy](https://example.com/image?url=https://file.notion.so/a?id=42&width=400)",
    "[proxy](/proxy/https://file.notion.so/a?id=42)",
    "[a]( https://example.com/a?width=1)[redacted]![b](https://example.com/b#section)",
    "<img src='//files.example/a?width=200'>",
  ])("INV-5: preserves ordinary user text and links byte for byte: %s", (input) => {
    expect(withholdEmbeddedUrls(input)).toBe(input);
  });

  it("INV-5: applies globally through arrays and projections' source objects without changing the default vendor policy", () => {
    const input = {
      description: "download https://files.example/a?token=PRIVATE",
      nested: [{ text: "[file](//example.com/a?sig=PRIVATE)" }],
    };
    expect(engine({ operations: {} }).redact(input, "GET", "/v1/things")).toEqual(input);
    const safety = engine({
      operations: {},
      embeddedUrls: { operations: { "GET /v1/things": ["description", "nested.text", "text"] } },
    });
    expect(safety.redact(input, "GET", "/v1/things")).toEqual({
      description: "download https://files.example/a?[redacted]",
      nested: [{ text: "[file](//example.com/a?[redacted])" }],
    });
    expect(
      safety.redact(
        { text: "https://example.com/a?width=400 see https://files.example/b?token=PRIVATE" },
        "GET",
        "/v1/things",
      ),
    ).toEqual({ text: "https://example.com/a?width=400 see https://files.example/b?[redacted]" });
    expect(safety.redact({ text: "https://example.com/a?token=PRIVATE&width=400" }, "GET", "/v1/things")).toEqual({
      text: "https://example.com/a?[redacted]",
    });
    const unchanged = { description: "[file](https://example.com/a?width=100)" };
    expect(withholdEmbeddedUrlsIn(unchanged)).toBe(unchanged);
    expect(withholdEmbeddedUrlsIn(input)).toEqual(safety.redact(input, "GET", "/v1/things"));
  });

  it.each([
    ["a large body with no URLs", "plain text ".repeat(200_000)],
    ["many ordinary queries", "[f](https://example.com/a?width=400)".repeat(40_000)],
    ["many signed queries", "[f](https://example.com/a?sig=PRIVATE)".repeat(40_000)],
    ["one long parameter name", `see https://example.com/a?${"a".repeat(2_000_000)}=value`],
    ["many parameter delimiters", `see https://example.com/a?${"?&a&".repeat(400_000)}`],
  ])(
    "INV-5: scans %s with bounded linear passes",
    (_, input) => {
      expect(linearWork(input, withholdEmbeddedUrls)).not.toContain("PRIVATE");
    },
    SCAN_HANG_GUARD_MS,
  );
});

describe("reviewed text policy and global admission (#846)", () => {
  it("INV-5: still strips userinfo from whole IPv6 URLs while preserving generic query data", () => {
    const safety = engine({ operations: {}, embeddedUrls: {} });
    const result = safety.redact(
      { description: "https://alice:PRIVATE@[::1]/a?code=welcome" },
      "GET",
      "/v1/things",
    ) as any;
    expect(result.description).not.toMatch(/alice|PRIVATE/);
    expect(new URL(result.description).searchParams.get("code")).toBe("welcome");
  });

  it.each(["&#61;", "&#x3d;"])("INV-5: scans original entity equals before URL normalization: %s", (equals) => {
    const safety = engine({ operations: {}, embeddedUrls: { operations: { "GET /v1/things": ["message"] } } });
    const input = `https://public.example/a<br>https://files.example/a?token${equals}PRIVATE`;
    const result = safety.redact({ message: input, description: input }, "GET", "/v1/things") as any;
    expect(result.message).not.toContain("PRIVATE");
    expect(result.description).toBe(input);
    const signed = input.replace("token", "X-Amz-Signature");
    expect(JSON.stringify(safety.redact({ description: signed }, "GET", "/v1/things"))).not.toContain("PRIVATE");
  });

  it.each([
    "[file](/proxy/https://files.example/a?token=PRIVATE)",
    "[file](/proxy/https://files.example/a%3Fkey%3DPRIVATE)",
    "[file](/proxy/https://files.example/a#token=PRIVATE)",
    "[a](/proxy/https://public.example/a?id=1)[b](/proxy/https://files.example/a?sig=PRIVATE)",
  ])("INV-5: inspects a relative Markdown destination's own query: %s", (input) => {
    expect(withholdEmbeddedUrls(input)).not.toContain("PRIVATE");
    expect(withholdSignedLinks(input, { domains: ["files.example"], buckets: [] })).toBe(input);
  });

  it.each([
    "[file](/proxy?url=https://files.example/a?token=ordinary&width=4)",
    "[file](/proxy?url=https%3A%2F%2Ffiles.example%2Fa%3Ftoken%3Dordinary%26key%3Dpublic)",
    "[file](/proxy?url=https%3A%2F%2Ffiles.example%2Fa%23token%3Dordinary)",
    "[file](/proxy%3Furl%3Dhttps%253A%252F%252Ffiles.example%252Fa%253Ftoken%253Dordinary%2526key%253Dpublic)",
  ])("INV-5: preserves nested ordinary proxy parameters without re-anchoring: %s", (input) => {
    expect(withholdEmbeddedUrls(input)).toBe(input);
  });

  it("INV-5: replaces a credential query ending in an existing signing placeholder without duplicating syntax", () => {
    expect(withholdEmbeddedUrls("[f](https://files.example/a?token=PRIVATE&X-Amz-Signature=[redacted])")).toBe(
      "[f](https://files.example/a?[redacted])",
    );
  });

  it("INV-5: protects resource diagnostics and partial event copies while preserving customer URLs", () => {
    const safety = engine({
      operations: {},
      embeddedUrls: {
        resources: { key: "object", partials: ["previous_attributes"], paths: { charge: ["failure_message"] } },
      },
    });
    const input = "See https://public.example/a?code=welcome&key=public";
    const result = safety.redact(
      {
        data: {
          object: { object: "charge", failure_message: input, description: input },
          previous_attributes: { failure_message: input, description: input },
        },
      },
      "GET",
      "/v1/things",
    ) as any;
    expect(result.data.object.failure_message).toContain("[redacted]");
    expect(result.data.previous_attributes.failure_message).toContain("[redacted]");
    expect(result.data.object.description).toBe(input);
    expect(result.data.previous_attributes.description).toBe(input);
    expect(safety.redact({ description: input.replace("See ", "") }, "GET", "/v1/things")).toEqual({
      description: input.replace("See ", ""),
    });
  });

  it("INV-5: removes a private suffix after an existing signing placeholder", () => {
    expect(
      withholdSignedLinks("https://files.example/a?X-Amz-Signature=[redacted]PRIVATE", { domains: [], buckets: [] }),
    ).not.toContain("PRIVATE");
  });

  it.each([
    "[file](/proxy/https://files.example/a?token=%255Bredacted%255D)",
    "[a](https://public.example/a?width=1),![b](https://files.example/a#&#91;redacted&#93;)",
    "[a](https://public.example/a?width=1);[b]( https://files.example/a%3F%5Bredacted%5D)",
  ])("INV-5: shares exact-placeholder admission and actual adjacent destination boundaries: %s", (input) => {
    expect(carriesWithheldLink(input)).toBe(true);
    expect(() => refuseWithheldLinks(input, "Vendor")).toThrow("withheld");
    expect(carriesWithheldLink("[file](https://files.example/a?width=1)[redacted]")).toBe(false);
    expect(carriesWithheldLink("[redacted] outside https://files.example/a?code=unredacted")).toBe(false);
  });

  it("INV-5: refuses decoded binary and multipart file bytes before upload", async () => {
    const text = "[file](/proxy/https://files.example/a%3F%5Bredacted%5D)";
    const bytes = new Uint8Array(new TextEncoder().encode(text));
    for (const body of [bytes, bytes.buffer, new Blob([text]), new URLSearchParams({ value: text })]) {
      await expect(refuseWithheldUpload(body, "Vendor")).rejects.toMatchObject({ code: "invalid_args" });
    }
    const form = new FormData();
    form.append("file", new Blob([text]), "index.js");
    await expect(refuseWithheldUpload(form, "Vendor")).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("INV-5: inspects object keys and array values with the same host policy as strings", () => {
    const input = "https://file.notion.so/a?%5Bredacted%5D";
    const external = "https://external.example/a?%5Bredacted%5D";
    const hosts = { domains: ["file.notion.so"], buckets: [] };
    for (const value of [{ [input]: "link" }, { nested: ["safe", { [input]: "link" }] }, [[input]]]) {
      expect(carriesWithheldLink(value)).toBe(true);
      expect(carriesWithheldLink(value, hosts)).toBe(true);
    }
    expect(carriesWithheldLink({ [external]: [external] }, hosts)).toBe(false);
    expect(carriesWithheldLink({ "https://public.example/?code=welcome": ["[redacted] outside"] })).toBe(false);
  });

  it("INV-5: scans all request-sized JSON keys and values iteratively without depth or breadth ceilings", () => {
    const nest = (value: unknown, depth: number): unknown => {
      for (let i = 0; i < depth; i++) value = [value];
      return value;
    };
    for (const depth of [48, 52, 20_000]) {
      expect(carriesWithheldLink(nest("https://files.example/?[redacted]", depth))).toBe(true);
      expect(carriesWithheldLink(nest("ordinary", depth))).toBe(false);
      expect(carriesWithheldLink(nest({ "https://files.example/?%5Bredacted%5D": "link" }, depth))).toBe(true);
    }
    expect(carriesWithheldLink(Array(110_000).fill("safe"))).toBe(false);
    expect(carriesWithheldLink(["https://files.example/?[redacted]", ...Array(110_000).fill("safe")])).toBe(true);
  });

  it("INV-5: refuses cyclic direct arguments while inspecting repeated non-cyclic references", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => refuseWithheldLinks(cyclic, "Vendor")).toThrow(expect.objectContaining({ code: "invalid_args" }));
    const repeated = { note: "safe" };
    expect(carriesWithheldLink([repeated, repeated])).toBe(false);
  });

  it("INV-5: decodes base64 once within its encoded length and optional operation value limit", async () => {
    const text = "https://files.example/?%255Bredacted%255D";
    await expect(refuseWithheldBase64(btoa(text), "Vendor")).rejects.toMatchObject({ code: "invalid_args" });
    await expect(refuseWithheldBase64("!!", "Vendor")).rejects.toMatchObject({ code: "invalid_args" });
    await expect(refuseWithheldBase64(btoa(btoa(text)), "Vendor")).resolves.toBeUndefined();
    await expect(refuseWithheldBase64(btoa("https://public.example/?code=welcome"), "Vendor")).resolves.toBeUndefined();
    for (const input of [btoa("safe"), btoa("safe").replace(/=+$/, ""), ` \n${btoa("safe")}\t`]) {
      await expect(refuseWithheldBase64(input, "Vendor", 4)).resolves.toBeUndefined();
      await expect(refuseWithheldBase64(input, "Vendor", 3)).rejects.toMatchObject({ code: "invalid_args" });
    }
  });

  it.each([
    "[f](/proxy/https://files.example/a%3Ftoken%3DPRIVATE)".repeat(30_000),
    "https://public.example/a<br>https://files.example/a?X-Amz-Signature&#61;PRIVATE ".repeat(25_000),
    `see https://public.example/a?${"?&a&".repeat(400_000)}`,
  ])(
    "INV-5: scans large reviewed paths, global signing values and admission with bounded linear passes",
    (input) => {
      const safety = engine({ operations: {}, embeddedUrls: { operations: { "GET /v1/things": ["message"] } } });
      const clean = linearWork(input, (message) => {
        const result = safety.redact({ message }, "GET", "/v1/things") as { message: string };
        return { message: result.message, withheld: carriesWithheldLink(result) };
      });
      expect(clean.message).not.toContain("PRIVATE");
      expect(clean.withheld).toBe(input.includes("PRIVATE"));
    },
    SCAN_HANG_GUARD_MS,
  );
});
