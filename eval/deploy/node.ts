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
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnecta, remoteMcp } from "@zackbart/connecta";
import {
  artifacts,
  kvArtifactStore,
  type ArtifactStore,
} from "@zackbart/connecta/artifacts";
import { accessTokens, AccessTokenManager } from "@zackbart/connecta/auth/access-tokens";
import { encryptedCredentialVault } from "@zackbart/connecta/credentials";
import { listen } from "@zackbart/connecta/node";
import { sqliteStorage } from "@zackbart/connecta/sqlite";
import { observedExecutor, type ProgramObservation } from "./observed-executor.js";
import { operatorUi } from "@zackbart/connecta/ui";
import type { FakeOAuth } from "../fakes/oauth.js";
import type { ArtifactSnapshot, ConnectorSpec } from "../fakes/world.js";
import { freePort } from "../support/serve.js";

/** An artifact a task starts with, created through the connector before the agent arrives. */
interface SeedArtifact {
  id: string;
  title: string;
  kind: "html" | "markdown";
  source: string;
  documents?: Record<string, unknown>;
}

/** What a task's `deployment.artifacts` may say; its presence switches the module on. */
interface ArtifactsTaskOptions {
  seed?: SeedArtifact[];
}

export interface Deployment {
  kind: string;
  origin: string;
  mcpUrl: string;
  token: string;
  programs: ProgramObservation[];
  /** The operator saving a credential in the connection page. */
  openConnect(url: string): Promise<void>;
  setCredential(connectorId: string, value: string): Promise<void>;
  /** Present when the task switched the artifacts module on. */
  artifacts?: {
    snapshot(): Promise<ArtifactSnapshot>;
    runDueAfterWeek(): Promise<void>;
  };
  close(): Promise<void>;
}

async function snapshotOf(store: ArtifactStore): Promise<ArtifactSnapshot> {
  const body = async (key: string | undefined) =>
    key === undefined ? "" : ((await store.body(key)) ?? "");
  const out: ArtifactSnapshot["artifacts"] = [];
  let after: string | undefined;
  for (;;) {
    const page = await store.heads({ ...(after === undefined ? {} : { after }), limit: 100 });
    for (const { id, head } of page.heads) {
      const views = [head.view, ...(await store.versions(id, "view", { below: head.view.version, limit: 1000 }))];
      const documents: Record<string, unknown> = {};
      const documentHistory: ArtifactSnapshot["artifacts"][number]["documentHistory"] = {};
      for (const [name, latest] of Object.entries(head.documents)) {
        const records = [latest, ...(await store.versions(id, `doc:${name}`, { below: latest.version, limit: 1000 }))];
        documentHistory[name] = await Promise.all(
          records.map(async (record) => ({
            version: record.version,
            op: record.op,
            ...(record.runId ? { runId: record.runId } : {}),
            value: record.removed ? null : (JSON.parse(await body(record.body)) as unknown),
          })),
        );
        if (!latest.removed) documents[name] = documentHistory[name]?.[0]?.value;
      }
      out.push({
        id,
        title: head.title,
        kind: head.kind,
        archived: head.archived,
        revision: head.revision,
        source: await body(head.view.body),
        views: await Promise.all(
          views.map(async (record) => ({
            version: record.version,
            op: record.op,
            by: record.by,
            source: await body(record.body),
          })),
        ),
        documents,
        documentHistory,
        ...(head.refresh ? { refresh: {
          schedule: head.refresh.schedule,
          document: head.refresh.document,
          programVersion: head.refresh.program.version,
        } } : {}),
        runs: (await store.runs(id, 50)).map((run) => ({
          runId: run.runId,
          status: run.status,
          trigger: run.trigger === "schedule" ? "schedule" as const : "manual" as const,
          ...(run.documentVersion !== undefined ? { documentVersion: run.documentVersion } : {}),
          ...(run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
        })),
      });
    }
    if (page.next === undefined) return { artifacts: out };
    after = page.next;
  }
}

/**
 * `extra` is a task's untyped passthrough, spread over the config last, so a
 * later phase's task can switch on a config key this adapter has never heard
 * of without a harness change. `artifacts` is the exception: the adapter owns
 * the store the graders read, so it builds the module itself.
 */
export async function startNodeDeployment(
  connectors: ConnectorSpec[],
  extra: Record<string, unknown> = {},
  oauth?: FakeOAuth,
): Promise<Deployment> {
  const { artifacts: artifactOptions, pool, ...passthrough } = extra as {
    artifacts?: ArtifactsTaskOptions;
  } & Record<string, unknown>;
  const dir = await mkdtemp(join(tmpdir(), "connecta-eval-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const storage = sqliteStorage(join(dir, "connecta.sqlite"));
  const { token } = await new AccessTokenManager(storage).create("eval-machine", "eval-provisioning");
  const vault = encryptedCredentialVault(storage, randomBytes(32).toString("base64"));
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const artifactStore = artifactOptions ? kvArtifactStore(storage) : undefined;
  const artifactsModule = artifactStore ? artifacts({ store: artifactStore }) : undefined;
  const observed = observedExecutor();
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
    connectors: [...(oauth ? [oauth.connector()] : []), ...connectors.map((spec) =>
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
    )],
    ...(artifactsModule ? { artifacts: artifactsModule } : {}),
    ...(passthrough as Partial<Parameters<typeof createConnecta>[0]>),
  });
  for (const spec of connectors) {
    if (spec.credential?.value) {
      await vault.set(spec.id, spec.credential.value, "operator");
    }
  }
  for (const seed of artifactOptions?.seed ?? []) {
    // Through the connector, so a seed is validated exactly like a write.
    await artifactsModule?.connector.callTool("create_artifact", seed, {
      storage,
      logger: quiet,
      baseUrl: origin,
    });
  }
  const server = listen(connecta, { port, host: "127.0.0.1", gracefulShutdown: false });
  await once(server, "listening");
  return {
    kind: "node-template-shape",
    programs: observed.programs,
    origin,
    mcpUrl: `${origin}/mcp${typeof pool === "string" ? `/${pool}` : ""}`,
    token: oauth?.token ?? token,
    openConnect: async url => {
      const target = new URL(url);
      if (target.origin !== origin || target.pathname !== "/connect/oauth" || !oauth) throw new Error("Unexpected eval connection URL");
      target.searchParams.set("start", "1");
      const response = await fetch(target, { headers: { Cookie: `__session=${oauth.token}` }, redirect: "manual" });
      await response.body?.cancel();
      if (response.status >= 400 || !oauth.connected) throw new Error(`Fake /connect visit failed: ${response.status}`);
      oauth.visits += 1;
    },
    setCredential: async (connectorId, value) => {
      await vault.set(connectorId, value, "operator");
    },
    ...(artifactStore
      ? { artifacts: {
        snapshot: () => snapshotOf(artifactStore),
        runDueAfterWeek: async () => {
          for (const { id, head } of (await artifactStore.heads({ limit: 1_000 })).heads) {
            if (!head.refresh) continue;
            const current = await artifactStore.head(id);
            if (!current?.head.refresh) continue;
            const at = new Date(Date.now() - 8 * 86_400_000).toISOString();
            const refresh = current.head.refresh;
            await artifactStore.swapHead(id, current.token, {
              ...current.head,
              refresh: { ...refresh,
                ...(refresh.last ? { last: { ...refresh.last, at } } : { configuredAt: at }),
              },
            });
          }
          await artifactsModule?.runDue();
        },
      } }
      : {}),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await connecta.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
