# Working on this Connecta deployment

This repository is deployment configuration, not a copy of Connecta itself.

- Edit `src/index.ts` for connectors, authentication, storage, and public URL.
- Keep `executor: quickJsExecutor()` for the prescribed eight-tool code-first
  surface. File storage supports resumable writes, so a program pauses at a
  write until `resume_execution` approves it.
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
- Brand the operator UI in `operatorUi({ branding })`: product and owner names,
  description, favicon, and `theme` (`accent`, `radius`, `fontFamily`,
  `monoFamily`, `colorScheme`). Ask the deployment's owner for their brand
  rather than leaving the default. The commented block above
  `ui: operatorUi()` in `src/index.ts` shows the shape; README "Select optional
  modules" covers the rest.
- Run `npm run typecheck` after configuration changes. With the server running,
  run `CONNECTA_TOKEN=... npm run doctor` before calling setup complete.
- `Dockerfile` and `docker-compose.yml` containerize *this* source; they are
  the same deployment, not a second one. Configuration belongs in `.env` and
  `src/index.ts`, never in a divergent container entrypoint.
- Moving this deployment to a newer Connecta is its own procedure, and it is
  not a re-`init` — `connecta init` refuses to merge into an existing path on
  purpose. Bump the exact `@zackbart/connecta` pin in `package.json`, then read
  the [changelog](https://github.com/zackbart/connecta/blob/main/CHANGELOG.md)
  for every release in between — it also ships at
  `node_modules/@zackbart/connecta/CHANGELOG.md`. Each release opens with what
  breaks and what a deployment can ignore.

Do not add alternate entrypoints, policy layers, generated connector catalogs,
or runtime connector registration. Keep the deployment small enough to review
as configuration.
