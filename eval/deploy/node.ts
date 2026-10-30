import { ALICE } from "../fakes/google.js";
import { holdFakeKitTransport, repinFakeKitTransport } from "../fakes/transport.js";
import { connectCcb, evalConfig, evalMcpPath, presetCredentials } from "./compose.js";
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
import { codeConfig, forSurface } from "./code-surface.js";
import type { Surface } from "../agent/surface.js";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_A, SHOP_ZONE } from "../fakes/rest.js";
import { createConnecta } from "@zackbart/connecta";
import { accessTokens, AccessTokenManager } from "@zackbart/connecta/auth/access-tokens";
import { encryptedCredentialVault } from "@zackbart/connecta/credentials";
import { listen } from "@zackbart/connecta/node";
import { openSqlite, sqliteStorage } from "@zackbart/connecta/sqlite";
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
  /** Worker target only: every vendor request its gateway dispatched. */
  vendorRequests?(): { method: string; url: string; status: number | "rejected" }[];
  /** Worker target only: where its hidden secrets surface in wrangler's output or logs. */
  secretLeaks?(): Promise<{ findings: string[]; sources: string[] }>;
  /** Refresh `programs` from a deployment that observes them out of process. */
  observe?(): Promise<ProgramObservation[]>;
  /** The operator saving a credential in the connection page. */
  openConnect(url: string): Promise<void>;
  setCredential(connectorId: string, value: string): Promise<void>;
  restart?(readOnly?: boolean): Promise<void>;
  close(): Promise<void>;
}

/**
 * `extra` is a task's untyped passthrough; see `evalConfig` in compose.ts.
 * `everyPool` names connector ids added to every pool, such as injected faults.
 */
export async function startNodeDeployment(
  connectors: ConnectorSpec[],
  extra: Record<string, unknown> = {},
  oauth?: FakeOAuth,
  surface: Surface = "six",
  everyPool: string[] = [],
): Promise<Deployment> {
  let endpointReadOnly = false;
  const dir = await mkdtemp(join(tmpdir(), "connecta-eval-"));
  let database: ReturnType<typeof openSqlite> | undefined;
  let connecta: ReturnType<typeof createConnecta> | undefined;
  let server: ReturnType<typeof listen> | undefined;
  let cleanupExecutor: ReturnType<typeof observedExecutor> | undefined;
  let releaseTransport: (() => void) | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      const listening = server;
      if (listening) {
        listening.closeAllConnections();
        await new Promise<void>((resolve) => listening.close(() => resolve()));
      }
    } finally {
      try {
        if (connecta) await connecta.close();
        else await cleanupExecutor?.executor.close?.();
      } finally {
        try {
          database?.close();
          releaseTransport?.();
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    }
  };
  try {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const storage = sqliteStorage((database = openSqlite(join(dir, "connecta.sqlite"))));
    const { token } = await new AccessTokenManager(storage, { agents: ["eval-machine"] }).rotate(
      "eval-machine",
      "eval-provisioning",
    );
    const vault = encryptedCredentialVault(storage, randomBytes(32).toString("base64"));
    let observed = (cleanupExecutor = observedExecutor(surface));
    const previousPrograms: ProgramObservation[] = [];
    // The fakes route their own credentials; see eval/fakes/transport.ts.
    const qb = connectors.find((s) => s.quickbooks);
    const provided = connectors.some((s) => s.provider);
    const build = () =>
      createConnecta(
        codeConfig(
          evalConfig(
            {
              connectors,
              extra,
              fixtures: { alice: ALICE, accountA: ACCOUNT_A, shopZone: SHOP_ZONE },
              readOnly: endpointReadOnly,
              everyPool,
            },
            {
              storage,
              accessTokens: accessTokens(storage),
              publicUrl: origin,
              executor: observed.executor,
              vault,
              ui: operatorUi(),
              ...(oauth
                ? { auth: { auth: oauth.inbound(), maintainers: ["eval-human"] }, oauthConnector: oauth.connector() }
                : {}),
            },
          ),
          surface,
        ),
      );
    connecta = build();
    await presetCredentials(vault, connectors);
    server = listen(
      { ...connecta, fetch: (...args) => forSurface(connecta!, surface).fetch(...args) },
      {
        port,
        host: "127.0.0.1",
        gracefulShutdown: false,
      },
    );
    // listen() just installed Node's owned sender, which bypasses the fake
    // routing. Re-pin it in the same tick, before any request can dispatch.
    if (qb || provided || connectors.some((spec) => spec.rest || spec.google))
      releaseTransport = holdFakeKitTransport();
    else repinFakeKitTransport();
    await once(server, "listening");
    await connectCcb(connecta, connectors, origin);
    return {
      kind: "node-template-shape",
      get programs() {
        return [...previousPrograms, ...observed.programs];
      },
      ...(qb || provided
        ? {
            restart: async (readOnly?: boolean) => {
              endpointReadOnly = readOnly ?? endpointReadOnly;
              await connecta!.close();
              previousPrograms.push(...observed.programs);
              observed = cleanupExecutor = observedExecutor(surface);
              connecta = build();
            },
          }
        : {}),
      origin,
      mcpUrl: `${origin}${evalMcpPath(extra, !!oauth)}`,
      token: oauth?.token ?? token,
      openConnect: async (url) => {
        const target = new URL(url);
        if (target.origin !== origin || target.pathname !== "/connect/oauth" || !oauth)
          throw new Error("Unexpected eval connection URL");
        target.searchParams.set("start", "1");
        const response = await fetch(target, { headers: { Cookie: `__session=${oauth.token}` }, redirect: "manual" });
        await response.body?.cancel();
        if (response.status >= 400 || !oauth.connected)
          throw new Error(`Fake /connect visit failed: ${response.status}`);
        oauth.visits += 1;
      },
      setCredential: async (connectorId, value) => {
        await vault.set(connectorId, value, "operator");
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
