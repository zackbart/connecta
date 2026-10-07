# Decision records

Records explain a choice and its tradeoffs. They do not bind later PRs.
A PR supersedes a record by linking it and explaining the new argument.
The roadmap lives in [issues](https://github.com/zackbart/connecta/issues),
not in this directory.

Use the next four-digit number and a descriptive filename. Keep each record
short enough to read before changing the relevant code:

```markdown
---
status: proposed
date: YYYY-MM-DD
issues: [703]
supersedes: []
---

# The choice

What problem requires a decision?

## Decision

What did we choose, and why? Name the alternatives and the tradeoffs.

## Consequences

What changes for deployments, and what evidence would make us reconsider?
```

`status` is `proposed`, `accepted`, or `superseded`. `date` is the decision date;
`issues` lists GitHub issue numbers; `supersedes` lists earlier record filenames.
A superseded record points to its replacement issue, PR, or record in its prose.

[0001](./0001-ethos-verdict-table.md) preserves the old verdict table.
