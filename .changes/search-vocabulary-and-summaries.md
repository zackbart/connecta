---
type: fixed
---

Stop a hatch's operation vocabulary hiding partial matches from named tools, and rank on what search shows. Search descriptions are now the first complete sentence with `descriptionTruncated: true` when cut, `connecta.describe` returns full text by default within a 32 KiB budget per call, a description's tail can no longer make a tool a complete match, titles are indexed, and a few abbreviations such as `env`/`environment` match. Partial matches score by the squared share of the query's rarity they cover, so rare words in a hatch's description outrank a common verb in another tool's name, and GitHub's hatch operations now count in main search as other hatches' already do.
