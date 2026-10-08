/** Self-contained content for the usage skill; independent of skill registration. */
export const USAGE_SKILL = `# Connecta usage

## Choose the route

| Work | Tool |
| --- | --- |
| One known-address read | call_tool |
| One known-address write | call_destructive_tool |
| Discovery, multiple or dependent calls, paging, reduction | execute_code |

For example, read account acct_42 with call_tool arguments
\`{ "address": "crm.get_account", "args": { "id": "acct_42" } }\`.
Discover and call in the same program when schemas suffice. Top-level search_tools
covers catalog inspection and write discovery in read-only pools. Programs may
write only in trusted pools; the tool description states this endpoint's trust.
Unannotated tools fail closed to writes.

## The global and the envelopes

Pass one plain JavaScript async arrow, \`async () => { ... }\`. It receives no
arguments. Use the supplied \`connecta\` global; do not shadow it with a parameter.
No imports, require, filesystem, fetch, or timers in portable programs.

\`connecta.call(address, args, { timeoutMs })\` is positional. The object overload
is \`connecta.call({ address, args, timeoutMs })\`. Both return \`{ data, format }\`.
For \`format: "json"\`, data is the JSON value. For \`format: "text"\`, data is a
string: parse only if the provider documents JSON text. Never guess collection roots.

Search and describe return \`{ tools }\`, never an array. Search also returns
\`catalogErrors\`, pagination, and possible \`absence\`; check failures before
selecting a match. JSON schemas are the program default. Compact schemas have
\`schemaFormat: "text"\`; do not read their .properties. Select the exact tool and
account/environment, inspect its schema, and supply its required keys and types.

Discover an unfamiliar run lookup, then reduce its JSON result:

\`\`\`js
async () => {
  const page = await connecta.search({ connector: "ci", query: "get_run", safety: "readOnly" });
  if (page.catalogErrors.length || page.absence) return { gap: page.catalogErrors, absence: page.absence };
  const tool = page.tools.find(t => t.name === "get_run");
  if (!tool) return { gap: "get_run unavailable" };
  const { tools } = await connecta.describe({ address: tool.address });
  if (tools[0].error) return { gap: tools[0].error };
  const result = await connecta.call(tool.address, { runId: 42 });
  if (result.format !== "json") return { gap: "Expected JSON" };
  return { status: result.data.status, jobId: result.data.failedJobId };
}
\`\`\`

## Keep partial successes

Await Promise.allSettled for independent calls when one failure must not discard
other answers. Each rejected reason keeps \`code\`, \`message\`, \`retryable\`, and
\`details\`. Branch on fields, never error prose. Repair one argument failure
before repeating it across records. Every run reports hostCalls counts separately.

After verifying these addresses and schemas, read JSON and plain text together:

\`\`\`js
async () => {
  const settled = await Promise.allSettled([
    connecta.call("ci.get_run", { runId: 42 }),
    connecta.call("ci.get_job_logs", { jobId: "job_7" }),
    connecta.call("ci.get_run", { runId: "wrong-type" })
  ]);
  return settled.map(s => s.status === "rejected"
    ? { error: s.reason.code, retryable: s.reason.retryable }
    : s.value.format === "text"
      ? { text: s.value.data.split("\\n").filter(line => line.startsWith("ERROR")) }
      : { status: s.value.data.status });
}
\`\`\`

Host-call budget exhaustion ends the run with budget_exceeded. Catch and
allSettled cannot recover it or return partial output. Bound batches before
starting them; search, describe, call, result, and skill spend host calls.
Split remaining reads into another run. Never replay writes for their output.

## Per-connector guides

Fetch a listed guide with skills by its exact name, or \`connecta.skill(name)\`
inside a program; it returns \`{ name, text, format: "text" }\`.
\`guideRequired: true\` is a hard stop. connector_required and approval_required
remain after schema expansion; schema_truncated clears after exact describe.
Otherwise fetch for relevant units, pagination, aliases, or sequences.

## Large results and recovery

A truncated direct result carries a resultId when paging is available. Follow
nextOffset in UTF-8 bytes, reassemble and reduce inside one program. Use the
returned id in place of result-id below; this example assumes documented JSON.

\`\`\`js
async () => {
  let text = "", offset = 0, page;
  do {
    page = await connecta.result("result-id", { offset, maxBytes: 8000 });
    text += page.text;
    offset = page.nextOffset;
  } while (page.hasMore);
  return JSON.parse(text).items.map(item => item.id);
}
\`\`\`

Program returns have no page handle. Reduce reads before returning. After a
write, use its existing result, check the target, or report the gap.
write_outcome_unknown means a write was sent without a known answer: check the
target, never resend automatically. Non-retryable errors require repair.
Follow typed auth recovery: host_auth_required needs host connection repair;
downstream_oauth_required or auth_required carries an authorize_connector
handoff; provider_permission_denied needs the resource owner to grant access.

## Output

Return reduced JSON. console.log is captured. connecta.emit accepts text, image,
or audio blocks, works without await, and delivers only after success. Images
need canonical base64 and image/png, image/jpeg, image/gif, or image/webp.
Text shares the result cap; the description states block and byte budgets.
`;

/** Kept in sync with GuestApi by the declaration test. These are type notation, not runnable JS. */
export const GUEST_API_DECLARATION = `search(args?: CatalogSearchArgs): Promise<CatalogSearchResult>;
describe(args?: CatalogDescribeArgs): Promise<{ tools: CatalogDescription[] }>;
call(address: string, args?: unknown, options?: { timeoutMs?: number }): Promise<GuestResult>;
call(request: { address: string; args?: unknown; timeoutMs?: number }): Promise<GuestResult>;
result(id: string, options?: { offset?: number; maxBytes?: number }): Promise<GuestResultPage>;
skill(name: string): Promise<{ name: string; text: string; format: "text" }>;
emit(block: GuestBlock): PromiseLike<void>;`;
