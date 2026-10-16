---
type: changed
---

Add the 0.33 migration guide (`documentation/migration-0.33.md`), mapping every removed access option to `maintainers`, pool `members`, and `agents`, with agent endpoints, pool owners, token revisions, operator contract v2, and the 0.29.0–0.32.0 pre-auth listen fix. Add connecta's agent pool layout as a documented standard in the auth guide ("Organizing an agent's pools") and decision 0007: one Connecta connection per agent, a base pool `<agent>` with shared connectors and no `owner`, and an `<agent>-<user>` pool per person with that person's own connector ids and their Workspace address as `owner`. The Node template and Worker example agent guidance follow it. The empty `identity` option is removed: `identity`, even `{}`, now fails construction, still naming each retired key's replacement. The Access bypass probe requires `--profile`.
