# Working on this Connecta deployment

This repository is deployment configuration, not a copy of Connecta itself.

- Edit `src/connecta.config.ts` for connectors, authentication, storage, public
  URL, and optional modules. `src/index.ts` only starts it.
- Keep `executor: quickJsExecutor()` for the prescribed six-tool code-first
  surface. Keep the required `readOnly` choice in the config: `false` lets
  `call_destructive_tool` and programs write and annotates `execute_code` as
  a write; `true` omits write tools from search and describe and refuses every
  write call. Named pools inherit it unless they set their own `readOnly`.
  Approval belongs to the MCP host. Do not configure the removed `trust` or
  `execute.approval`.
- Keep credentials in environment variables or an external secret store.
  Never commit `.env`, `.connecta.sqlite` (and its `-wal`/`-shm` files),
  tokens, or credential values.
- Add application logic only inside deliberate `api()` connector handlers.
  Do not copy or modify Connecta package internals here.
- Prefer `api()` when the agent must see an exact reviewed capability surface;
  `remoteMcp()` follows the downstream server's evolving tool catalog.
- Optional modules (Clerk sign-in, credential vault, activity history) are type-checked code in `src/connecta.config.ts`, switched on by
  their environment variables. Follow README "Select optional modules". Shared auth management
  requires a signed-in maintainer, and a pool member manages only their own
  account on a personal connector in their pools; visibility alone never grants it. Clerk supplies human identity; machine clients are the
  `agents` declared by name in `src/connecta.config.ts`, each with one `cta_` token.
  Keep `accessTokens(storage)` installed even before the first token exists.
  Issue or rotate an agent's token with `npm run --silent rotate-token -- <agent>`
  against the same configuration and database the server uses; bind a token
  from before agents once with `npm run adopt-token -- <token-id> <agent>`.
  Plain `/mcp` serves `maintainers` only; other people reach `/mcp/<pool>` and
  agents `/agent/<pool>` for a pool listing them in `members` (`npm run doctor`
  checks `/agent/local`). Human endpoints refuse `cta_` tokens. `CONNECTA_TOKEN` is only for clients and doctor; never add a configured
  static bearer or an open startup mode.
  All state, activity included, lives in the one SQLite file `CONNECTA_DATABASE`
  names, through `@zackbart/connecta/sqlite`.
- Brand the operator UI in `operatorUi({ branding })`: product and owner names,
  description, favicon, and `theme` (`accent`, `radius`, `fontFamily`,
  `monoFamily`, `colorScheme`). Ask the deployment's owner for their brand
  rather than leaving the default. README "Select optional modules" shows the
  shape.
- Run `npm run typecheck` after configuration changes. With the server running,
  run `CONNECTA_TOKEN=... npm run doctor` before calling setup complete.
- `Dockerfile` and `docker-compose.yml` containerize _this_ source; they are
  the same deployment, not a second one. Configuration belongs in `.env` and
  `src/connecta.config.ts`, never in a divergent container entrypoint.
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
