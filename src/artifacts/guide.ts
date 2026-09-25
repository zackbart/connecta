// The artifacts connector's usage guide: what an agent must know before its
// first write. Built once at construction with this deployment's allowlist
// and limits, so the numbers and origins it states are the ones enforced.

import type { ArtifactAllowlist, ArtifactLimits } from "./types.js";

export const GUIDE_SUMMARY =
  "Publish team pages: validate first, keep data in documents, patch small edits, pass baseVersion, share the url.";

const size = (bytes: number) =>
  bytes % (1024 * 1024) === 0
    ? `${bytes / (1024 * 1024)} MiB`
    : bytes % 1024 === 0
      ? `${bytes / 1024} KiB`
      : `${bytes.toLocaleString("en-US")} bytes`;

export function buildGuide(options: {
  allowlist: ArtifactAllowlist;
  limits: ArtifactLimits;
  renderCheck: boolean;
}): string {
  const { allowlist, limits } = options;
  const origins = (list: readonly string[]) =>
    list.length ? list.map((origin) => `\`${origin}\``).join(", ") : "none";
  return `# Artifacts

Artifacts are team pages that outlive a chat: dashboards, reports, plans. A page
is self-contained HTML or Markdown; the numbers it shows live in named JSON
**documents** that the page reads from a read-only global. Every write makes a
new immutable version, attributed to you, and any version can be rolled back.
Only people who can read this connector can open a page.

## Writing a page

- **HTML** (\`kind: "html"\`): a complete document starting \`<!doctype html>\`,
  with exactly one element \`id="artifact-root"\` (usually
  \`<main id="artifact-root">\`) holding the content.
- **Markdown** (\`kind: "markdown"\`): headings, lists, tables, code, links, and
  \`data:\` images. Raw HTML shows as text. Markdown pages cannot read data.
- **Data**: a script reads \`window.artifact.data.<name>\` — each document by
  name, already parsed and frozen. \`window.artifact\` also has \`id\`, \`title\`,
  \`view.version\`, \`documents.<name>.{version, updatedAt}\`, and \`snapshot\`.
  Document names are identifiers: letters, digits, \`_\`.
- **Keep data out of the HTML.** Put every figure in a document and render it
  from script; then fixing a number is \`set_documents\`, not a page rewrite,
  and a refresh can replace the data without touching the view.

Pages run sandboxed in their own origin, so some things cannot work there:

- **No network.** \`fetch\`, XHR, WebSocket, and beacons fail. Read
  \`window.artifact.data\` instead.
- **External scripts** load only from ${origins(allowlist.scripts)}. None are
  allowed by default; an operator must opt in to each trusted origin. A script
  can read this page's data. When allowed, use https and pin an exact version
  (\`https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js\`).
  Libraries that need \`eval\` or \`new Function\` do not run. Inline
  \`<script>\` is fine.
- **External stylesheets** load only from ${origins(allowlist.styles)}; fonts
  from ${origins(allowlist.fonts)} or \`data:\`. Both origin lists default to
  empty. Trusted script, style, and font origins may receive page data in
  request URLs. Inline \`<style>\` is fine.
- **Images** are \`data:\` URLs or inline SVG. Nothing relative: a page has no
  files beside it.
- No \`<iframe>\`, \`<form>\`, \`<object>\`, \`<embed>\`, \`<base>\`, or
  \`<meta http-equiv>\`. A link navigates the page's own frame and cannot open a
  new window, so show URLs as text when readers need them elsewhere.

## Tools

Reads run anywhere, including inside \`execute_code\`:

- \`list_artifacts { query?, includeArchived?, limit?, cursor? }\` — check for an
  existing page before creating one.
- \`get_artifact { id, version?, includeSource? }\` — the view, its history, its
  documents' versions, \`revision\`, \`url\`, and \`snapshotUrl\`.
- \`get_document { id, name, version? }\` — one document's value and history.
- \`get_refresh { id }\` — the configured program, schedule, freshness, and the
  latest 20 run records. Logs and failure messages are for agents, not readers.
- \`validate_artifact { kind, source, documents? }\` — every check a save runs${
    options.renderCheck ? ", including this deployment's render check," : ""
  } without saving. **Validate before you save**; each error names a line and
  the fix.

Writes make new versions and never ask for approval inside \`execute_code\`
(unless this deployment turned that off); each one spends the program's write
budget. At the top level, \`call_tool\` refuses them — use
\`call_destructive_tool\`.

- \`create_artifact { id, title, kind, source, documents? }\` — \`id\` is the
  page's URL slug (lowercase letters, digits, hyphens). \`documents\` maps each
  name straight to its value, \`{ "data": { "rows": [...] } }\`; supply
  everything the first render needs in the same call.
- \`patch_artifact { id, baseVersion, edits: [{ find, replace }] }\` — **prefer
  this for small edits** such as a title or a label. Each \`find\` must occur
  exactly once in the current source (include surrounding text if it would
  match twice); every edit applies at once, and if any fails nothing changes.
- \`update_artifact { id, baseVersion, source, title? }\` — replace the whole
  source.
- \`set_documents { id, documents: { <name>: { baseVersion, value } } }\` — set
  several documents atomically; \`baseVersion: 0\` creates one, \`value: null\`
  removes one.
- \`set_refresh { id, document, program, schedule, baseVersion }\` — version a
  complete \`execute_code\` async-arrow program returning the document's JSON
  value. \`schedule\` is \`manual\`, \`daily\`, or \`weekly\`; use \`baseVersion: 0\`
  for the first program, then the version from \`get_refresh\`. It can call
  only explicitly read-only tools on shared connectors. Personal connectors
  and writes fail the run even if the program catches the refusal. A failed
  run keeps the last good document and marks the page stale.
- \`run_refresh { id }\` — trigger one run now through
  \`call_destructive_tool\`. It cannot run inside \`execute_code\` because that
  would hold an executor permit while asking for another.
- \`rollback_artifact { id, target: "view" | "document", name?, version, baseVersion }\`
  — a new version with an old body; history is never rewritten.
- \`archive_artifact\` / \`restore_artifact { id, baseRevision }\` — hide a page
  from the library, or bring it back. Archived pages refuse writes.

## Versions and conflicts

Every write names what it expects to replace: \`baseVersion\` is the current
view version (or the document's version), \`baseRevision\` the artifact's
revision, all from \`get_artifact\`/\`get_document\`. If someone changed it
first, the write fails with code \`conflict\` and nothing is saved; the error's
\`current\` (\`err.details.current\` in a program) says where things stand.
Re-read, reapply your change, and retry with the new base. Never retry the
same call unchanged.

## Sharing

\`url\` is the page as it is now; share that. \`snapshotUrl\` pins the view and
every document to their current versions, for "as of" links. Both are for the
team only.

## Limits

| What | Limit |
| --- | --- |
| Page source | ${size(limits.sourceBytes)} |
| One document, serialized | ${size(limits.documentBytes)} |
| Documents per artifact | ${limits.documents} |
| Distinct document names over its lifetime | 64 (removed names keep their versions) |
| All documents together | ${size(limits.totalDocumentBytes)} |
| Page plus documents | ${size(limits.renderedBytes)} |
| Title | ${limits.titleChars} characters |
| Edits per patch | ${limits.patchEdits}, each \`find\` up to ${size(limits.findBytes)} |
| Document nesting | ${limits.jsonDepth} levels; numbers finite; no \`__proto__\` keys |

A program's host call returns at most 256 KiB on some executors: read a large
source with \`includeSource: false\` inside a program, or with \`call_tool\`.
Versions are kept forever, and a body written by a write that lost a conflict
stays stored unreferenced.
`;
}
