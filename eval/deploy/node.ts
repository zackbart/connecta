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
import {
  artifacts,
  kvArtifactStore,
  type ArtifactStore,
} from "@zackbart/connecta/artifacts";
import { bearerToken } from "@zackbart/connecta/auth/bearer";
import { encryptedCredentialVault } from "@zackbart/connecta/credentials";
import { fileStorage, listen } from "@zackbart/connecta/node";
import { quickJsExecutor } from "@zackbart/connecta/quickjs";
import { operatorUi } from "@zackbart/connecta/ui";
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
  /** The operator saving a credential in the connection page. */
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
): Promise<Deployment> {
  const { artifacts: artifactOptions, ...passthrough } = extra as {
    artifacts?: ArtifactsTaskOptions;
  } & Record<string, unknown>;
  const dir = await mkdtemp(join(tmpdir(), "connecta-eval-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const token = randomBytes(18).toString("base64url");
  const storage = fileStorage(join(dir, "state.json"));
  const vault = encryptedCredentialVault(storage, randomBytes(32).toString("base64"));
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const artifactStore = artifactOptions ? kvArtifactStore(storage) : undefined;
  const artifactsModule = artifactStore ? artifacts({ store: artifactStore }) : undefined;
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
    origin,
    mcpUrl: `${origin}/mcp`,
    token,
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
