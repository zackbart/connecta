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
import { forSurface } from "./code-surface.js";
import type { Surface } from "../agent/surface.js";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripe } from "@zackbart/connecta/providers/stripe";
import { cloudflare } from "@zackbart/connecta/providers/cloudflare";
import { vercel } from "@zackbart/connecta/providers/vercel";
import { ccb } from "@zackbart/connecta/providers/ccb";
import { overflow } from "@zackbart/connecta/providers/overflow";
import { breeze } from "@zackbart/connecta/providers/breeze";
import { tithely } from "@zackbart/connecta/providers/tithely";
import { ACCOUNT_A, SHOP_ZONE, installRestKitTransport } from "../fakes/rest.js";
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
  const { pool: selected, pools: taskPools, ...passthrough } = extra;
  // Plain /mcp serves maintainers only and an agent is never one (#837): the
  // agent token reaches every connector at the `eval` pool's /agent endpoint.
  const ids = [...(oauth ? ["oauth"] : []), ...connectors.map((spec) => spec.id)];
  const pool = typeof selected === "string" ? selected : oauth ? undefined : "eval";
  const dir = await mkdtemp(join(tmpdir(), "connecta-eval-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const storage = sqliteStorage(join(dir, "connecta.sqlite"));
  const { token } = await new AccessTokenManager(storage, { agents: ["eval-machine"] }).rotate(
    "eval-machine",
    "eval-provisioning",
  );
  const vault = encryptedCredentialVault(storage, randomBytes(32).toString("base64"));
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const observed = observedExecutor(surface);
  const connecta = createConnecta({
    readOnly: false,
    storage,
    agents: ["eval-machine"],
    accessTokens: accessTokens(storage),
    ...(oauth ? { auth: oauth.inbound(), maintainers: ["eval-human"] } : {}),
    pools: {
      eval: { tools: ids, members: ["agent:eval-machine"] },
      ...(taskPools as Record<string, { tools: string[]; members: string[]; readOnly?: boolean }> | undefined),
    },
    publicUrl: origin,
    executor: observed.executor,
    vault,
    ui: operatorUi(),
    logger: quiet,
    connectors: [
      ...(oauth ? [oauth.connector()] : []),
      ...connectors.map((spec) => {
        const options = { purpose: spec.description };
        if (spec.rest === "ccb")
          return ccb(spec.id, {
            ...options,
            environment: "production",
            mode: "system",
            access: "read-write",
            ...JSON.parse(spec.credential!.value!),
          });
        if (spec.rest === "overflow")
          return overflow(spec.id, { ...options, environment: "staging", baseUrl: spec.url });
        if (spec.rest === "breeze") return breeze(spec.id, { ...options, subdomain: "church" });
        if (spec.rest === "stripe") return stripe(spec.id, { ...options, auth: { type: "apiKey" }, mode: "sandbox" });
        if (spec.rest === "tithely")
          return tithely(spec.id, { ...options, environment: "live", baseUrl: `${spec.url}/api/v1` });
        if (spec.rest === "vercel")
          return vercel(spec.id, { ...options, auth: { type: "token" }, teamId: "team_fake" });
        if (spec.rest === "cloudflare")
          return cloudflare(spec.id, {
            ...options,
            ...(spec.id === "cloudflare_legacy"
              ? { auth: { type: "globalApiKey" as const } }
              : { auth: { type: "apiToken" as const } }),
            pin: { accountIds: [ACCOUNT_A] },
            ...(spec.id === "cloudflare_legacy"
              ? { instructions: `The operator's zone inventory reports shop.example.org as zone ${SHOP_ZONE}.` }
              : {}),
          });
        return remoteMcp(spec.id, {
          url: spec.url,
          title: spec.title,
          description: spec.description,
          ...(spec.usageGuide ? { usageGuide: spec.usageGuide } : {}),
          logger: quiet,
          ...(spec.credential
            ? { auth: { type: "credential" as const, credential: { label: spec.credential.label } } }
            : {}),
        });
      }),
    ],
    ...(passthrough as Partial<Parameters<typeof createConnecta>[0]>),
  });
  for (const spec of connectors) {
    if (spec.rest !== "ccb" && spec.credential?.value) {
      if (spec.id === "cloudflare_legacy" || spec.rest === "tithely" || spec.rest === "overflow")
        await vault.setAll(spec.id, JSON.parse(spec.credential.value), "operator");
      else await vault.set(spec.id, spec.credential.value, "operator");
    }
  }
  const server = listen(forSurface(connecta, surface), {
    port,
    host: "127.0.0.1",
    gracefulShutdown: false,
  });
  await once(server, "listening");
  if (connectors.some((spec) => spec.rest)) installRestKitTransport();
  for (const spec of connectors.filter((entry) => entry.rest === "ccb")) {
    const connector = connecta.registry.getConnector(spec.id)!;
    const ctx = connecta.registry.contextFor(spec.id, origin);
    const start = await connector.startAuth!({ ...ctx, allowAuthorization: true });
    const state = new URL(start.authorizationUrl!).searchParams.get("state")!;
    if (!(await connector.verifyState!(state, ctx))) throw new Error("CCB eval OAuth state was refused.");
    await connector.finishAuth!("fake-code", ctx, new URLSearchParams({ code: "fake-code", state }));
  }
  return {
    kind: "node-template-shape",
    programs: observed.programs,
    origin,
    // Agents use /agent/<pool>; human endpoints refuse their cta_ token (#837).
    mcpUrl:
      !oauth && typeof pool === "string"
        ? `${origin}/agent/${pool}`
        : `${origin}/mcp${typeof pool === "string" ? `/${pool}` : ""}`,
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
