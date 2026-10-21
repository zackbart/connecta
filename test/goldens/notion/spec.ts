import { notion } from "../../../src/providers/notion/index.js";
import { defineGoldenSpec } from "../harness.js";

/** A page carrying several of the property shapes the projection flattens. */
const PAGE = {
  object: "page",
  id: "page-1",
  url: "https://app.notion.com/p/page-1",
  created_time: "2026-01-01T00:00:00.000Z",
  last_edited_time: "2026-02-02T00:00:00.000Z",
  created_by: { object: "user", id: "user-1", name: "Alice" },
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
    Notes: { id: "abc", type: "rich_text", rich_text: [{ plain_text: "ship it" }] },
    Estimate: { id: "num", type: "number", number: 42 },
    Done: { id: "chk", type: "checkbox", checkbox: true },
    Status: { id: "sta", type: "status", status: { name: "In progress" } },
    Tags: { id: "ms", type: "multi_select", multi_select: [{ name: "infra" }, { name: "urgent" }] },
    Due: { id: "dt", type: "date", date: { start: "2026-03-01", end: null, time_zone: null } },
    Owner: { id: "ppl", type: "people", people: [{ object: "user", id: "user-9", name: "Bob" }] },
    Blocked: { id: "rel", type: "relation", relation: [{ id: "page-2" }, { id: "page-3" }], has_more: true },
    Ticket: { id: "uid", type: "unique_id", unique_id: { number: 12, prefix: "RL" } },
  },
};

const DATA_SOURCE = {
  object: "data_source",
  id: "ds-1",
  title: [{ plain_text: "Roadmap" }],
  parent: { type: "database_id", database_id: "db-1" },
  last_edited_time: "2026-02-02T00:00:00.000Z",
  properties: {
    Name: { id: "title", type: "title", title: {} },
    Status: {
      id: "sta",
      type: "status",
      status: { options: [{ name: "Todo" }, { name: "Done" }], groups: [{ name: "To-do" }] },
    },
    Project: { id: "rel", type: "relation", relation: { database_id: "db-2", data_source_id: "ds-2" } },
  },
};

const BLOCKS = {
  object: "list",
  results: [
    { id: "b1", type: "heading_2", has_children: false, heading_2: { rich_text: [{ plain_text: "Goals" }] } },
    { id: "b2", type: "to_do", has_children: true, to_do: { rich_text: [{ plain_text: "Ship it" }], checked: true } },
    {
      id: "b3",
      type: "code",
      has_children: false,
      code: { rich_text: [{ plain_text: "const x = 1" }], language: "typescript" },
    },
  ],
  has_more: false,
  next_cursor: null,
};

const NESTED = {
  object: "list",
  results: [{ id: "b2a", type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: "sub" }] } }],
  has_more: false,
  next_cursor: null,
};

export default defineGoldenSpec({
  provider: "notion",
  create: () => notion("workspace", { auth: { type: "token" }, purpose: "Team knowledge base" }),
  credential: "golden-notion-token/123+456=",
  // 409 carries the code Notion documents for it, conflict_error (#902).
  failureReply: (status, message) => ({
    status,
    body: { object: "error", status, code: status === 409 ? "conflict_error" : `golden_${status}`, message },
  }),
  calls: [
    { tool: "notion_api_search", args: { query: "query data source", limit: 3 } },
    { tool: "notion_api_details", args: { method: "PATCH", path: "/v1/pages/page-1" } },
    {
      tool: "notion_api_read",
      args: { path: "/v1/users", query: { page_size: 1 } },
      replies: [
        {
          body: {
            object: "list",
            results: [{ object: "user", id: "user-1", name: "Alice", type: "person" }],
            has_more: true,
            next_cursor: "c-get",
          },
        },
      ],
    },
    {
      label: "notion_api_read POST query",
      tool: "notion_api_read",
      args: {
        method: "POST",
        path: "/v1/search",
        body: { query: "roadmap", start_cursor: "c-prev" },
        select: ["results.id"],
      },
      replies: [
        {
          body: {
            object: "list",
            results: [{ object: "page", id: "page-1", url: "https://app.notion.com/p/page-1" }],
            has_more: true,
            next_cursor: "c-post",
          },
        },
      ],
    },
    {
      tool: "notion_api_write",
      args: { method: "PATCH", path: "/v1/pages/page-1", body: { in_trash: true } },
      replies: [{ body: { ...PAGE, in_trash: true } }],
    },
    {
      tool: "integration_search",
      args: { query: "review", object_type: "page", sort: "last_edited_desc" },
      replies: [{ body: { object: "list", results: [PAGE, DATA_SOURCE], has_more: true, next_cursor: "cursor-2" } }],
    },
    { tool: "integration_get_page", args: { page_id: "page-1" }, replies: [{ body: PAGE }] },
    { tool: "integration_get_page_content", args: { block_id: "page-1" }, replies: [{ body: BLOCKS }] },
    {
      label: "integration_get_page_content nested",
      tool: "integration_get_page_content",
      args: { block_id: "page-1", depth: 1 },
      replies: [{ body: BLOCKS }, { body: NESTED }],
    },
    {
      tool: "integration_get_data_source_schema",
      args: { data_source_id: "ds-1" },
      replies: [{ body: DATA_SOURCE }],
    },
    {
      tool: "integration_query_data_source",
      args: {
        data_source_id: "ds-1",
        filter: { property: "Status", status: { equals: "In progress" } },
        sorts: [{ property: "Due", direction: "ascending" }],
        properties: ["Name", "Status"],
      },
      replies: [{ body: { object: "list", results: [PAGE], has_more: true, next_cursor: "cursor-rows" } }],
    },
    {
      tool: "integration_create_page",
      args: {
        parent_data_source_id: "ds-1",
        title: "New row",
        title_property: "Name",
        properties: { Status: { status: { name: "Todo" } } },
        markdown: "# Body",
        icon: "🚀",
      },
      replies: [{ body: { ...PAGE, id: "page-new", url: "https://app.notion.com/p/page-new" } }],
    },
    {
      tool: "integration_append_blocks",
      args: {
        block_id: "page-1",
        checklist: ["Book venue", "Send invites"],
        position: "after_block",
        after_block_id: "b3",
      },
      replies: [
        {
          body: {
            object: "list",
            results: [
              {
                id: "todo-1",
                type: "to_do",
                has_children: false,
                to_do: { rich_text: [{ plain_text: "Book venue" }], checked: false },
              },
              {
                id: "todo-2",
                type: "to_do",
                has_children: false,
                to_do: { rich_text: [{ plain_text: "Send invites" }], checked: false },
              },
            ],
          },
        },
      ],
    },
  ],
  echo: {
    tool: "notion_api_read",
    args: { path: "/v1/users/user-1" },
    replies: (text) => [{ body: { object: "user", id: "user-1", name: text, type: "person" } }],
  },
  failures: {
    read: { tool: "integration_get_page", args: { page_id: "page-1" } },
    write: {
      tool: "integration_create_page",
      args: { parent_page_id: "page-1", title: "Meeting notes", markdown: "Agenda" },
    },
  },
});
