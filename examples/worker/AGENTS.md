# Working on this Connecta Worker deployment

This repository is deployment configuration, not a copy of Connecta itself.

- Edit `src/connecta.config.ts` for connectors, authentication, storage, public
  URL, and optional modules. `src/index.ts` only starts it. Set plain vars
  `CONNECTA_ACTIVITY="on"` for preserved activity.
- Keep `cloudflareAccessAuth()` for human identity and `accessTokens(storage)`
  always installed over the same `CONNECTA_DB` for machines. Cloudflare Access
  admits the request before the Worker runs; a service identity alone is
  refused inside connecta. Do not add JWT parsing or another identity gate.
  Grant `identity.accessTokenManagement` explicitly to interactive operators;
  this example permits every signed-in human to manage connectors and tokens.
- Attach Access to the Worker itself, not only its hostname. Enable Managed
  OAuth on that Access application. CIMD is the spec's preferred client
  registration; enable DCR as the fallback Access currently requires.
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
- Keep credentials in Worker secrets. Never commit credential values, Access
  service-token secrets, or `CREDENTIAL_ENCRYPTION_KEY`.
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
- Unattended clients and `connecta doctor` need Access service credentials
  plus a stored `cta_` bearer. Set `CF_ACCESS_CLIENT_ID`,
  `CF_ACCESS_CLIENT_SECRET`, and `CONNECTA_TOKEN` together for doctor.
  Bootstrap tokens through the Access-authenticated operator page or trusted
  `AccessTokenManager.create` tooling against this same D1 storage, as README
  "Machine tokens" describes. Never configure a static bearer or open startup.
  UI, vault, and activity use explicit optional imports;
  auth changes require code-derived shared or personal management permissions.
- Brand the operator UI in `operatorUi({ branding })`: product and owner names,
  description, favicon, and `theme` (`accent`, `radius`, `fontFamily`,
  `monoFamily`, `colorScheme`). Ask the deployment's owner for their brand
  rather than leaving the default. README "UI and encrypted credentials" shows
  the shape.
- After configuration changes, typecheck: inside the connecta repository that
  is `npm run check:examples`; a copied deployment runs its own `tsc --noEmit`.
  After deployment, connect both Claude and ChatGPT to `<PUBLIC_URL>/mcp` and
  complete their browser authorization flows before calling setup complete.

Do not add alternate entrypoints, policy layers, generated connector catalogs,
or runtime connector registration. Keep the deployment small enough to review
as configuration.
