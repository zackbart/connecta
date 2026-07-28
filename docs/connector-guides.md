# Per-connector usage guides

Descriptions and schemas say *what* a connector's tools are. They don't say
which tool to prefer, which id format an address quirk expects, how the service
paginates, or how hard you may hammer it. Operators know those things; without
somewhere to put them, every agent session rediscovers them.

A connector may therefore carry an optional **`usageGuide`** — a markdown
string, authored in config alongside the connector, like everything else:

```ts
export const notion = remoteMcp("notion", {
  url: "https://mcp.notion.com/mcp",
  description: "Notion — pages, databases, comments",
  auth: { type: "oauth" },
  usageGuide: `# Notion usage

Search before listing: \`notion.search\` covers pages and databases in one call.

- Page ids are dashed UUIDs. Strip the trailing slug from a pasted URL first.
- Paginate with \`start_cursor\`; \`page_size\` is capped at 100.
- Writes replace blocks wholesale — read the block, merge, then write.
`,
});
```

It works the same on `api()` and on a hand-written `Connector`; the field is on
the interface, not on the factories.

The guide is served by the [`skills`](./meta-tools.md#skills) meta-tool:

- `skills({})` lists the built-in `usage` guide plus one entry per connector
  that has a guide, named **`connector:<connectorId>`** and summarized by the
  guide's first meaningful line (heading marks and bullets stripped, capped at
  120 characters). A connector without a guide adds no entry, so listing stays
  cheap with many connectors.
- `skills({ name: "connector:notion" })` returns the markdown **verbatim**.
- The `connector:` prefix is the *only* address for a guide. Built-in skill
  names are bare identifiers, so a guide can never shadow or be shadowed by
  `usage` — a connector whose id is literally `usage` is listed as
  `connector:usage`, and `skills({ name: "usage" })` still returns the built-in
  guide.
- Every miss is an error result: an unknown skill name, an unknown connector,
  or a connector that has no guide. Nothing silently falls back to the generic
  guide.

`search_tools` and `describe_tools` set a `guide` field on matches whose
connector has one, holding the skill name to fetch — so an agent that never
called `skills({})` still discovers the guide at the moment it matters.

Discovery text is **conditional on the deployment actually having a guide**.
The built-in `usage` skill gains a short "Per-connector guides" section, and
the `skills`, `search_tools`, and `describe_tools` tool descriptions each gain
one sentence, only when at least one connector declares a `usageGuide`. The
connector set is fixed at construction, so this is stable per deployment — and
a deployment with no guides serves every one of those strings exactly as it
always has, paying no always-loaded context for a feature it does not use.

Guides follow the connection's scope. In a toolkit-scoped session
([toolkits](./toolkits.md#toolkits-scoped-views)) `skills({})` lists only
in-scope connectors' guides,
`skills({ name: "connector:<id>" })` for an out-of-scope connector returns the
same error as an unknown connector, and the conditional discovery text above is
computed from the **scoped** connector set — so a scoped session never learns
from a tool description that guides exist outside its view.

**Style.** Write for the agent, not the operator — the built-in `usage` skill
(`src/skills.ts`) is the model. Concise and imperative; lead with the decision
("Search before listing"), not with background. Prefer short bullets over
prose, name exact tool addresses and argument names, and state the constraint
with its number (`page_size` is capped at 100). Cover what descriptions and
schemas cannot: tool preference, id/address quirks, pagination conventions,
rate-limit etiquette, query patterns that work. Skip anything the agent can
read off the schema, and keep it short — it is fetched into a live context
window.

Return to the [connector reference](./connectors.md#connectors).
