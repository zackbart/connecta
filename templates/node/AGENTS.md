# Working on this Connecta deployment

This repository is deployment configuration, not a copy of Connecta itself.

- Edit `src/index.ts` for connectors, authentication, storage, and public URL.
- Keep `executor: quickJsExecutor()` for the prescribed seven-tool code-first
  surface.
- Keep credentials in environment variables or an external secret store.
  Never commit `.env`, `.connecta-state.json`, tokens, or credential values.
- Add application logic only inside deliberate `api()` connector handlers.
  Do not copy or modify Connecta package internals here.
- Prefer `api()` when the agent must see an exact reviewed capability surface;
  `remoteMcp()` follows the downstream server's evolving tool catalog.
- Run `npm run typecheck` after configuration changes. With the server running,
  run `CONNECTA_TOKEN=... npm run doctor` before calling setup complete.

Do not add alternate entrypoints, policy layers, generated connector catalogs,
or runtime connector registration. Keep the deployment small enough to review
as configuration.
