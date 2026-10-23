import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../../errors.js";

import { notion, NOTION_API_VERSION } from "./index.js";
import { NotionApi, notionIndex } from "./api.js";
import { openapi } from "./openapi.generated.js";
import { manifest } from "../../http/vendor.js";
import { configureGuardedTransport } from "../../guarded-transport.js";

import { silentLogger } from "../../../test/helpers.js";
import type { Connector, ConnectorContext } from "../../types.js";

// The token connector is Connecta's own, so there is no downstream catalog to
// stub. What needs stubbing is the network: every assertion below either
// inspects the request this connection built or the projection it made of a
// canned Notion payload.

interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

const calls: StubCall[] = [];
let queued: StubResponse[] = [];

function queue(...responses: StubResponse[]): void {
  queued.push(...responses);
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  configureGuardedTransport({ send: (url, init) => globalThis.fetch(url, init) });
  calls.length = 0;
  queued = [];
  globalThis.fetch = vi.fn(async (input: any, init: any = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const next = queued.shift() ?? { body: {} };
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json", ...next.headers },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  configureGuardedTransport(undefined);
  globalThis.fetch = realFetch;
});

function context(token: string | null = "secret_token"): ConnectorContext {
  return {
    storage: {
      capabilities: { absoluteExpiry: true },
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
      compareAndSet: async () => false,
    },
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    credential: {
      get: async () => token,
      getAll: async () => (token ? { value: token } : null),
    },
  };
}

const TOKEN = { auth: { type: "token" }, purpose: "Team knowledge base" } as const;

function build(overrides: Record<string, unknown> = {}): Connector {
  return notion("workspace", { ...TOKEN, ...overrides } as any);
}

function call(
  connector: Connector,
  name: string,
  args: Record<string, unknown> = {},
  ctx: ConnectorContext = context(),
): Promise<any> {
  return connector.callTool(name, args, ctx) as Promise<any>;
}

async function refusal(promise: Promise<unknown>): Promise<ConnectorCallError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConnectorCallError);
  return error as ConnectorCallError;
}

/** A page carrying one of every property shape the projection flattens. */
const PAGE_FIXTURE = {
  object: "page",
  id: "page-1",
  url: "https://app.notion.com/p/page-1",
  created_time: "2026-01-01T00:00:00.000Z",
  last_edited_time: "2026-02-02T00:00:00.000Z",
  created_by: { object: "user", id: "user-1", name: "Ada" },
  last_edited_by: { object: "user", id: "user-2" },
  in_trash: false,
  is_archived: false,
  icon: { type: "emoji", emoji: "📘" },
  parent: { type: "data_source_id", data_source_id: "ds-1" },
  properties: {
    Name: {
      id: "title",
      type: "title",
      title: [{ plain_text: "Quarterly ", annotations: { bold: true } }, { plain_text: "review" }],
    },
    Notes: {
      id: "abc",
      type: "rich_text",
      rich_text: [{ plain_text: "ship it" }],
    },
    Estimate: { id: "num", type: "number", number: 42 },
    Done: { id: "chk", type: "checkbox", checkbox: true },
    Stage: { id: "sel", type: "select", select: { name: "In review" } },
    Status: { id: "sta", type: "status", status: { name: "In progress" } },
    Tags: {
      id: "ms",
      type: "multi_select",
      multi_select: [{ name: "infra" }, { name: "urgent" }],
    },
    Due: {
      id: "dt",
      type: "date",
      date: { start: "2026-03-01", end: null, time_zone: null },
    },
    Owner: {
      id: "ppl",
      type: "people",
      people: [{ object: "user", id: "user-9", name: "Grace" }],
    },
    Blocked: {
      id: "rel",
      type: "relation",
      relation: [{ id: "page-2" }, { id: "page-3" }],
      has_more: true,
    },
    Score: { id: "fx", type: "formula", formula: { type: "number", number: 7 } },
    Count: {
      id: "rl",
      type: "rollup",
      rollup: { type: "number", number: 3, function: "count" },
    },
    Ticket: {
      id: "uid",
      type: "unique_id",
      unique_id: { number: 12, prefix: "RL" },
    },
    Spec: {
      id: "fl",
      type: "files",
      files: [{ name: "spec.pdf", type: "external", external: { url: "https://x/1" } }],
    },
    Missing: { id: "mt", type: "select", select: null },
    Invented: { id: "new", type: "brand_new_type", brand_new_type: "kept" },
  },
};

it("INV-5 INV-11: preserves the manifest, version, admission defaults and candidate credential probe", async () => {
  expect(NOTION_API_VERSION).toBe(openapi.version);
  expect(build().callAdmission?.rules[0]).toMatchObject({
    maxConcurrency: 3,
    budget: { kind: "rolling-window", maxCalls: 180, windowMs: 60_000 },
  });
  const override = { rules: [{ maxConcurrency: 1 }] };
  expect(build({ callAdmission: override }).callAdmission).toEqual(override);
  queue({ body: { object: "user", bot: { workspace_name: "Fixture workspace" } } });
  expect(await build().testCredential!("candidate-notion-token", context("stored-notion-token"))).toEqual({
    ok: true,
    message: "Authenticated as Fixture workspace.",
  });
  expect(calls).toHaveLength(1);
  expect(new Headers(calls[0]!.headers).get("authorization")).toBe("Bearer candidate-notion-token");
  expect(new Headers(calls[0]!.headers).get("notion-version")).toBe(NOTION_API_VERSION);

  const paths = manifest(NotionApi).paths;
  const actual = Object.entries(paths)
    .flatMap(([path, item]) =>
      Object.keys(item as object)
        .filter((method) => ["get", "post", "patch", "put", "delete", "head"].includes(method))
        .map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
  expect(actual).toEqual(notionIndex.ops.map((op) => `${op.method} ${op.path}`).sort());
  for (const op of notionIndex.ops) {
    const expected = [...op.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
    const operation = (paths[op.path] as Record<string, { parameters?: { name: string; in: string }[] }>)[
      op.method.toLowerCase()
    ]!;
    expect(
      (operation.parameters ?? [])
        .filter((param) => param.in === "path")
        .map((param) => param.name)
        .sort(),
    ).toEqual(expected);
  }
});

describe("notion() value safety", () => {
  it("INV-5: withholds a pre-signed file URL's signature and keeps the upload endpoint", async () => {
    const signed =
      "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/file/report.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=ASIAEXAMPLE%2F20261009%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20261009T000000Z" +
      "&X-Amz-Expires=3600&X-Amz-Security-Token=SESSION-TOKEN&X-Amz-Signature=SIGNATURE-HEX&X-Amz-SignedHeaders=host";
    queued = [
      {
        body: {
          object: "block",
          id: "b1",
          type: "file",
          file: { type: "file", file: { url: signed, expiry_time: "2026-10-09T01:00:00.000Z" }, caption: [] },
        },
      },
      { body: { object: "file_upload", id: "fu_1", upload_url: "https://api.notion.com/v1/file_uploads/fu_1/send" } },
    ];
    const block = await call(build(), "notion_api_read", { path: "/v1/blocks/b1" });
    const url = new URL(block.data.file.file.url);
    expect(url.pathname).toBe("/ws/file/report.pdf");
    for (const leaked of ["ASIAEXAMPLE", "SESSION-TOKEN", "SIGNATURE-HEX"]) expect(url.href).not.toContain(leaked);
    const upload = await call(build(), "notion_api_read", { path: "/v1/file_uploads/fu_1" });
    expect(upload.data.upload_url).toBe("https://api.notion.com/v1/file_uploads/fu_1/send");
  });

  // Synthetic, vendor-shaped payloads: each spelling a Markdown destination or
  // an HTML attribute allows for the same signed link, the reviews'
  // reproductions included.
});

describe("notion() value safety: a person's links and read-modify-write", () => {
  const HOST = "prod-files-secure.s3.us-west-2.amazonaws.com";

  // Review round 3, finding 2: a host or path that merely contains a
  // reviewed name is someone else's.
  const LOOKALIKES = [
    "https://file.notion.so.example.com/report?reportId=42",
    "https://file.notion.so;example.com/report?reportId=42",
    "https://s3.amazonaws.com/prod-files-secure;archive/a.png?v=1",
    "https://my-prod-files-secure.example.com/report?reportId=42",
    "https://example.com/prod-files-secure?reportId=42",
    // Review round 4, finding 1: a name in a path or before userinfo is not the host.
    "https://example.com/x.file.notion.so/report?reportId=42",
    "https://example.com//file.notion.so/report?reportId=42",
    "https://192.0.2.1/x.notionusercontent.com/report?reportId=42",
    "https://[2001:db8::1]/x.secure.notion-static.com/report?reportId=42",
    "https://s3.us-west-2.amazonaws.com/prod-files-secure@other/a.png?v=1",
  ];
  // In text; as a whole URL field the URL rule withholds its userinfo instead.
  const USERINFO = "https://file.notion.so@evil.com/report?reportId=42";

  it("INV-5: returns links at look-alike hosts byte for byte in Markdown and admits writes carrying them", async () => {
    const markdown = [...LOOKALIKES, USERINFO]
      .map((link, i) => `[r${i}](${link}) <file src="${link}">f</file> ${link}`)
      .join("\n");
    queue({
      body: {
        object: "page_markdown",
        id: "page-1",
        markdown,
        truncated: false,
      },
    });
    const read = await call(build(), "notion_api_read", {
      path: "/v1/pages/page-1/markdown",
    });
    expect(read.data.markdown).toBe(markdown);

    queue(
      { body: { object: "page", id: "page-1" } },
      { body: { object: "page_markdown", id: "page-1", markdown } },
      { body: { object: "page_markdown", id: "page-1", markdown } },
    );
    await call(build(), "notion_api_write", {
      method: "PATCH",
      path: "/v1/pages/page-1",
      body: { cover: { type: "external", external: { url: LOOKALIKES[0] } } },
    });
    await call(build(), "notion_api_write", {
      method: "PATCH",
      path: "/v1/pages/page-1/markdown",
      body: { type: "insert_content", insert_content: { content: markdown } },
    });
    // A placeholder in their own queries is theirs too.
    await call(build(), "notion_api_write", {
      method: "PATCH",
      path: "/v1/pages/page-1/markdown",
      body: {
        type: "insert_content",
        insert_content: { content: markdown.replaceAll("?", "?[redacted]&") },
      },
    });
    // The read, then all three writes.
    expect(calls).toHaveLength(4);
  });

  it("INV-5: refuses a write that copies a withheld file link back, before any request", async () => {
    const writes: Array<[string, Record<string, unknown>]> = [
      [
        "notion_api_write",
        {
          method: "PATCH",
          path: "/v1/pages/page-1",
          body: {
            cover: {
              type: "external",
              external: { url: `https://${HOST}/ws/c.png?[redacted]` },
            },
          },
        },
      ],
      [
        "notion_api_write",
        {
          method: "PATCH",
          path: "/v1/pages/page-1/markdown",
          body: {
            type: "replace_content",
            replace_content: {
              new_str: `<file src="https://${HOST}/ws/a.pdf?X-Amz-Signature=%5Bredacted%5D">f</file>`,
            },
          },
        },
      ],
      [
        "integration_append_blocks",
        {
          block_id: "page-1",
          children: [
            {
              object: "block",
              type: "image",
              image: {
                type: "external",
                external: {
                  url: "https://file.notion.so/f/f/a.png?[redacted]",
                },
              },
            },
          ],
        },
      ],
    ];
    for (const [tool, args] of writes) {
      const error = await refusal(call(build(), tool, args));
      expect(error.code).toBe("invalid_args");
      expect(error.message).toContain("cannot be copied into a write");
    }
    expect(calls).toHaveLength(0);

    // The placeholder alone, away from a Notion file host, is a person's text.
    queue({ body: { object: "page", id: "page-1" } });
    await call(build(), "notion_api_write", {
      method: "PATCH",
      path: "/v1/pages/page-1",
      body: {
        properties: {
          Note: {
            rich_text: [{ text: { content: "[redacted] https://example.com/a?b=1" } }],
          },
        },
      },
    });
    expect(calls).toHaveLength(1);
  });

  // Review round 3, finding 3: the placeholder itself, however encoded, and
  // never the word inside another value.
  const insert = (content: string) => ({
    method: "PATCH",
    path: "/v1/pages/page-1/markdown",
    body: { type: "insert_content", insert_content: { content } },
  });

  const PROXIES = [
    "https://example.com/image?url=https://file.notion.so/f/f/a.png?table=block&id=42&width=400",
    "https://example.com/image?url=//file.notion.so/f/f/a.png?id=42",
    "https://example.com/proxy/https://file.notion.so/f/f/a.png?id=42",
    "/proxy/https://file.notion.so/f/f/a.png?id=42",
    "https://example.com/image?url=https%3A%2F%2Ffile.notion.so%2Fa.png%3Fid%3D42",
    `https://example.com/image?url=https://${HOST}/a.png?id=42`,
    "https://example.com/image?url=https://s3.amazonaws.com/prod-files-secure/a.png?id=42",
  ];

  it.each([PROXIES[0]!, PROXIES[3]!, PROXIES[4]!])(
    "INV-5: preserves a proxy URL through fields, select, named tools, Markdown, and writes: %s",
    async (link) => {
      const page = {
        object: "page",
        id: "page-1",
        cover: { type: "external", external: { url: link } },
        properties: { Report: { id: "r", type: "url", url: link } },
      };
      queue({ body: page }, { body: page }, { body: page });
      const read = await call(build(), "notion_api_read", { path: "/v1/pages/page-1" });
      expect(read.data).toEqual(page);
      const selected = await call(build(), "notion_api_read", {
        path: "/v1/pages/page-1",
        select: ["cover.external.url", "properties.Report.url"],
      });
      expect(selected.data).toEqual({ cover: { external: { url: link } }, properties: { Report: { url: link } } });
      const named = await call(build(), "integration_get_page", { page_id: "page-1", properties: ["Report"] });
      expect(named.properties.Report).toBe(link);
      const markdown = `[r](${link}) ![i]( \t${link}) <file src="${link}">f</file>`;
      const body = { object: "page_markdown", id: "page-1", markdown };
      queue({ body }, { body });
      expect((await call(build(), "notion_api_read", { path: "/v1/pages/page-1/markdown" })).data.markdown).toBe(
        markdown,
      );
      expect(
        (await call(build(), "notion_api_read", { path: "/v1/pages/page-1/markdown", select: ["markdown"] })).data
          .markdown,
      ).toBe(markdown);
      for (const value of [link, link.replace("42", "%5Bredacted%5D")]) {
        queue({ body: page }, { body: { ...body, markdown: value } });
        await call(build(), "notion_api_write", {
          method: "PATCH",
          path: "/v1/pages/page-1",
          body: { cover: { type: "external", external: { url: value } }, properties: { Report: { url: value } } },
        });
        expect(calls.at(-1)!.body.cover.external.url).toBe(value);
        const content = `[r](${value})`;
        await call(build(), "notion_api_write", insert(content));
        expect(calls.at(-1)!.body.insert_content.content).toBe(content);
      }
      expect(calls).toHaveLength(9);
    },
  );
});

describe("notion() generic REST tools", () => {
  it("INV-10: admits exactly the reviewed read-only POST queries on the read tool", async () => {
    const connector = build();
    for (const path of [
      "/v1/search",
      "/v1/data_sources/ds-1/query",
      "/v1/blocks/meeting_notes/query",
      "/v1/agents/query",
      "/v1/sessions/query",
      "/v1/sessions/s-1/events/query",
    ]) {
      queue({ body: { object: "list", results: [], has_more: false, next_cursor: null } });
      await call(connector, "notion_api_read", { method: "POST", path, body: {} });
    }
    expect(calls.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["POST", "/v1/search"],
      ["POST", "/v1/data_sources/ds-1/query"],
      ["POST", "/v1/blocks/meeting_notes/query"],
      ["POST", "/v1/agents/query"],
      ["POST", "/v1/sessions/query"],
      ["POST", "/v1/sessions/s-1/events/query"],
    ]);
    configureGuardedTransport({ send: (url, init) => globalThis.fetch(url, init) });
    calls.length = 0;
    // A view query is stored until deleted, and a page create is a create:
    // neither may ride the read path.
    for (const path of ["/v1/views/v-1/queries", "/v1/pages"]) {
      const refused = await refusal(call(connector, "notion_api_read", { method: "POST", path, body: {} }));
      expect(refused.message).toContain("call it with notion_api_write");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("notion() lean projections", () => {
  it("stops the nested walk at its request ceiling and says so", async () => {
    const children = Array.from({ length: 25 }, (_unused, index) => ({
      id: `top-${index}`,
      type: "toggle",
      has_children: true,
      toggle: { rich_text: [{ plain_text: `toggle ${index}` }] },
    }));
    queue({ body: { results: children, has_more: false, next_cursor: null } });
    for (let index = 0; index < 25; index += 1) {
      queue({
        body: {
          results: [
            {
              id: `child-${index}`,
              type: "paragraph",
              has_children: false,
              paragraph: { rich_text: [{ plain_text: `nested ${index}` }] },
            },
          ],
          has_more: false,
        },
      });
    }

    const walked: any = await call(build(), "integration_get_page_content", { block_id: "page-1", depth: 1 });
    // One request for the top level plus nineteen children: twenty in total.
    expect(calls).toHaveLength(20);
    expect(walked.truncated).toBe(true);
    expect(walked.results.filter((block: any) => block.depth === 0)).toHaveLength(25);
    expect(walked.results.filter((block: any) => block.depth === 1)).toHaveLength(19);
  });

  it("names native and custom icons, and reads an uncomputable value as null", async () => {
    const page = (icon: unknown) => ({
      ...PAGE_FIXTURE,
      icon,
      properties: {
        Name: PAGE_FIXTURE.properties.Name,
        Score: {
          id: "fx",
          type: "formula",
          formula: { type: "unsupported", unsupported: {} },
        },
        Count: {
          id: "rl",
          type: "rollup",
          rollup: {
            type: "unsupported",
            unsupported: {},
            function: "show_original",
          },
        },
      },
    });
    queue(
      { body: page({ type: "icon", icon: { name: "pizza", color: "blue" } }) },
      {
        body: page({
          type: "custom_emoji",
          custom_emoji: { id: "e1", name: "shipit", url: "https://x/e.png" },
        }),
      },
    );
    const native: any = await call(build(), "integration_get_page", {
      page_id: "page-1",
    });
    expect(native.icon).toBe("pizza");
    expect(native.properties).toEqual({
      Name: "Quarterly review",
      Score: null,
      Count: null,
    });
    const custom: any = await call(build(), "integration_get_page", {
      page_id: "page-1",
    });
    expect(custom.icon).toBe(":shipit:");
  });
});

describe("notion() named-tool pagination", () => {
  it("reports a query Notion stopped at its result cap as incomplete, not finished", async () => {
    const capped = {
      object: "list",
      results: [PAGE_FIXTURE],
      has_more: false,
      next_cursor: null,
      request_status: {
        type: "incomplete",
        incomplete_reason: "query_result_limit_reached",
      },
    };
    queue({ body: capped }, { body: capped }, { body: { ...capped, request_status: { type: "complete" } } });
    const rows: any = await call(build(), "integration_query_data_source", {
      data_source_id: "ds-1",
    });
    expect(rows).toMatchObject({
      has_more: false,
      next_cursor: null,
      incomplete: true,
    });

    const generic = await call(build(), "notion_api_read", {
      method: "POST",
      path: "/v1/data_sources/ds-1/query",
      body: {},
      select: ["results.id"],
    });
    // A cut-off with no cursor, like a meeting-note query past its limit.
    expect(generic.page).toEqual({ hasMore: true });

    const finished: any = await call(build(), "integration_query_data_source", {
      data_source_id: "ds-1",
    });
    expect(finished.incomplete).toBeUndefined();
  });
});

describe("notion() error mapping", () => {
  const cases: Array<[string, () => Promise<void>]> = [];
  const caseOf = (name: string, run: () => Promise<void>) => {
    cases.push([name, run]);
  };

  async function failWith(status: number, body: unknown, headers: Record<string, string> = {}): Promise<any> {
    queue({ status, body, headers });
    return call(build(), "integration_get_page", { page_id: "page-1" }).catch((thrown) => thrown);
  }

  caseOf("reads Notion's body retry_after when a proxy drops the header", async () => {
    const error = await failWith(429, {
      code: "rate_limited",
      message: "slow",
      additional_data: {
        rate_limit_reason: "public_api_space_request_rate_limit",
        retry_after: "90",
      },
    });
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterMs).toBe(90_000);
    expect(error.message).toContain("shared budget across all its connections");
  });

  caseOf("does not offer a retry when Notion has blocked the integration's API access", async () => {
    const error = await failWith(
      429,
      {
        code: "rate_limited",
        message: "Blocked.",
        additional_data: { rate_limit_reason: "public_api_request_blocked" },
      },
      { "Retry-After": "5" },
    );
    expect(error.code).toBe("connector_call_failed");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("contact Notion support");
  });

  caseOf("INV-9: names what a failed write committed, so the caller reads it instead of repeating", async () => {
    queue({
      status: 503,
      body: {
        code: "service_unavailable",
        message: "Timed out.",
        // POST /v1/pages withholds Notion's error text; an id-shaped commit still shows.
        additional_data: {
          committed_resource_id: "5c6a2821-6bb1-4a7e-b6e1-c50111515c3d",
        },
      },
    });
    const created = await call(build(), "integration_create_page", {
      parent_page_id: "p",
      title: "x",
    }).catch((thrown: any) => thrown);
    expect(created).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
    expect(created.message).toContain("5c6a2821-6bb1-4a7e-b6e1-c50111515c3d");
    expect(created.message).toContain("instead of repeating the write");

    queue({
      status: 503,
      body: {
        code: "service_unavailable",
        message: "Timed out.",
        additional_data: {
          committed_resource_id: "1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6",
          committed_child_ids: ["0b6f0c8e-1d1e-4c55-9a0e-6f1b2a3c4d01", "0b6f0c8e-1d1e-4c55-9a0e-6f1b2a3c4d02"],
        },
      },
    });
    const appended = await call(build(), "integration_append_blocks", {
      block_id: "page-1",
      text: ["a", "b"],
    }).catch((thrown: any) => thrown);
    expect(appended).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
    expect(appended.message).toContain("0b6f0c8e-1d1e-4c55-9a0e-6f1b2a3c4d01, 0b6f0c8e-1d1e-4c55-9a0e-6f1b2a3c4d02");
    expect(calls).toHaveLength(2);
  });

  caseOf("INV-5: withholds retry guidance and committed ids for an operation whose errors are withheld", async () => {
    const signed = "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/a.png?X-Amz-Signature=FAKE_SIGNATURE";
    queue({
      status: 503,
      body: {
        code: "service_unavailable",
        message: `See ${signed}`,
        additional_data: { retry_guidance: `Fetch ${signed}` },
      },
    });
    const read = await call(build(), "notion_api_read", {
      path: "/v1/users/me",
    }).catch((thrown: any) => thrown);
    expect(read).toBeInstanceOf(ConnectorCallError);
    expect(read.message).toContain("withheld because this operation handles credentials");
    expect(read.message).not.toContain("FAKE_SIGNATURE");
    expect(read.message).not.toContain("Fetch");

    queue({
      status: 503,
      body: {
        code: "service_unavailable",
        message: "Timed out.",
        additional_data: {
          committed_resource_id: "SECRET-ECHO",
          retry_guidance: "SECRET-GUIDANCE",
        },
      },
    });
    const created = await call(build(), "notion_api_write", {
      method: "POST",
      path: "/v1/file_uploads",
      body: {
        mode: "external_url",
        external_url: "https://example.com/a.png",
        filename: "a.png",
      },
    }).catch((thrown: any) => thrown);
    expect(created).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
    expect(created.message).toContain("committed the write");
    expect(created.message).not.toContain("SECRET-");
    expect(calls).toHaveLength(2);
  });

  caseOf("INV-5: withholds signed file links that Notion's error text echoes", async () => {
    const signed = "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/a.png?X-Amz-Signature=FAKE_SIGNATURE";
    queue({
      status: 400,
      body: {
        code: "validation_error",
        message: `old_str not found near ![a](${signed})`,
      },
    });
    const error = await call(build(), "notion_api_write", {
      method: "PATCH",
      path: "/v1/pages/page-1/markdown",
      body: {
        type: "update_content",
        update_content: { content_updates: [{ old_str: "x", new_str: "y" }] },
      },
    }).catch((thrown: any) => thrown);
    expect(error.code).toBe("invalid_args");
    expect(error.message).toContain("prod-files-secure.s3.us-west-2.amazonaws.com/ws/a.png?[redacted])");
    expect(error.message).not.toContain("FAKE_SIGNATURE");

    queue({
      status: 503,
      body: {
        code: "service_unavailable",
        message: "Saved.",
        additional_data: { retry_guidance: [`Read ${signed} again.`] },
      },
    });
    const updated = await call(build(), "notion_api_write", {
      method: "PATCH",
      path: "/v1/pages/page-1",
      body: { properties: { Done: { checkbox: true } } },
    }).catch((thrown: any) => thrown);
    expect(updated).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
    expect(updated.message).toContain("Notion's guidance: Read");
    expect(updated.message).not.toContain("FAKE_SIGNATURE");
  });

  caseOf("INV-5: token-only rate-limit metadata cannot leak vendor prose on a withheld operation", async () => {
    queue({
      status: 429,
      body: {
        code: "rate_limited",
        message: "PRIVATE ERROR",
        additional_data: { rate_limit_reason: "PRIVATE VENDOR PROSE" },
      },
    });
    const error = await refusal(call(build(), "integration_create_page", { parent_page_id: "p", title: "x" }));
    expect(error.code).toBe("rate_limited");
    expect(error.message).not.toContain("PRIVATE");
    expect(error.message).toContain("withheld because this operation handles credentials");
  });

  it("INV-5 INV-9: preserves structured retry, commitment and withheld-error diagnostics", async () => {
    for (const [, run] of cases) {
      calls.length = 0;
      queued = [];
      await run();
    }
  });
});

describe("notion() authoring helpers", () => {
  it("splits text past Notion's 2,000-character run limit, and refuses what no request could carry", async () => {
    queue({ body: PAGE_FIXTURE }, { body: { results: [] } });
    // An astral character straddles the cut: it must not be split in half.
    const title = `${"t".repeat(1_999)}😀${"u".repeat(2_500)}`;
    await call(build(), "integration_create_page", {
      parent_page_id: "p",
      title,
    });
    const runs = calls[0]?.body.properties.title.title.map((run: any) => run.text.content);
    expect(runs.map((run: string) => run.length)).toEqual([1_999, 2_000, 502]);
    expect(runs.join("")).toBe(title);
    expect(runs[1].startsWith("😀")).toBe(true);

    await call(build(), "integration_append_blocks", {
      block_id: "page-1",
      checklist: ["x".repeat(4_001)],
    });
    expect(calls[1]?.body.children[0].to_do.rich_text).toHaveLength(3);

    configureGuardedTransport({ send: (url, init) => globalThis.fetch(url, init) });
    calls.length = 0;
    const tooLong = await refusal(
      call(build(), "integration_append_blocks", {
        block_id: "page-1",
        text: ["ok", "y".repeat(200_001)],
      }),
    );
    expect(tooLong.code).toBe("invalid_args");
    expect(tooLong.message).toContain("text[1]");
    expect(calls).toHaveLength(0);
  });
});
