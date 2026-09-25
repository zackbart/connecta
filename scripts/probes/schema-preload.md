# MCP schema preload measurement

On 2026-09-25, three fresh local workerd isolates per variant imported the
Worker example. The control used both MCP 2.0.0 workerd shims unchanged. The
comparison removed only their two module-scope `preloadSchemas()` calls with an
esbuild measurement plugin. No dependency file was patched.

After one synthetic request, `Runtime.getHeapUsage` reported:

| Variant | Used V8 heap, bytes | Total V8 heap, bytes |
| --- | --- | --- |
| Original, run 1 | 23,184,168 | 37,535,744 |
| Without preload, run 1 | 12,485,064 | 18,137,088 |
| Original, run 2 | 22,998,196 | 37,273,600 |
| Without preload, run 2 | 12,478,996 | 18,137,088 |
| Original, run 3 | 22,846,584 | 37,273,600 |
| Without preload, run 3 | 12,503,924 | 18,137,088 |

The average used-heap difference was 10,520,321 bytes, about 10.03 MiB. This is
cold-import allocation, without forced garbage collection. It does not establish
retained heap after GC, provider-call behavior, or production isolate churn.
`HeapProfiler.collectGarbage` did not respond within ten seconds in this runtime,
so those attempts produced no measurement and are excluded from the table.

Environment: Node 26.9.0, Miniflare 4.20260722.0, workerd 1.20260722.1,
`@modelcontextprotocol/client` and `server` 2.0.0, compatibility date 2025-01-01,
`nodejs_compat`. Source baseline: connecta `8fec715` plus the #602 program-description clarification. The real Worker example is
retained on a global to prevent tree shaking; the measurement wrapper answers
only a synthetic `loaded` response and does not call providers or initialize the
example's deployment bindings.

Run `node scripts/probes/schema-preload.mjs output.json` from the repository root.
It builds six bundles, starts six local workerd processes in sequence, reads their
inspector heap counters, and disposes them. It never deploys. The committed raw
observations are `schema-preload-2026-09-25.json` beside this file.

Decision for #578: report the cold-import cost upstream. Do not ship a dependency
patch in Connecta or recommend removing preload in deployments, since that change
has not been verified against all SDK schema paths on Workers.
