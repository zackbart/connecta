# Granola REST contract review, 2026-10-27

Only public documentation was fetched; no Granola key or operational data was
used. The exact official OpenAPI JSON is retained, SHA-256 pinned, and compiled
offline. Its source is https://docs.granola.ai/api-reference/openapi.json.
The document includes audit, webhook and legal-hold operations; these have
explicit refuse verdicts and no callable write surface.

The five reviewed reads match the pinned path/query contracts, including
case-insensitive 14-character API identifiers (provider-owned regex guards,
because the compact index omits patterns), date/date-time filters, note
page sizes 1–30, transcript sizes 1–100, and nullable vendor cursors. Paging
uses hasMore and cursor, never row count. Inconsistent metadata fails closed;
the standard hatch binds continuations to the connector/owner/path/query and
withholds credential-bearing tokens. A safe continuation can never change
the API origin. Empty intermediate pages remain valid.

https://docs.granola.ai/introduction documents the 25-request/5-second burst,
5 requests/second sustained, 429, notes requiring both generated summary and
transcript, and HTTP 413 TRANSCRIPT_TOO_LARGE recovery through the paginated
transcript endpoint. That is caller-driven recovery with no automatic second
request. The 30-second timeout, 4 MiB byte ceiling, concurrency 2 and bounded
queue are Connecta choices; rolling-window admission is per runtime, not a
distributed quota. Missing/inaccessible/unsummarized notes are indistinguishable
404s, classified connector_call_failed rather than proof of absence.

https://docs.granola.ai/help-center/sharing/integrations/granola-api#workspace-api-keys
documents workspace admin creation, Business/Enterprise availability,
workspace-owned non-expiring keys and public/API-enabled-space access. Personal
keys differ; the REST server supplies no reviewed key-type introspection, so
the provider cannot claim to verify that a supplied key is workspace-owned.
https://docs.granola.ai/help-center/sharing/integrations/mcp#how-to-connect
confirms MCP accepts individual OAuth/EMA rather than API keys or service
accounts. No REST operation implements MCP's natural-language search.

NoteAttachment.url explicitly grants anyone with the URL access, so the whole
value is withheld. The detector's private_notes_text/private_notes_markdown and
space_membership candidates describe API-key access in their prose; they are
note content (vendor-null for workspace keys) and membership metadata, not
authentication material. Exact path keeps preserve these fields while their
nested values still cross the shared heuristic and URL/sent-secret boundaries.
The shared reviewProblems test independently checks every detector candidate
and reviewed path against the pinned schemas.
Note.web_url is a navigation link requiring Granola access,
not an attachment grant. Summary/private-note/transcript text and titles can
contain copied credential-bearing URLs: those paths use the shared embedded
URL scanner, with global signing-parameter scanning and the ordinary credential
field heuristic. No Granola/file-host blanket rule or credential-name exemption
is added. Stored key values sent on a request are redacted before text
transforms, field selection and cursor signing. Vendor error prose is withheld;
only statuses and closed error facts route. Speaker source/diarization labels
do not identify attendees. Owner private note fields remain vendor-null for
workspace keys; the connector grants no wider access.

Migration retains the connector ID, three tool names, shared owner and default
single-secret value field used by api(). Local nonstandard fields, raw vendor
cursors, response envelopes or tool names require explicit caller updates.
