# Operating an endpoint

Use this guide as an agent connected to an existing Connecta endpoint. Setup
and credentials are the deployment operator's responsibility; use
[Deploying Connecta](./deploying.md) if you are that operator.
[All agent routes](./README.md) are in the index.

## Choose the call path

Connecta exposes six top-level tools. Read [the tool table](./meta-tools.md#the-six-tools)
for exact arguments and result envelopes. Follow the endpoint's supplied
instructions and `skills` usage guide for deployment-specific context.

| Work                                                               | Use                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| One known read, with usable arguments and a small result           | `call_tool`                                               |
| Discover a tool, chain calls, combine services, or reduce a result | `execute_code`                                            |
| One known write on a writable endpoint                             | `call_destructive_tool`                                   |
| Obtain connector instructions                                      | `skills` with the returned guide name                     |
| Start a required authentication handoff                            | `authorize_connector`, using the returned recovery action |

Whether the endpoint is read-only or writable is part of its tool
descriptions. On a writable endpoint, programs and `call_destructive_tool` may
write within the caller's grants, and `execute_code` is annotated as a write;
the client controls approval. On a read-only endpoint, search and describe omit
write tools and every write call is refused with `read_only_endpoint`, even one
a connector guide names; tell the user rather than looking for another route. A connector marked Read-only serves only read-classified tools even on a writable endpoint; writes and unclassified tools are omitted from search/describe and refused on every call path. Endpoint and connector restrictions compose by OR. Never change pool, identity, or `readOnly` to work
around a refusal.
[Routing between the call surfaces](./meta-tools.md#routing-between-the-call-surfaces)
owns the full decision rules.

## Discover before guessing

Use two to four distinctive action/object terms for each operation, and name
the connector when it is obvious. Read `catalogErrors`, `absence`, classification,
and required inputs before selecting a result. An empty search may mean a
failed catalog or a service outside the caller's grants.

For normal reads, keep discovery, calls, and reduction in one program when the
schemas suffice; return the answer rather than catalog matches. Use top-level
`search_tools` for catalog inspection or to find one known write on a writable
endpoint, then dispatch it with `call_destructive_tool`. An unfamiliar read
result may return a bounded sample for inspection before the next program.

Use the exact returned `address`, including punctuation. A TypeScript signature
is guidance for writing JavaScript; do not paste types into executable code.
If a schema is truncated or exact constraints matter, describe the address with
`format: "json"`. Read a returned `guide` through `skills` or
`connecta.skill` before relying on provider-specific conventions.
[Discovery context](./meta-tools.md#discovery-context) and
[guest search](./code-mode.md#connectasearch) define these results.

## Call, combine, and reduce

A program is one JavaScript `async` arrow expression. It has the `connecta`
guest API and captured console output, with no portable imports, filesystem,
network access, or credentials. Downstream calls return an envelope; read its
`data` rather than treating the envelope as the provider's result.

This illustrative tracker has a `list_issues` read accepting `state` and
returning `data.nodes`. Discover its address, call it, and group the identifiers
in one program:

```js
async () => {
  const page = await connecta.search({
    connector: "tracker",
    query: "list issues",
    safety: "readOnly",
  });
  if (page.catalogErrors.length || page.absence) {
    return { gap: page.catalogErrors, absence: page.absence };
  }
  const tool = page.tools.find(t => t.name === "list_issues");
  if (!tool) return { gap: "list_issues unavailable" };
  const { data, format } = await connecta.call(tool.address, {
    state: "started",
  });
  if (format !== "json" || !Array.isArray(data?.nodes)) {
    return { gap: "Expected a JSON issues collection" };
  }
  const byOwner = Object.create(null);
  for (const issue of data.nodes) {
    const owner = issue.assignee?.name ?? "unassigned";
    (byOwner[owner] ??= []).push(issue.identifier);
  }
  return byOwner;
}
```

`tracker.list_issues` is illustrative, not a built-in address. Discover the real
connector's schemas and pagination before adapting this program. Keep loops and
parallel work bounded. [Parallel calls](./code-mode.md#parallel-calls),
[results and projection](./code-mode.md#results-and-projection), and
[cancellation and limits](./code-mode.md#cancellation-and-limits) own those rules.

Discovery may label an output schema `observed`. It records field names and
broad types from successful reads in bounded runtime memory, with no scalar
values. Treat it as evidence, not a provider contract; handle missing fields.

## Large results and resources

Direct calls may return a preview and a result handle. Page the handle through
`connecta.result` in a program using the returned offset and byte limits, or
reduce the data in the original program. Handles are short-lived and bound to
the admitted caller, endpoint/pool, and current grants. Never invent one or pass
it between identities. [Paging](./meta-tools.md#paging-with-connectaresult)
owns the envelope and expiry rules.

For resources, use the exposed resource inventory and `connecta.read`; do not
fetch an arbitrary URL. [Resource reads](./code-mode.md#connectaread) describe
which URIs may be read. Connector guides and native skills are described in
[skills](./meta-tools.md#connector-guides-and-skills).

## Recover without replaying a write

Read typed failures and their `nextAction`. Authorization recovery can point
to consent, operator credential setup, or deployment configuration. Discovery
and status do not begin consent on their own. Follow
[authorization recovery](./meta-tools.md#authorization-recovery),
[routing recovery](./meta-tools.md#routing-recovery), and
[argument recovery](./meta-tools.md#argument-recovery) for the specific failure.

A dispatched write is never automatically replayed. An ambiguous timeout may
mean the provider applied it; inspect state to check whether it took effect, or
ask for the missing decision, before any fresh call. [Retry semantics](./code-mode.md#retry-semantics) and
[writes](./code-mode.md#writes) describe program outcomes and write accounting.

## Contributor reference

### Implementation and evidence

The endpoint's built-in [usage skill](https://github.com/zackbart/connecta/blob/main/src/skills.ts)
is maintained alongside [meta-tools](https://github.com/zackbart/connecta/blob/main/src/meta-tools.ts)
and [execution](https://github.com/zackbart/connecta/blob/main/src/execute.ts).
[Usage-guide tests](https://github.com/zackbart/connecta/blob/main/test/usage-guide.test.ts),
[direct-call tests](https://github.com/zackbart/connecta/blob/main/test/meta-tools-call.test.ts),
and [guest-contract tests](https://github.com/zackbart/connecta/blob/main/test/guest-api-contract.test.ts)
check the contracts. Executor-specific evidence is indexed in
[code-mode verification](./code-mode.md#verification).
