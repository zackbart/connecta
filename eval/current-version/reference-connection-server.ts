/**
 * The isolated deployment the reference-connection cases run against.
 *
 * This server exists to answer the last open acceptance criterion of #297: a
 * cold agent must be able to discover and use a maintained prebuilt connection
 * without avoidable repair. Everything here is the real thing except the
 * network at the far end — the connection is built by the real `cloudflare()`
 * constructor, with its real schemas, annotations, projections, admission
 * policy, usage guide, and error mapping, and only its documented `baseUrl`
 * option is redirected at the local double in `cloudflare-fixture.ts`.
 *
 * It is deliberately a second server rather than more connectors inside
 * `sandbox-server.ts`. That sandbox's catalog is the ranking pool for the
 * held-out discovery corpus, which is gated release evidence and explicitly
 * must not be tuned against; adding twenty-eight real Cloudflare tools to it
 * would perturb the corpus by another name. Keeping the catalogs apart is what
 * lets the reference-connection numbers and the release-audit numbers both
 * stay honest.
 *
 * Two instances of the same connection are registered on purpose. They give
 * the unavailable-auth case a genuinely separate credential to fail on, and
 * they exercise the same per-connector-id isolation the provider suites pin.
 */
import { once } from "node:events";

import {
  bearerToken,
  createConnecta,
  memoryStorage,
  type ToolCallActivityEvent,
} from "../../src/index.js";
import { CredentialVault } from "../../src/credentials.js";
import { cloudflare } from "../../src/providers/cloudflare.js";
import { quickJsExecutor } from "../../src/executors/quickjs.js";
import { listen } from "../../src/node.js";
import { createEvalTracing } from "./eval-tracing.js";
import { startCloudflareFixture } from "./cloudflare-fixture.js";

const token = process.env["CONNECTA_EVAL_TOKEN"] ?? "connecta-eval-token";
const sourceCommit =
  process.env["CONNECTA_EVAL_SOURCE_COMMIT"] ?? "working-tree";
const traceEnabled = process.env["CONNECTA_EVAL_TRACE"] === "enabled";
const port = Number(process.env["CONNECTA_EVAL_PORT"] ?? "0");
const host = "127.0.0.1";

/**
 * Fixture credentials. Both are literals in an isolated process talking to a
 * loopback double; neither is a secret, and neither reaches a real provider.
 */
const EDGE_TOKEN = "cf-eval-edge-token";
const PARTNER_TOKEN = "cf-eval-partner-rotated-token";

const credentialEncryptionKey = Buffer.alloc(32, 11).toString("base64");
const storage = memoryStorage();
const activityEvents: ToolCallActivityEvent[] = [];
const tracing = createEvalTracing({ enabled: traceEnabled, token });

const fixture = await startCloudflareFixture({
  validToken: EDGE_TOKEN,
  revokedToken: PARTNER_TOKEN,
});

const edge = cloudflare("cloudflare-edge", {
  title: "Cloudflare — Eval Edge",
  purpose:
    "the production edge estate behind connecta-eval.test; read zones, DNS records, and platform inventory, and make DNS changes only with approval",
  baseUrl: fixture.baseUrl,
  instructions:
    "This estate owns connecta-eval.test and its staging subdomain. Resolve a zone id with list_zones before any zone-scoped call.",
});

const partner = cloudflare("cloudflare-partner", {
  title: "Cloudflare — Partner Estate",
  purpose:
    "a partner-managed estate whose API token was rotated out of this deployment and has not yet been replaced",
  baseUrl: fixture.baseUrl,
});

const baseExecutor = quickJsExecutor({ timeoutMs: 10_000, cpuTimeMs: 2_000 });
const executor = traceEnabled
  ? tracing.tracedExecutor(baseExecutor)
  : baseExecutor;

const connecta = createConnecta({
  auth: [bearerToken(token, { subjectId: "reference-connection-evaluator" })],
  connectors: [edge, partner],
  storage,
  executor,
  credentials: { encryptionKey: credentialEncryptionKey },
  calls: {
    defaultTimeoutMs: 15_000,
    // Generous on purpose. The dependent-read case must measure whether a cold
    // agent chooses to reduce in-program, not whether Connecta truncated the
    // listing for it — a budget that forces the right answer measures nothing.
    maxResultBytes: 32_000,
  },
  activity: {
    deploymentId: "reference-connection-eval",
    store: {
      record(event) {
        activityEvents.push(event);
        tracing.emitTrace({
          kind: "execution",
          address: event.address,
          source: event.source,
          outcome: event.outcome,
          durationMs: event.durationMs,
          attempts: event.attempts,
          ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        });
      },
      async list({ limit }) {
        return { events: activityEvents.slice(-limit).reverse() };
      },
    },
  },
  serverInfo: {
    name: "connecta-reference-connection-eval",
    version: sourceCommit.slice(0, 12),
    title: "Connecta reference-connection eval sandbox",
  },
  deploymentInfo: { sourceCommit, isolated: true },
});

/**
 * Seed the operator vault directly. The connection reads its token through
 * `ctx.credential.get()` like any deployment; the only thing skipped is the
 * human at /credentials. The partner estate is seeded with a token the double
 * rejects, so its failure is the provider's real 401 mapping rather than the
 * "no credential configured" branch — those are different findings and the
 * lane should measure the one an operator actually meets.
 */
const vault = new CredentialVault(storage, credentialEncryptionKey);
await vault.set("cloudflare-edge", EDGE_TOKEN, "reference-connection-eval");
await vault.set("cloudflare-partner", PARTNER_TOKEN, "reference-connection-eval");
await connecta.registry.invalidateStored("cloudflare-edge");
await connecta.registry.invalidateStored("cloudflare-partner");

const traced = traceEnabled ? tracing.withOuterTracing(connecta) : connecta;
const server = listen(
  {
    ...traced,
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      // Downstream evidence, kept separate from the meta-tool trace: it answers
      // "what actually reached the provider API, and with which token", which
      // is how the write-routing case proves no unapproved write got through.
      if (request.method === "GET" && url.pathname === "/__eval/downstream") {
        if (request.headers.get("authorization") !== `Bearer ${token}`) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return Response.json({
          requests: fixture.requests.map((entry) => ({
            method: entry.method,
            path: entry.path,
            connection:
              entry.token === EDGE_TOKEN
                ? "cloudflare-edge"
                : entry.token === PARTNER_TOKEN
                  ? "cloudflare-partner"
                  : "unknown",
          })),
        });
      }
      return traced.fetch(request, env, ctx);
    },
  },
  { port, host, gracefulShutdown: false },
);
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Reference-connection eval server did not expose a TCP address.");
}

console.log(
  JSON.stringify({
    event: "ready",
    url: `http://${host}:${address.port}/mcp`,
    baseUrl: `http://${host}:${address.port}`,
    sourceCommit,
    connectorCount: 2,
    downstream: fixture.baseUrl,
    traceEnabled,
  }),
);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await connecta.close();
  await fixture.close();
}

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
