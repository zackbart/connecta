---
type: fixed
---

Never cut a write tool's description in discovery, so a precondition stated late in it (such as "transfer resources first") is seen before the write is sent. Search pages show every write row's full description; write descriptions share a 32 KiB budget per page, and a page ends before a write that would exceed it (`hasMore`/`nextOffset`), with a single larger write returned alone. Read rows keep the one-sentence summary. `call_tool`'s refusal of a write now ends with the tool's full description.
