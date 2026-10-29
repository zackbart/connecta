// The shared value-safety engine (decision 0005, "Value safety"): one path
// language, one heuristic that is the union of the two former vendor engines,
// and one error policy, for every REST vendor.
import { describe, expect, it } from "vitest";
import { SentSecrets } from "../src/sent-secrets.js";
import { OperationIndex, type OpenApiData } from "../src/providers/_shared/rest/operation-index.js";
import {
  carriesWithheldLink,
  redact,
  REDACTED,
  refuse,
  refuseWithheldBase64,
  refuseWithheldLinks,
  refuseWithheldUpload,
  safe,
  validPath,
  valueSafety,
  vendorErrors,
  withholdEmbeddedUrls,
  withholdEmbeddedUrlsIn,
  type ValueSafetyTable,
} from "../src/providers/_shared/rest/value-safety.js";
import { linearWork, SCAN_HANG_GUARD_MS } from "./scanner-work.js";

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

  it("INV-5 INV-10: hints only paths a rule withholds whatever their value, and the body confirms each", () => {
    const safety = engine({
      operations: {
        "GET /v1/things": redact("Hooks carry secrets.", [
          "hook_uuid",
          "data[].hook_uuid",
          "drains[].headers{}",
          "aliases@keys",
          "url:dest_conf",
          "origin:callback",
          "items[?env].value",
        ]),
        "POST /v1/keys": refuse("It mints a key."),
      },
      fields: {
        card_number: { verdict: "redact", reason: "A PAN." },
        token_hint: { verdict: "keep", reason: "Metadata." },
      },
      resources: { key: "object", rules: { session: { reason: "A payer page.", paths: ["payer_page"] } } },
    });
    const hint = safety.withholds("GET", "/v1/things");
    const split = (path: string) => path.split(".");
    const known = ["hook_uuid", "data[].hook_uuid", "card_number", "x.card_number", "items[].private_token"];
    // Rules that can leave some value unchanged are not hints: a URL's parameters or a bare
    // origin, a map's keys, a typed record, a resource type, a suffix rule that scrubs only
    // strings (`input_tokens`). Nor are reviewed paths placed elsewhere, a `[]` path where no
    // list is declared, a container above a withheld path, or a reviewed keep.
    const unknown = [
      "id",
      "result[].hook_uuid",
      "data.hook_uuid",
      "data",
      "drains[].headers",
      "aliases",
      "dest_conf",
      "callback",
      "items[].value",
      "payer_page",
      "token_hint",
      "usage.input_tokens",
    ];
    expect(known.filter((path) => !hint(split(path)))).toEqual([]);
    expect(unknown.filter((path) => hint(split(path)))).toEqual([]);
    // Each hinted path is withheld from a body carrying it, whatever non-null shape its value has.
    for (const value of ["h-1", "https://hooks.example", 7, true, { nested: "v" }, ["v"]]) {
      const body = {
        hook_uuid: value,
        data: [{ hook_uuid: value }],
        card_number: value,
        x: { card_number: value },
        items: [{ private_token: value }],
      };
      const out = safety.redact(structuredClone(body), "GET", "/v1/things") as any;
      expect([
        out.hook_uuid,
        out.data[0].hook_uuid,
        out.card_number,
        out.x.card_number,
        out.items[0].private_token,
      ]).toEqual(Array(5).fill(REDACTED));
    }
    // The excluded shapes really pass some value through: a bare origin and a number under a suffix name.
    const passed = safety.redact(
      { callback: "https://hooks.example", usage: { input_tokens: 7 } },
      "GET",
      "/v1/things",
    ) as any;
    expect(passed).toEqual({ callback: "https://hooks.example", usage: { input_tokens: 7 } });
    expect(safety.withholds("POST", "/v1/keys")(["id"])).toBe(true);
    expect(safety.withholds("POST", "/v1/things")(["hook_uuid"])).toBe(false);
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
  const HOST = "prod-files-secure.s3.us-west-2.amazonaws.com";
  const S3 = `https://${HOST}`;
  const query = "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAEXAMPLE&X-Amz-Signature=FAKE_SIGNATURE";
  const leaks = (text: string) => ["ASIAEXAMPLE", "FAKE_SIGNATURE"].filter((secret) => text.includes(secret));
  const withheld = (text: string) => withholdEmbeddedUrls(text);

  it.each([
    ["a filename with parentheses", `![a](${S3}/ws/file(1).png?${query})`, `![a](${S3}/ws/file(1).png?${REDACTED})`],
    [
      "numeric slash references",
      `<file src="https:&#47;&#47;${HOST}/ws/file.png?${query}">`,
      `<file src="https:&#47;&#47;${HOST}/ws/file.png?${REDACTED}">`,
    ],
    [
      "a percent-encoded whole link",
      `see ${encodeURIComponent(`${S3}/ws/a.png?${query}`)} now`,
      `see https%3A%2F%2F${HOST}%2Fws%2Fa.png?${REDACTED} now`,
    ],
  ])("INV-5: withholds a signed link in %s and keeps the syntax around it", (_, text, expected) => {
    const clean = withheld(text);
    expect(leaks(clean)).toEqual([]);
    expect(clean).toBe(expected);
  });

  it("INV-5: finds a withheld file link in a request, plain or encoded, and nothing else", () => {
    for (const text of [
      `![a](${S3}/a.png?${REDACTED})`,
      `<file src="${S3}/a.png?X-Amz-Signature=%5Bredacted%5D">`,
      `https:&#47;&#47;${HOST}/a.png&#63;&#91;redacted&#93;`,
    ]) {
      expect(carriesWithheldLink({ body: [{ text }] })).toBe(true);
    }
    for (const text of [`![a](${S3}/a.png)`, `https://example.com/?q=public`, `${REDACTED} ${S3}/a.png`]) {
      expect(carriesWithheldLink({ text })).toBe(false);
    }
  });

  // Review round 3, finding 3: the exact placeholder, decoded, and never the word.
  it.each([
    "https://file.notes.example/f/f/a.png?%5B%72%65%64%61%63%74%65%64%5D",
    "https://file.notes.example/f/f/a.png?&amp;#91;redacted&amp;#93;",
    "![a](https://file.notes.example/f/f/a\\).png?[redacted])",
  ])("INV-5: finds the placeholder however it is encoded in %s", (text) => {
    expect(carriesWithheldLink({ text })).toBe(true);
  });

  it.each([
    ["host names in one unbroken link", `https://${"file.notes.example/".repeat(200_000)}`],
    ["one Markdown destination of open parentheses", `[a](https://file.notes.example/${"(".repeat(2_000_000)}`],
    ["leading Markdown whitespace", `[a](${" ".repeat(2_000_000)}https://file.notes.example/a?b)[redacted]`],
  ])(
    "INV-5: scans %s in linear time",
    (_, text) => {
      const clean = linearWork(text, withheld);
      expect(clean.length).toBeGreaterThan(0);
      expect(linearWork(text, (input) => carriesWithheldLink(input))).toBeTypeOf("boolean");
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
      "encoded URL",
      "see https%3A%2F%2Ffiles.example%2Fa%3Ftoken%3DPRIVATE now",
      "see https%3A%2F%2Ffiles.example%2Fa?[redacted] now",
    ],
    [
      "credential after a placeholder",
      "see https://files.example/a?token=[redacted]PRIVATE",
      "see https://files.example/a?[redacted]",
    ],
  ])("INV-5: withholds credential queries in %s", (_, input, expected) => {
    expect(withholdEmbeddedUrls(input)).toBe(expected);
    expect(withholdEmbeddedUrls(expected)).toBe(expected);
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
    ["many signed queries", "[f](https://example.com/a?sig=PRIVATE)".repeat(40_000)],
    ["one long parameter name", `see https://example.com/a?${"a".repeat(2_000_000)}=value`],
    [
      // Placeholder runs a repeated private value leaves: each run is read once (#703).
      "many parameter delimiters and placeholder runs",
      `see https://example.com/a?${"?&a&".repeat(400_000)} ${"[redacted]abc-".repeat(100_000)}=PRIVATE ${"[redacted]!!!=".repeat(100_000)}=PRIVATE`,
    ],
  ])(
    "INV-5: scans %s with bounded linear passes",
    (_, input) => {
      expect(linearWork(input, withholdEmbeddedUrls)).not.toContain("PRIVATE");
    },
    SCAN_HANG_GUARD_MS,
  );
});

describe("reviewed text policy and global admission (#846)", () => {
  it.each([
    "[file](/proxy/https://files.example/a?token=PRIVATE)",
    "[file](/proxy/https://files.example/a%3Fkey%3DPRIVATE)",
    "[file](/proxy/https://files.example/a#token=PRIVATE)",
    "[a](/proxy/https://public.example/a?id=1)[b](/proxy/https://files.example/a?sig=PRIVATE)",
  ])("INV-5: inspects a relative Markdown destination's own query: %s", (input) => {
    expect(withholdEmbeddedUrls(input)).not.toContain("PRIVATE");
  });

  it.each(["&#61;"])("INV-5: scans original entity equals before URL normalization: %s", (equals) => {
    const safety = engine({ operations: {}, embeddedUrls: { operations: { "GET /v1/things": ["message"] } } });
    const input = `https://public.example/a<br>https://files.example/a?token${equals}PRIVATE`;
    const result = safety.redact({ message: input, description: input }, "GET", "/v1/things") as any;
    expect(result.message).not.toContain("PRIVATE");
    expect(result.description).toBe(input);
    const signed = input.replace("token", "X-Amz-Signature");
    expect(JSON.stringify(safety.redact({ description: signed }, "GET", "/v1/things"))).not.toContain("PRIVATE");
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

  it("INV-5: withholds complete signing values and private suffixes across character references", () => {
    for (const text of [
      "X-Amz-Signature=[redacted]PRIVATE",
      "/a?X-Amz-Signature=[redacted]PRIVATE",
      "https://files.example/a?X-Amz-Signature=[redacted]PRIVATE",
    ])
      expect(withholdEmbeddedUrls(text)).not.toContain("PRIVATE");
    const safety = engine({ operations: {}, embeddedUrls: { operations: { "GET /v1/things": ["message"] } } });
    // References are value data even when they spell punctuation. Keep the original spelling of
    // ordinary text and of the genuine query parameter after the signing value (#703).
    for (const [value, remainder] of [
      ["&#50;&#97;PRIVATE", true],
      ["&#x32;&#X61;PRIVATE", true],
      ["raw&#50;mixed&#x61;PRIVATE", true],
      ["&amp;&equals;&plus;&sol;PRIVATE", true],
      ["&plus;&sol;&equals;", true],
      ["&#43;&#47;&#61;", true],
      ["&quot;&apos;&#32;&#41;PRIVATE", false],
      ["&amp;#50;&amp;#x61;PRIVATE", true],
      ["&amp#50;&amp#x61;PRIVATE", true],
      ["&#38;#50;PRIVATE", true],
      ["&CounterClockwiseContourIntegral;PRIVATE", false],
      ["&#00000000000000000000000000000050;PRIVATE", true],
      ["&#50&#97PRIVATE", true],
      ["raw&#479PRIVATE", true],
      ["&#x2faPRIVATE", true],
      ["&#00000479PRIVATE", true],
      ["&#x0002faPRIVATE", true],
      ["&#1000PRIVATE", true],
      ["&#x250PRIVATE", true],
      ["&amp;#479PRIVATE", true],
      ["&#479;PRIVATE", false],
      ["&#x2fa;PRIVATE", false],
      ["&amp;#479;PRIVATE", false],
    ] as const) {
      for (const name of ["X-Amz-Signature", "X-Goog-Credential", "X-Amz-Security-Token"]) {
        const input = `diagnostic ${name}=${value}&name=alice now`;
        const expected = `diagnostic ${name}=[redacted]&name=alice now`;
        expect(safety.redact({ description: input }, "GET", "/v1/things"), input).toEqual({ description: expected });
        expect(withholdEmbeddedUrls(input), input).toBe(expected);
        for (const prefix of [`${name}=[redacted]`, "[redacted]"]) {
          const split = `diagnostic ${prefix}${value}&name=alice now`;
          const clean = `diagnostic ${prefix}&name=alice now`;
          expect(safety.redact({ description: split }, "GET", "/v1/things"), split).toEqual({
            description: prefix === "[redacted]" && !remainder ? split : clean,
          });
        }
        const link = `see https://files.example/a?${name}=${value}&name=alice now`;
        expect(safety.redact({ message: link }, "GET", "/v1/things"), link).toEqual({
          message: `see https://files.example/a?${name}=[redacted]&name=alice now`,
        });
        expect(withholdEmbeddedUrls(link), link).toBe("see https://files.example/a?[redacted] now");
        const ending = `see [file](https://files.example/a?${name}=${value}).`;
        expect(withholdEmbeddedUrls(ending), ending).toBe("see [file](https://files.example/a?[redacted]).");
      }
    }
    const schema = { type: "object", properties: { pin: { type: "string", writeOnly: true } } } as const;
    for (const [parameter, pin] of [
      ["X-Amz-Security-Token=raw&#479PRIVATE", "X-Amz-Security-Token="],
      ["X-Amz-Security-Token=raw&#479PRIVATE", "X-Amz-Security-Token=raw&"],
      ["X-Amz-Security-Token=raw&#479PRIVATE", "Security-Token"],
      ["X-Amz-Security-Token&#619PRIVATE", "X-Amz-Security-Token&"],
    ]) {
      const secrets = new SentSecrets();
      secrets.arguments({ pin }, schema);
      const input = secrets.redact(`diagnostic ${parameter}&name=alice now`);
      const out = safety.redact({ description: input }, "GET", "/v1/things") as { description: string };
      expect(out.description, pin).not.toContain("PRIVATE");
      expect(out.description, pin).toContain("&name=alice now");
    }
    // Every cut is inside an encoded value or separator, before the private value is replaced.
    for (const prefix of ["&", "&a", "&am", "&amp", "&amp;", "&amp#", "&amp;#", "&#", "&#x"]) {
      const hex = prefix === "&#x";
      const value = `${hex ? "&#x50;" : prefix.startsWith("&a") ? "&amp;#80;" : "&#80;"}RIVATE`;
      // The semicolon-less amp spelling is valid only immediately before `#`.
      const encoded = prefix === "&amp#" ? value.replace("amp;", "amp") : value;
      const secrets = new SentSecrets();
      secrets.arguments({ pin: `X-Amz-Signature=${prefix}` }, schema);
      const input = secrets.redact(`diagnostic X-Amz-Signature=${encoded}&name=alice now`);
      expect(safety.redact({ description: input }, "GET", "/v1/things"), prefix).toEqual({
        description: "diagnostic [redacted]&name=alice now",
      });
    }
    for (const separator of [
      "&amp;#61;",
      "&amp;#x3d;",
      "&amp;equals;",
      "&#38;#61;",
      "&#x26;#x3d;",
      "&amp;amp;#61;",
      "&amp#61;",
    ]) {
      const input = `diagnostic X-Amz-Security-Token${separator}PRIVATE&name=alice now`;
      expect(safety.redact({ description: input }, "GET", "/v1/things"), separator).toEqual({
        description: `diagnostic X-Amz-Security-Token${separator}[redacted]&name=alice now`,
      });
      const secrets = new SentSecrets();
      secrets.arguments({ pin: "X-Amz-Security-Token&" }, schema);
      const altered = secrets.redact(input);
      expect(safety.redact({ description: altered }, "GET", "/v1/things"), separator).toEqual({
        description: "diagnostic [redacted]&name=alice now",
      });
    }
    for (const text of [
      "ordinary prose &amp; &equals; &#50; stays here",
      "see https://public.example/a?width=400&name=alice now",
      "see https://public.example/a?width=400&amp;name=alice now",
      "an assignment name=alice&other=bob now",
      "[redacted]&nbsp;was rotated",
      "value [redacted]&#8212;rotated yesterday",
      "[redacted]&amp;nbsp;was rotated",
      "[redacted]#160;was rotated",
    ]) {
      expect(safety.redact({ description: text, message: text }, "GET", "/v1/things")).toEqual({
        description: text,
        message: text,
      });
    }
    expect(withholdEmbeddedUrls("value [redacted]abc&nbsp;was rotated")).toBe("value [redacted]&nbsp;was rotated");
    for (const reference of ["&plus;", "&sol;", "&equals;", "&percnt;", "&lowbar;", "&UnderBar;", "&fjlig;"]) {
      expect(withholdEmbeddedUrls(`value [redacted]${reference}PRIVATE now`), reference).toBe("value [redacted] now");
    }
    expect(withholdEmbeddedUrls("X-Amz-Signature=PRIVATE&amp=public&name=alice now")).toBe(
      "X-Amz-Signature=[redacted]&amp=public&name=alice now",
    );
    expect(withholdEmbeddedUrls("X-Amz-Signature=PRIVATE#123&name=alice now")).toBe(
      "X-Amz-Signature=[redacted]&name=alice now",
    );
  });

  it.each([
    "X-Amz-Signature",
    "X-Amz-Credential",
    "X-Amz-Security-Token",
    "X-Goog-Signature",
    "X-Goog-Credential",
    "X-Goog-Security-Token",
  ])("INV-5: retains text spelling while maintaining signing boundaries across name representations: %s", (name) => {
    const safety = engine({ operations: {}, embeddedUrls: { operations: { "GET /v1/things": ["message"] } } });
    const forms = [
      (c: string) => `&#${c.charCodeAt(0)};`,
      (c: string) => `&#000${c.charCodeAt(0)}`,
      (c: string) => `&#X${c.charCodeAt(0).toString(16)};`,
      (c: string) => `&#x00${c.charCodeAt(0).toString(16)}`,
      (c: string) => `%${c.charCodeAt(0).toString(16)}`,
      (c: string) => `%2525${c.charCodeAt(0).toString(16)}`,
      (c: string) => `&amp;#${c.charCodeAt(0)};`,
      (c: string) => `&#38;#x${c.charCodeAt(0).toString(16)};`,
      (c: string) => `&amp#${c.charCodeAt(0)};`,
      (c: string) => `\\u00${c.charCodeAt(0).toString(16)}`,
      (c: string) => `\\x${c.charCodeAt(0).toString(16)}`,
      (c: string) => (c === "-" ? "&hyphen;" : c),
      (c: string) => (c === "-" ? "&amp;dash;" : c),
    ];
    for (const encode of forms) {
      const spellings = [
        Array.from(name, encode).join(""),
        ...Array.from(name, (c, i) => name.slice(0, i) + encode(c) + name.slice(i + 1)),
      ];
      for (const spelling of spellings)
        for (const separator of ["=", "&#61;", "&amp;#x3d;", "%253d"]) {
          const input = `diagnostic ${spelling}${separator}PRIVATE_VALUE_27abc&name=alice now`;
          const expected = `diagnostic ${spelling}${separator}[redacted]&name=alice now`;
          expect(safety.redact({ description: input }, "GET", "/v1/things"), input).toEqual({
            description: expected,
          });
          expect(withholdEmbeddedUrls(input), input).toBe(expected);
          const secrets = new SentSecrets();
          secrets.arguments(
            { pin: spelling.slice(3, 15) },
            {
              type: "object",
              properties: { pin: { type: "string", writeOnly: true } },
            },
          );
          const altered = withholdEmbeddedUrls(secrets.redact(input));
          expect(altered, input).not.toContain("PRIVATE");
          const global = safety.redact({ description: secrets.redact(input) }, "GET", "/v1/things") as {
            description: string;
          };
          expect(global.description, input).not.toContain("PRIVATE");
          expect(global.description, input).toContain("&name=alice now");
          const link = `see https://files.example/a?${spelling}${separator}PRIVATE_VALUE_27abc&name=alice now`;
          expect(JSON.stringify(safety.redact({ message: link }, "GET", "/v1/things")), link).not.toContain("PRIVATE");
        }
    }
    for (const text of [
      "ordinary X&#45;Amz&#45;Algorithm=public&name=alice now",
      "ordinary X%2DAmz%2DDate=public&name=alice now",
      "ordinary X&unknown;Amz-Signature=public&name=alice now",
      "ordinary X&#xZZ;Amz-Signature=public&name=alice now",
      "ordinary X&#45Amz-Signature public&name=alice now",
      "ordinary X&hyphen=Amz-Signature=public&name=alice now",
      "Q&A AT&T &nbsp; ordinary text",
    ])
      expect(withholdEmbeddedUrls(text), text).toBe(text);
  });

  it(
    "INV-5: scans consecutive altered name candidates within a linear work bound",
    () => {
      for (const group of ["[redacted]&hyphen;", "[redacted][redacted]&dash;", "[redacted]&#45;"]) {
        const input = group.repeat(50_000) + " now";
        const expected = group.includes("#") ? "[redacted] now" : input;
        expect(linearWork(input, withholdEmbeddedUrls) === expected).toBe(true);
        expect(withholdEmbeddedUrls(group + "[redacted]&hyphen;Signature\\u003dPRIVATE now")).not.toContain("PRIVATE");
      }
    },
    SCAN_HANG_GUARD_MS,
  );

  it("INV-5: applies complete value boundaries after recognizing an altered name", () => {
    const safety = engine({ operations: {}, embeddedUrls: {} });
    const schema = { type: "object", properties: { pin: { type: "string", writeOnly: true } } } as const;
    for (const name of [
      "X-Amz-Signature",
      "X&hyphen;Amz&hyphen;Signature",
      "X&#45;Goog&#45;Credential",
      "X%2DAmz%2DSecurity-Token",
    ])
      for (const value of [
        "&quot;PRIVATE_VALUE_27abc",
        "&amp;quot;PRIVATE_VALUE_27abc",
        "&#32;PRIVATE_VALUE_27abc",
        "&CounterClockwiseContourIntegral;PRIVATE_VALUE_27abc",
        "&#50;PRIVATE_VALUE_27abc",
      ])
        for (const pin of [name.slice(3, 15), "Signatur", name, "Signature=", "Credential=", "Security-Token="]) {
          const secrets = new SentSecrets();
          secrets.arguments({ pin }, schema);
          for (const separator of ["=", "\\u003d"]) {
            const text = secrets.redact(`diagnostic ${name}${separator}${value}&name=alice now`);
            const out = safety.redact({ description: text }, "GET", "/v1/things") as { description: string };
            expect(out.description, text).not.toContain("PRIVATE_VALUE");
            expect(out.description, text).toContain("&name=alice now");
            expect(withholdEmbeddedUrls(text), text).not.toContain("PRIVATE_VALUE");
          }
        }
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

  it("INV-5: inspects object keys and array values with the same URL policy as strings", () => {
    const input = "https://file.notes.example/a?%5Bredacted%5D";
    for (const value of [{ [input]: "link" }, { nested: ["safe", { [input]: "link" }] }, [[input]]]) {
      expect(carriesWithheldLink(value)).toBe(true);
    }
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
    `https://files.example/a?X-Amz-Signature=PRIVATE diagnostic X&${"amp;".repeat(400_000)}#45;Amz-Signature=PRIVATE now ${"diagnostic X&#45;Goog&#45;Signature=PRIVATE&name=alice now ".repeat(20_000)} ${"diagnostic [redacted]&hyphen;Amz-Signature\\u003dPRIVATE&name=alice now ".repeat(10_000)}`,
    "[f](/proxy/https://files.example/a%3Ftoken%3DPRIVATE)".repeat(30_000),
    "https://public.example/a<br>https://files.example/a?X-Amz-Signature&#61;PRIVATE ".repeat(25_000),
    `see https://public.example/a?${"?&a&".repeat(400_000)} ${"see https://files.example/a?X-Amz-Signature=&#50;&#x61;&amp;&equals;&plus;&sol;PRIVATE&name=alice now ".repeat(
      15_000,
    )} diagnostic X-Goog-Credential=[redacted]${"&#00000000000000000000000050;&amp;#x61;".repeat(30_000)}PRIVATE now ${"diagnostic [redacted]#50;PRIVATE now X-Amz-Security-Token&amp;#61;PRIVATE now ".repeat(
      15_000,
    )}`,
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
