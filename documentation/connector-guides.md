# Connector guides

Descriptions and schemas say *what* a connector's tools are. They do not say
which tool to prefer, which id format an address quirk expects, how the service
paginates, or how hard you may hammer it. A connector's optional `usageGuide`
is where that goes — deployment-owned configuration, served by the `skills`
meta-tool as `connector:<id>` and returned verbatim, with a bounded `summary`
surfaced in discovery so an agent learns the guide exists at the moment it
matters. See [meta-tools](./meta-tools.md#connector-guide-selection) for the
discovery contract and [connectors](./connectors.md#catalog-contract) for how a
guide is configured.

## The shape of a guide

`usageGuide` accepts a bare markdown string, which is still the shortest
correct configuration, or the structured form:

```ts
const notion = remoteMcp("notion", {
  url: "https://mcp.notion.com/mcp",
  description: "Notion — pages, databases, comments",
  auth: { type: "oauth" },
  usageGuide: {
    content: `# Notion usage

Search before listing: \`notion.search\` covers pages and databases in one call.

- Page ids are dashed UUIDs. Strip the trailing slug from a pasted URL first.
- Paginate with \`start_cursor\`; \`page_size\` is capped at 100.
- Writes replace blocks wholesale — read the block, merge, then write.
`,
    summary: "Search before listing; dashed-UUID page ids; cursor pagination",
  },
});
```

The field is on the `Connector` interface, not on a factory, so it works
identically for `api()`, `remoteMcp()`, a prebuilt connection, and a
hand-written connector. It is deployment-owned configuration like everything
else here: an edit and a redeploy, never a runtime registration.

`content` is returned byte for byte by `skills({ name: "connector:<id>" })`.
`summary` is normalized and must fit 120 characters. A longer configured value
refuses construction instead of silently changing the operator's words. Omit
it and connecta derives the same bounded summary the skills listing uses: the
first meaningful body paragraph, joined across Markdown's physical line wraps,
with frontmatter, fences, rules, comments, and tables skipped. When the
paragraph does not fit, connecta keeps a useful complete sentence when one
fits, then prefers a clause or word boundary before adding an ellipsis. A heading is used
only when the guide has no body, and the connector's description is the last
resort. A derived summary is usually worse than a written one — it was written
to open a document, not to answer "is this guide relevant to what I am about
to do".

`connector:<id>` is the only address for a guide, and built-in skill names are
bare identifiers, so a guide can never shadow or be shadowed by `usage`: a
connector whose id is literally `usage` is listed as `connector:usage`, and
`skills({ name: "usage" })` still returns the built-in guide. Every miss —
unknown name, unknown connector, connector with no guide — is an explicit
error. Nothing silently falls back to the generic guide, because a generic
answer to a specific question is worse than no answer.

Discovery text is conditional on the deployment actually having a guide. Short
pointers in the `skills`, `search_tools`, `call_destructive_tool`, and
`execute_code` descriptions appear only when at least one visible connector
declares one. The detailed selection rules live only in the built-in `usage`
skill. That skill stays byte-identical across deployments, including its
per-connector-guides section, so an agent reads it at most once per task.

## What belongs in a guide

The test is not "is this true" but "can a schema carry it". If a schema can,
fix the schema instead — a constraint in the schema is enforced, is visible at
the moment of the call, and costs nothing to a caller who never fetches the
guide.

So a guide carries:

- **Tool preference.** Which of two plausible tools is the right one, and the
  fact that decides it.
- **Sequence.** What must happen first — resolving a name to an id, listing a
  parent before a child.
- **Identity and address quirks.** The id format an address expects, the
  difference between the id in the URL and the id the API wants.
- **Pagination conventions.** The cursor field, the page cap, whether the
  connector has more than one convention.
- **Units and aliases.** What a bare number means; what the service calls the
  thing the caller calls something else.
- **Reduction advice.** Which fields matter, for a downstream whose results are
  large and whose schemas you do not control.
- **Rate-limit etiquette**, with the number.

And a guide does not carry: anything readable off the schema, background on
what the service is, marketing, a tool list, or a second copy of the tool
descriptions. It is fetched into a live context window — every line that
repeats the schema is a line that displaced one that did not.

**Style.** Write for the agent, not the operator; the built-in `usage` skill
(`src/skills.ts`) is the model. Concise and imperative, leading with the
decision rather than the background ("Search before listing", not "Notion has a
search API"). Prefer short bullets to prose. Name exact tool addresses and
argument names. State a constraint with its number.

## The `required` rule

`required: true` on the structured form means: fetch this guide before every
operation on this connector. It surfaces as `guideRequired: true` with
`guideRequiredReasons: ["connector_required"]` on discovery results.

It is an instruction, not a gate. Nothing refuses the call — connecta tells the
agent to read the guide first and then believes it, because a server-side
refusal here would be a policy engine, which
[`ethos.md`](../ethos.md) refuses.

Reserve it for connectors whose correct arguments or sequence *cannot* be
expressed by the downstream tool schema at all: generic API wrappers whose one
broad tool name carries no endpoint vocabulary, and cross-operation conventions
no single schema can state. Two categories already produce the flag on their
own and must not be hand-declared for it — an unannotated or write-capable tool
(`approval_required`) and a compact schema that was capped
(`schema_truncated`). `connector_required` and `approval_required` survive
exact schema expansion; `schema_truncated` clears once describe returns the
exact shape.

The failure mode of over-declaring is quiet and expensive: an agent that must
fetch a guide before every call pays that fetch on the calls where the schema
was already complete and unambiguous. `required` earns its cost on connectors
where the alternative is a wrong call, not on connectors where it is a slightly
slower right one.

## Provider conventions

The maintained prebuilt connections come in two shapes, and each has its own
convention set — including the shape of its usage guide, which is one of the
few things both shapes fully own:

- [Hand-written HTTP providers](./provider-conventions.md#hand-written-http-providers)
  (H1–H14) — `api()` surfaces where Connecta owns every name, schema,
  projection, and error. Cloudflare and Notion.
- [Hosted-MCP proxies](./provider-conventions.md#hosted-mcp-proxies) (P1–P13) —
  `remoteMcp()` wrappers where the downstream owns the catalog and Connecta
  owns the endpoint, credential, classification, guide, and budget. Linear,
  Stripe, and Mixpanel.

Both sets are judged by one measure: what the convention saves the model that
interacts with connecta, priced in discovery tokens, wrong-tool selection,
argument retries, or result size. The same document defines
[what a provider audit checks](./provider-conventions.md#what-the-audit-checks),
so [#342](https://github.com/zackbart/connecta/issues/342) can run against it
convention by convention rather than by taste.

Two of those conventions decide how a guide is written, and they differ by
shape. A hand-written provider's guide carries only what a schema cannot,
because it owns the schemas and should fix them instead
([H13](./provider-conventions.md#h13--the-guide-carries-only-what-a-schema-cannot)).
A proxy's guide carries the reduction and identity-resolution advice its
schemas will never carry, because it cannot change them
([P7](./provider-conventions.md#p7--the-guide-carries-the-reduction-advice-the-schemas-cannot),
[P8](./provider-conventions.md#p8--identity-resolution-comes-before-action)).

## Tests that enforce this

`test/meta-tools.test.ts` owns the guide behavior end to end: the skills
listing carrying one entry per guided connector, summaries joining a
hard-wrapped opening paragraph and shortening at readable boundaries,
configured summaries refusing construction past the bound, heading and
description fallbacks, markup skipping, whitespace-only guides treated as no
guide, content returned verbatim including surrounding padding, identical
content in two deployments staying isolated, every miss erroring rather than
falling back to the generic guide with an identically labelled skills list on
each branch, the `guide` pointer in search output, and `guideRequired`
appearing for connector-required conventions, approval-bound tools, and
truncated schemas — and being absent from a search that asked for no schemas.
`test/server.test.ts` owns the conditional half: it compares a guide-free
deployment's four short pointers against a guided one's, and asserts the
complete `usage` skill is byte-identical between them.
