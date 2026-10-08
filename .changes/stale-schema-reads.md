---
type: fixed
---

**A reviewed read whose schema changed is a write**
([#705](https://github.com/zackbart/connecta/issues/705)). A reviewed tool
whose live input or output schema no longer matches the digest its release
recorded, or whose digest cannot be checked, keeps no reviewed verdict: it is
served as a write, so `search_tools` and in-program discovery list it as
approval-required, `call_tool` refuses it toward `call_destructive_tool`, and
`execute_code` refuses it before it is sent. Before, such a read kept
`readOnlyHint: true` and ran unapproved; only the drift report's
`schemaChanges` count moved. This applies to `remoteMcp({ classify })` and to
the hosted providers that record digests today, which is Mixpanel: its reads
whose live schemas differ from the reviewed ones now need
`call_destructive_tool` until a release reviews them again. The digest now
covers the whole schema rather than its first 64 levels; a schema too large to
digest is unchecked, so a write. Catalog caches no longer store
classifications: they keep the downstream listing, and each read classifies it
with the running release's review, so a catalog persisted before an upgrade or
served as a stale fallback cannot keep a read. This holds when a deployment
decorates a classified connector with its own `listTools`: the decorator's
filtering and additions are kept, and the review still decides every reviewed
tool. Catalogs persisted by 0.28 are
refreshed on first read, and until then serve none of their read-only claims.
