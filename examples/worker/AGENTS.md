# Working on this Connecta Worker deployment

This repository is deployment configuration, not a copy of Connecta itself.

- Edit `src/index.ts` for connectors, authentication, storage, and public URL.
- Keep `cloudflareAccessAuth()` as the inbound auth provider. Cloudflare Access
  authenticates the request before the Worker runs; do not add JWT parsing or a
  second Worker-side identity gate.
- Attach Access to the Worker itself, not only its hostname. Enable Managed
  OAuth and Dynamic Client Registration on that Access application.
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
- Keep `new DynamicWorkerExecutor({ loader: env.LOADER })` loader-only. Do not
  add bindings, modules, or outbound access to generated code.
- Keep credentials in Worker secrets. Never commit credential values, Access
  service-token secrets, or `CREDENTIAL_ENCRYPTION_KEY`.
- Add application logic only inside deliberate `api()` connector handlers.
  Do not copy or modify Connecta package internals here.
- Prefer `api()` when the agent must see an exact reviewed capability set;
  `remoteMcp()` follows the downstream server's evolving tool catalog.
- Use Access service credentials for `connecta doctor` and unattended clients.
  A `cta_` token or static Connecta bearer cannot cross the Access edge alone.
- Run the repository's `npm run check:examples` after configuration changes.
  After deployment, connect both Claude and ChatGPT to `<PUBLIC_URL>/mcp` and
  complete their browser authorization flows before calling setup complete.

Do not add alternate entrypoints, policy layers, generated connector catalogs,
or runtime connector registration. Keep the deployment small enough to review
as configuration.
