import { afterEach, beforeEach, describe, expect, it, it as test, vi } from "vitest";
import { ConnectorCallError } from "../../errors.js";
import type { ToolDef } from "../../types.js";
import { guideOf, itClassifiesLikeARelease, mockRemoteMcp } from "../../../test/fixtures/hosted-provider.js";

const mcpMocks = vi.hoisted(() => ({
  listTools: vi.fn<() => Promise<ToolDef[]>>(),
  remoteMcp: vi.fn(),
}));

vi.mock("../../connectors/remote-mcp.js", async (importOriginal) => ({
  // Only the hosted constructor is stubbed; the REST connector never touches it.
  ...(await importOriginal<typeof import("../../connectors/remote-mcp.js")>()),
  remoteMcp: mcpMocks.remoteMcp,
}));

import {
  NOTION_API_BASE_URL,
  NOTION_API_VERSION,
  NOTION_MCP_ENDPOINT,
  NOTION_MCP_VETTED_CATALOG,
  notion,
} from "./index.js";
import { openapi } from "./openapi.generated.js";
import { CatalogService } from "../../catalog-service.js";
import { InvocationService } from "../../invocation.js";
import { runEdge } from "../../runtime/run.js";
import { writeStateOf } from "../../program-writes.js";
import { classifyTool } from "../../tool-safety.js";
import { connectorGuideSummary } from "../../skills.js";
import { makeRegistry, silentLogger } from "../../../test/helpers.js";
import type { Connector, ConnectorContext } from "../../types.js";

const isRead = (tool: ToolDef) => classifyTool(tool) === "read";

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
  calls.length = 0;
  queued = [];
  mockRemoteMcp(mcpMocks);
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

const NAMED = [
  "integration_search",
  "integration_get_page",
  "integration_get_page_content",
  "integration_get_data_source_schema",
  "integration_query_data_source",
  "integration_create_page",
  "integration_append_blocks",
];

describe("notion() auth selects the implementation", () => {
  it("INV-11: requires auth and names the valid types, with no silent default", () => {
    expect(() => notion("wiki", { purpose: "Docs" } as never)).toThrow(
      'notion("wiki") requires auth.type is required: one of "oauth", "token".',
    );
    for (const type of ["headers", "credential", "apiKey"]) {
      expect(() => notion("wiki", { purpose: "Docs", auth: { type } } as never)).toThrow(
        'notion("wiki") requires auth.type to be one of "oauth", "token".',
      );
    }
    expect(() => notion("wiki", { purpose: "Docs", auth: { type: "token" }, surface: "api" } as never)).toThrow(
      'Unknown option: notion("wiki").surface.',
    );
    expect(mcpMocks.remoteMcp).not.toHaveBeenCalled();
  });

  it("INV-11: refuses token-only options under OAuth by name, and OAuth-only options under a token", () => {
    expect(() =>
      // @ts-expect-error The hosted server holds no operator credential.
      notion("wiki", { purpose: "Docs", auth: { type: "oauth" }, credentialLabel: "Docs token" }),
    ).toThrow('Unknown option: notion("wiki").credentialLabel.');
    expect(() =>
      // @ts-expect-error Hosted tools own their own paging.
      notion("wiki", { purpose: "Docs", auth: { type: "oauth" }, defaultPageSize: 10 }),
    ).toThrow('Unknown option: notion("wiki").defaultPageSize.');
    expect(() => build({ callAdmission: { rules: [{ maxConcurrency: 1 }] } })).toThrow(
      'Unknown option: notion("workspace").callAdmission.',
    );
    expect(() => build({ auth: { type: "token", token: "secret_x" } })).toThrow(
      'Unknown option: notion("workspace").auth.token.',
    );
    expect(mcpMocks.remoteMcp).not.toHaveBeenCalled();
  });
});

describe("notion() over OAuth", () => {
  function mcp(): Connector {
    return notion("workspace_mcp", { auth: { type: "oauth" }, purpose: "Team knowledge base" });
  }

  it("binds Notion's hosted endpoint over OAuth only, with no network access at construction", () => {
    const callAdmission = { rules: [{ maxConcurrency: 2 }] };
    const connector = notion("workspace_mcp", {
      auth: { type: "oauth" },
      purpose: "Team knowledge base",
      callAdmission,
      instructions: "Prefer the Engineering teamspace.",
    });
    expect(mcpMocks.remoteMcp).toHaveBeenCalledWith(
      "workspace_mcp",
      expect.objectContaining({
        url: NOTION_MCP_ENDPOINT,
        title: "Notion (MCP)",
        description: "Notion's official hosted MCP interface: Team knowledge base",
        auth: { type: "oauth" },
        callAdmission,
        requireHttps: true,
      }),
    );
    expect(connector.kind).toBe("mcp");
    expect(connector.credential).toBeUndefined();
    const guide = guideOf(connector);
    expect(guide).toContain("live server");
    expect(guide).toContain("Workspace purpose: Team knowledge base");
    expect(guide).toContain("acts as its OAuth-authorized user");
    expect(guide).toContain("## Notion's data model");
    expect(guide).toContain("no idempotency key");
    expect(guide).toContain("## Workspace instructions\n\nPrefer the Engineering teamspace.");
    // The token guide's REST mechanics never leak into the OAuth guide.
    expect(guide).not.toContain("page.param");
    expect(guide).not.toContain("surface");
    expect((connector.usageGuide as { required?: boolean }).required).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("classifies every tool in Notion's published MCP reference", () => {
    const counts = { "read-only": 0, additive: 0, destructive: 0 };
    for (const { verdict } of NOTION_MCP_VETTED_CATALOG.tools.values()) {
      counts[verdict] += 1;
    }
    expect(NOTION_MCP_VETTED_CATALOG.tools.size).toBe(38);
    expect(counts).toEqual({ "read-only": 22, additive: 10, destructive: 6 });
    // Documented since the release review, and reads by Notion's own description.
    for (const name of ["notion-ai-search", "notion-get-self", "notion-get-tool-access", "notion-download-skill"]) {
      expect(NOTION_MCP_VETTED_CATALOG.tools.get(name)?.verdict).toBe("read-only");
    }
  });

  itClassifiesLikeARelease(mcp, mcpMocks, {
    read: ["notion-search", "notion-fetch", "notion-get-users"],
    write: "notion-create-comment",
    destructive: "notion-update-page",
    unknown: ["notion-new-tool", "notion-new-read", "notion-new-write"],
  });
});

describe("notion() over an integration token", () => {
  it("publishes the generic REST set and the named tools that earn their place", () => {
    const connector = build();
    expect(mcpMocks.remoteMcp).not.toHaveBeenCalled();
    expect(connector.staticTools?.map((tool) => tool.name)).toEqual([
      "notion_api_search",
      "notion_api_details",
      "notion_api_read",
      "notion_api_write",
      ...NAMED,
    ]);
    expect(connector.describe?.()).toMatchObject({
      source: { kind: "api", provider: "notion" },
      auth: { mode: "credential" },
    });
  });

  it("INV-1: annotates its own tools with the exact read/write partition", () => {
    const tools = build().staticTools ?? [];
    expect(tools.filter(isRead).map((tool) => tool.name)).toEqual([
      "notion_api_search",
      "notion_api_details",
      "notion_api_read",
      "integration_search",
      "integration_get_page",
      "integration_get_page_content",
      "integration_get_data_source_schema",
      "integration_query_data_source",
    ]);
    expect(tools.filter((tool) => !isRead(tool)).map((tool) => tool.name)).toEqual([
      "notion_api_write",
      "integration_create_page",
      "integration_append_blocks",
    ]);
    // Only the generic write carries the whole write API's blast radius; the
    // named writes only add content.
    expect(tools.filter((tool) => tool.annotations?.destructiveHint === true).map((tool) => tool.name)).toEqual([
      "notion_api_write",
    ]);
    expect(build().classification).toBeUndefined();
  });

  it("declares a rate budget and a concurrency cap together", () => {
    expect(build().callAdmission).toEqual({
      rules: [
        {
          maxConcurrency: 3,
          budget: { kind: "rolling-window", maxCalls: 180, windowMs: 60_000 },
          maxQueueSize: 32,
          queueTimeoutMs: 5_000,
          retryAfterMs: 1_000,
        },
      ],
    });
  });

  it("carries a required guide covering what schemas cannot", () => {
    const connector = build({ instructions: "Use the Engineering wiki unless the request names another." });
    const guide = connector.usageGuide as { content: string; summary: string; required: boolean };
    expect(guide.required).toBe(true);
    expect(new TextEncoder().encode(connectorGuideSummary(connector) ?? "").length).toBeLessThanOrEqual(120);
    for (const text of [
      "Workspace purpose: Team knowledge base",
      "Databases contain data sources",
      "data_source_id",
      "raw: true",
      "no idempotency key",
      "not shared with this integration",
      "notion_api_search",
      "`page.in` is `body`",
      "GET /v1/pages/{page_id}/properties/{property_id}",
      "GET /v1/pages/{page_id}/markdown",
      "PATCH /v1/pages/{page_id}/markdown",
      '"type":"insert_content"',
      "/v1/oauth/*",
      "Those need an OAuth connector.",
      "## Workspace instructions",
      "Use the Engineering wiki unless the request names another.",
    ]) {
      expect(guide.content, text).toContain(text);
    }
    expect(guide.content).not.toContain("+## Workspace instructions");
    expect(guide.content).not.toContain("no guarded raw-REST tool");
    expect(guide.content).not.toContain("surface");
  });

  it("INV-11: rejects a missing purpose or an out-of-range page size", () => {
    expect(() => notion("workspace", { ...TOKEN, purpose: "  " })).toThrow("a non-empty purpose");
    expect(() => notion("workspace", { ...TOKEN, defaultPageSize: 500 })).toThrow(
      "defaultPageSize to be a whole number between 1 and 100",
    );
  });

  it("describes the integration token as an operator credential", () => {
    expect(build().credential?.label).toBe("Notion integration token");
    expect(build({ credentialLabel: "Docs token" }).credential?.label).toBe("Docs token");
    expect(build().credential?.description).toContain("shared with that integration");
  });

  it("INV-5: tests a pasted token with the cheapest identifying read, and never echoes it", async () => {
    queue({ body: { object: "user", id: "bot-1", type: "bot", name: "Docs bot", bot: { workspace_name: "Acme" } } });
    const ok = await build().testCredential!("secret_pasted", context(null));
    expect(ok).toEqual({ ok: true, message: "Authenticated as Acme." });
    expect(calls[0]?.url).toBe(`${NOTION_API_BASE_URL}/v1/users/me`);
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer secret_pasted");

    queue({ status: 401, body: { object: "error", code: "unauthorized", message: "API token is invalid." } });
    const bad = await build().testCredential!("secret_wrong", context(null));
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("unauthorized");
    expect(bad.message).not.toContain("secret_wrong");
  });
});

describe("notion() request construction", () => {
  it("sends the pinned API version and the operator's bearer token", async () => {
    queue({ body: PAGE_FIXTURE });
    await call(build(), "integration_get_page", { page_id: "page-1" });

    expect(calls[0]?.url).toBe(`${NOTION_API_BASE_URL}/v1/pages/page-1`);
    expect(calls[0]?.headers["Notion-Version"]).toBe(NOTION_API_VERSION);
    expect(NOTION_API_VERSION).toBe("2026-03-11");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer secret_token");
  });

  it("keeps the sent Notion-Version equal to the pinned index's version", () => {
    // The index describes one version's contract. Regenerating it against a
    // newer Notion-Version must move the sent header with it, deliberately.
    expect(openapi.version).toBe(NOTION_API_VERSION);
    expect(openapi.servers).toEqual([NOTION_API_BASE_URL]);
  });

  it("fails with auth_required before touching the network", async () => {
    const error = await call(build(), "notion_api_read", { path: "/v1/users/me" }, context(null)).catch(
      (thrown) => thrown,
    );
    expect(error).toBeInstanceOf(ConnectorCallError);
    expect(error.code).toBe("auth_required");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("this connection in the operator UI");
    expect(error.message).toContain("authorize_connector");
    expect(calls).toHaveLength(0);
  });

  it("refuses an id that would escape its path segment, before any request", async () => {
    const error = await refusal(call(build(), "integration_get_page", { page_id: "../users" }));
    expect(error.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });
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

  it("INV-5: withholds the signature of every pre-signed link a page's Markdown embeds", async () => {
    const signed = (name: string) =>
      `https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/${name}?X-Amz-Algorithm=AWS4-HMAC-SHA256` +
      "&X-Amz-Credential=ASIAEXAMPLE%2F20261009&X-Amz-Security-Token=SESSION-TOKEN&X-Amz-Signature=SIGNATURE-HEX";
    const markdown = [
      "# Report",
      `![Chart](${signed("chart.png")})`,
      `<file src="${signed("report.pdf").replaceAll("&", "&amp;")}">Report</file>`,
      "See [the docs](https://developers.notion.com/reference?topic=markdown) for more.",
    ].join("\n");
    queue({ body: { object: "page_markdown", id: "page-1", markdown, truncated: false, unknown_block_ids: [] } });
    const read = await call(build(), "notion_api_read", { path: "/v1/pages/page-1/markdown" });
    const text: string = read.data.markdown;
    for (const leaked of ["ASIAEXAMPLE", "SESSION-TOKEN", "SIGNATURE-HEX"]) expect(text).not.toContain(leaked);
    // The links still name their files, and the attribute keeps its escaping.
    expect(text).toContain("![Chart](https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/chart.png?[redacted])");
    expect(text).toContain(
      '<file src="https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/report.pdf?[redacted]">Report</file>',
    );
    // An ordinary link and the surrounding Markdown come back byte for byte.
    expect(text).toContain("# Report\n");
    expect(text).toContain("See [the docs](https://developers.notion.com/reference?topic=markdown) for more.");
  });

  // Synthetic, vendor-shaped payloads: each spelling a Markdown destination or
  // an HTML attribute allows for the same signed link, the reviews'
  // reproductions included.
  const HOST = "prod-files-secure.s3.us-west-2.amazonaws.com";
  const S3 = `https://${HOST}/ws`;
  const WRAPPED = [
    `![a](${S3}/file(1).png?X-Amz-Signature=FAKE_SIGNATURE)`,
    `<file src="${S3}/file(1).pdf?X-Amz-Signature=FAKE_SIGNATURE">f</file>`,
    `![a](${S3}/file\\(1\\).png?X-Amz-Signature=FAKE_SIGNATURE)`,
    `<file src="https://cdn.example/a.pdf?a=1&#38;X-Amz-Signature=FAKE_SIGNATURE"></file>`,
    `<file src="https://cdn.example/a.pdf?a=1&#x26;X-Amz-Signature=FAKE_SIGNATURE"></file>`,
    `<file src="${S3}/file).pdf?X-Amz-Signature=FAKE_SIGNATURE">f</file>`,
    `<file src="${S3}/file.pdf?name=a)b&X-Amz-Signature=FAKE_SIGNATURE">f</file>`,
    `<${S3}/file).pdf?X-Amz-Signature=FAKE_SIGNATURE>`,
    `<file src="${S3}/a]b.pdf?X-Amz-Signature=FAKE_SIGNATURE">f</file>`,
    `<file src="https:&#47;&#47;${HOST}/ws/file.png?X-Amz-Signature=FAKE_SIGNATURE">f</file>`,
    `[a](https:\\/\\/${HOST}/ws/file.png?X-Amz-Signature=FAKE_SIGNATURE)`,
    `<file src="${S3}/a.png?table=block&amp;id=ASIAEXAMPLE">f</file>`,
  ].join("\n");
  const PAGE_MARKDOWN = { object: "page_markdown", id: "page-1", markdown: WRAPPED, truncated: false };

  it("INV-5: withholds signed links behind parentheses and character references on a Markdown read", async () => {
    queue({ body: PAGE_MARKDOWN });
    const read = await call(build(), "notion_api_read", { path: "/v1/pages/page-1/markdown" });
    expect(read.data.markdown).not.toContain("FAKE_SIGNATURE");
    expect(read.data.markdown).not.toContain("ASIAEXAMPLE");
    expect(read.data.markdown).toContain(`![a](${S3}/file(1).png?[redacted])`);
    expect(read.data.markdown).toContain(`<file src="${S3}/file.pdf?[redacted]">f</file>`);
    expect(read.data.markdown).toContain(`[a](https:\\/\\/${HOST}/ws/file.png?[redacted])`);

    queue({ body: PAGE_MARKDOWN });
    const selected = await call(build(), "notion_api_read", {
      path: "/v1/pages/page-1/markdown",
      select: ["markdown"],
    });
    expect(JSON.stringify(selected)).not.toContain("FAKE_SIGNATURE");
    expect(JSON.stringify(selected)).not.toContain("ASIAEXAMPLE");
  });

  it("INV-5: withholds signed links in the Markdown a page update answers with", async () => {
    for (const select of [undefined, ["markdown"]]) {
      queue({ body: PAGE_MARKDOWN });
      const written = await call(build(), "notion_api_write", {
        method: "PATCH",
        path: "/v1/pages/page-1/markdown",
        body: { type: "insert_content", insert_content: { content: "More" } },
        ...(select ? { select } : {}),
      });
      expect(JSON.stringify(written)).not.toContain("FAKE_SIGNATURE");
      expect(JSON.stringify(written)).not.toContain("ASIAEXAMPLE");
      expect(written.data.markdown).toContain(`<file src="${S3}/file(1).pdf?[redacted]">f</file>`);
      expect(written.data.markdown).toContain(`<file src="https:&#47;&#47;${HOST}/ws/file.png?[redacted]">f</file>`);
    }
  });

  it("INV-5: withholds signed links in an async Markdown update's polled result", async () => {
    const task = {
      object: "async_task",
      id: "task-1",
      status: "completed",
      status_url: "https://api.notion.com/v1/async_tasks/task-1",
      created_time: "2026-10-09T00:00:00.000Z",
      operation: { surface: "rest", name: "update_page_markdown" },
      result: PAGE_MARKDOWN,
    };
    queue({ body: task });
    const polled = await call(build(), "notion_api_read", { path: "/v1/async_tasks/task-1" });
    expect(JSON.stringify(polled)).not.toContain("FAKE_SIGNATURE");
    expect(polled.data.result.markdown).toContain(`![a](${S3}/file(1).png?[redacted])`);
    expect(polled.data.status_url).toBe("https://api.notion.com/v1/async_tasks/task-1");

    queue({ body: task });
    const selected = await call(build(), "notion_api_read", {
      path: "/v1/async_tasks/task-1",
      select: ["result.markdown"],
    });
    expect(JSON.stringify(selected)).not.toContain("FAKE_SIGNATURE");
  });
});

describe("notion() value safety: a person's links and read-modify-write", () => {
  const HOST = "prod-files-secure.s3.us-west-2.amazonaws.com";
  const AWS_LINK = "https://api-id.execute-api.us-east-1.amazonaws.com/prod/report?reportId=42";

  // Review round 3, finding 2: a host or path that merely contains a
  // reviewed name is someone else's.
  const LOOKALIKES = [
    "https://file.notion.so.example.com/report?reportId=42",
    "https://my-prod-files-secure.example.com/report?reportId=42",
    "https://example.com/prod-files-secure?reportId=42",
  ];

  it.each([AWS_LINK, ...LOOKALIKES])(
    "INV-5: returns a person's link %s unchanged in a URL property and an external cover",
    async (link) => {
      const page = {
        object: "page",
        id: "page-1",
        cover: { type: "external", external: { url: link } },
        properties: { Report: { id: "r", type: "url", url: link } },
      };
      queue({ body: page }, { body: page });
      const read = await call(build(), "notion_api_read", { path: "/v1/pages/page-1" });
      expect(read.data.cover.external.url).toBe(link);
      expect(read.data.properties.Report.url).toBe(link);
      const projected = await call(build(), "integration_get_page", { page_id: "page-1" });
      expect(projected.properties.Report).toBe(link);
    },
  );

  it("INV-5: returns links at look-alike hosts byte for byte in Markdown and admits writes carrying them", async () => {
    const markdown = LOOKALIKES.map((link, i) => `[r${i}](${link}) <file src="${link}">f</file> ${link}`).join("\n");
    queue({ body: { object: "page_markdown", id: "page-1", markdown, truncated: false } });
    const read = await call(build(), "notion_api_read", { path: "/v1/pages/page-1/markdown" });
    expect(read.data.markdown).toBe(markdown);

    queue({ body: { object: "page", id: "page-1" } }, { body: { object: "page_markdown", id: "page-1", markdown } });
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
    // The read, then both writes.
    expect(calls).toHaveLength(3);
  });

  it("INV-5: returns a person's links in page Markdown and rich text byte for byte", async () => {
    const markdown = [
      `[report](${AWS_LINK}) and [login](https://app.example/cb?code=abc&name=x).`,
      "![chart](https://cdn.example/chart(1).png?width=200)",
    ].join("\n");
    queue({ body: { object: "page_markdown", id: "page-1", markdown, truncated: false } });
    const read = await call(build(), "notion_api_read", { path: "/v1/pages/page-1/markdown" });
    expect(read.data.markdown).toBe(markdown);

    const run = {
      type: "text",
      text: { content: "login", link: { url: "https://app.example/cb?state=s" } },
      plain_text: "login",
      href: "https://app.example/cb?state=s",
    };
    queue({ body: { object: "block", id: "b1", type: "paragraph", paragraph: { rich_text: [run] } } });
    const block = await call(build(), "notion_api_read", { path: "/v1/blocks/b1" });
    expect(block.data.paragraph.rich_text[0]).toEqual(run);
  });

  it("INV-5: refuses a write that copies a withheld file link back, before any request", async () => {
    const writes: Array<[string, Record<string, unknown>]> = [
      [
        "notion_api_write",
        {
          method: "PATCH",
          path: "/v1/pages/page-1",
          body: { cover: { type: "external", external: { url: `https://${HOST}/ws/c.png?[redacted]` } } },
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
              image: { type: "external", external: { url: "https://file.notion.so/f/f/a.png?[redacted]" } },
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
      body: { properties: { Note: { rich_text: [{ text: { content: "[redacted] https://example.com/a?b=1" } }] } } },
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

  it.each([
    ["percent-encoded", "![a](https://file.notion.so/f/f/a.png?%5B%72%65%64%61%63%74%65%64%5D)"],
    ["entity-encoded", '<file src="https://file.notion.so/f/f/a.pdf?&#91;redac&#116;ed&#93;">f</file>'],
    ["double percent-encoded", `![a](https://${HOST}/ws/a.png?X-Amz-Signature=%255Bredacted%255D)`],
  ])("INV-5: refuses a write carrying the placeholder %s on a Notion file link", async (_, content) => {
    const error = await refusal(call(build(), "notion_api_write", insert(content)));
    expect(error.code).toBe("invalid_args");
    expect(error.message).toContain("cannot be copied into a write");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a value containing the word", "[a](https://file.notion.so/f/f/a.png?label=unredacted)"],
    ["a filename containing the word", "![a](https://file.notion.so/f/f/redacted-report.png?table=block)"],
    ["a query value starting with the word", "![a](https://file.notion.so/f/f/a.png?name=redacted-report)"],
    ["the placeholder as text beside a file link", "[redacted] ![a](https://file.notion.so/f/f/a.png)"],
  ])("INV-5: admits a write with %s", async (_, content) => {
    queue({ body: { object: "page_markdown", id: "page-1", markdown: content } });
    await call(build(), "notion_api_write", insert(content));
    expect(calls).toHaveLength(1);
  });
});

describe("notion() generic REST tools", () => {
  it("INV-10: finds operations and their contracts in the pinned index without a request", async () => {
    const connector = build();
    const found = await call(connector, "notion_api_search", { query: "query data source" });
    expect(found.operations).toContainEqual(
      expect.objectContaining({
        method: "POST",
        path: "/v1/data_sources/{data_source_id}/query",
        tool: "notion_api_read",
      }),
    );
    const details = await call(connector, "notion_api_details", { method: "PATCH", path: "/v1/pages/page-1" });
    expect(details).toMatchObject({ path: "/v1/pages/{page_id}", tool: "notion_api_write" });
    expect(Object.keys(details.body.schema.properties)).toContain("in_trash");
    expect(calls).toHaveLength(0);
  });

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
    calls.length = 0;
    // A view query is stored until deleted, and a page create is a create:
    // neither may ride the read path.
    for (const path of ["/v1/views/v-1/queries", "/v1/pages"]) {
      const refused = await refusal(call(connector, "notion_api_read", { method: "POST", path, body: {} }));
      expect(refused.message).toContain("call it with notion_api_write");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses unknown paths and guessed parameters before anything reaches Notion", async () => {
    const connector = build();
    const path = await refusal(call(connector, "notion_api_read", { path: "/v1/page/page-1" }));
    expect(path.message).toContain("Nearest: GET /v1/pages/{page_id}");
    const param = await refusal(
      call(connector, "notion_api_read", { method: "POST", path: "/v1/search", body: { cursor: "c1" } }),
    );
    expect(param.message).toContain("Not sent:");
    expect(param.validation?.issues[0]).toMatchObject({ path: "/body/cursor", code: "additionalProperties" });
    const missing = await refusal(
      call(connector, "notion_api_write", { method: "PATCH", path: "/v1/blocks/b-1/children", body: {} }),
    );
    expect(missing.validation?.issues[0]).toMatchObject({ path: "/body/children", code: "required" });
    expect(calls).toHaveLength(0);
  });

  it("refuses Notion's OAuth token endpoints and multipart sends with the route to take instead", async () => {
    const connector = build();
    const minting = await refusal(
      call(connector, "notion_api_write", { method: "POST", path: "/v1/oauth/token", body: {} }),
    );
    expect(minting.message).toContain("mint and revoke credentials");
    const upload = await refusal(
      call(connector, "notion_api_write", { method: "POST", path: "/v1/file_uploads/fu-1/send", body: {} }),
    );
    expect(upload.message).toContain("multipart/form-data");
    expect(upload.message).toContain('mode "external_url"');
    expect(calls).toHaveLength(0);
  });

  it("returns one envelope whose cursor names where it goes: query on GET, body on POST queries", async () => {
    const connector = build();
    queue({ body: { object: "list", results: [{ id: "u1" }], has_more: true, next_cursor: "c-get" } });
    const users = await call(connector, "notion_api_read", { path: "/v1/users", query: { page_size: 1 } });
    expect(new URL(calls[0]!.url).searchParams.get("page_size")).toBe("1");
    expect(users).toEqual({
      status: 200,
      data: { object: "list", results: [{ id: "u1" }], has_more: true, next_cursor: "c-get" },
      page: { hasMore: true, next: "c-get", param: "start_cursor" },
    });

    queue({ body: { object: "list", results: [{ id: "p1", url: "u" }], has_more: true, next_cursor: "c-post" } });
    const found = await call(connector, "notion_api_read", {
      method: "POST",
      path: "/v1/search",
      body: { query: "roadmap", start_cursor: "c-prev" },
      select: ["results.id"],
    });
    expect(calls[1]?.body).toEqual({ query: "roadmap", start_cursor: "c-prev" });
    expect(found).toEqual({
      status: 200,
      data: { results: [{ id: "p1" }] },
      page: { hasMore: true, next: "c-post", param: "start_cursor", in: "body" },
    });

    queue({ body: { object: "list", results: [], has_more: false, next_cursor: null } });
    const last = await call(connector, "notion_api_read", { path: "/v1/users" });
    expect(last.page).toEqual({ hasMore: false });
  });

  it("refuses a block whose type, payload key, or payload fields disagree with the index, before dispatch", async () => {
    const connector = build();
    const append = (children: unknown[]) =>
      call(connector, "notion_api_write", { method: "PATCH", path: "/v1/blocks/b-1/children", body: { children } });
    // The `type` discriminator is a const in Notion's document: it must name
    // the payload key the block carries.
    const mismatched = await refusal(append([{ type: "to_do", paragraph: { rich_text: [] } }]));
    expect(mismatched.message).toContain("Not sent:");
    expect(mismatched.validation?.issues[0]).toMatchObject({ path: "/body/children/0/type", code: "enum" });
    const invented = await refusal(append([{ object: "block", type: "wizard", wizard: {} }]));
    expect(invented.validation?.issues.map((issue) => issue.path)).toContain("/body/children/0/wizard");
    const typo = await refusal(append([{ type: "to_do", to_do: { rich_txt: [] } }]));
    expect(typo.validation?.issues[0]).toMatchObject({
      path: "/body/children/0/to_do/rich_txt",
      code: "additionalProperties",
    });
    expect(typo.validation?.issues[0]?.expected).toMatch(/^rich_text\? /);
    expect(calls).toHaveLength(0);

    queue({ body: { object: "list", results: [{ id: "new-1", type: "to_do" }], has_more: false, next_cursor: null } });
    const children = [
      { object: "block", type: "to_do", to_do: { rich_text: [{ type: "text", text: { content: "Ship" } }] } },
    ];
    await append(children);
    expect(calls[0]).toMatchObject({ method: "PATCH", body: { children } });
  });

  it("keeps a view query's continuation and a meeting-note cut-off through select", async () => {
    const connector = build();
    // Creating a view query stores it, so it is a write; its first page
    // continues at the query's own GET, not at the POST.
    queue({
      body: {
        object: "view_query",
        id: "q-1",
        view_id: "v-1",
        expires_at: "2026-10-09T20:00:00.000Z",
        total_count: 130,
        results: [{ object: "page", id: "p1" }],
        next_cursor: "c-view",
        has_more: true,
      },
    });
    const created = await call(connector, "notion_api_write", {
      method: "POST",
      path: "/v1/views/v-1/queries",
      body: { page_size: 1 },
      select: ["results.id"],
    });
    expect(created).toEqual({
      status: 200,
      data: { results: [{ id: "p1" }] },
      page: { hasMore: true, next: "c-view", param: "start_cursor", in: "query", path: "/v1/views/v-1/queries/q-1" },
    });

    queue({
      body: { object: "list", results: [{ id: "p2" }], has_more: false, next_cursor: null, type: "page", page: {} },
    });
    const next = await call(connector, "notion_api_read", {
      path: created.page.path,
      query: { [created.page.param]: created.page.next },
      select: ["results.id"],
    });
    expect(calls[1]?.method).toBe("GET");
    expect(new URL(calls[1]!.url).pathname).toBe("/v1/views/v-1/queries/q-1");
    expect(new URL(calls[1]!.url).searchParams.get("start_cursor")).toBe("c-view");
    expect(next).toEqual({ status: 200, data: { results: [{ id: "p2" }] }, page: { hasMore: false } });

    // Meeting notes have no cursor: hasMore without next says the list was
    // cut at its limit, even when select drops the body's own has_more.
    queue({ body: { results: [{ id: "m1", type: "meeting_notes" }], has_more: true } });
    const notes = await call(connector, "notion_api_read", {
      method: "POST",
      path: "/v1/blocks/meeting_notes/query",
      body: { limit: 1 },
      select: ["results.id"],
    });
    expect(notes).toEqual({ status: 200, data: { results: [{ id: "m1" }] }, page: { hasMore: true } });
  });

  it("INV-9: sends a write once with method and path stated, and never replays it after a failure", async () => {
    const connector = build();
    queue({ body: { object: "page", id: "page-1", in_trash: true } });
    const trashed = await call(connector, "notion_api_write", {
      method: "PATCH",
      path: "/v1/pages/page-1",
      body: { in_trash: true },
    });
    expect(trashed).toMatchObject({ status: 200, data: { in_trash: true } });
    expect(calls[0]).toMatchObject({ method: "PATCH", body: { in_trash: true } });
    expect(calls[0]?.headers["Notion-Version"]).toBe(NOTION_API_VERSION);
    // Notion has no idempotency key, so none is invented.
    expect(trashed).not.toHaveProperty("idempotencyKey");

    calls.length = 0;
    queue({ status: 502, body: { object: "error", code: "internal_server_error", message: "boom" } });
    const failed = await refusal(call(connector, "notion_api_write", { method: "DELETE", path: "/v1/blocks/b-1" }));
    // A keyless write that may have reached Notion is never advertised as
    // retryable: repeating it could apply the change twice.
    expect(failed).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(calls).toHaveLength(1);
  });
});

describe("notion() lean projections", () => {
  it("flattens every property shape and reports truncation", async () => {
    queue({ body: PAGE_FIXTURE });
    const page: any = await call(build(), "integration_get_page", { page_id: "page-1" });

    expect(page.id).toBe("page-1");
    expect(page.title).toBe("Quarterly review");
    expect(page.icon).toBe("📘");
    expect(page.parent).toEqual({ type: "data_source_id", id: "ds-1" });
    expect(page.created_by).toEqual({ id: "user-1", name: "Ada" });
    expect(page.properties).toEqual({
      Name: "Quarterly review",
      Notes: "ship it",
      Estimate: 42,
      Done: true,
      Stage: "In review",
      Status: "In progress",
      Tags: ["infra", "urgent"],
      Due: { start: "2026-03-01", end: null },
      Owner: [{ id: "user-9", name: "Grace" }],
      Blocked: ["page-2", "page-3"],
      Score: 7,
      Count: 3,
      Ticket: "RL-12",
      Spec: [{ name: "spec.pdf", url: "https://x/1" }],
      Missing: null,
      // A property type that shipped after this release degrades to its
      // payload rather than vanishing.
      Invented: "kept",
    });
    // Notion caps a paginated property at 25 entries and says so only with
    // has_more. The id travels with the name because the property-item read
    // addresses properties by id.
    expect(page.truncated_properties).toEqual([{ name: "Blocked", id: "rel" }]);

    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("plain_text");
    expect(serialized).not.toContain("annotations");
    expect(serialized).not.toContain("multi_select");
  });

  it("names native and custom icons, and reads an uncomputable value as null", async () => {
    const page = (icon: unknown) => ({
      ...PAGE_FIXTURE,
      icon,
      properties: {
        Name: PAGE_FIXTURE.properties.Name,
        Score: { id: "fx", type: "formula", formula: { type: "unsupported", unsupported: {} } },
        Count: {
          id: "rl",
          type: "rollup",
          rollup: { type: "unsupported", unsupported: {}, function: "show_original" },
        },
      },
    });
    queue(
      { body: page({ type: "icon", icon: { name: "pizza", color: "blue" } }) },
      { body: page({ type: "custom_emoji", custom_emoji: { id: "e1", name: "shipit", url: "https://x/e.png" } }) },
    );
    const native: any = await call(build(), "integration_get_page", { page_id: "page-1" });
    expect(native.icon).toBe("pizza");
    expect(native.properties).toEqual({ Name: "Quarterly review", Score: null, Count: null });
    const custom: any = await call(build(), "integration_get_page", { page_id: "page-1" });
    expect(custom.icon).toBe(":shipit:");
  });

  it("narrows to the requested properties", async () => {
    queue({ body: PAGE_FIXTURE });
    const page: any = await call(build(), "integration_get_page", {
      page_id: "page-1",
      properties: ["Name", "Status"],
    });
    expect(Object.keys(page.properties)).toEqual(["Name", "Status"]);
    expect(page.truncated_properties).toBeUndefined();
  });

  it("returns Notion's untouched payload through the raw escape hatch", async () => {
    queue({ body: PAGE_FIXTURE });
    const page = await call(build(), "integration_get_page", { page_id: "page-1", raw: true });
    expect(page).toEqual(PAGE_FIXTURE);
  });

  it("keeps search results to identity fields only", async () => {
    queue({
      body: {
        object: "list",
        results: [
          PAGE_FIXTURE,
          {
            object: "data_source",
            id: "ds-1",
            title: [{ plain_text: "Roadmap" }],
            parent: { type: "database_id", database_id: "db-1" },
            last_edited_time: "2026-02-02T00:00:00.000Z",
          },
        ],
        has_more: true,
        next_cursor: "cursor-2",
      },
    });
    const found: any = await call(build(), "integration_search", { query: "review" });

    expect(found.results[0]).toEqual({
      id: "page-1",
      object: "page",
      title: "Quarterly review",
      url: "https://app.notion.com/p/page-1",
      parent: { type: "data_source_id", id: "ds-1" },
      last_edited_time: "2026-02-02T00:00:00.000Z",
    });
    expect(found.results[0].properties).toBeUndefined();
    expect(found.results[1]).toEqual({
      id: "ds-1",
      object: "data_source",
      title: "Roadmap",
      database_id: "db-1",
      url: null,
      last_edited_time: "2026-02-02T00:00:00.000Z",
    });
    expect(found.has_more).toBe(true);
    expect(found.next_cursor).toBe("cursor-2");
  });

  it("flattens blocks to text and follows nesting only when asked", async () => {
    const parent = {
      results: [
        { id: "b1", type: "heading_2", has_children: false, heading_2: { rich_text: [{ plain_text: "Goals" }] } },
        {
          id: "b2",
          type: "to_do",
          has_children: true,
          to_do: { rich_text: [{ plain_text: "Ship it" }], checked: true },
        },
        {
          id: "b3",
          type: "code",
          has_children: false,
          code: { rich_text: [{ plain_text: "const x = 1" }], language: "typescript" },
        },
        { id: "b4", type: "child_page", has_children: true, child_page: { title: "Appendix" } },
        // Notion adds block types to every API version at once. An unmodelled
        // type must not collapse to an empty string and lose its payload.
        {
          id: "b5",
          type: "meeting_notes",
          has_children: false,
          meeting_notes: {
            name: [{ plain_text: "Weekly sync" }],
            summary: [{ plain_text: "Shipped the thing" }],
            transcript_id: "tr-1",
          },
        },
        // A divider's payload is empty and a table of contents carries only
        // colour, so neither earns a raw field.
        { id: "b6", type: "divider", has_children: false, divider: {} },
        { id: "b7", type: "table_of_contents", has_children: false, table_of_contents: { color: "default" } },
      ],
      has_more: false,
      next_cursor: null,
    };

    queue({ body: parent });
    const shallow: any = await call(build(), "integration_get_page_content", { block_id: "page-1" });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.get("page_size")).toBe("25");
    expect(shallow.truncated).toBe(false);
    expect(shallow.results).toEqual([
      { id: "b1", type: "heading_2", depth: 0, text: "Goals", has_children: false },
      { id: "b2", type: "to_do", depth: 0, text: "Ship it", has_children: true, checked: true },
      { id: "b3", type: "code", depth: 0, text: "const x = 1", has_children: false, language: "typescript" },
      { id: "b4", type: "child_page", depth: 0, text: "Appendix", has_children: true },
      {
        id: "b5",
        type: "meeting_notes",
        depth: 0,
        text: "",
        has_children: false,
        raw: {
          name: [{ plain_text: "Weekly sync" }],
          summary: [{ plain_text: "Shipped the thing" }],
          transcript_id: "tr-1",
        },
      },
      { id: "b6", type: "divider", depth: 0, text: "", has_children: false },
      { id: "b7", type: "table_of_contents", depth: 0, text: "", has_children: false },
    ]);

    calls.length = 0;
    queue(
      { body: parent },
      {
        body: {
          results: [
            { id: "b2a", type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: "sub" }] } },
          ],
          has_more: false,
        },
      },
      { body: { results: [], has_more: false } },
    );
    const deep: any = await call(build(), "integration_get_page_content", { block_id: "page-1", depth: 1 });
    expect(calls).toHaveLength(3);
    expect(deep.results.map((block: any) => [block.id, block.depth])).toEqual([
      ["b1", 0],
      ["b2", 0],
      ["b2a", 1],
      ["b3", 0],
      ["b4", 0],
      ["b5", 0],
      ["b6", 0],
      ["b7", 0],
    ]);
  });

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

  it("reports truncation when a nested level has more than one page", async () => {
    queue(
      {
        body: {
          results: [{ id: "b1", type: "toggle", has_children: true, toggle: { rich_text: [{ plain_text: "Deep" }] } }],
          has_more: false,
          next_cursor: null,
        },
      },
      {
        body: {
          results: [
            {
              id: "b1a",
              type: "paragraph",
              has_children: false,
              paragraph: { rich_text: [{ plain_text: "one of many" }] },
            },
          ],
          has_more: true,
          next_cursor: "cursor-nested",
        },
      },
    );
    const walked: any = await call(build(), "integration_get_page_content", { block_id: "page-1", depth: 1 });
    expect(calls).toHaveLength(2);
    expect(walked.truncated).toBe(true);
    // The nested cursor belongs to b1; re-reading it directly is the route.
    expect(walked.next_cursor).toBeNull();
  });

  it("does not walk children when raw asks for Notion's own response", async () => {
    const body = {
      results: [{ id: "b1", type: "toggle", has_children: true, toggle: { rich_text: [{ plain_text: "Deep" }] } }],
      has_more: false,
      next_cursor: null,
    };
    queue({ body });
    const raw = await call(build(), "integration_get_page_content", { block_id: "page-1", depth: 2, raw: true });
    expect(calls).toHaveLength(1);
    expect(raw).toEqual(body);
  });

  it("reduces a data source schema to what a filter or a write needs", async () => {
    queue({
      body: {
        id: "ds-1",
        title: [{ plain_text: "Roadmap" }],
        parent: { type: "database_id", database_id: "db-1" },
        properties: {
          Name: { id: "title", type: "title", title: {} },
          Status: {
            id: "sta",
            type: "status",
            status: { options: [{ name: "Todo" }, { name: "Done" }], groups: [{ name: "To-do" }] },
          },
          Project: { id: "rel", type: "relation", relation: { database_id: "db-2", data_source_id: "ds-2" } },
        },
      },
    });
    const schema: any = await call(build(), "integration_get_data_source_schema", { data_source_id: "ds-1" });
    expect(calls[0]?.url).toBe(`${NOTION_API_BASE_URL}/v1/data_sources/ds-1`);
    expect(schema.database_id).toBe("db-1");
    expect(schema.title_property).toBe("Name");
    expect(schema.properties["Status"]).toEqual({
      id: "sta",
      type: "status",
      options: ["Todo", "Done"],
      groups: ["To-do"],
    });
    expect(schema.properties["Project"]).toEqual({ id: "rel", type: "relation", relation_data_source_id: "ds-2" });
  });
});

describe("notion() named-tool pagination", () => {
  it("defaults to a lean page size and passes cursors back verbatim", async () => {
    queue({ body: { results: [], has_more: false, next_cursor: null } });
    await call(build(), "integration_query_data_source", { data_source_id: "ds-1" });
    expect(calls[0]?.body).toEqual({ page_size: 25 });

    calls.length = 0;
    queue({ body: { results: [], has_more: false, next_cursor: null } });
    await call(build({ defaultPageSize: 50 }), "integration_get_page_content", {
      block_id: "page-1",
      start_cursor: "opaque::cursor+value",
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("start_cursor")).toBe("opaque::cursor+value");
    expect(url.searchParams.get("page_size")).toBe("50");
  });

  it("reports a query Notion stopped at its result cap as incomplete, not finished", async () => {
    const capped = {
      object: "list",
      results: [PAGE_FIXTURE],
      has_more: false,
      next_cursor: null,
      request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" },
    };
    queue({ body: capped }, { body: capped }, { body: { ...capped, request_status: { type: "complete" } } });
    const rows: any = await call(build(), "integration_query_data_source", { data_source_id: "ds-1" });
    expect(rows).toMatchObject({ has_more: false, next_cursor: null, incomplete: true });

    const generic = await call(build(), "notion_api_read", {
      method: "POST",
      path: "/v1/data_sources/ds-1/query",
      body: {},
      select: ["results.id"],
    });
    // A cut-off with no cursor, like a meeting-note query past its limit.
    expect(generic.page).toEqual({ hasMore: true });

    const finished: any = await call(build(), "integration_query_data_source", { data_source_id: "ds-1" });
    expect(finished.incomplete).toBeUndefined();
  });

  it("rejects a page size Notion would reject, before the request", async () => {
    const error = await refusal(
      call(build(), "integration_query_data_source", { data_source_id: "ds-1", page_size: 5_000 }),
    );
    expect(error.code).toBe("invalid_args");
    expect(error.message).toContain("page_size");
    expect(calls).toHaveLength(0);
  });

  it("passes filters and sorts through unchanged", async () => {
    queue({ body: { results: [], has_more: false } });
    await call(build(), "integration_query_data_source", {
      data_source_id: "ds-1",
      filter: { property: "Status", status: { equals: "Done" } },
      sorts: [{ property: "Due", direction: "ascending" }],
      start_cursor: "c1",
    });
    expect(calls[0]?.url).toBe(`${NOTION_API_BASE_URL}/v1/data_sources/ds-1/query`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      page_size: 25,
      filter: { property: "Status", status: { equals: "Done" } },
      sorts: [{ property: "Due", direction: "ascending" }],
      start_cursor: "c1",
    });
  });

  it("builds search filter and sort objects from flat arguments", async () => {
    queue({ body: { results: [], has_more: false } });
    await call(build(), "integration_search", {
      query: "roadmap",
      object_type: "data_source",
      sort: "last_edited_desc",
    });
    expect(calls[0]?.body).toEqual({
      page_size: 25,
      query: "roadmap",
      filter: { property: "object", value: "data_source" },
      sort: { timestamp: "last_edited_time", direction: "descending" },
    });

    calls.length = 0;
    queue({ body: { results: [], has_more: false } });
    await call(build(), "integration_search", { sort: "relevance" });
    expect(calls[0]?.body?.sort).toEqual({ property: "relevance" });
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

  caseOf("routes an invalid token to auth_required", async () => {
    const error = await failWith(401, {
      object: "error",
      status: 401,
      code: "unauthorized",
      message: "API token is invalid.",
    });
    expect(error.code).toBe("auth_required");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("unauthorized");
    expect(error.message).toContain("this connection in the operator UI");
    expect(error.message).toContain("authorize_connector");
  });

  caseOf("does not send a capability failure to re-authorization", async () => {
    const error = await failWith(403, { object: "error", code: "restricted_resource", message: "Insufficient." });
    expect(error.code).toBe("provider_permission_denied");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("capability");
    expect(error.message).toContain("block limit");
    expect(error.message).toContain("Re-authorizing will not help");
  });

  caseOf("says a 404 may mean unshared rather than absent", async () => {
    const error = await failWith(404, { object: "error", code: "object_not_found", message: "Could not find page." });
    // Deliberately not not_found: Notion's 404 does not know whether the
    // object is missing or merely unshared (H11).
    expect(error.code).not.toBe("not_found");
    expect(error.code).toBe("connector_call_failed");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("not been shared with this integration");
    expect(error.message).toContain("do not treat it as proof of deletion");
  });

  caseOf("treats every malformed request as invalid_args", async () => {
    const error = await failWith(400, {
      object: "error",
      code: "validation_error",
      message: "body failed validation.",
    });
    expect(error.code).toBe("invalid_args");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("validation_error");
  });

  caseOf("converts Retry-After seconds into a millisecond window", async () => {
    const error = await failWith(
      429,
      {
        object: "error",
        code: "rate_limited",
        message: "You have been rate limited.",
        additional_data: { rate_limit_reason: "public_api_request_rate_limit" },
      },
      { "Retry-After": "7" },
    );
    expect(error.code).toBe("rate_limited");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(7_000);
    expect(error.message).toContain("public_api_request_rate_limit");
  });

  caseOf("reads Notion's body retry_after when a proxy drops the header", async () => {
    const error = await failWith(429, {
      code: "rate_limited",
      message: "slow",
      additional_data: { rate_limit_reason: "public_api_space_request_rate_limit", retry_after: "90" },
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

  caseOf("falls back to a default window when Retry-After is absent", async () => {
    const error = await failWith(429, { code: "rate_limited", message: "slow" });
    expect(error.retryAfterMs).toBe(1_000);
  });

  caseOf("backs off on overload and conflict, and retries upstream failures", async () => {
    const overloaded = await failWith(529, { code: "service_overload", message: "overloaded" }, { "Retry-After": "2" });
    expect(overloaded.code).toBe("unavailable");
    expect(overloaded.retryable).toBe(true);
    expect(overloaded.retryAfterMs).toBe(2_000);

    const conflict = await failWith(409, { code: "conflict_error", message: "Conflict occurred." });
    expect(conflict.code).toBe("unavailable");
    expect(conflict.retryable).toBe(true);

    const upstream = await failWith(503, { code: "service_unavailable", message: "unavailable" });
    expect(upstream.code).toBe("unavailable");
    expect(upstream.retryable).toBe(true);
  });

  caseOf("INV-9: names what a failed write committed, so the caller reads it instead of repeating", async () => {
    queue({
      status: 503,
      body: {
        code: "service_unavailable",
        message: "Timed out.",
        // POST /v1/pages withholds Notion's error text; an id-shaped commit still shows.
        additional_data: { committed_resource_id: "5c6a2821-6bb1-4a7e-b6e1-c50111515c3d" },
      },
    });
    const created = await call(build(), "integration_create_page", { parent_page_id: "p", title: "x" }).catch(
      (thrown: any) => thrown,
    );
    expect(created).toMatchObject({ code: "connector_call_failed", retryable: false });
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
    const appended = await call(build(), "integration_append_blocks", { block_id: "page-1", text: ["a", "b"] }).catch(
      (thrown: any) => thrown,
    );
    expect(appended).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(appended.message).toContain("0b6f0c8e-1d1e-4c55-9a0e-6f1b2a3c4d01, 0b6f0c8e-1d1e-4c55-9a0e-6f1b2a3c4d02");
    expect(calls).toHaveLength(2);
  });

  caseOf("INV-9: relays Notion's retry guidance for a saved update to an existing object", async () => {
    queue({
      status: 503,
      body: {
        code: "service_unavailable",
        message: "The change was saved, but the response could not be built in time.",
        additional_data: {
          retry_guidance: ["Read the object again to confirm the saved change.", "Do not repeat the write."],
        },
      },
    });
    const updated = await call(build(), "notion_api_write", {
      method: "PATCH",
      path: "/v1/pages/page-1",
      body: { properties: { Done: { checkbox: true } } },
    }).catch((thrown: any) => thrown);
    expect(updated).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(updated.message).toContain(
      "Notion's guidance: Read the object again to confirm the saved change. Do not repeat the write.",
    );
    expect(updated.message).not.toContain("is unknown");
    expect(calls).toHaveLength(1);
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
    const read = await call(build(), "notion_api_read", { path: "/v1/users/me" }).catch((thrown: any) => thrown);
    expect(read).toBeInstanceOf(ConnectorCallError);
    expect(read.message).toContain("withheld because this operation handles credentials");
    expect(read.message).not.toContain("FAKE_SIGNATURE");
    expect(read.message).not.toContain("Fetch");

    queue({
      status: 503,
      body: {
        code: "service_unavailable",
        message: "Timed out.",
        additional_data: { committed_resource_id: "SECRET-ECHO", retry_guidance: "SECRET-GUIDANCE" },
      },
    });
    const created = await call(build(), "notion_api_write", {
      method: "POST",
      path: "/v1/file_uploads",
      body: { mode: "external_url", external_url: "https://example.com/a.png", filename: "a.png" },
    }).catch((thrown: any) => thrown);
    expect(created).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(created.message).toContain("committed the write");
    expect(created.message).not.toContain("SECRET-");
    expect(calls).toHaveLength(2);
  });

  caseOf("INV-5: withholds signed file links that Notion's error text echoes", async () => {
    const signed = "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/a.png?X-Amz-Signature=FAKE_SIGNATURE";
    queue({
      status: 400,
      body: { code: "validation_error", message: `old_str not found near ![a](${signed})` },
    });
    const error = await call(build(), "notion_api_write", {
      method: "PATCH",
      path: "/v1/pages/page-1/markdown",
      body: { type: "update_content", update_content: { content_updates: [{ old_str: "x", new_str: "y" }] } },
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
    expect(updated).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(updated.message).toContain("Notion's guidance: Read");
    expect(updated.message).not.toContain("FAKE_SIGNATURE");
  });

  caseOf("survives an error body that is not JSON", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("<html>gateway</html>", { status: 502 }),
    ) as unknown as typeof fetch;
    const error = await call(build(), "notion_api_read", { path: "/v1/users/me" }).catch((thrown: any) => thrown);
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("HTTP 502");
  });

  caseOf("fails an oversized 2xx body instead of reporting an empty success", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ blob: "x".repeat(5 * 1024 * 1024) }), {
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const error = await call(build(), "notion_api_read", { path: "/v1/users/me" }).catch((thrown: any) => thrown);
    expect(error).toBeInstanceOf(ConnectorCallError);
    expect(error.code).toBe("connector_call_failed");
    expect(error.retryable).toBe(false);
  });

  test.each(cases)("%s", async (_name, run) => run());
});

describe("notion() successful response integrity", () => {
  it.each([
    ["text/html", "<html>synthetic gateway</html>"],
    ["application/json", ""],
    ["application/json", "null"],
    ["application/json", "[]"],
    ["application/json", '"text"'],
    ["application/json", "{not json"],
  ])("rejects an unusable successful %s body without reporting an empty page: %s", async (type, body) => {
    globalThis.fetch = vi.fn(
      async () => new Response(body, { headers: { "content-type": type } }),
    ) as unknown as typeof fetch;
    await expect(call(build(), "integration_get_page_content", { block_id: "synthetic" })).rejects.toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("INV-9: keeps a sent write's unreadable response unknown and does not expose body details", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("synthetic body detail"));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    const provider = build();
    const { credential: _credential, ...local } = provider;
    const registry = makeRegistry([
      {
        ...local,
        callTool: (name, args) => provider.callTool(name, args, context()),
      },
    ]);
    const invocation = new InvocationService(registry, new CatalogService(registry, "https://connecta.example"));
    const outcome = await runEdge(
      invocation.pipeline(
        "workspace.integration_append_blocks",
        { block_id: "synthetic", text: ["hello"] },
        { source: "call_destructive_tool" },
      ),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("Expected failed write response");
    // Notion has no idempotency key, so a lost reply on a sent write is not
    // retryable: repeating it could create the content twice.
    expect(outcome.error).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(outcome.error.message).toContain("check the target before repeating it");
    expect(outcome.error.message).not.toContain("synthetic body detail");
    expect(outcome.dispatched).toBe(true);
    expect(writeStateOf(outcome)).toBe("unknown");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("notion() authoring helpers", () => {
  it("creates a data source row with a schema-named title property", async () => {
    queue({ body: PAGE_FIXTURE });
    await call(build(), "integration_create_page", {
      parent_data_source_id: "ds-1",
      title: "New row",
      title_property: "Name",
      properties: { Status: { status: { name: "Todo" } } },
      markdown: "# Body",
      icon: "🚀",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      parent: { type: "data_source_id", data_source_id: "ds-1" },
      properties: {
        Status: { status: { name: "Todo" } },
        Name: { title: [{ type: "text", text: { content: "New row" } }] },
      },
      markdown: "# Body",
      icon: { type: "emoji", emoji: "🚀" },
    });
  });

  it("requires exactly one parent and one body form", async () => {
    const both = await refusal(
      call(build(), "integration_create_page", { parent_page_id: "page-1", parent_data_source_id: "ds-1", title: "x" }),
    );
    expect(both.code).toBe("invalid_args");
    expect(both.message).toContain("exactly one");
    expect(both.message).toContain("never by a database_id");

    const neither = await refusal(call(build(), "integration_create_page", { title: "x" }));
    expect(neither.code).toBe("invalid_args");

    const twoBodies = await refusal(
      call(build(), "integration_create_page", {
        parent_page_id: "page-1",
        markdown: "a",
        children: [{ object: "block" }],
      }),
    );
    expect(twoBodies.code).toBe("invalid_args");
    expect(twoBodies.message).toContain("not both");
    expect(calls).toHaveLength(0);
  });

  it("keeps reviewed create-page expansions outside the maintained tool", () => {
    const properties = build().staticTools?.find((tool) => tool.name === "integration_create_page")?.inputSchema?.[
      "properties"
    ];
    for (const declined of ["workspace", "template", "position", "cover", "file_upload"]) {
      expect(properties).not.toHaveProperty(declined);
    }
  });

  it("turns plain text into paragraph blocks and honours position", async () => {
    queue({
      body: {
        results: [
          { id: "new-1", type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: "first" }] } },
        ],
      },
    });
    const appended: any = await call(build(), "integration_append_blocks", {
      block_id: "page-1",
      text: ["first", "second"],
      position: "after_block",
      after_block_id: "b3",
    });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe(`${NOTION_API_BASE_URL}/v1/blocks/page-1/children`);
    expect(calls[0]?.body).toEqual({
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: "first" } }] },
        },
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: "second" } }] },
        },
      ],
      // The 2026-03-11 shape; the old `after` string is deprecated.
      position: { type: "after_block", after_block: { id: "b3" } },
    });
    expect(appended.appended).toBe(1);

    const missingAnchor = await refusal(
      call(build(), "integration_append_blocks", { block_id: "page-1", text: ["x"], position: "after_block" }),
    );
    expect(missingAnchor.code).toBe("invalid_args");
    expect(missingAnchor.message).toContain("after_block_id");
  });

  it("splits text past Notion's 2,000-character run limit, and refuses what no request could carry", async () => {
    queue({ body: PAGE_FIXTURE }, { body: { results: [] } });
    // An astral character straddles the cut: it must not be split in half.
    const title = `${"t".repeat(1_999)}😀${"u".repeat(2_500)}`;
    await call(build(), "integration_create_page", { parent_page_id: "p", title });
    const runs = calls[0]?.body.properties.title.title.map((run: any) => run.text.content);
    expect(runs.map((run: string) => run.length)).toEqual([1_999, 2_000, 502]);
    expect(runs.join("")).toBe(title);
    expect(runs[1].startsWith("😀")).toBe(true);

    await call(build(), "integration_append_blocks", { block_id: "page-1", checklist: ["x".repeat(4_001)] });
    expect(calls[1]?.body.children[0].to_do.rich_text).toHaveLength(3);

    calls.length = 0;
    const tooLong = await refusal(
      call(build(), "integration_append_blocks", { block_id: "page-1", text: ["ok", "y".repeat(200_001)] }),
    );
    expect(tooLong.code).toBe("invalid_args");
    expect(tooLong.message).toContain("text[1]");
    expect(calls).toHaveLength(0);
  });

  it("turns checklist items into unchecked to-do blocks, and takes one body form only", async () => {
    queue({
      body: {
        results: [
          {
            id: "todo-1",
            type: "to_do",
            has_children: false,
            to_do: { rich_text: [{ plain_text: "Book venue" }], checked: false },
          },
        ],
      },
    });
    const appended: any = await call(build(), "integration_append_blocks", {
      block_id: "page-1",
      checklist: ["Book venue", "Send invites"],
    });
    expect(calls[0]?.body).toEqual({
      children: [
        {
          object: "block",
          type: "to_do",
          to_do: { rich_text: [{ type: "text", text: { content: "Book venue" } }], checked: false },
        },
        {
          object: "block",
          type: "to_do",
          to_do: { rich_text: [{ type: "text", text: { content: "Send invites" } }], checked: false },
        },
      ],
    });
    expect(appended.results[0]).toMatchObject({ type: "to_do", text: "Book venue", checked: false });

    calls.length = 0;
    const ambiguous = await refusal(
      call(build(), "integration_append_blocks", { block_id: "page-1", text: ["a"], checklist: ["b"] }),
    );
    expect(ambiguous.message).toContain("exactly one of text, checklist, children");
    expect(calls).toHaveLength(0);
  });
});
