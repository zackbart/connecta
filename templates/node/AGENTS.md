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
- The operator surface — Clerk sign-in, credential vault, access tokens,
  activity — ships as commented blocks in `src/index.ts`. Enable one by
  uncommenting it and setting the variables it names in `.env`, never by
  inventing a parallel configuration path. `README.md` § "Turn on the operator
  surface" is the walkthrough; `src/file-activity.ts` is the deployment-owned
  activity store the activity block wires.
- Run `npm run typecheck` after configuration changes. With the server running,
  run `CONNECTA_TOKEN=... npm run doctor` before calling setup complete.
- `Dockerfile` and `docker-compose.yml` containerize *this* source; they are
  the same deployment, not a second one. Configuration belongs in `.env` and
  `src/index.ts`, never in a divergent container entrypoint.

Do not add alternate entrypoints, policy layers, generated connector catalogs,
or runtime connector registration. Keep the deployment small enough to review
as configuration.
