# Issue #322 deterministic baseline

Source commit: `d58f874588bdf6aa37b4404b9416a8b9b0b917c9`

Runtime: Node 22.23.2 on darwin-arm64; tokenizer `o200k_base`; required
executor; seven-tool surface.

Machine-readable artifact:
`issue-322-before-audit.json`

Artifact SHA-256:
`0775ed3e1a502089b5999932d25653e6a66b9e6bac808895d56f089810b0279d`

The artifact is the exact baseline used by the issue #322 comparison. It was
copied byte-for-byte from the orchestration audit path; `cmp` confirmed
identity before commit. Its sealed holdout SHA-256 is
`25928ad2634f44ba02653613fd54d3cd93da6bde9a6a7fee845e336a004bbb1a`.

## Result

- Release gate: pass
- Behavioral scenarios: 21/21
- Top-1: 93.1%
- Positive and default-page recall: 100.0%
- Negative false-positive rate: 40.0%
- Mean precision: 71.1%
- Mean discovery response tokens: 402.9
- Complete measured surface tokens: 22,910
