# Recorded Vercel MCP references

The landing page and all 28 category Markdown response bodies were retrieved
from Vercel's public documentation on 2026-10-08, without credentials.
`recording.json` records the precise retrieval time, source URL and SHA-256 for
each page, plus the expected sorted union of 213 tool names. The Markdown bodies
are preserved verbatim, including frontmatter, related links and parameter tables.
The recording totals approximately 308 KB.

These are documentation evidence, not reviewed tool classifications. Tests read
the recording offline and derive negative cases and link-format variations by
mutating copies. `incomplete.md`, `unparseable.md` and `unavailable.json` are
synthetic failure responses, not vendor recordings.
