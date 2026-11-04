---
type: fixed
---

Stop a hatch's operation vocabulary hiding partial matches from named tools, and rank on what search shows. Search descriptions are now the first complete sentence with `descriptionTruncated: true` when cut, `connecta.describe` returns full text by default within a 32 KiB budget per call, a description's tail can no longer make a tool a complete match, titles are indexed, and a few abbreviations such as `env`/`environment` match.
