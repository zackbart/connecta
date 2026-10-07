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
`call_destructive_tool` until a release reviews them again.
