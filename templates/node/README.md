# Connecta deployment

This is the prescribed small Node deployment. Install and run it:

```sh
npm install
CONNECTA_TOKEN=dev-token npm start
```

Then point an MCP client at `http://localhost:8787/mcp` with
`Authorization: Bearer dev-token`.

## Deployment contract

- Edit `src/index.ts` for connectors, auth, storage, and the public URL.
- Keep `executor: quickJsExecutor()` for the seven-tool code-first surface.
- Keep secrets in environment variables or an external secret store.
- Add application code only inside deliberate `api()` connector handlers.
- Do not copy Connecta package internals into this deployment.
- `AGENTS.md` is the canonical convention file; `CLAUDE.md` points to it.

Verify a change with:

```sh
npm run typecheck
# In another terminal, while npm start is running:
CONNECTA_TOKEN=dev-token npm run doctor
```

Doctor checks health, the executor, and the exact prescribed seven-tool
model-facing surface by running a harmless sandbox program. It reads the bearer
from `CONNECTA_TOKEN`; it never accepts the secret as a command-line argument.
Remote URLs must use HTTPS.
