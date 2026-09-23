/**
 * The Node deployment the agent evals run against: the composition
 * `templates/node/src/index.ts` prescribes — bearer auth, file storage, the
 * QuickJS executor, the operator UI, `listen()` — plus the credential vault the
 * template ships commented, with the fakes wired in as `remoteMcp()`
 * connectors over real loopback HTTP.
 *
 * This is the only file in the agent harness that speaks connecta's config
 * API, and it only uses published entry points. When the config surface
 * changes, this adapter changes; the tasks and graders do not.
 */
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnecta, remoteMcp } from "@zackbart/connecta";
import { bearerToken } from "@zackbart/connecta/auth/bearer";
import { encryptedCredentialVault } from "@zackbart/connecta/credentials";
import { fileStorage, listen } from "@zackbart/connecta/node";
import { quickJsExecutor } from "@zackbart/connecta/quickjs";
import { operatorUi } from "@zackbart/connecta/ui";
import type { ConnectorSpec } from "../fakes/world.js";
import { freePort } from "../support/serve.js";

export interface Deployment {
  kind: string;
  origin: string;
  mcpUrl: string;
  token: string;
  /** The operator saving a credential in the connection page. */
  setCredential(connectorId: string, value: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * `extra` is a task's untyped passthrough, spread over the config last, so a
 * later phase's task can switch on a config key this adapter has never heard
 * of without a harness change.
 */
export async function startNodeDeployment(
  connectors: ConnectorSpec[],
  extra: Record<string, unknown> = {},
): Promise<Deployment> {
  const dir = await mkdtemp(join(tmpdir(), "connecta-eval-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const token = randomBytes(18).toString("base64url");
  const storage = fileStorage(join(dir, "state.json"));
  const vault = encryptedCredentialVault(storage, randomBytes(32).toString("base64"));
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const connecta = createConnecta({
    storage,
    auth: [bearerToken(token, { subjectId: "operator" })],
    identity: {
      credentialAdministration: () => "all",
      personalConnection: () => "all",
    },
    publicUrl: origin,
    executor: quickJsExecutor(),
    vault,
    ui: operatorUi(),
    logger: quiet,
    connectors: connectors.map((spec) =>
      remoteMcp(spec.id, {
        url: spec.url,
        title: spec.title,
        description: spec.description,
        logger: quiet,
        ...(spec.credential
          ? { auth: { type: "credential" as const, credential: { label: spec.credential.label } } }
          : {}),
      }),
    ),
    ...(extra as Partial<Parameters<typeof createConnecta>[0]>),
  });
  for (const spec of connectors) {
    if (spec.credential?.value) {
      await vault.set(spec.id, spec.credential.value, "operator");
    }
  }
  const server = listen(connecta, { port, host: "127.0.0.1", gracefulShutdown: false });
  await once(server, "listening");
  return {
    kind: "node-template-shape",
    origin,
    mcpUrl: `${origin}/mcp`,
    token,
    setCredential: async (connectorId, value) => {
      await vault.set(connectorId, value, "operator");
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await connecta.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
