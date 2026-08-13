# What lives in `results/`

Markdown. Every lane here writes a JSON artifact beside its report, and those
artifacts are the reason this directory once held about 7 MB for verdicts that
fit in a paragraph. A settled issue's answer is already in the report, in
[`ethos.md`](../../../ethos.md), and in git history; the trace that produced it
is regeneration output. So `results/*.json` is ignored, and the reports below
name their JSON sibling rather than linking it — the name tells you what to ask
for, and the command in [the lane's README](../README.md) produces it (#346).

Two files are tracked anyway, because neither can be regenerated:

- `current-agent-performance.json` — the v1-legacy agent-benchmark artifact that
  `performance-report-self-test.mjs` reads to prove the report normalizer still
  understands the old schema. It is a fixture wearing an output filename, which
  is also why `perf:agent` writing over it would break the self-test.
- `issue-322-preregistered-provenance.json` — the
  [#322](https://github.com/zackbart/connecta/issues/322) preregistration timing
  record: observed timestamps, the GitHub PushEvent id, and the SHA-256 of the
  plan, the coverage-off patch, the comparison, and both raw arms. You cannot
  re-observe a timestamp, and those hashes are what still ties the retired
  blobs in git history to the verdict in `issue-322-evidence.md`.

An artifact that is genuinely evidence — an observation, not a rerun — gets a
line here and a negation in the root `.gitignore`. Everything else gets a
command.
