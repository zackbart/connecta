# Operating an endpoint

Use this guide as an agent connected to an existing Connecta endpoint. Setup
and credentials are the deployment operator's responsibility; use
[Deploying Connecta](./deploying.md) if you are that operator.
[All agent routes](./README.md) are in the index.

## Choose the call path

A [native pool](./meta-tools.md#native-tool-surface) lists individual operations.
Use your host's tool search, call a known operation directly, and follow its
repair or authorization handoff. Use `execute_code` for combined work when
listed; without code, page results through the listed `read_result` tool.

Meta endpoints expose six top-level tools. Read [the tool table](./meta-tools.md#the-six-tools)
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

MCP request bodies default to a 4 MiB limit on every endpoint. Deployment code
can set `admission.requests.maxBodyBytes`; `describeConfig()` reports its value
and source. An oversized body returns 413 before tool dispatch. See
[request admission and body limits](./architecture.md#admission-in-two-places)
for Node's separate pre-auth buffer and the listen-classification bound. A `503`
from Node before auth means all in-flight bodies together passed
[`maxInFlightBodyBytes`](./deploying.md#start-on-node).

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

## Read failure records

Failure logs and connector status report checked facts without downstream
error text. A failure record can include `httpStatus`, an integer from 100
through 599; status messages can include `with HTTP <status>`. Recorded status
is retained when a write's 401 had no mapped authorization verdict, when a Google write reports
an unknown outcome, and when a response exceeds the connector's byte ceiling.
If no answer was recorded, the field is absent. The status alone does not
prove whether a write took effect or permit replaying it.

For example, a `crm` write answered HTTP 503 can log `httpStatus: 503` while
its outcome stays unknown. Inspect the target before repeating the call.

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

## Sample payload-free timing on Workers

Set `timingTraceSampleRate` in deployment code passed to `createConnecta`:

```ts
const app = createConnecta({
  // ...the deployment's connectors, storage, auth and executor
  timingTraceSampleRate: 0.1, // sample 10% of MCP requests; default 0 (off)
});
```

The rate must be a finite number from 0 through 1. Set 1 for a short diagnostic
window, then return it to 0. Sampling is independent of the caller's
`diagnostics` argument. Enable Workers observability logs in the deployment's
Wrangler configuration (`observability.logs.enabled: true`). Its own sampling
may reduce captured records further. The configured logger receives
`connecta.timing` and one structured object when the MCP response body closes;
`logger: "silent"` suppresses these records too. Consume or close streaming
responses to finish their trace. An isolate-first-request flag means the first
MCP request that reaches tracing in that isolate, including unsampled requests;
it does not measure module boot.

Each version-1 record contains elapsed request time, the first-request flag,
weak-reference availability and aggregate operation families. Each family has
`count`, `durationMs`, `bytes`, `statements`, `items` and `absent` totals.
`catalog.accepted` counts complete accepted catalogs, serialized bytes and tools. Invocation
`catalog`, `admission`, `connector` and `result` durations reuse the existing
`diagnostics` segments. `catalog.cache.lookup` counts cache probes; `catalog.cache.hit` counts accepted
unexpired entries. Lookups without hits can include misses, expiry, invalid
entries or interrupted reads; they are not proof of live relisting.
`catalog.validated.hit`/`miss` report immutable validation reuse.
`catalog.decode` counts JSON decodes and their UTF-8 input bytes;
`catalog.validate` and `catalog.intake` count those stages without timing them.
These three count-only families always have `durationMs: 0`.
`catalog.chunks` records accepted chunk bytes and counts. These counters do not
identify a connector, owner or private/public partition.
Concurrent spans can overlap; do not sum them as wall time.
`memo.hit`, `memo.miss` and `memo.fresh` describe the request-read memo
(`absent` counts null values, not cache failures). `d1.read`, `d1.write` and
`d1.batch` count physical native D1 trips and SQL statements, including
failed attempts. Batch count is one trip; statements is the batch length.
All native D1 work carrying the request context shares these totals, including
admission, credential and catalog work. Comparing them with `catalog` duration
(the diagnostics `catalogMs` segment) does not isolate catalog storage.
Returned D1 bytes measure serialized application results, not Cloudflare's wire
encoding. Memo bytes measure UTF-8 stored values. Result bytes use the existing
invocation measurement. No keys, tool names, owner identity, arguments, results,
credentials or error text enter the record. Records retain totals only.

On production Workers, `performance.now()` advances only across I/O. Durations
are I/O-spanning elapsed observations, not CPU attribution: zero is ambiguous,
and CPU work can appear in a later I/O interval. D1 durations are therefore not
pure storage latency. Use counts, sizes, cache outcomes and the isolate-first-request
flag to compare warm direct and one-call program requests with the same catalog.
For per-invocation CPU, use Workers' invocation telemetry field
[`$workers.cpuTimeMs`](https://developers.cloudflare.com/workers/observability/query-builder/).
Deeper attribution requires [CPU profiling](https://developers.cloudflare.com/workers/runtime-apis/performance/).

Only work carrying the MCP request's native context contributes D1 counters;
standalone operator/background or custom Promise adapter work is outside that
request trace. Sampling does not add reads, change TTLs, bypass generation or
credential fences, or start authorization.

For example, query a ten-minute window for a neutral Worker `assistant` (replace
the millisecond timestamps with the window you need):

```sh
cf --profile assistant o11y telemetry query \
  --query-id 00000000-0000-4000-8000-000000000001 \
  --view events --limit 100 \
  --timeframe-from 1793700000000 --timeframe-to 1793700600000 \
  --parameters-order-by-value count --parameters-order-by-order desc \
  --parameters-calculations '[{"operator":"count","alias":"count"}]' \
  --parameters-filters '[{"key":"$workers.scriptName","operation":"eq","type":"string","value":"assistant"}]'
```

Select `connecta.timing` messages in the returned events and inspect their
structured operation totals. Use the profile belonging to your deployment.
The example reads telemetry only; it changes no Worker settings.

The example passes CLI dry-run validation; server acceptance has not been verified.
Use `--dry-run` to validate the request locally without querying telemetry.
