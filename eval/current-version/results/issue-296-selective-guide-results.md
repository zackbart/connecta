# Selective connector-guide evaluation (#296)

Source: `147f744e6a612dedad87246c60afdd33e9cb98c9` with a clean product tree, Codex default model, three fresh sessions per case, and two concurrent sessions.

## Result

All 12 agent runs returned the correct fixture result, passed the read-only safety check, and used the advertised seven-tool surface. Guide behavior separated cleanly by need:

| Case | Correct | Guide fetches | Connecta round trips | MCP result tokens | Repairs |
| --- | ---: | ---: | ---: | ---: | ---: |
| Optional guide, complete point read | 3/3 | 0/3 | 2 each | 415 each | 0 |
| Required generic wrapper guide | 3/3 | 3/3 | 4 each | 942–1,070 | 0 |
| Provider-query guide | 3/3 | 3/3 | 3–4 | 1,966–3,065 | 2 |
| Required truncated-schema guide | 3/3 | 3/3 | 4–5 | 588–1,825 | 1 |

The optional-guide control discovered and called `bookshelf.get_book` without reading an unrelated pagination guide. Every connector-required or schema-required case fetched the named connector guide before successful execution.

The strict aggregate `passed` score is lower than task correctness because it also treats generic MCP resource-list probes as foreign calls and enforces the fixture's provisional context envelope. Five such probes occurred in the optional-guide case and four in two schema-heavy runs; they did not reach a connector or affect guide selection. One generic-wrapper run exceeded the 1,000-token envelope by 70 tokens, and one provider-query run exceeded its 2,300-token envelope. These are retained in the raw artifacts rather than normalized away.

Mutation and approval-required behavior is covered deterministically by the repository tests: discovery emits `guideRequired: true` with `approval_required`, instructions make that marker a pre-call hard stop, and `call_destructive_tool` points callers to the guide when one exists. The live-agent lane remains read-only by design.

## Artifacts

- `issue-296-optional-guide-skip.json`
- `issue-296-generic-final.json`
- `issue-296-guide-heavy.json`
- `issue-296-schema-required.json`

Repository verification on the same source commit passed all 72 test files (1,710 passed, 38 skipped), build, documentation, operator UI, lint, unused-code analysis, type checking, example compilation, the production dependency audit (zero vulnerabilities), and the published-package smoke test (301 files, 856,025 bytes). The eval harness type check and scoring/report self-tests also passed.
