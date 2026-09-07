# Current-version benchmark

This is the active whole-agent benchmark for Connecta's seven-tool surface.
It runs fresh Codex sessions against a loopback fixture server with synthetic
data. It never uses a deployment's credentials or contacts a downstream provider.

Four control cases cover cold discovery, a known-address read, exact analytics
semantics, and private pagination. Four usability cases derive from repeated
local transcript patterns:

- `text-project-resolution`: resolve a project from a provider text table and
  verify customer access using the exact id, without assuming an object result.
- `purchase-verification`: resolve Android production across payment and access,
  without querying sandbox or treating a paid subscription as proof of access.
- `experiment-check`: select the production project and its context, then compare
  conversion for the requested population and date window.
- `capability-limit`: establish from the connector guide that individual event
  order cannot be verified, without substituting an aggregate query.

Usability prompts request outcomes, not a route or a guide. Their gate checks the
answer, source selection, and evidence. It does not demand one particular count
of execute calls. Control cases retain their explicit routing checks. Both gates
reject writes. These tests exercise selection within the supplied MCP connection;
they do not measure whether an agent chooses it over browser or unrelated apps.

## Run

Requires a working `codex` CLI login, repository dependencies, and the benchmark's
small token-counting dependency:

```sh
npm --prefix eval/current-version ci
npm --prefix eval/current-version run check
npm --prefix eval/current-version run benchmark
```

Default: three sequential repetitions of all eight cases. Narrow the run with
`--case usability`, `--case controls`, or a single case id, and `--repetitions 2`. The four controls
are `cold-unknown-read`, `known-address-read`, `semantic-analytics`, and
`private-pagination`.

For a comparison, build each revision into an isolated directory and point the
same runner and fixtures at its **frozen** dist directory. It must be able to
resolve the normal runtime dependencies. Do not rebuild a directory during a run:

```sh
CONNECTA_BENCHMARK_DIST=/absolute/baseline/dist node eval/current-version/benchmark.mjs --case usability --repetitions 2 --output results/baseline.json
CONNECTA_BENCHMARK_DIST=/absolute/candidate/dist node eval/current-version/benchmark.mjs --case usability --repetitions 2 --output results/candidate.json
```

The default model is `gpt-5.6-sol`; `CONNECTA_BENCHMARK_MODEL` selects another
exact model. Reports record the requested model, dist directory, and a fingerprint of the
compiled guidance and catalog modules. A run set that changes builds is rejected.

## Evidence and limits

Reports preserve answers, tool arguments and results, downstream calls, catalog
reads, token use, response bytes, and latency. `firstProviderCallMs` measures the
first dispatched provider call from fixture startup, not the first correct or
useful answer. `adverseResponses` counts top-level error responses; it does not
count every caught or nested batch error. Correctness checks can fail a run whose
tools all reported success.

A 240-second deadline bounds each session. Timeouts and nonzero client exits are
failed runs with available evidence, not discarded samples. Each completed run
writes a `.partial.json` checkpoint; final JSON and Markdown follow at completion.

The small synthetic sample is a regression signal, not a production success-rate
estimate. Use individual traces to explain changes, and include failures when
reporting a comparison. Stable facts from actual deployment guides still belong
to the deployment, not these fixtures.

The [September 7 usability comparison](./results/usability-2026-09-07.md) records
the transcript-derived cases, frozen-build results, and their limits.
