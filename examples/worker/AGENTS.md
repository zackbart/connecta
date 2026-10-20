# Working on this Connecta Worker deployment

This repository is deployment configuration, not a copy of Connecta itself.

Start every operator task at
`node_modules/@zackbart/connecta/documentation/README.md#operator-tasks`.
That installed index routes adding/removing connectors, organizing agent pools,
adding people, connecting shared credentials, issuing/rotating/revoking agent
tokens, upgrading, and diagnosis with `connecta doctor` to their procedures.

- Edit `src/connecta.config.ts` for connectors, authentication, storage, public
  URL, and optional modules. `src/index.ts` only starts it. Set plain vars
  `CONNECTA_ACTIVITY="on"` for preserved activity.
- Keep `cloudflareAccessAuth()` for human identity and `accessTokens(storage)`
  always installed over the same `CONNECTA_DB` for machines. Cloudflare Access
  admits the request before the Worker runs; a service identity alone is
  refused inside connecta. Do not add JWT parsing or another identity gate.
  Signed-in maintainers alone manage shared credentials and agent tokens; pool
  members connect only their own accounts on personal connectors in their pools.
- Attach Access to the Worker itself, not only its hostname: keep the
  Worker's `access` property pointing at the Worker-level application in
  `alchemy.run.ts`. Enable Managed OAuth on that Access application. CIMD is
  the spec's preferred client registration; enable DCR as the fallback Access
  currently requires.
- Managed OAuth's **Allowed redirect URIs** must contain all three entries
  below. This is application configuration under
  `oauth_configuration.dynamic_client_registration.allowed_uris`, not an
  Access Allow policy:

  ```text
  https://claude.ai/api/mcp/auth_callback
  https://chatgpt.com/connector_platform_oauth_redirect
  https://chatgpt.com/connector/oauth/*
  ```

  The first is Claude's hosted MCP callback. The two ChatGPT entries cover its
  stable callback and its callback-id form. An empty allowlist lets Access
  discovery work but makes client registration fail with `redirect_uri` not
  allowed. If a client presents a different callback, copy that exact URI from
  its registration attempt and add the narrowest matching entry rather than
  broadening the allowlist to an entire origin.

- Keep `workerExecutor({ loader: env.LOADER })` loader-only. Do not
  add bindings, modules, or outbound access to generated code.
  Import it from `@zackbart/connecta/worker`; direct upstream
  `new DynamicWorkerExecutor()` construction throws at boot. Keep the
  `@cloudflare/codemode` optional peer installed.
- Keep the required `readOnly` choice in `src/connecta.config.ts`; startup
  fails without it. `true` omits write tools from search and describe and
  refuses every write call; `false` lets them run with MCP host approval. Named
  pools inherit it unless they set their own `readOnly`. Do not configure the
  removed `trust`.
- Deploy only with `npx alchemy deploy --stage production` from the folder
  holding `alchemy.run.ts`, passing the same `--stage` to every `plan`,
  `deploy`, and `destroy`. `wrangler.jsonc` is for `wrangler dev` only; never
  deploy with Wrangler. Change Workers, D1, Access applications, vars, and
  secrets in `alchemy.run.ts`, not in the dashboard or with other CLIs.
- Declare every secret in `alchemy.run.ts` `env` with `Config.Redacted`, its
  value supplied through the environment or an uncommitted `.env`. Each deploy
  deletes secrets set any other way. Never commit credential values, `.env`,
  `.alchemy/` (local state holds secret values in plaintext), Access
  service-token secrets, or `CREDENTIAL_ENCRYPTION_KEY`. Keep the
  `.gitignore` renamed from the example's `gitignore`; if it is missing,
  restore it before any `git add`.
- Keep `Alchemy.RemovalPolicy.retain()` on the D1 database and any R2 bucket,
  so `alchemy destroy` never deletes connecta's state.
- All state lives in the one D1 database bound as `CONNECTA_DB`, through
  `d1Storage` (and `d1ActivityStore`) from `@zackbart/connecta/d1`. Do not add
  a KV namespace, a second database, or a copied storage adapter; connecta
  creates its own tables. The only KV binding is in `kv-to-d1.wrangler.jsonc`,
  which is never deployed. It exists for the one-shot copy from a 0.28 Workers
  KV deployment (README.md § "Upgrading from 0.28"). Back up, block traffic
  and background writers, drain, wait for stable KV, copy and verify, deploy
  while maintenance remains, then mark cutover before reopening traffic. Never
  rerun stale KV after cutover. Retain backups before removing KV.
- Add application logic only inside deliberate `api()` connector handlers.
  Do not copy or modify Connecta package internals here.
- Prefer `api()` when the agent must see an exact reviewed capability set;
  `remoteMcp()` follows the downstream server's evolving tool catalog.
- Agents (unattended clients) use `<PUBLIC_URL>/agent/<pool>` with a stored
  `cta_` bearer as their only credential. That needs the self-hosted Access
  application `ConnectaAgents` in `alchemy.run.ts`, one `<host>/agent/*`
  destination per agent hostname with a single Bypass policy, beside the
  Worker-level application (README.md § "Let agents through Access"). Never bypass any other path. `/mcp` and `/mcp/<pool>` refuse `cta_`.
  `connecta doctor` also reads `/health` behind Access: set
  `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, and `CONNECTA_TOKEN`
  together, and pass `--pool ci`, a pool that lists the agent.
  Machine clients are the `agents` declared in `src/connecta.config.ts`. Issue
  or rotate a token through the operator Tokens page as a signed-in maintainer or trusted
  `AccessTokenManager.rotate` tooling against this same D1 storage, as README
  "Machine tokens" describes. Never configure a static bearer or open startup.
  UI, vault, and activity use explicit optional imports;
  auth changes require a maintainer, or a pool member for their own personal account.
- Organize agent pools by connecta's agent pool layout:
  `node_modules/@zackbart/connecta/documentation/auth.md#organizing-an-agents-pools`
  ([online](https://github.com/zackbart/connecta/blob/main/documentation/auth.md#organizing-an-agents-pools)).
  Each agent keeps one Connecta connection whose harness, never the model,
  picks the pool per turn. Tiers are nested pools of shared connectors with
  no `owner`, each spreading the tool list below. Recommended names are
  `<agent>` for the lowest and `<agent>-<tier>` above it; any named pool,
  including an existing `team` or `leadership` pool, may be a tier if all its
  human members are cleared for it. A chat gets the most capable tier everyone
  present is cleared for, and the lowest when anyone present is unknown.
  `<agent>-<user>` (that user's highest tier plus their own connector ids,
  `owner` set to their Workspace address) is used only in a one-on-one with
  that user. List only cleared people in a tier, and never another person in
  a `<agent>-<user>` pool: its per-user connectors act as that user for every
  member. Never add a second Connecta connection or mount downstream tools
  directly.
- Brand the operator UI in `operatorUi({ branding })`: product and owner names,
  description, favicon, and `theme` (`accent`, `radius`, `fontFamily`,
  `monoFamily`, `colorScheme`). Ask the deployment's owner for their brand
  rather than leaving the default. README "UI and encrypted credentials" shows
  the shape.
- After configuration changes, typecheck: inside the connecta repository that
  is `pnpm run check:examples`; a copied deployment runs its own `tsc --noEmit`.
  After deployment, connect both Claude and ChatGPT to `<PUBLIC_URL>/mcp` and
  complete their browser authorization flows before calling setup complete.

Do not add alternate entrypoints, policy layers, generated connector catalogs,
or runtime connector registration. Keep the deployment small enough to review
as configuration.
