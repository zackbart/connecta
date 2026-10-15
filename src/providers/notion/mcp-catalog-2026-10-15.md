# Live Notion hosted MCP catalog, captured 2026-10-15

Source: the operator's Notion hosted MCP connection (claude.ai connector, OAuth) as seen from a Claude Code client on 2026-10-15. Only the catalog (names, descriptions, input schemas) was read; no operational tool was called. MCP annotations (`readOnlyHint` and `destructiveHint`) were not visible through this client, so verdicts must rest on names, descriptions and schemas.

## Full live tool list

- `notion-check-mcp-next-steps`
- `notion-convert-page-to-skill`
- `notion-create-attachment`
- `notion-create-comment`
- `notion-create-database`
- `notion-create-file-upload`
- `notion-create-folder`
- `notion-create-pages`
- `notion-create-view`
- `notion-delete-comment`
- `notion-delete-databases`
- `notion-delete-pages`
- `notion-download-attachment`
- `notion-download-skill`
- `notion-duplicate-page`
- `notion-fetch`
- `notion-get-async-task`
- `notion-get-comments`
- `notion-get-enabled-skills`
- `notion-get-file-download-urls`
- `notion-get-groups`
- `notion-get-self`
- `notion-get-session-status`
- `notion-get-teams`
- `notion-get-tool-access`
- `notion-get-users`
- `notion-list-favorite-pages`
- `notion-list-page-backlinks`
- `notion-list-private-pages`
- `notion-list-recent-pages`
- `notion-list-session-events`
- `notion-list-shared-pages`
- `notion-memory-search`
- `notion-move-pages`
- `notion-query-data-sources`
- `notion-query-meeting-notes`
- `notion-query-multiple-data-sources`
- `notion-query-sessions`
- `notion-read-session-event`
- `notion-restore-pages`
- `notion-search`
- `notion-search-agents`
- `notion-search-sessions`
- `notion-send-message-to-session`
- `notion-set-comment-reaction`
- `notion-set-discussion-resolved`
- `notion-show-advanced-analysis-next-steps`
- `notion-spawn-session`
- `notion-stop-session`
- `notion-update-comment`
- `notion-update-data-source`
- `notion-update-enabled-skills`
- `notion-update-folder`
- `notion-update-page`
- `notion-update-view`
- `notion-upload-skill`
- `notion-wait-session`

Previously reviewed tools absent from this live catalog: notion-ai-search, notion-list-agents, notion-search-skills (keep them; catalog varies by client/plan/rollout).

## Live tools newly reviewed in #814 (22), with captured descriptions and inputs

- notion-check-mcp-next-steps: "When to call: Only when a Notion fetch result instructs you to... call at most once with no arguments." Returns an upsell/next-step card. Input: {}. No side effects described.
- notion-show-advanced-analysis-next-steps: "Use this exactly once at the end of a turn when query_multiple_data_sources requires the full version of Notion MCP. Call with no arguments." Returns card data (message + destination link). Input: {}.
- notion-delete-comment: "Delete a comment you wrote... If it is the last comment in its discussion, the discussion is removed too." Business/Enterprise. Input: {comment_id}.
- notion-delete-databases: "Move Notion databases to Trash... Without user_confirmed: true, nothing is trashed and the error lists what would be moved." Input: {database_ids[1..20], user_confirmed?}.
- notion-delete-pages: "Move Notion pages to Trash... Without user_confirmed: true, nothing is trashed." Input: {page_ids[1..20], user_confirmed?}.
- notion-get-enabled-skills: "view the Notion skills the user has enabled for you and other external MCP clients, each with a name and a description". Input: {}.
- notion-get-file-download-urls: "Get signed download URLs for files that fetch output cites by stable notion-file-block:// references. Pass up to 25 references... The URLs expire after a few minutes... Keep the stable references, not the URLs, when editing or copying page Markdown." Input: {references[1..25]}. Returns signed URLs.
- notion-get-groups: "Retrieves permission groups in the current workspace that you can see, with their IDs and names... limited to 25 groups." Input: {query?}.
- notion-list-favorite-pages: "List the current user's favorite pages and databases in sidebar order." Input: {cursor?, limit?(1-200)}.
- notion-list-page-backlinks: "List the pages that link to or mention a Notion page (backlinks)... Returns IDs, titles and URLs only." Input: {page_id, cursor?, page_size?(1-100), types?[page_mention|link_to_page|property_mention|comment_mention]}.
- notion-list-private-pages: "List the current user's top-level pages and databases in their Private sidebar section." Input: {cursor?, limit?}.
- notion-list-recent-pages: "List pages and databases the current user recently viewed... This reflects views, not edits." Input: {cursor?, limit?}.
- notion-list-shared-pages: "List pages and databases in the current user's Shared sidebar section." Input: {cursor?, limit?}.
- notion-memory-search: "Search memories that the user's connected agents saved in earlier sessions... Returns the best matches." Input: {query(1..500), limit?(1..50)}.
- notion-query-multiple-data-sources: "Query data across multiple Notion data sources using read-only SQLite SQL... JOINs, UNIONs... Business or Enterprise plan with Notion AI." Input: {query, data_source_urls[2..100], params?, mode?:"sql"}.
- notion-restore-pages: "Restore Notion pages or databases from Trash to where they were before they were deleted." Input: {page_ids[1..20]}.
- notion-set-comment-reaction: "Add or remove your emoji reaction on a comment... Safe to repeat." Business/Enterprise. Input: {comment_id, emoji, reacted:boolean}.
- notion-set-discussion-resolved: "Resolve or reopen a comment discussion... only when a human explicitly asks." Business/Enterprise. Input: {discussion_id, resolved:boolean}.
- notion-update-comment: "Replace the text of a comment you wrote... The new text replaces the whole comment." Business/Enterprise. Input: {comment_id, markdown}.
- notion-update-enabled-skills: "Enable or disable Notion Skills for external MCP clients, Notion AI, or both by adding or removing their page URLs... changes only the current user's Skill settings." Input: {add_skill_urls?, remove_skill_urls?, surfaces?[mcp|notion_ai]}.
- notion-update-folder: "Update an existing Notion Folder with an explicit Folder operation" (add_files | remove_files | add_subfolder). Input: {folder_id, command, file_upload_ids?, file_urls?, title?}.
- notion-upload-skill: "Import a spec-compliant Agent Skills directory into a page in a Skills database. action=prepare ... then action=complete... Completion replaces the page title, Description, body, and Files". Input: {action: prepare|complete, page_id, content_length?, checksum_crc32?, upload_token?}. prepare returns an upload_url + upload_headers (credential-bearing, 10-minute expiry).

## Review outcome

All 57 captured tools have reviewed verdicts. This review adds 12 reads and 10
destructive writes, preserving the 38 earlier verdicts for a 60-tool union.
The per-tool reasons live in `index.ts`; `drift.json` records the public and
manual review sources. The inputs above are summaries, not complete JSON
Schemas, so this evidence asserts no schema digests or annotation values.
Signed download URLs follow the existing `notion-download-skill` read
convention. Upload preparation returns credentials and completion replaces
page content, so the entire `notion-upload-skill` tool stays a write.
