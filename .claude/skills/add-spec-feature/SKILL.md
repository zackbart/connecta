---
name: add-spec-feature
description: Implement or change an MCP specification feature in connecta and record it in spec/coverage.json with test evidence and INV citations. Use when adding protocol support, changing a feature's status, or touching spec coverage.
---

# Add or change an MCP spec feature

Connecta targets MCP revision 2026-07-28 and its official extensions.
[spec/coverage.json](../../../spec/coverage.json) is the record of what exists;
describe planned work as planned.

## The record

Each feature has `id`, `status`, `spec` (a `https://modelcontextprotocol.io/`
URL), and non-empty `notes`.

- `supported` or `partial` needs `tests`: `{ "file": "test/….test.ts", "title": "<exact test name>" }`.
  `partial` notes name the gaps; link an `issue` for them.
- `planned` or `declined` needs an `issue` or `decision` URL on
  `github.com/zackbart/connecta/issues|pull/<n>`.
- The feature id list is a snapshot of the revision in
  [test/spec-coverage.node.test.ts](../../../test/spec-coverage.node.test.ts).
  Change it only with a spec revision, never to drop an inconvenient row.

`title` is the leaf `it()` name, not the describe path. The coverage reporter
matches it exactly against tests that **passed** in that file during the full
Node run; a skipped, renamed, or failing test fails `npm run test`.

## Steps

1. Read [PRINCIPLES.md](../../../PRINCIPLES.md) and the relevant guide in
   [documentation/](../../../documentation/). Note which invariants the
   feature touches (classification, request lifetime, credentials, purity).
2. Write the tests first, in `test/`. Prefer a portable `*.test.ts`, which
   runs on Node and workerd. Use `*.node.test.ts` only with a first-line
   `// Node-only: <reason>`.
3. Cite each invariant a test enforces in its title, e.g.
   `"INV-7: releases the downstream stream when the request ends"`. Unknown IDs fail.
4. Implement. Effect stays inside; published declarations name no Effect type.
5. Update the feature's row: status, notes, `tests`, and `issue` for gaps.
6. Add a `.changes/<slug>.md` fragment.
7. `npm run check:fast` while iterating (it skips coverage checks), then
   `npm run check`, whose full Node run enforces INV and spec references.
