// Portable security/data-integrity regressions for #812 and PR #846 review rounds.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stripe } from "../src/providers/stripe/index.js";
import { vercel } from "../src/providers/vercel/index.js";
import { cloudflare } from "../src/providers/cloudflare/index.js";
import type { Connector, ConnectorContext } from "../src/types.js";
import { connectorContext } from "./fixtures/misc.js";

const ACCOUNT = "a".repeat(32);
const ZONE = "b".repeat(32);
const OPTIONS = { purpose: "URL safety regression" };
const ctx: ConnectorContext = {
  ...connectorContext(),
  credential: { get: async () => "rk_test_51abc", getAll: async () => ({ value: "rk_test_51abc" }) },
};
const VENDORS = [
  {
    name: "stripe",
    create: () => stripe("test", { ...OPTIONS, auth: { type: "apiKey" }, mode: "sandbox" }),
    read: "/v1/charges/ch_1",
    field: "failure_message",
    diagnostic: (text: string) => ({ object: "charge", failure_message: text }),
    userRead: "/v1/products/prod_1",
    userField: "description",
    user: (text: string) => ({ object: "product", description: text }),
    write: (text: string) => ({ method: "POST", path: "/v1/products/prod_1", body: { description: text } }),
    envelope: (data: unknown) => Response.json(data),
    error: (text: string) =>
      Response.json({ error: { type: "invalid_request_error", message: text } }, { status: 400 }),
    errorRead: "/v1/products/prod_1",
  },
  {
    name: "vercel",
    create: () => vercel("test", { ...OPTIONS, auth: { type: "token" } }),
    read: "/v13/deployments/dpl_1",
    field: "errorMessage",
    diagnostic: (text: string) => ({ errorMessage: text }),
    userRead: "/v13/deployments/dpl_1",
    userField: "meta",
    user: (text: string) => ({ meta: { note: text } }),
    write: (text: string) => ({
      method: "POST",
      path: "/v13/deployments",
      body: { name: "test", meta: { note: text } },
    }),
    envelope: (data: unknown) => Response.json(data),
    error: (text: string) => Response.json({ error: { code: "bad_request", message: text } }, { status: 400 }),
    errorRead: "/v3/deployments/dpl_1/events",
  },
  {
    name: "cloudflare",
    create: () => cloudflare("test", { ...OPTIONS, auth: { type: "apiToken" } }),
    read: `/accounts/${ACCOUNT}/builds/builds/build-1/logs`,
    field: "lines",
    diagnostic: (text: string) => ({ lines: [[123, text]] }),
    userRead: `/zones/${ZONE}/dns_records/dns-1`,
    userField: "content",
    user: (text: string) => ({ type: "TXT", name: "example.com", content: text }),
    write: (text: string) => ({ method: "PATCH", path: `/zones/${ZONE}/dns_records/dns-1`, body: { content: text } }),
    envelope: (data: unknown) => Response.json({ success: true, result: data, errors: [], messages: [] }),
    error: (text: string) =>
      Response.json({ success: false, errors: [{ code: 1000, message: text }] }, { status: 400 }),
    errorRead: `/accounts/${ACCOUNT}/access/custom_pages/page-1`,
  },
] as const;
const TEXTS = [
  "https://public.example/a<br>https://files.example/a?X-Amz-Signature&#61;PRIVATE",
  "https://public.example/a<br>https://files.example/a?X-Amz-Credential&#x3d;PRIVATE",
  "https://files.example/a?token&#61;PRIVATE",
  "https://files.example/a?token&#x3d;PRIVATE",
  "[file](/proxy/https://files.example/a?token=PRIVATE)",
  "[file](/proxy/https://files.example/a%3Fkey%3DPRIVATE)",
  "[a](/proxy/https://files.example/a?id=42)[file](/proxy/https://files.example/a?token=PRIVATE)![b](https://public.example/b?width=4)",
  "[file](/proxy/https://files.example/a#access_token=PRIVATE)",
];
const PLACEHOLDERS = [
  "https://files.example/a?[redacted]",
  "https://files.example/a?token=%5Bredacted%5D",
  "https://files.example/a#%255Bredacted%255D",
  "[a](https://public.example/a?x=1)[b](/proxy/https://files.example/a%3Ftoken%3D%5Bredacted%5D)",
  "[file](https://files.example/a?token=&#91;redacted&#93;)",
  "[file](https://files.example/a#&#x5b;redacted&#x5d;)",
];

let sent: Array<{ body: BodyInit | null | undefined; url: string }>;
let respond: () => Response;
const realFetch = globalThis.fetch;
beforeEach(() => {
  sent = [];
  respond = () => Response.json({});
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ body: init?.body, url: String(input) });
    return respond();
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
const call = (connector: Connector, tool: string, args: Record<string, unknown>) =>
  connector.callTool(tool, args, ctx) as Promise<any>;

describe.each(VENDORS)("$name URL safety", (vendor) => {
  it.each(TEXTS)(
    "INV-5: scans original escaped and relative destinations before success/select/error mapping: %s",
    async (input) => {
      const connector = vendor.create();
      respond = () => vendor.envelope(vendor.diagnostic(input));
      for (const projection of [{}, { select: [vendor.field] }]) {
        const result = await call(connector, `${vendor.name}_api_read`, { path: vendor.read, ...projection });
        expect(JSON.stringify(result)).toContain("[redacted]");
        expect(JSON.stringify(result)).not.toContain("PRIVATE");
      }
      respond = () => vendor.error(input);
      await expect(call(connector, `${vendor.name}_api_read`, { path: vendor.errorRead })).rejects.toMatchObject({
        code: "invalid_args",
        message: expect.stringContaining("[redacted]"),
      });
      try {
        await call(connector, `${vendor.name}_api_read`, { path: vendor.errorRead });
      } catch (error) {
        expect(String(error)).not.toContain("PRIVATE");
      }
    },
  );

  it.each([
    "See https://docs.example/tutorial?code=welcome&key=public#section",
    "https://EXAMPLE.com/a%2fb?code=welcome&key=%2f#section",
    "https://docs.example/a?token=ordinary&signature=public&sig=example",
    "https://public.example/a<br>https://docs.example/a?token&#61;ordinary",
  ])("INV-5: round-trips ordinary code/key URLs in customer data byte for byte: %s", async (input) => {
    const connector = vendor.create();
    respond = () => vendor.envelope(vendor.user(input));
    const read = await call(connector, `${vendor.name}_api_read`, {
      path: vendor.userRead,
      select: [vendor.userField],
    });
    expect(read.data[vendor.userField]).toEqual((vendor.user(input) as Record<string, unknown>)[vendor.userField]);
    await call(connector, `${vendor.name}_api_write`, vendor.write(input));
    expect(sent).toHaveLength(2);
    const raw = sent[1]!.body;
    if (vendor.name === "stripe") expect(new URLSearchParams(String(raw)).get("description")).toBe(input);
    else expect(JSON.stringify(JSON.parse(String(raw)))).toContain(input);
  });

  it.each(["&#61;", "&#x3d;", "=", "%3D"])(
    "INV-5: globally withholds signing values in customer strings before select: %s",
    async (equals) => {
      const connector = vendor.create();
      const input = `https://public.example/a<br>https://files.example/a?X-Amz-Security-Token${equals}PRIVATE`;
      respond = () => vendor.envelope(vendor.user(input));
      const result = await call(connector, `${vendor.name}_api_read`, {
        path: vendor.userRead,
        select: [vendor.userField],
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
      expect(JSON.stringify(result)).toContain("[redacted]");
      const value = vendor.name === "vercel" ? result.data.meta.note : result.data[vendor.userField];
      sent = [];
      await expect(call(connector, `${vendor.name}_api_write`, vendor.write(value))).rejects.toMatchObject({
        code: "invalid_args",
        message: expect.stringContaining("withheld"),
      });
      expect(sent).toHaveLength(0);
    },
  );

  it.each(PLACEHOLDERS)("INV-5: refuses plain/encoded withheld destinations with zero dispatch: %s", async (input) => {
    await expect(call(vendor.create(), `${vendor.name}_api_write`, vendor.write(input))).rejects.toMatchObject({
      code: "invalid_args",
      message: expect.stringContaining("withheld"),
    });
    expect(sent).toHaveLength(0);
  });

  it.each([
    "[redacted] outside a URL",
    "[file](https://public.example/a?width=1)[redacted]",
    "[file](/proxy/https://public.example/a?id=42) [redacted]",
    "https://public.example/a?code=unredacted",
    "[file](/proxy?url=https%3A%2F%2Fpublic.example%2Fa%3Ftoken%3Dordinary%26key%3Dpublic)",
  ])("INV-5: admits placeholders outside destinations and ordinary proxy parameters: %s", async (input) => {
    respond = () => vendor.envelope({});
    await call(vendor.create(), `${vendor.name}_api_write`, vendor.write(input));
    expect(sent).toHaveLength(1);
  });
});

it("INV-5: preserves Stripe descriptions, metadata, price nicknames and invoice footers through form writes", async () => {
  const connector = VENDORS[0].create();
  const input = "https://docs.example/a?code=welcome&key=public";
  for (const [path, body] of [
    ["/v1/products/prod_1", { description: input, metadata: { url: input } }],
    ["/v1/prices/price_1", { nickname: input }],
    ["/v1/invoices/in_1", { footer: input, description: input }],
    ["/v1/customers/cus_1", { description: input }],
  ] as const) {
    respond = () => Response.json(body);
    const read = await call(connector, "stripe_api_read", { path });
    expect(read.data).toEqual(body);
    await call(connector, "stripe_api_write", { method: "POST", path, body: read.data });
    expect([...new URLSearchParams(String(sent.at(-1)!.body)).values()].every((value) => value === input)).toBe(true);
  }
});

it.each(PLACEHOLDERS)("INV-5: refuses withheld links in Stripe JSON writes: %s", async (input) => {
  await expect(
    call(VENDORS[0].create(), "stripe_api_write", {
      method: "POST",
      path: "/v2/billing/meter_events",
      body: { event_name: "api_call", payload: { stripe_customer_id: "cus_1", value: input } },
    }),
  ).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("withheld") });
  expect(sent).toHaveLength(0);
});

it.each(PLACEHOLDERS)(
  "INV-5: refuses withheld destinations in Vercel named writes and raw/base64 uploads: %s",
  async (input) => {
    const connector = VENDORS[1].create();
    const cases = [
      ["upsert_project_env_var", { projectId: "web", key: "URL", value: input, type: "plain", targets: ["preview"] }],
      ["update_project_env_var", { projectId: "web", envVarId: "env_1", value: input }],
      ["vercel_api_upload", { method: "POST", path: "/v2/files", textBody: input }],
      ["vercel_api_upload", { method: "POST", path: "/v2/files", base64Body: btoa(input) }],
    ] as const;
    for (const [tool, args] of cases) {
      await expect(call(connector, tool, args)).rejects.toMatchObject({
        code: "invalid_args",
        message: expect.stringContaining("withheld"),
      });
      expect(sent).toHaveLength(0);
    }
  },
);

it.each(PLACEHOLDERS)("INV-5: refuses withheld destinations in Cloudflare generic text writes: %s", async (input) => {
  await expect(
    call(VENDORS[2].create(), "cloudflare_api_write", {
      method: "PUT",
      path: `/accounts/${ACCOUNT}/workers/scripts/main`,
      body: input,
    }),
  ).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("withheld") });
  expect(sent).toHaveLength(0);
});

it.each(PLACEHOLDERS)(
  "INV-5: refuses withheld destinations in Cloudflare raw/base64/multipart uploads: %s",
  async (input) => {
    const connector = VENDORS[2].create();
    const bodies = [
      { textBody: input },
      { base64Body: btoa(input) },
      { parts: [{ name: "value", text: input }] },
      { parts: [{ name: "file", text: input, fileName: "index.js" }] },
      { parts: [{ name: "file", base64: btoa(input), fileName: "index.js" }] },
    ];
    for (const body of bodies) {
      await expect(
        call(connector, "cloudflare_api_upload", {
          method: "PUT",
          path: `/accounts/${ACCOUNT}/workers/scripts/main`,
          ...body,
        }),
      ).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("withheld") });
      expect(sent).toHaveLength(0);
    }
  },
);

it("INV-5: round-trips ordinary Cloudflare KV and operator HTML links unchanged", async () => {
  const connector = VENDORS[2].create();
  const input = "See https://docs.example/a?code=welcome&key=public";
  const path = `/accounts/${ACCOUNT}/storage/kv/namespaces/ns/values/link`;
  respond = () => new Response(input, { headers: { "content-type": "text/plain" } });
  const read = await call(connector, "cloudflare_api_read", { path });
  expect(read.data).toBe(input);
  await call(connector, "cloudflare_api_upload", { method: "PUT", path, textBody: read.data });
  expect(sent.at(-1)!.body).toBe(input);
  respond = () => VENDORS[2].envelope({ custom_html: input });
  expect(
    (await call(connector, "cloudflare_api_read", { path: `/accounts/${ACCOUNT}/access/custom_pages/page-1` })).data
      .custom_html,
  ).toBe(input);
});

it("INV-5: withholds signing values before Stripe/Cloudflare named projections", async () => {
  const input = "https://public.example/a<br>https://files.example/a?X-Goog-Signature&#x3d;PRIVATE";
  respond = () => Response.json({ id: "acct_1", business_profile: { name: input } });
  expect((await call(VENDORS[0].create(), "get_stripe_account_info", {})).name).not.toContain("PRIVATE");
  respond = () => VENDORS[2].envelope([{ id: ACCOUNT, name: input }]);
  expect((await call(VENDORS[2].create(), "list_accounts", {})).accounts[0].name).not.toContain("PRIVATE");
});

it.each(TEXTS)("INV-5: scans escaped/relative Vercel named log projections: %s", async (input) => {
  const connector = VENDORS[1].create();
  respond = () => Response.json([{ type: "stdout", payload: { text: input } }]);
  const build = await call(connector, "get_deployment_build_logs", { deploymentId: "dpl_1" });
  expect(build.events[0].text).not.toContain("PRIVATE");
  expect(build.events[0].text).toContain("[redacted]");
  respond = () =>
    new Response(JSON.stringify({ level: "info", message: input }) + "\n", {
      headers: { "content-type": "application/x-ndjson" },
    });
  const runtime = await call(connector, "get_runtime_logs", { projectId: "web", deploymentId: "dpl_1" });
  expect(runtime.logs[0].text).not.toContain("PRIVATE");
  expect(runtime.logs[0].text).toContain("[redacted]");
});

it("INV-5: omits URL-bearing Cloudflare envelope cursors and preserves ordinary opaque cursors", async () => {
  const connector = VENDORS[2].create();
  for (const cursor of [
    "opaque_cursor_1",
    "https://files.example/a?token=PRIVATE",
    "https://files.example/a?X-Amz-Signature&#61;PRIVATE",
  ]) {
    respond = () => Response.json({ success: true, result: [], result_info: { cursor }, errors: [], messages: [] });
    const result = await call(connector, "cloudflare_api_read", {
      path: `/accounts/${ACCOUNT}/storage/kv/namespaces/ns/keys`,
    });
    expect(result.page).toEqual(
      cursor === "opaque_cursor_1" ? { hasMore: true, next: cursor, param: "cursor" } : { hasMore: false },
    );
  }
});

it("INV-5: describes Worker JavaScript as unchanged base64, outside decoded-text scanning", async () => {
  const input = "export const url = 'https://files.example/a?X-Amz-Signature=PRIVATE';";
  respond = () => new Response(input, { headers: { "content-type": "application/javascript" } });
  const result = await call(VENDORS[2].create(), "cloudflare_api_read", {
    path: `/accounts/${ACCOUNT}/workers/scripts/main`,
  });
  expect(result.data.base64).toBe(btoa(input));
});

it("INV-5: sanitizes every Vercel deployment-list diagnostic before full-response and select projections", async () => {
  const connector = VENDORS[1].create();
  respond = () =>
    Response.json({
      deployments: [
        { uid: "dpl_1", errorMessage: "Download https://files.example/a?token=PRIVATE" },
        { uid: "dpl_2", errorMessage: "See https://files.example/b#key=PRIVATE" },
      ],
    });
  for (const projection of [{}, { select: ["deployments.errorMessage"] }]) {
    const result = await call(connector, "vercel_api_read", { path: "/v7/deployments", ...projection });
    expect(result.data.deployments).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(result.data.deployments.map((item: any) => item.errorMessage)).toEqual([
      "Download https://files.example/a?[redacted]",
      "See https://files.example/b#[redacted]",
    ]);
  }
});

it.each(["events", "invocations"])(
  "INV-5: sanitizes Cloudflare telemetry metadata and raw string/object sources in %s before select",
  async (view) => {
    const connector = VENDORS[2].create();
    const input = "Fetched https://imagedelivery.net/account/image/private?exp=2000000000&sig=PRIVATE";
    const events = [
      input,
      { message: input, nested: [input, { log: input }], ordinary: "https://docs.example/a?page=1" },
    ].map((source, i) => ({
      $metadata: { id: `event${i}`, message: input, error: input },
      source,
      timestamp: 1,
      dataset: "cloudflare-workers",
    }));
    const data =
      view === "events" ? { events: { events } } : { invocations: { request1: [events[0]], request2: [events[1]] } };
    respond = () => VENDORS[2].envelope(data);
    const selected = view === "events" ? "events.events" : "invocations";
    for (const projection of [
      {},
      { select: [selected] },
      ...(view === "events" ? [{ select: ["events.events.source", "events.events.$metadata.message"] }] : []),
    ]) {
      const result = await call(connector, "cloudflare_api_read", {
        method: "POST",
        path: `/accounts/${ACCOUNT}/workers/observability/telemetry/query`,
        body: { view, queryId: "review", timeframe: { from: 0, to: 2 } },
        ...projection,
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
      expect(JSON.stringify(result)).toContain("[redacted]");
      expect(JSON.stringify(result)).toContain("https://docs.example/a?page=1");
    }
  },
);

const JSON_UPLOADS = [
  {
    vendor: VENDORS[1],
    args: (data: string) => ({
      method: "POST",
      path: "/v13/deployments",
      body: {
        name: "review",
        files: [
          { file: "safe.txt", data: btoa("safe"), encoding: "base64" },
          { file: "url.txt", data, encoding: "base64" },
        ],
      },
    }),
  },
  {
    vendor: VENDORS[2],
    args: (value: string) => ({
      method: "PUT",
      path: `/accounts/${ACCOUNT}/storage/kv/namespaces/ns/bulk`,
      body: [
        { key: "safe", value: btoa("safe"), base64: true },
        { key: "review", value, base64: true },
      ],
    }),
  },
] as const;

describe.each(JSON_UPLOADS)("$vendor.name decoded JSON admission", ({ vendor, args }) => {
  it.each(PLACEHOLDERS)(
    "INV-5: refuses withheld links in later base64 array entries with zero dispatch: %s",
    async (input) => {
      for (const encoded of [btoa(input), btoa(input).replace(/=+$/, ""), btoa(input).replace(/.{12}/g, "$&\n")]) {
        await expect(call(vendor.create(), `${vendor.name}_api_write`, args(encoded))).rejects.toMatchObject({
          code: "invalid_args",
          message: expect.stringContaining("withheld"),
        });
        expect(sent).toHaveLength(0);
      }
    },
  );

  it.each(["not base64!", "A".repeat(4 * Math.ceil((8 * 1024 * 1024) / 3) + 4)])(
    "INV-5: refuses malformed or oversized decoded JSON uploads with zero dispatch %#",
    async (input) => {
      await expect(call(vendor.create(), `${vendor.name}_api_write`, args(input))).rejects.toMatchObject({
        code: "invalid_args",
      });
      expect(sent).toHaveLength(0);
    },
  );

  it("INV-5: preserves benign base64 field bytes and application links on dispatch", async () => {
    const input = "See https://docs.example/a?code=welcome&key=public [redacted] outside";
    const request = args(btoa(input));
    respond = () => vendor.envelope({});
    await call(vendor.create(), `${vendor.name}_api_write`, request);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0]!.body))).toEqual(request.body);
  });

  it("INV-5: refuses JSON-escaped and entity-encoded destinations after the documented base64 decode", async () => {
    for (const input of [
      '{"https:\\u002f\\u002ff.test/\\u003f\\u005bredacted\\u005d":"link"}',
      "[file](https://files.example/a?token=&#x5b;redacted&#x5d;)",
    ]) {
      await expect(call(vendor.create(), `${vendor.name}_api_write`, args(btoa(input)))).rejects.toMatchObject({
        code: "invalid_args",
        message: expect.stringContaining("withheld"),
      });
      expect(sent).toHaveLength(0);
    }
  });
});

describe.each(VENDORS)("$name JSON key and depth admission", (vendor) => {
  const args = (metadata: unknown) =>
    vendor.name === "stripe"
      ? { method: "POST", path: "/v1/products/prod_1", body: { metadata } }
      : vendor.name === "vercel"
        ? { method: "POST", path: "/v13/deployments", body: { name: "review", meta: metadata } }
        : {
            method: "PUT",
            path: `/accounts/${ACCOUNT}/storage/kv/namespaces/ns/bulk`,
            body: [{ key: "review", value: "safe", metadata }],
          };

  it.each(["https://f.test/?%5Bredacted%5D", "https://f.test/#%255Bredacted%255D"])(
    "INV-5: refuses encoded withheld object keys with zero dispatch: %s",
    async (input) => {
      await expect(call(vendor.create(), `${vendor.name}_api_write`, args({ [input]: "link" }))).rejects.toMatchObject({
        code: "invalid_args",
        message: expect.stringContaining("withheld"),
      });
      expect(sent).toHaveLength(0);
    },
  );

  it.each(["https://files.example/a?[redacted]", "ordinary text"])(
    "INV-5: refuses over-depth metadata instead of skipping an unexamined subtree: %s",
    async (input) => {
      let nested: unknown = input;
      for (let depth = 0; depth < 52; depth++) nested = [nested];
      await expect(call(vendor.create(), `${vendor.name}_api_write`, args({ nested }))).rejects.toMatchObject({
        code: "invalid_args",
        ...(vendor.name === "cloudflare" ? { message: expect.stringContaining("maximum JSON depth") } : {}),
      });
      expect(sent).toHaveLength(0);
    },
  );
});
