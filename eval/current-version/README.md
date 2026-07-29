# Current-version release audit

This isolated Node-only harness qualifies the checked-out Connecta source
without changing production activity storage or calling real external
accounts. It exercises:

- discovery and full schema description;
- direct calls, batching, and code-mode reduction;
- truncation and result paging;
- destructive approval routing;
- successful and unavailable OAuth recovery;
- successful operator-managed static-credential recovery and its unavailable
  path; and
- the payload-free activity event shape.

The discovery suite runs through the real MCP transport against
[`discovery-holdout.json`](./discovery-holdout.json). That corpus was authored
before the closed #188 research corpus was inspected. It is held-out release
evidence: do not tune ranking rules, stopwords, aliases, or thresholds against
its cases.

## Run

Install the repository and audit dependencies once:

```sh
npm ci
npm ci --prefix eval/current-version
```

Then one command runs the complete audit and writes machine-readable JSON plus
a concise Markdown qualification report:

```sh
npm --prefix eval/current-version run audit
```

The command runs on Node 20 and 22. It records the source commit, Node runtime,
tokenizer, holdout hash, task outcomes, round trips, client-observed latency,
and exact JSON-serialized definition, request, and response token surfaces.
The default tokenizer is `o200k_base`; override it with
`CONNECTA_EVAL_TOKENIZER`.

Choose stable output names for release evidence:

```sh
npm --prefix eval/current-version run audit -- \
  --output results/0.8.0-baseline.json \
  --report results/0.8.0-baseline.md
```

The audit is intentionally outside the root TypeScript, Vitest, Knip, purity,
and published-package graphs. Validate its TypeScript separately:

```sh
npm --prefix eval/current-version run check
```

For exploratory calls, start `sandbox-server.ts` with `tsx`, set
`CONNECTA_EVAL_URL` to its reported MCP URL, and pipe JSON commands into
`mcp-session.mjs`. The release gate is the complete `audit` command above, not
an ad hoc session.
