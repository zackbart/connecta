# connecta — roadmap

A running, scannable list of what's next. Grouped by priority. Design rationale
and non-goals live in [`docs/design.md`](./docs/design.md).

## Next up

- [x] Extract Connecta into its own repository as a reusable, versioned package.
- [x] Payload-free downstream tool activity history with authenticated actor,
      actual connector tool address, outcome, duration, and call source. The
      package exposes vendor-neutral activity contracts plus the authenticated
      `/ui` Activity tab; the Worker example owns its D1 implementation.
- [ ] Toolkits / scoped views — a `?toolkit=` filter over the registry for
      per-client deployments.
- [ ] Per-connector `maxResultBytes` override.

## Later

- [ ] Credential health checks — proactive token-liveness probes so status flips
      before a call fails.
- [ ] `skills` meta-tool serving per-connector usage guides.
- [ ] OpenAPI spec import as a connector factory.
- [ ] Semantic tool search (embeddings) vs. today's substring match.
- [ ] Group `ConnectaConfig`'s three `activity*` fields and four catalog/result
      tuning knobs into nested objects. Breaking; batch with the next intentional
      breaking release.
- [ ] Run `branding.productUrl` / `ownerUrl` / `favicon.href` through
      `isSafeHttpUrl`. Operator-controlled config today, so not a live
      vulnerability — required the moment branding becomes settable from `/ui`.

## Later (code mode)

- [x] Code-mode `execute_code` sandbox — **shipped** (#9) as an optional,
      executor-gated tenth meta-tool (`ConnectaConfig.executor`, `src/execute.ts`,
      `quickJsExecutor` / `DynamicWorkerExecutor`). See [`docs/documentation.md` §13](./docs/documentation.md#13-code-mode-execute_code).
- [x] Call-contract follow-ups — shipped in 0.4.0: the `retryAfterMs` channel,
      `AbortError` classification, and the opt-in `defaultToolTimeoutMs` (#13),
      plus the exported `validateToolInput` (#12).
