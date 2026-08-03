import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../src/errors.js";
import {
  NOTION_API_BASE_URL,
  NOTION_API_VERSION,
  notion,
} from "../src/providers/notion.js";
import { isExplicitlyReadOnly } from "../src/tool-safety.js";
import { silentLogger } from "./helpers.js";
import type { Connector, ConnectorContext } from "../src/types.js";

// The whole surface is hand-written, so there is no downstream catalog to
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
      headers: next.headers ?? {},
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function context(token: string | null = "secret_token"): ConnectorContext {
  return {
    storage: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
    },
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    credential: {
      get: async () => token,
      getAll: async () => (token ? { value: token } : null),
    },
  };
}

function build(overrides: Record<string, unknown> = {}): Connector {
  return notion("workspace", {
    purpose: "Team knowledge base",
    ...overrides,
  } as any);
}

function call(
  connector: Connector,
  name: string,
  args: Record<string, unknown> = {},
  ctx: ConnectorContext = context(),
): Promise<any> {
  return connector.callTool(name, args, ctx) as Promise<any>;
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
      title: [
        { plain_text: "Quarterly ", annotations: { bold: true } },
        { plain_text: "review" },
      ],
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
      files: [
        { name: "spec.pdf", type: "external", external: { url: "https://x/1" } },
      ],
    },
    Missing: { id: "mt", type: "select", select: null },
    Invented: { id: "new", type: "brand_new_type", brand_new_type: "kept" },
  },
};

describe("notion() tool surface", () => {
  it("publishes exactly the maintained tool inventory", () => {
    const names = build().staticTools?.map((tool) => tool.name);
    expect(names).toEqual([
      "search",
      "get_page",
      "get_page_content",
      "get_page_property",
      "get_database",
      "get_data_source_schema",
      "query_data_source",
      "list_users",
      "get_self",
      "list_comments",
      "create_page",
      "append_blocks",
      "update_page_properties",
      "trash_page",
      "add_comment",
    ]);
  });

  it("pins the read/write partition against the fail-closed classifier", () => {
    const tools = build().staticTools ?? [];
    const reads = tools.filter(isExplicitlyReadOnly).map((tool) => tool.name);
    const writes = tools
      .filter((tool) => !isExplicitlyReadOnly(tool))
      .map((tool) => tool.name);

    // These are hand-written, so this is not a fill-in check like Mixpanel's —
    // it is the exact partition the release ships. Moving a name across this
    // line changes which calls a host asks a human about.
    expect(reads).toEqual([
      "search",
      "get_page",
      "get_page_content",
      "get_page_property",
      "get_database",
      "get_data_source_schema",
      "query_data_source",
      "list_users",
      "get_self",
      "list_comments",
    ]);
    expect(writes).toEqual([
      "create_page",
      "append_blocks",
      "update_page_properties",
      "trash_page",
      "add_comment",
    ]);

    // Only operations that replace or remove existing state claim destruction;
    // creates stay off the read path without inflating the approval copy.
    const destructive = tools
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name);
    expect(destructive).toEqual(["update_page_properties", "trash_page"]);
  });

  it("gives every tool the description and schemas the registry expects", () => {
    for (const tool of build().staticTools ?? []) {
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeTruthy();
      expect(tool.outputSchema, `${tool.name} outputSchema`).toBeTruthy();
      expect(tool.inputSchema?.["type"]).toBe("object");
    }
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
    const connector = build({
      instructions: "Use the Engineering wiki unless the request names another.",
    });
    const guide = connector.usageGuide as {
      content: string;
      summary: string;
      required: boolean;
    };
    expect(guide.required).toBe(true);
    expect(guide.summary).toBeTruthy();
    expect(guide.content).toContain("Databases contain data sources");
    expect(guide.content).toContain("data_source_id");
    expect(guide.content).toContain("raw: true");
    expect(guide.content).toContain("no idempotency key");
    expect(guide.content).toContain("not shared with this integration");
    // Real markdown, not a diff hunk: agents read this string verbatim.
    expect(guide.content).toContain("## Workspace instructions");
    expect(guide.content).not.toContain("+## Workspace instructions");
    expect(guide.content).toContain(
      "Use the Engineering wiki unless the request names another.",
    );
  });

  it("rejects a missing purpose or an out-of-range page size", () => {
    expect(() => notion("workspace", { purpose: "  " })).toThrow(
      "notion() requires a non-empty workspace purpose.",
    );
    expect(() =>
      notion("workspace", { purpose: "Docs", defaultPageSize: 500 }),
    ).toThrow("defaultPageSize must be a whole number between 1 and 100");
  });

  it("describes the integration token as an operator credential", () => {
    expect(build().credential?.label).toBe("Notion integration token");
    expect(build({ credentialLabel: "Docs token" }).credential?.label).toBe(
      "Docs token",
    );
    expect(build().credential?.description).toContain("shared with that integration");
  });
});

describe("notion() request construction", () => {
  it("sends the pinned API version and the operator's bearer token", async () => {
    queue({ body: PAGE_FIXTURE });
    await call(build(), "get_page", { page_id: "page-1" });

    expect(calls[0]?.url).toBe(`${NOTION_API_BASE_URL}/v1/pages/page-1`);
    expect(calls[0]?.headers["Notion-Version"]).toBe(NOTION_API_VERSION);
    expect(NOTION_API_VERSION).toBe("2026-03-11");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer secret_token");
  });

  it("fails with auth_required before touching the network", async () => {
    const error = await call(build(), "get_self", {}, context(null)).catch(
      (thrown) => thrown,
    );
    expect(error).toBeInstanceOf(ConnectorCallError);
    expect(error.code).toBe("auth_required");
    expect(error.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("notion() lean projections", () => {
  it("flattens every property shape and reports truncation", async () => {
    queue({ body: PAGE_FIXTURE });
    const page: any = await call(build(), "get_page", { page_id: "page-1" });

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
    // has_more. The id travels with the name because get_page_property — the
    // tool this flag exists to send an agent to — addresses properties by id.
    expect(page.truncated_properties).toEqual([{ name: "Blocked", id: "rel" }]);

    // No rich-text runs, annotations, or property wrappers survived.
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("plain_text");
    expect(serialized).not.toContain("annotations");
    expect(serialized).not.toContain("multi_select");
  });

  it("narrows to the requested properties", async () => {
    queue({ body: PAGE_FIXTURE });
    const page: any = await call(build(), "get_page", {
      page_id: "page-1",
      properties: ["Name", "Status"],
    });
    expect(Object.keys(page.properties)).toEqual(["Name", "Status"]);
    expect(page.truncated_properties).toBeUndefined();
  });

  it("returns Notion's untouched payload through the raw escape hatch", async () => {
    queue({ body: PAGE_FIXTURE });
    const page = await call(build(), "get_page", {
      page_id: "page-1",
      raw: true,
    });
    expect(page).toEqual(PAGE_FIXTURE);
  });

  it("keeps search results to identity fields only", async () => {
    queue({
      body: {
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
    const found: any = await call(build(), "search", { query: "review" });

    expect(found.results[0]).toEqual({
      id: "page-1",
      object: "page",
      title: "Quarterly review",
      url: "https://app.notion.com/p/page-1",
      parent: { type: "data_source_id", id: "ds-1" },
      last_edited_time: "2026-02-02T00:00:00.000Z",
    });
    // A search over a populated database must not drag every row's properties
    // back with it — that is the bloat this connection exists to remove.
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
        {
          id: "b1",
          type: "heading_2",
          has_children: false,
          heading_2: { rich_text: [{ plain_text: "Goals" }] },
        },
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
        {
          id: "b4",
          type: "child_page",
          has_children: true,
          child_page: { title: "Appendix" },
        },
        // Notion adds block types to every API version at once — meeting_notes
        // shipped in the pinned one. An unmodelled type must not collapse to
        // an empty string and lose its whole payload.
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
        {
          id: "b7",
          type: "table_of_contents",
          has_children: false,
          table_of_contents: { color: "default" },
        },
      ],
      has_more: false,
      next_cursor: null,
    };

    queue({ body: parent });
    const shallow: any = await call(build(), "get_page_content", {
      block_id: "page-1",
    });
    expect(calls).toHaveLength(1);
    expect(shallow.truncated).toBe(false);
    expect(shallow.results).toEqual([
      { id: "b1", type: "heading_2", depth: 0, text: "Goals", has_children: false },
      {
        id: "b2",
        type: "to_do",
        depth: 0,
        text: "Ship it",
        has_children: true,
        checked: true,
      },
      {
        id: "b3",
        type: "code",
        depth: 0,
        text: "const x = 1",
        has_children: false,
        language: "typescript",
      },
      // child_page carries a plain string title, not a rich-text array.
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
      {
        id: "b7",
        type: "table_of_contents",
        depth: 0,
        text: "",
        has_children: false,
      },
    ]);

    calls.length = 0;
    queue(
      { body: parent },
      {
        body: {
          results: [
            {
              id: "b2a",
              type: "paragraph",
              has_children: false,
              paragraph: { rich_text: [{ plain_text: "sub" }] },
            },
          ],
          has_more: false,
        },
      },
      { body: { results: [], has_more: false } },
    );
    const deep: any = await call(build(), "get_page_content", {
      block_id: "page-1",
      depth: 1,
    });
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
    // The ceiling is the only thing standing between one admitted tool call
    // and unbounded downstream traffic, so it gets pinned by count.
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

    const walked: any = await call(build(), "get_page_content", {
      block_id: "page-1",
      depth: 1,
    });

    // One request for the top level plus nineteen children: twenty in total,
    // and not a request more however many blocks claim children.
    expect(calls).toHaveLength(20);
    expect(walked.truncated).toBe(true);
    // Truncation costs descendants, never the level that was already fetched.
    expect(
      walked.results.filter((block: any) => block.depth === 0),
    ).toHaveLength(25);
    expect(
      walked.results.filter((block: any) => block.depth === 1),
    ).toHaveLength(19);
  });

  it("reports truncation when a nested level has more than one page", async () => {
    // Nested levels take their first page only, so a nested has_more is a
    // second, quieter way for content to go missing.
    queue(
      {
        body: {
          results: [
            {
              id: "b1",
              type: "toggle",
              has_children: true,
              toggle: { rich_text: [{ plain_text: "Deep" }] },
            },
          ],
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

    const walked: any = await call(build(), "get_page_content", {
      block_id: "page-1",
      depth: 1,
    });
    expect(calls).toHaveLength(2);
    expect(walked.truncated).toBe(true);
    // The nested cursor is deliberately not surfaced: next_cursor belongs to
    // the top level, and re-reading b1 directly is the documented route.
    expect(walked.next_cursor).toBeNull();
  });

  it("does not walk children when raw asks for Notion's own response", async () => {
    const body = {
      results: [
        {
          id: "b1",
          type: "toggle",
          has_children: true,
          toggle: { rich_text: [{ plain_text: "Deep" }] },
        },
      ],
      has_more: false,
      next_cursor: null,
    };
    queue({ body });
    const raw = await call(build(), "get_page_content", {
      block_id: "page-1",
      depth: 2,
      raw: true,
    });
    // depth is ignored alongside raw — one level, one request, no walk. The
    // input schema says so, because silently returning depth-0 would not.
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
            status: {
              options: [{ name: "Todo" }, { name: "Done" }],
              groups: [{ name: "To-do" }],
            },
          },
          Project: {
            id: "rel",
            type: "relation",
            relation: { database_id: "db-2", data_source_id: "ds-2" },
          },
        },
      },
    });
    const schema: any = await call(build(), "get_data_source_schema", {
      data_source_id: "ds-1",
    });
    expect(schema.database_id).toBe("db-1");
    expect(schema.title_property).toBe("Name");
    expect(schema.properties["Status"]).toEqual({
      id: "sta",
      type: "status",
      options: ["Todo", "Done"],
      groups: ["To-do"],
    });
    // Responses carry both ids; writes may only send the data source one.
    expect(schema.properties["Project"]).toEqual({
      id: "rel",
      type: "relation",
      relation_data_source_id: "ds-2",
    });
  });

  it("turns a database id into its queryable data sources", async () => {
    queue({
      body: {
        id: "db-1",
        title: [{ plain_text: "Roadmap" }],
        is_inline: false,
        in_trash: false,
        parent: { type: "page_id", page_id: "page-0" },
        data_sources: [{ id: "ds-1", name: "Roadmap" }],
      },
    });
    const database: any = await call(build(), "get_database", {
      database_id: "db-1",
    });
    expect(database.data_sources).toEqual([{ id: "ds-1", name: "Roadmap" }]);
    expect(database.parent).toEqual({ type: "page_id", id: "page-0" });
  });
});

describe("notion() pagination", () => {
  it("defaults to a lean page size and passes cursors back verbatim", async () => {
    queue({ body: { results: [], has_more: false, next_cursor: null } });
    await call(build(), "query_data_source", { data_source_id: "ds-1" });
    expect(calls[0]?.body).toEqual({ page_size: 25 });

    calls.length = 0;
    queue({ body: { results: [], has_more: false, next_cursor: null } });
    await call(build({ defaultPageSize: 50 }), "list_users", {});
    expect(calls[0]?.url).toContain("page_size=50");

    calls.length = 0;
    queue({ body: { results: [], has_more: false, next_cursor: null } });
    await call(build(), "list_comments", {
      block_id: "page-1",
      start_cursor: "opaque::cursor+value",
      page_size: 100,
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("start_cursor")).toBe("opaque::cursor+value");
    expect(url.searchParams.get("page_size")).toBe("100");
    expect(url.searchParams.get("block_id")).toBe("page-1");
  });

  it("rejects a page size Notion would reject, before the request", async () => {
    const error = await call(build(), "query_data_source", {
      data_source_id: "ds-1",
      page_size: 5_000,
    }).catch((thrown: any) => thrown);
    // api() enforces the declared schema, so an out-of-range page size never
    // becomes a Notion 400 the agent has to interpret.
    expect(error).toBeInstanceOf(ConnectorCallError);
    expect(error.code).toBe("invalid_args");
    expect(error.message).toContain("page_size");
    expect(calls).toHaveLength(0);
  });

  it("passes filters and sorts through unchanged", async () => {
    queue({ body: { results: [], has_more: false } });
    await call(build(), "query_data_source", {
      data_source_id: "ds-1",
      filter: { property: "Status", status: { equals: "Done" } },
      sorts: [{ property: "Due", direction: "ascending" }],
      start_cursor: "c1",
    });
    expect(calls[0]?.url).toBe(
      `${NOTION_API_BASE_URL}/v1/data_sources/ds-1/query`,
    );
    expect(calls[0]?.body).toEqual({
      page_size: 25,
      filter: { property: "Status", status: { equals: "Done" } },
      sorts: [{ property: "Due", direction: "ascending" }],
      start_cursor: "c1",
    });
  });

  it("builds search filter and sort objects from flat arguments", async () => {
    queue({ body: { results: [], has_more: false } });
    await call(build(), "search", {
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
    await call(build(), "search", { sort: "relevance" });
    expect(calls[0]?.body?.sort).toEqual({ property: "relevance" });
  });
});

describe("notion() property pagination", () => {
  // A property-item list is not shaped like a page. On a page the type key
  // holds an array; here each result holds a single object under it. Every
  // payload below is the documented shape from
  // developers.notion.com/reference/retrieve-a-page-property.
  function propertyList(
    type: string,
    results: Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ) {
    return {
      object: "list",
      results: results.map((result) => ({
        object: "property_item",
        id: "prop",
        type,
        ...result,
      })),
      next_cursor: "cursor-2",
      has_more: true,
      // The envelope's own type is the literal "property_item"; the real one
      // is nested. Reading the outer field reports "property_item" forever.
      type: "property_item",
      property_item: {
        id: "prop",
        next_url: "https://api.notion.com/v1/pages/page-1/properties/prop",
        type,
        [type]: {},
      },
      ...extra,
    };
  }

  it("unwraps a paginated relation into page ids", async () => {
    queue({
      body: propertyList("relation", [
        { relation: { id: "page-2" } },
        { relation: { id: "page-3" } },
      ]),
    });
    const property: any = await call(build(), "get_page_property", {
      page_id: "page-1",
      property_id: "prop",
    });
    expect(property.type).toBe("relation");
    expect(property.results).toEqual(["page-2", "page-3"]);
    expect(property.has_more).toBe(true);
    expect(property.next_cursor).toBe("cursor-2");
  });

  it("unwraps paginated people into user references", async () => {
    queue({
      body: propertyList("people", [
        {
          people: {
            object: "user",
            id: "user-9",
            name: "Grace",
            type: "person",
            person: { email: "grace@example.com" },
          },
        },
        { people: { object: "user", id: "user-10", name: "Ada" } },
      ]),
    });
    const property: any = await call(build(), "get_page_property", {
      page_id: "page-1",
      property_id: "prop",
    });
    expect(property.type).toBe("people");
    expect(property.results).toEqual([
      { id: "user-9", name: "Grace" },
      { id: "user-10", name: "Ada" },
    ]);
  });

  it("joins paginated title and rich_text runs back into plain text", async () => {
    for (const type of ["title", "rich_text"] as const) {
      calls.length = 0;
      queue({
        body: propertyList(type, [
          {
            [type]: {
              type: "text",
              text: { content: "Quarterly ", link: null },
              annotations: { bold: true },
              plain_text: "Quarterly ",
              href: null,
            },
          },
          {
            [type]: {
              type: "text",
              text: { content: "review", link: null },
              plain_text: "review",
              href: null,
            },
          },
        ]),
      });
      const property: any = await call(build(), "get_page_property", {
        page_id: "page-1",
        property_id: "prop",
      });
      expect(property.type, type).toBe(type);
      // One run per result, each a plain string — not the empty strings a
      // page-shaped projection would produce from these.
      expect(property.results, type).toEqual(["Quarterly ", "review"]);
    }
  });

  it("flattens a single-value property without an envelope", async () => {
    queue({
      body: { object: "property_item", id: "num", type: "number", number: 42 },
    });
    const property: any = await call(build(), "get_page_property", {
      page_id: "page-1",
      property_id: "num",
    });
    expect(property).toEqual({ type: "number", value: 42 });
  });

  it("passes page size and cursor through, and offers the raw escape hatch", async () => {
    const body = propertyList("relation", [{ relation: { id: "page-2" } }]);
    queue({ body });
    const raw = await call(build(), "get_page_property", {
      page_id: "page-1",
      property_id: "prop",
      page_size: 100,
      start_cursor: "opaque::cursor",
      raw: true,
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/pages/page-1/properties/prop");
    expect(url.searchParams.get("page_size")).toBe("100");
    expect(url.searchParams.get("start_cursor")).toBe("opaque::cursor");
    // The only read whose shapes are this easy to be surprised by needs a way
    // out that does not require a new release.
    expect(raw).toEqual(body);
  });
});

describe("notion() error mapping", () => {
  async function failWith(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<any> {
    queue({ status, body, headers });
    return call(build(), "get_page", { page_id: "page-1" }).catch(
      (thrown) => thrown,
    );
  }

  it("routes an invalid token to auth_required", async () => {
    const error = await failWith(401, {
      object: "error",
      status: 401,
      code: "unauthorized",
      message: "API token is invalid.",
    });
    expect(error.code).toBe("auth_required");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("unauthorized");
    expect(error.message).toContain("/credentials");
  });

  it("does not send a capability failure to re-authorization", async () => {
    const error = await failWith(403, {
      object: "error",
      code: "restricted_resource",
      message: "Insufficient permissions.",
    });
    // auth_required would route the agent to authorize_connector, which cannot
    // grant a Notion capability or share a page.
    expect(error.code).toBe("connector_call_failed");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("capability");
    expect(error.message).toContain("Re-authorizing will not help");
  });

  it("says a 404 may mean unshared rather than absent", async () => {
    const error = await failWith(404, {
      object: "error",
      code: "object_not_found",
      message: "Could not find page.",
    });
    expect(error.code).toBe("connector_call_failed");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("not been shared with this integration");
    expect(error.message).toContain("do not treat it as proof of deletion");
  });

  it("treats every malformed request as invalid_args", async () => {
    const error = await failWith(400, {
      object: "error",
      code: "validation_error",
      message: "body failed validation.",
    });
    expect(error.code).toBe("invalid_args");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("validation_error");
  });

  it("converts Retry-After seconds into a millisecond window", async () => {
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
    // Notion documents Retry-After as integer seconds; connecta wants ms.
    expect(error.retryAfterMs).toBe(7_000);
    expect(error.message).toContain("public_api_request_rate_limit");
  });

  it("falls back to a default window when Retry-After is absent", async () => {
    const error = await failWith(429, { code: "rate_limited", message: "slow" });
    expect(error.retryAfterMs).toBe(1_000);
  });

  it("backs off on overload and conflict, and retries upstream failures", async () => {
    const overloaded = await failWith(
      529,
      { code: "service_overload", message: "overloaded" },
      { "Retry-After": "2" },
    );
    expect(overloaded.code).toBe("unavailable");
    expect(overloaded.retryable).toBe(true);
    expect(overloaded.retryAfterMs).toBe(2_000);

    const conflict = await failWith(409, {
      code: "conflict_error",
      message: "Conflict occurred.",
    });
    expect(conflict.code).toBe("unavailable");
    expect(conflict.retryable).toBe(true);

    const upstream = await failWith(503, {
      code: "service_unavailable",
      message: "unavailable",
    });
    expect(upstream.code).toBe("unavailable");
    expect(upstream.retryable).toBe(true);
  });

  it("survives an error body that is not JSON", async () => {
    queue({ status: 500, body: undefined });
    globalThis.fetch = vi.fn(
      async () => new Response("<html>gateway</html>", { status: 502 }),
    ) as unknown as typeof fetch;
    const error = await call(build(), "get_self", {}).catch((thrown: any) => thrown);
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("HTTP 502");
  });
});

describe("notion() writes", () => {
  it("creates a data source row with a schema-named title property", async () => {
    queue({ body: PAGE_FIXTURE });
    await call(build(), "create_page", {
      parent_data_source_id: "ds-1",
      title: "New row",
      title_property: "Name",
      properties: { Status: { status: { name: "Todo" } } },
      markdown: "# Body",
      icon: "🚀",
    });
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
    const both = await call(build(), "create_page", {
      parent_page_id: "page-1",
      parent_data_source_id: "ds-1",
      title: "x",
    }).catch((thrown: any) => thrown);
    expect(both.code).toBe("invalid_args");
    expect(both.message).toContain("exactly one");
    expect(both.message).toContain("never by a database_id");

    const neither = await call(build(), "create_page", { title: "x" }).catch(
      (thrown) => thrown,
    );
    expect(neither.code).toBe("invalid_args");

    const twoBodies = await call(build(), "create_page", {
      parent_page_id: "page-1",
      markdown: "a",
      children: [{ object: "block" }],
    }).catch((thrown: any) => thrown);
    expect(twoBodies.code).toBe("invalid_args");
    expect(twoBodies.message).toContain("not both");
    expect(calls).toHaveLength(0);
  });

  it("turns plain text into paragraph blocks and honours position", async () => {
    queue({
      body: {
        results: [
          {
            id: "new-1",
            type: "paragraph",
            has_children: false,
            paragraph: { rich_text: [{ plain_text: "first" }] },
          },
        ],
      },
    });
    const appended: any = await call(build(), "append_blocks", {
      block_id: "page-1",
      text: ["first", "second"],
      position: "after_block",
      after_block_id: "b3",
    });
    expect(calls[0]?.method).toBe("PATCH");
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

    const missingAnchor = await call(build(), "append_blocks", {
      block_id: "page-1",
      text: ["x"],
      position: "after_block",
    }).catch((thrown: any) => thrown);
    expect(missingAnchor.code).toBe("invalid_args");
    expect(missingAnchor.message).toContain("after_block_id");
  });

  it("updates properties without being able to trash a page", async () => {
    queue({ body: PAGE_FIXTURE });
    await call(build(), "update_page_properties", {
      page_id: "page-1",
      title: "Renamed",
      title_property: "Name",
    });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({
      properties: {
        Name: { title: [{ type: "text", text: { content: "Renamed" } }] },
      },
    });
    // in_trash is not in this tool's schema, so an update can never trash.
    expect(
      build().staticTools?.find(
        (tool) => tool.name === "update_page_properties",
      )?.inputSchema?.["properties"],
    ).not.toHaveProperty("in_trash");

    const empty = await call(build(), "update_page_properties", {
      page_id: "page-1",
    }).catch((thrown: any) => thrown);
    expect(empty.code).toBe("invalid_args");
  });

  it("trashes and restores through the same tool", async () => {
    queue({ body: { ...PAGE_FIXTURE, in_trash: true } });
    const trashed: any = await call(build(), "trash_page", {
      page_id: "page-1",
    });
    expect(calls[0]?.body).toEqual({ in_trash: true });
    expect(trashed.in_trash).toBe(true);

    calls.length = 0;
    queue({ body: PAGE_FIXTURE });
    await call(build(), "trash_page", { page_id: "page-1", restore: true });
    expect(calls[0]?.body).toEqual({ in_trash: false });
  });

  it("comments on a page or replies to a discussion, never both", async () => {
    queue({
      body: {
        id: "comment-1",
        discussion_id: "disc-1",
        created_time: "2026-02-02T00:00:00.000Z",
        created_by: { object: "user", id: "user-1" },
        rich_text: [{ plain_text: "looks good" }],
      },
    });
    const comment: any = await call(build(), "add_comment", {
      page_id: "page-1",
      text: "looks good",
    });
    expect(calls[0]?.body).toEqual({
      rich_text: [{ type: "text", text: { content: "looks good" } }],
      parent: { type: "page_id", page_id: "page-1" },
    });
    expect(comment).toEqual({
      id: "comment-1",
      discussion_id: "disc-1",
      created_time: "2026-02-02T00:00:00.000Z",
      created_by: { id: "user-1" },
      text: "looks good",
    });

    calls.length = 0;
    queue({ body: { id: "comment-2", rich_text: [] } });
    await call(build(), "add_comment", {
      discussion_id: "disc-1",
      text: "reply",
    });
    expect(calls[0]?.body?.discussion_id).toBe("disc-1");

    const ambiguous = await call(build(), "add_comment", {
      page_id: "page-1",
      discussion_id: "disc-1",
      text: "x",
    }).catch((thrown: any) => thrown);
    expect(ambiguous.code).toBe("invalid_args");
  });
});
