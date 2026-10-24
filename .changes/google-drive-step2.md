---
type: changed
breaking: true
---

Standardize Google Drive's agent surface while retaining its 17 named tools and adding four indexed `drive_api_*` tools. Named lists return `items` instead of `files`, `permissions` or `drives`; terminal cursors are omitted, old cursors must be discarded, and all named reads accept narrowing `fields`. Replace `truncatedFields` and `contentTruncated` with `truncated` paths. The hatch executes 13 reviewed JSON metadata operations from a pinned 64-method inventory; all grants remain in `share_file`, and media, ownership transfer, permanent deletion, watches and credential minting stay refused. Use standard error/outcome mapping, treat move lookups as auxiliary, refuse altered decision metadata before follow-up dispatch, and permanently withhold private access keys and download destinations. Existing names and approval classes are unchanged; Drive had no raw argument to remove. See the Drive section of the 0.35 provider migration guide for request and result examples.
