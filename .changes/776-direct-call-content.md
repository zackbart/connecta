---
type: fixed
breaking: true
---

Keep default direct-call data and truncation previews visible in clients that prefer structured content. Successful `call_tool` and `call_destructive_tool` results with `resultMode` omitted or set to `"mcp"` now omit `structuredContent`, including its former `format` and paging fields. These tools also stop advertising `outputSchema`.

Migrate clients to read result data from `content` and format from `_meta["dev.connecta/format"]` instead of `structuredContent.format`. For truncated default-mode results, parse the first line of the content text as a JSON notice to read `resultId`, `nextOffset`, and `nextAction`, then page with `connecta.result`. Clients that need a structured envelope can request `resultMode: "value"` and keep reading `structuredContent.format` and the paging notice in `structuredContent.data`. Remove assumptions that either direct-call tool advertises an `outputSchema`; use content handling or the value-mode envelope instead. Value-mode and error envelopes retain their complete JSON mirrors.
