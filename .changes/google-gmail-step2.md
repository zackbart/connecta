---
type: changed
breaking: true
---

Standardize Gmail's read surface with three indexed hatches and retain all nine named tools. Gmail is the documented decision 0014 exception: no `gmail_api_write`; only `create_draft`/`update_draft` write drafts, and sending is never available. Replace `get_message.raw` with `gmail_api_read` (`path: "/messages/{id}"`, `query: { format: "full" }`, resource in `data`). Named list `threads`/`drafts`/`labels` become `items`; remove the named search estimate. Named reads gain `fields` and preserve thread continuations; labels use one bounded unpaged read, size booleans/omission counts become top-level `truncated` paths, terminal cursors are omitted and old private cursors expire. Use top-level `cursor` for signed hatch continuation instead of raw `query.pageToken`. Copied threading headers now refuse malformed/control/non-ASCII tokens before saving. Standard error meanings replace legacy wording. Draft approval classification, MIME/attachment safeguards and scopes remain unchanged. See the Gmail section of `documentation/provider-migration-0.35.md` for every mapping.
