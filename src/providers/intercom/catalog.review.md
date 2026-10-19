# Intercom catalog review — 2026-10-19

Contributor evidence, not a vendored MCP schema. Runtime names, descriptions,
input/output schemas and results come from Intercom's live `tools/list`.

Sources: [current MCP Markdown](https://developers.intercom.com/docs/guides/mcp.md),
[Fin Operator Markdown](https://developers.intercom.com/docs/guides/fin-operator-mcp.md),
[October 2026 permissions change](https://developers.intercom.com/docs/build-an-integration/learn-more/rest-apis/unversioned-changes).
The indexed MCP HTML was stale; the current Markdown lists 14 core tools plus
five optional Operator tools and both US/EU regions. This is the documented
superset, not a claim every workspace exposes exactly 19 tools.

## Schema evidence and per-tool verdicts

**All 19 complete JSON input schemas are unavailable and all schema digests
are unpinned.** Anonymous JSON-RPC `tools/list` returned 401 in both regions.
No credentials were obtained or used. The table records only parameters and
constraints the docs state; it deliberately does not invent required flags,
JSON types, nested schemas, additional properties or defaults for other fields.
Fetch live schemas through authorized discovery before invoking tools.
`catalog.fixture.json` contains names and the five documented Fin annotations,
without `inputSchema`; it is documentation-derived test evidence.

| Tool                    | Documented input evidence (not a complete schema)                                                                                                                                                                                                                                                              | Documented access and reviewed verdict                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`                | Query DSL; object_type must be conversations or contacts; filters, q, limit (default 5/max 150), starting_after within query. Argument envelope/key not specified.                                                                                                                                             | Search existing data; read.                                                                                                                                     |
| `fetch`                 | Prefixed conversation_, contact_ or company_ id from search. Argument envelope/key not specified.                                                                                                                                                                                                              | Retrieve existing object; read.                                                                                                                                 |
| `search_conversations`  | ids array; source_type; source_author_name/email; state open/closed/snoozed; team_assignee_id string; admin_assignee_id number; statistics_time_to_assignment/admin_reply/first_close with comparison operators; per_page (default 5/max 150); starting_after. Full operator shapes and required flags absent. | Search existing threads; read.                                                                                                                                  |
| `get_conversation`      | Conversation id; precise argument key/type absent.                                                                                                                                                                                                                                                             | Retrieve thread/parts/metadata; read.                                                                                                                           |
| `search_contacts`       | IDs, name, email, phone, custom attributes, email domain; per_page (default 5/max 150), starting_after. Filter keys/types/matching shapes not fully specified.                                                                                                                                                 | Search existing profiles; read.                                                                                                                                 |
| `get_contact`           | Contact id; precise argument key/type absent.                                                                                                                                                                                                                                                                  | Retrieve profile; read.                                                                                                                                         |
| `list_companies`        | Optional name, company_id, tag_id, segment_id, per_page (default 15/max 60), page (default 1). Full types absent.                                                                                                                                                                                              | List/filter companies; read.                                                                                                                                    |
| `get_company`           | Company id; precise argument key/type absent.                                                                                                                                                                                                                                                                  | Retrieve company and attributes; read.                                                                                                                          |
| `list_articles`         | page (default 1); per_page (1–150, default 25).                                                                                                                                                                                                                                                                | List articles; read.                                                                                                                                            |
| `search_articles`       | At least one search parameter: phrase, state (published/draft), help_center_id (numeric), highlight (boolean). Other exact types/constraints absent.                                                                                                                                                           | Search Help Center; read.                                                                                                                                       |
| `get_article`           | Article id; precise argument key/type absent.                                                                                                                                                                                                                                                                  | Retrieve article HTML/metadata; read.                                                                                                                           |
| `create_article`        | Required title, author_id (numeric); optional description, body (HTML), state (published/draft; default draft), parent_id (numeric), parent_type (collection/section, required with parent_id).                                                                                                                | Create/potentially publish article; write.                                                                                                                      |
| `update_article`        | Required id; at least one update among title, author_id, description, body, state, parent_id, parent_type. Complete types/cross-field schema absent.                                                                                                                                                           | Overwrite existing article; destructive.                                                                                                                        |
| `add_internal_note`     | Required conversation_id (numeric id, prefixed id or Inbox URL; exact JSON type absent), body (HTML/plain text); ticket ids unsupported; author fixed by grant.                                                                                                                                                | Append internal note and possibly reopen snoozed thread; destructive because it can change existing conversation state.                                         |
| `send_operator_message` | Required message; optional chat_id, omitted for new chat. Full types absent.                                                                                                                                                                                                                                   | Start async work/spend usage; destructive per vendor.                                                                                                           |
| `get_operator_response` | Required chat_id (UUID from chat URL).                                                                                                                                                                                                                                                                         | Poll current result, never start work; read per vendor.                                                                                                         |
| `get_proposal_details`  | Required chat_id; optional proposal_ids, omitted for all pending proposals.                                                                                                                                                                                                                                    | Read proposed changes/files; read per vendor.                                                                                                                   |
| `apply_proposals`       | Required chat_id, proposals (max 5); each has required proposal_id, optional apply_mode (apply/draft/release/publish/destroy), which must be supported by the proposal.                                                                                                                                        | Create/overwrite/publish/delete live configuration; destructive per vendor.                                                                                     |
| `reject_proposals`      | Required chat_id, proposal_ids (max 20).                                                                                                                                                                                                                                                                       | Discard pending proposals; write per vendor, conservatively destructive in Connecta because pending proposal state is deleted. Vendor destructiveHint is false. |

13 reads, 6 writes (5 destructive). The rejected-proposal verdict intentionally
exceeds the vendor hint. No customer replies, assignments, contact changes,
ticket changes or conversation closures are documented as separate tools;
new unreviewed tools fail closed unless explicit uncontradicted read annotations
establish a read. Operator proposals can still change live configuration.

## Connection and auth evidence

- Streamable HTTP: US `https://mcp.intercom.com/mcp`, EU
  `https://mcp.eu.intercom.com/mcp`. Deprecated `/sse` endpoints exist in both
  regions but are not selected by the provider. AU workspaces unsupported.
  Require explicit region; never silently route an EU workspace to US.
- Both anonymous listing probes returned `401 invalid_token`, with a Bearer
  challenge advertising `scope="mcp operator"` and regional resource metadata.
  [US metadata](https://mcp.intercom.com/.well-known/oauth-protected-resource/mcp)
  and [EU metadata](https://mcp.eu.intercom.com/.well-known/oauth-protected-resource/mcp)
  advertise header bearer auth, regional resource/issuer and mcp/operator scopes.
  [US authorization metadata](https://mcp.intercom.com/.well-known/oauth-authorization-server)
  and [EU authorization metadata](https://mcp.eu.intercom.com/.well-known/oauth-authorization-server)
  advertise authorization_code/refresh_token, dynamic registration and S256.
- Default OAuth authScope is personal: teammate permissions/seats apply. Token
  auth defaults to shared, with explicit authScope overrides available. OAuth
  discovery supplies scopes; the provider does not invent API permission scope
  strings or require an operator credential in source. Stored credentials use
  the standard Bearer framing. No end-to-end credentialed auth was tested.
- Remote OAuth callbacks require Intercom Customer Support allowlisting;
  localhost and 127.0.0.1 are preallowed. App Store review is separate.
- Required API permissions: Read and list users and companies; Read
  conversations; Write conversations for internal notes; Read and write
  articles for Help Center tools. Use Fin Operator is OAuth-only, with
  workspace/teammate access prerequisites. Intercom says OAuth consent requests
  Use Fin Operator on every connection. Bearer tokens never get Operator tools.
- Intercom API rate limits apply. The documented 60/minute/connection limit
  covers all five Fin tools, not the core tools; no single provider-wide budget
  would describe it accurately.

## Remaining evidence gaps

Obtain a permitted authenticated listing separately to pin exact schemas and
confirm the inventory for a workspace/seat. Confirm the deployment's callback
allowlist and grants through normal operator authorization. These gaps do not
justify credential acquisition or operational calls during provider research.
