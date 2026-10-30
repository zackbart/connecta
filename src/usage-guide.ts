import { UNCOUNTED_GUEST_FUNCTIONS } from "./guest-functions.js";

/** Self-contained content for the usage skill; independent of skill registration. */
export const USAGE_SKILL = `---
name: usage
description: How to route work between one execute_code program and Connecta's explicit call, authorization, and result tools.
---

# Connecta usage

## Choose the route

Route as the server instructions and execute_code's first sentence say.
Read one account with call_tool: \`{ "address": "crm.get_account", "args": { "id": "acct_42" } }\`.
On a read-only endpoint search omits writes (guides may name them) and each
fails read_only_endpoint; tell the user. Unannotated tools fail closed to writes.
Connecta classifies and routes a requested write; the host owns approval.

## The global and the envelopes

Pass JavaScript \`async () => { ... }\`, no arguments. Do not shadow \`connecta\`.
No imports, require, filesystem, fetch, or timers.

\`connecta.call(address, args, { timeoutMs })\` and
\`connecta.call({ address, args, timeoutMs })\` return \`{ data, format }\`.
Parse \`format: "text"\` only when documented as JSON. Verify collection roots.

\`connecta.read("resource://id/"+encodeURIComponent(uri))\` returns \`{ contents }\` for advertised URIs.

Search/describe return \`{ tools }\`, never an array. Check search's
\`catalogErrors\` and \`absence\` before selecting a match. Search defaults to a
TypeScript \`signature\`; text schemas have \`schemaFormat: "text"\` and no .properties.
A \`readyCalls\` entry is a complete read: \`connecta.call(entry.address, entry.args)\`. Select the exact tool and
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
starting them; every guest call except ${UNCOUNTED_GUEST_FUNCTIONS} spends host calls.
Split remaining reads. Never replay writes for their output.

## Per-connector guides

Fetch a listed guide by its exact name with the skills tool, or
\`connecta.skill(name)\` inside a program; it returns \`{ name, text, format: "text" }\`.
\`guideRequired: true\` is a hard stop. connector_required and approval_required
remain after schema expansion; schema_truncated clears after exact describe.
Otherwise fetch for units, pagination, aliases, or sequences.

## Large results and recovery

Large direct results and program returns carry resultId when paging is available. Follow
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

Oversized returns lead with nextAction. Never rerun writes for output. write_outcome_unknown or writeOutcome forbids retry, even if caught.
Recovery args may be partial (argsRedacted) or absent (argsOmitted). Reconcile
before retrying with the original args or repeating a program that sent writes.
Non-retryable errors need repair.
host_auth_required needs host connection repair; provider_permission_denied needs
resource-owner access. Auth failures carry the handoff in error.data. When an auth
error includes a handoff, give it to the user or operator.

## Output

Use \`connecta.emit(await connecta.call(address, args))\` for MCP rich output,
or \`for (const b of x.content ?? []) connecta.emit(b)\`. Both forward originals,
including resources and metadata; edits do not change them. Page oversized
native content with \`connecta.result(x.contentResult)\`.
Authored blocks accept text or base64 image/audio; images require canonical
base64 and PNG/JPEG/GIF/WebP MIME. Emit works without await, delivers on success,
and obeys byte/block budgets; text shares the return cap. Return reduced JSON.

`;
