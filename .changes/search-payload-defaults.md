---
type: changed
breaking: true
---

Search pages state connector facts once: `connectorTitle`, `guide` and `guideSummary` moved off every tool row into a page-level `connectors` map keyed by connector id (`connectors[id].title`, `.guide`, `.guideSummary`); rows keep `guideRequired` and `guideRequiredReasons`. In-program `connecta.search` now defaults to `includeSchemas: "typescript"` (one `signature` per row, about half the bytes of JSON); pass `includeSchemas: "json"` for JSON Schema. Top-level `search_tools` still omits schemas by default. A query led by `list`, `get`, `find`, `search`, `show`, `read`, `fetch` or `count` ranks read rows above write rows within each relevance tier without hiding writes. Maintained providers may declare `searchSynonyms`, groups of interchangeable lowercase words search matches lexically for that provider only; Church Community Builder declares `person`/`individual` and `household`/`family`, and Granola `meeting`/`note`.
