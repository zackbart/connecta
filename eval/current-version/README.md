# Current-version local eval sandbox

This sandbox runs the exact checked-out `origin/main` Connecta source over
loopback. It has:

- live read-only npm and public GitHub API connectors;
- deterministic fixtures for truncation and code-mode reduction;
- an isolated in-memory write for the destructive approval path;
- an OAuth-shaped fixture for authorization recovery;
- a disposable credential-gated connector for fail-at-use recovery;
- QuickJS-backed `execute_code`;
- in-memory credentials, catalogs, paging results, and payload-free activity.

Install the audit-only tokenizer and start the server:

```sh
npm install --prefix eval/current-version
npx tsc -p eval/current-version/tsconfig.json
npx tsx eval/current-version/sandbox-server.ts
```

In another terminal, start one persistent MCP client session:

```sh
node eval/current-version/mcp-session.mjs
```

The client accepts one JSON command per line and reports client-observed
latency plus serialized request/response byte counts:

```json
{"action":"call","tool":"search_tools","args":{"query":"npm package search","includeSchemas":"compact"}}
{"action":"call","tool":"call_tool","args":{"address":"npm.search_packages","args":{"query":"model context protocol","size":3},"resultMode":"value","diagnostics":true}}
{"action":"close"}
```

Run the complete ten-tool token and behavior audit against a fresh server:

```sh
node eval/current-version/audit-all-tools.mjs \
  eval/current-version/audit-results-2026-07-29.json
```

The audit uses `o200k_base` by default and records definition, request, and
response tokens separately. Set `CONNECTA_EVAL_TOKENIZER` to select another
encoding supported by `js-tiktoken`.

Results and interpretation:

- [`audit-results-2026-07-29.json`](./audit-results-2026-07-29.json)
- [`tool-audit-2026-07-29.md`](./tool-audit-2026-07-29.md)

Run the reproducible discovery A/B benchmark:

```sh
CONNECTA_COMMIT=$(git rev-parse HEAD) \
  npx tsx eval/current-version/discovery-benchmark.ts
```

Discovery findings:

- [`discovery-findings-2026-07-29.md`](./discovery-findings-2026-07-29.md)

The disposable credential value for the `protected` connector is
`sandbox-ok`. The current operator credential route requires Clerk
authentication, so the bearer-only sandbox intentionally cannot mutate it.
Restart with the disposable credential pre-seeded to simulate the operator
completing recovery:

```sh
CONNECTA_EVAL_SEED_PROTECTED=1 \
  npx tsx eval/current-version/sandbox-server.ts
```
