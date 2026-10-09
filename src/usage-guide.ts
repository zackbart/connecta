/** Self-contained content for the usage skill; independent of skill registration. */
export const USAGE_SKILL = `---
name: usage
description: How to route work between one execute_code program and Connecta's explicit call, authorization, and result tools.
---

# Connecta usage

## Choose the route

| Work | Tool |
| --- | --- |
| One known-address read | call_tool |
| One known-address write | call_destructive_tool |
| Discovery, multiple or dependent calls, paging, reduction | execute_code |

Read one account with call_tool: \`{ "address": "crm.get_account", "args": { "id": "acct_42" } }\`.
Discover and call together when schemas suffice. search_tools covers catalog
inspection and write discovery in read-only pools. Programs may
write only in trusted pools; the tool description states this endpoint's trust.
Unannotated tools fail closed to writes.

## The global and the envelopes

Pass JavaScript \`async () => { ... }\`, no arguments. Do not shadow \`connecta\`.
No imports, require, filesystem, fetch, or timers.

Use \`connecta.call(address, args, { timeoutMs })\` or
\`connecta.call({ address, args, timeoutMs })\`; both return \`{ data, format }\`.
\`format: "json"\` carries JSON; \`format: "text"\` carries text. Parse text only
when documented as JSON. Verify collection roots.

\`connecta.read("resource://id/"+encodeURIComponent(uri))\` returns \`{ contents }\` for advertised URIs.

Search/describe return \`{ tools }\`, never an array. Search also returns
\`catalogErrors\`, pagination, and possible \`absence\`; check failures before
selecting a match. JSON schemas are the program default. Compact schemas have
\`schemaFormat: "text"\`; do not read their .properties. Select the exact tool and
account/environment, inspect its schema, and supply its required keys and types.

Discover an unfamiliar read and reduce its result:

\`\`\`js
async () => {
  const page = await connecta.search({ connector: "ci", query: "get_run" });
  if (page.catalogErrors.length || page.absence) return page;
  const tool = page.tools.find(t => t.name === "get_run");
  if (!tool) return { gap: "get_run unavailable" };
  const result = await connecta.call(tool.address, { runId: 42 });
  return result.format === "json"
    ? { status: result.data.status, jobId: result.data.failedJobId } : result;
}
\`\`\`

## Keep partial successes

Use Promise.allSettled to keep independent successes. Rejections retain \`code\`,
\`message\`, \`retryable\`, and \`details\`. Branch on fields, not prose. Repair
arguments before batching. Runs report hostCalls separately.

Read JSON and text after verifying addresses and schemas:

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
Split remaining reads. Never replay writes for their output.

## Per-connector guides

Fetch a listed guide with skills by its exact name, or \`connecta.skill(name)\`
inside a program; it returns \`{ name, text, format: "text" }\`.
\`guideRequired: true\` is a hard stop. connector_required and approval_required
remain after schema expansion; schema_truncated clears after exact describe.
Otherwise fetch for units, pagination, aliases, or sequences.

## Large results and recovery

A truncated direct result carries a resultId when paging is available. Follow
nextOffset in UTF-8 bytes, reassemble and reduce inside one program. Use the
returned id in place of result-id below; this example assumes documented JSON.

Calls reconstruct up to 1 MiB through stash pages. Larger values return
\`{ format: "paged", valueFormat, resultId?, totalBytes, hint }\`. Pass the handle
to \`connecta.result\`. No resultId means no paging. IDs expire after
15 minutes; only explicit paging spends extra host calls.
Use zero-based \`{ page: 0 }\` or UTF-8 \`{ offset }\`, never both. Keep maxBytes
fixed across pages; connector caps and the 32 KiB bridge ceiling apply.

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

Returns have no page handle. Reduce reads; check write results and targets. write_outcome_unknown forbids automatic retry, even if caught.
Recovery args may be partial (argsRedacted) or absent (argsOmitted). Reconcile
before retrying with the original args or repeating a program that sent writes.
Non-retryable errors need repair.
Follow typed auth recovery: host_auth_required needs host connection repair;
downstream_oauth_required or auth_required carries an authorize_connector
handoff; provider_permission_denied needs the resource owner to grant access.

## Output

Use \`connecta.emit(await connecta.call(address, args))\` for MCP rich output,
or \`for (const b of x.content ?? []) connecta.emit(b)\`. Both forward originals,
including resources and metadata; edits do not change them. Page oversized
native content with \`connecta.result(x.contentResult)\`.
Authored blocks accept text or base64 image/audio; images require canonical
base64 and PNG/JPEG/GIF/WebP MIME. Emit works without await, delivers on success,
and obeys byte/block budgets; text shares the return cap. Return reduced JSON.

`;

/** Kept in sync with GuestApi by the declaration test. These are type notation, not runnable JS. */
export const GUEST_API_DECLARATION = `search(args?: CatalogSearchArgs): Promise<CatalogSearchResult>;
describe(args?: CatalogDescribeArgs): Promise<{ tools: CatalogDescription[] }>;
call(address: string, args?: unknown, options?: { timeoutMs?: number }): Promise<GuestResult>;
call(request: { address: string; args?: unknown; timeoutMs?: number }): Promise<GuestResult>;
read(uri: string): Promise<GuestResourceResult>;
result(
  id: string | GuestResultHandle,
  options?: { page?: number; offset?: number; maxBytes?: number },
): Promise<GuestResultPage>;
skill(name: string): Promise<{ name: string; text: string; format: "text" }>;
emit(block: GuestNativeBlock | GuestResult): PromiseLike<void>;`;
