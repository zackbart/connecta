/**
 * The Node deployment the agent evals run against uses the template's stored
 * access-token auth, SQLite storage, QuickJS executor, operator UI, and
 * `listen()`, plus its optional credential vault. The fakes are `remoteMcp()`
 * connectors over real loopback HTTP.
 *
 * This is the only file in the agent harness that speaks connecta's config
 * API, and it only uses published entry points. When the config surface
 * changes, this adapter changes; the tasks and graders do not.
 */
import { withCodeSurface } from "./code-surface.js";
import type { Surface } from "../agent/surface.js";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnecta, remoteMcp } from "@zackbart/connecta";
import { accessTokens, AccessTokenManager } from "@zackbart/connecta/auth/access-tokens";
import { encryptedCredentialVault } from "@zackbart/connecta/credentials";
import { listen } from "@zackbart/connecta/node";
import { sqliteStorage } from "@zackbart/connecta/sqlite";
import { observedExecutor, type ProgramObservation } from "./observed-executor.js";
import { operatorUi } from "@zackbart/connecta/ui";
import type { FakeOAuth } from "../fakes/oauth.js";
import type { ConnectorSpec } from "../fakes/world.js";
import { freePort } from "../support/serve.js";

export interface Deployment {
  kind: string;
  origin: string;
  mcpUrl: string;
  token: string;
  programs: ProgramObservation[];
  /** The operator saving a credential in the connection page. */
  openConnect(url: string): Promise<void>;
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
  oauth?: FakeOAuth,
  surface: Surface = "six",
): Promise<Deployment> {
  const { pool, ...passthrough } = extra;
  const dir = await mkdtemp(join(tmpdir(), "connecta-eval-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const storage = sqliteStorage(join(dir, "connecta.sqlite"));
  const { token } = await new AccessTokenManager(storage).create("eval-machine", "eval-provisioning");
  const vault = encryptedCredentialVault(storage, randomBytes(32).toString("base64"));
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const observed = observedExecutor(surface);
  const connecta = createConnecta({
    storage,
    accessTokens: accessTokens(storage),
    ...(oauth ? { auth: oauth.inbound() } : {}),
    identity: {
      credentialAdministration: () => "all",
      personalConnection: () => "all",
    },
    publicUrl: origin,
    executor: observed.executor,
    vault,
    ui: operatorUi(),
    logger: quiet,
    connectors: [
      ...(oauth ? [oauth.connector()] : []),
      ...connectors.map((spec) =>
        remoteMcp(spec.id, {
          url: spec.url,
          title: spec.title,
          description: spec.description,
          ...(spec.usageGuide ? { usageGuide: spec.usageGuide } : {}),
          logger: quiet,
          ...(spec.credential
            ? { auth: { type: "credential" as const, credential: { label: spec.credential.label } } }
            : {}),
        }),
      ),
    ],
    ...(passthrough as Partial<Parameters<typeof createConnecta>[0]>),
  });
  for (const spec of connectors) {
    if (spec.credential?.value) {
      await vault.set(spec.id, spec.credential.value, "operator");
    }
  }
  const server = listen(surface === "six" ? connecta : withCodeSurface(connecta), {
    port,
    host: "127.0.0.1",
    gracefulShutdown: false,
  });
  await once(server, "listening");
  return {
    kind: "node-template-shape",
    programs: observed.programs,
    origin,
    mcpUrl: `${origin}/mcp${typeof pool === "string" ? `/${pool}` : ""}`,
    token: oauth?.token ?? token,
    openConnect: async (url) => {
      const target = new URL(url);
      if (target.origin !== origin || target.pathname !== "/connect/oauth" || !oauth)
        throw new Error("Unexpected eval connection URL");
      target.searchParams.set("start", "1");
      const response = await fetch(target, { headers: { Cookie: `__session=${oauth.token}` }, redirect: "manual" });
      await response.body?.cancel();
      if (response.status >= 400 || !oauth.connected) throw new Error(`Fake /connect visit failed: ${response.status}`);
      oauth.visits += 1;
    },
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
