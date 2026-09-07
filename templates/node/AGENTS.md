# Working on this Connecta deployment

This repository is deployment configuration, not a copy of Connecta itself.

- Edit `src/index.ts` for connectors, authentication, storage, and public URL.
- Keep `executor: quickJsExecutor()` for the prescribed seven-tool code-first
  surface.
- Keep credentials in environment variables or an external secret store.
  Never commit `.env`, `.connecta-state.json`, `.connecta-activity.jsonl`,
  tokens, or credential values.
- Add application logic only inside deliberate `api()` connector handlers.
  Do not copy or modify Connecta package internals here.
- Prefer `api()` when the agent must see an exact reviewed capability surface;
  `remoteMcp()` follows the downstream server's evolving tool catalog.
- The UI, encrypted credential vault, and activity history use explicit module
  imports and typed `ui`, `vault`, and `activity` options in `src/index.ts`.
  Follow README "Select optional modules". Auth management requires explicit
  `credentialAdministration` or `personalConnection` permissions; visibility
  alone never grants it. Configured bearer auth is a client option, not a human
  management identity. Connecta-issued access tokens are removed.
  `src/file-activity.ts` remains the deployment-owned history store.

- Run `npm run typecheck` after configuration changes. With the server running,
  run `CONNECTA_TOKEN=... npm run doctor` before calling setup complete.
- `Dockerfile` and `docker-compose.yml` containerize *this* source; they are
  the same deployment, not a second one. Configuration belongs in `.env` and
  `src/index.ts`, never in a divergent container entrypoint.
- Moving this deployment to a newer Connecta is its own procedure, and it is
  not a re-`init` — `connecta init` refuses to merge into an existing path on
  purpose. Follow
  [the upgrade guide](https://github.com/zackbart/connecta/blob/main/documentation/upgrading.md),
  which also ships at `node_modules/@zackbart/connecta/documentation/upgrading.md`.

Do not add alternate entrypoints, policy layers, generated connector catalogs,
or runtime connector registration. Keep the deployment small enough to review
as configuration.
