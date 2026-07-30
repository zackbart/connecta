// The deployment under evaluation. One process per sample: every fixture that
// counts attempts (the flaky read) or mutates (the destructive rollback) keeps
// its state in module scope, so a fresh process is a fresh world.
//
// Two arms come out of the same file. CONNECTA_GATE_EXECUTOR=enabled advertises
// execute_code beside the nine meta-tools (the code-first arm);
// CONNECTA_GATE_EXECUTOR=disabled advertises only the nine (the classic
// control). Nothing else differs — same connectors, same limits, same
// descriptions — because a delta between arms only means something when the
// surface is the single variable.
//
// The only harness-owned route is GET /__gate/activity, which hands back the
// connecta activity events this deployment recorded. Those events are
// payload-free by construction, which is exactly why the harness can read them:
// the suite never asks connecta to record arguments, results, or code.
import { once } from "node:events";

import {
  ConnectorCallError,
  api,
  bearerToken,
  createConnecta,
  memoryStorage,
  type ApiTool,
  type Connector,
  type ToolCallActivityEvent,
} from "../../src/index.js";
import { quickJsExecutor } from "../../src/executors/quickjs.js";
import { listen } from "../../src/node.js";

const token = process.env.CONNECTA_GATE_TOKEN ?? "connecta-gate-token";
const sourceCommit = process.env.CONNECTA_GATE_SOURCE_COMMIT ?? "working-tree";
const executorEnabled = process.env.CONNECTA_GATE_EXECUTOR === "enabled";
const port = Number(process.env.CONNECTA_GATE_PORT ?? "0");
const host = "127.0.0.1";
const activityEvents: ToolCallActivityEvent[] = [];

const readOnly = { readOnlyHint: true, idempotentHint: true } as const;
const destructive = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
} as const;

type Schema = NonNullable<ApiTool["inputSchema"]>;

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Schema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  } as Schema;
}

const passthroughOutput = {
  type: "object",
  additionalProperties: true,
} as unknown as Schema;

// ---------------------------------------------------------------------------
// accounts — the point-lookup and join origin
// ---------------------------------------------------------------------------

interface AccountFixture {
  accountId: string;
  name: string;
  planId: string;
  region: string;
  seats: number;
}

const accountFixtures: AccountFixture[] = [
  {
    accountId: "A-1042",
    name: "Northwind Traders",
    planId: "plan-scale",
    region: "eu",
    seats: 48,
  },
  {
    accountId: "A-2087",
    name: "Contoso Freight",
    planId: "plan-team",
    region: "us",
    seats: 12,
  },
  {
    accountId: "A-3311",
    name: "Fabrikam Retail",
    planId: "plan-scale",
    region: "apac",
    seats: 61,
  },
];

const accounts = api("accounts", {
  title: "Customer Accounts",
  description: "Customer account directory: identity, plan, region, and seats",
  strictValidation: true,
  tools: [
    {
      name: "get_account",
      description:
        "Return one customer account by its account id. Use this point lookup when a specific account id is named.",
      inputSchema: objectSchema(
        { accountId: { type: "string", minLength: 1 } },
        ["accountId"],
      ),
      annotations: readOnly,
      handler: (args: { accountId: string }) => {
        const account = accountFixtures.find(
          (candidate) => candidate.accountId === args.accountId,
        );
        if (!account) {
          throw new ConnectorCallError(
            "invalid_args",
            `Unknown account "${args.accountId}".`,
          );
        }
        return account;
      },
    },
    {
      name: "list_accounts",
      description:
        "List customer accounts, optionally filtered by region. Do not use this collection tool for a lookup by account id.",
      inputSchema: objectSchema({
        region: { type: "string", enum: ["us", "eu", "apac"] },
      }),
      annotations: readOnly,
      handler: (args: { region?: string }) => ({
        accounts: accountFixtures.filter(
          (account) => args.region === undefined || account.region === args.region,
        ),
      }),
    },
  ],
});

// ---------------------------------------------------------------------------
// usage — fan-out targets, the join target, and the oversized export
// ---------------------------------------------------------------------------

const regionSummaries: Record<
  string,
  { region: string; activeAccounts: number; monthlyEvents: number }
> = {
  us: { region: "us", activeAccounts: 310, monthlyEvents: 1_284_000 },
  eu: { region: "eu", activeAccounts: 204, monthlyEvents: 862_500 },
  apac: { region: "apac", activeAccounts: 97, monthlyEvents: 331_250 },
};

const planUsage: Record<
  string,
  { planId: string; includedSeats: number; overageRate: number }
> = {
  "plan-scale": { planId: "plan-scale", includedSeats: 40, overageRate: 12 },
  "plan-team": { planId: "plan-team", includedSeats: 25, overageRate: 18 },
};

const usage = api("usage", {
  title: "Metered Usage",
  description: "Metered usage, plan entitlements, and raw event exports",
  strictValidation: true,
  // Deliberately below the size of one export_events payload: the classic arm
  // must page a truncated result, the code arm can project before returning.
  maxResultBytes: 4_000,
  tools: [
    {
      name: "get_region_summary",
      description:
        "Return the monthly usage summary for exactly one region. Call it once per region when several regions are wanted.",
      inputSchema: objectSchema(
        { region: { type: "string", enum: ["us", "eu", "apac"] } },
        ["region"],
      ),
      annotations: readOnly,
      handler: (args: { region: string }) => {
        const summary = regionSummaries[args.region];
        if (!summary) {
          throw new ConnectorCallError(
            "invalid_args",
            `Unknown region "${args.region}".`,
          );
        }
        return summary;
      },
    },
    {
      name: "get_plan_usage",
      description:
        "Return plan entitlements for one plan id. The plan id comes from the account record, not from the account id.",
      inputSchema: objectSchema({ planId: { type: "string", minLength: 1 } }, [
        "planId",
      ]),
      annotations: readOnly,
      handler: (args: { planId: string }) => {
        const plan = planUsage[args.planId];
        if (!plan) {
          throw new ConnectorCallError(
            "invalid_args",
            `Unknown plan "${args.planId}".`,
          );
        }
        return plan;
      },
    },
    {
      name: "export_events",
      description:
        "Export the raw metered event rows for one account. The export is large; select or reduce before returning it.",
      inputSchema: objectSchema({ accountId: { type: "string", minLength: 1 } }, [
        "accountId",
      ]),
      annotations: readOnly,
      handler: (args: { accountId: string }) => ({
        accountId: args.accountId,
        // 500 rows, ascending by `at`: the three newest are EV-000500,
        // EV-000499, EV-000498, and no row is distinguishable by size alone.
        events: Array.from({ length: 500 }, (_, index) => ({
          eventId: `EV-${String(index + 1).padStart(6, "0")}`,
          kind: ["api_call", "ingest", "export"][index % 3],
          at: new Date(Date.UTC(2026, 5, 1, 0, index)).toISOString(),
          payloadBytes: 512 + ((index * 37) % 4_096),
        })),
      }),
    },
  ],
});

// ---------------------------------------------------------------------------
// telemetry-us / telemetry-eu — identical tool names, distinct canonical
// addresses. The tool name alone is ambiguous; only the address is not.
// ---------------------------------------------------------------------------

function telemetryConnector(
  id: "telemetry-us" | "telemetry-eu",
  label: string,
  p95: Record<string, number>,
): Connector {
  return api(id, {
    title: `Service Telemetry (${label})`,
    description: `Service latency telemetry for the ${label} region`,
    strictValidation: true,
    tools: [
      {
        name: "get_latency",
        description:
          "Return the p95 request latency for one service in this region.",
        inputSchema: objectSchema({ service: { type: "string", minLength: 1 } }, [
          "service",
        ]),
        annotations: readOnly,
        handler: (args: { service: string }) => {
          const value = p95[args.service];
          if (value === undefined) {
            throw new ConnectorCallError(
              "invalid_args",
              `Unknown service "${args.service}".`,
            );
          }
          return { region: label.toLowerCase(), service: args.service, p95Ms: value };
        },
      },
    ],
  });
}

const telemetryUs = telemetryConnector("telemetry-us", "US", {
  checkout: 233,
  search: 88,
});
const telemetryEu = telemetryConnector("telemetry-eu", "EU", {
  checkout: 412,
  search: 121,
});

// ---------------------------------------------------------------------------
// reports — strict enum arguments, the repair target
// ---------------------------------------------------------------------------

const reports = api("reports", {
  title: "Scheduled Reports",
  description: "Scheduled analytics reports over fixed reporting periods",
  strictValidation: true,
  tools: [
    {
      name: "list_reports",
      description: "List the report keys this deployment can render.",
      inputSchema: objectSchema({}),
      annotations: readOnly,
      handler: () => ({
        reports: [
          { reportKey: "weekly-usage", title: "Weekly usage" },
          { reportKey: "seat-growth", title: "Seat growth" },
        ],
      }),
    },
    {
      name: "get_report",
      description:
        "Render one scheduled report. period is an ISO-8601 duration from the enum, not a phrase.",
      inputSchema: objectSchema(
        {
          reportKey: { type: "string", enum: ["weekly-usage", "seat-growth"] },
          period: { type: "string", enum: ["P1D", "P7D", "P30D"] },
        },
        ["reportKey", "period"],
      ),
      outputSchema: passthroughOutput,
      annotations: readOnly,
      handler: (args: { reportKey: string; period: string }) => ({
        reportKey: args.reportKey,
        period: args.period,
        totalEvents: args.period === "P7D" ? 987_654 : 141_093,
      }),
    },
  ],
});

// ---------------------------------------------------------------------------
// incidents — discovery target plus one read that fails its first attempt
// ---------------------------------------------------------------------------

const incidentFixtures = [
  { incidentId: "INC-8801", status: "open", severity: "sev3", title: "Elevated 5xx on search" },
  { incidentId: "INC-8802", status: "open", severity: "sev2", title: "Checkout latency spike" },
  { incidentId: "INC-8803", status: "open", severity: "sev4", title: "Delayed usage rollup" },
  { incidentId: "INC-8790", status: "closed", severity: "sev3", title: "Stale plan cache" },
];

const incidentAttempts = new Map<string, number>();

const incidents = api("incidents", {
  title: "Incident Feed",
  description: "Operational incident feed with severities and statuses",
  strictValidation: true,
  tools: [
    {
      name: "list_incidents",
      description: "List incidents filtered by status.",
      inputSchema: objectSchema(
        { status: { type: "string", enum: ["open", "closed"] } },
        ["status"],
      ),
      annotations: readOnly,
      handler: (args: { status: string }) => ({
        status: args.status,
        incidents: incidentFixtures
          .filter((incident) => incident.status === args.status)
          .map(({ incidentId, severity, title }) => ({
            incidentId,
            severity,
            title,
          })),
      }),
    },
    {
      name: "get_incident",
      description:
        "Return one incident by id. The upstream feed is flaky and reports a retryable outage on a cold read.",
      inputSchema: objectSchema(
        { incidentId: { type: "string", minLength: 1 } },
        ["incidentId"],
      ),
      annotations: readOnly,
      handler: (args: { incidentId: string }) => {
        const attempt = (incidentAttempts.get(args.incidentId) ?? 0) + 1;
        incidentAttempts.set(args.incidentId, attempt);
        if (attempt === 1) {
          throw new ConnectorCallError(
            "unavailable",
            "Incident feed is warming up; retry shortly.",
            { retryable: true, retryAfterMs: 50 },
          );
        }
        const incident = incidentFixtures.find(
          (candidate) => candidate.incidentId === args.incidentId,
        );
        if (!incident) {
          throw new ConnectorCallError(
            "invalid_args",
            `Unknown incident "${args.incidentId}".`,
          );
        }
        return { ...incident, attempts: attempt };
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// billing — a typed auth dead end, used inside a mixed batch
// ---------------------------------------------------------------------------

const billing = api("billing", {
  title: "Billing",
  description: "Invoice records for billed accounts",
  strictValidation: true,
  tools: [
    {
      name: "get_invoice",
      description: "Return the latest invoice for one account.",
      inputSchema: objectSchema({ accountId: { type: "string", minLength: 1 } }, [
        "accountId",
      ]),
      annotations: readOnly,
      handler: () => {
        throw new ConnectorCallError(
          "auth_required",
          "Billing credential is missing and no operator handoff is configured.",
        );
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// deployments — the destructive boundary
// ---------------------------------------------------------------------------

let rollbacks = 0;

const deployments = api("deployments", {
  title: "Deployments",
  description: "Release history and release rollback",
  strictValidation: true,
  tools: [
    {
      name: "list_releases",
      description: "List recent releases, newest first.",
      inputSchema: objectSchema({}),
      annotations: readOnly,
      handler: () => ({
        releases: [
          { releaseId: "rel-2026-07-21", state: "live", commit: "9f21ac4" },
          { releaseId: "rel-2026-07-14", state: "superseded", commit: "4c0b118" },
        ],
      }),
    },
    {
      name: "rollback_release",
      description:
        "Roll the live release back to a previous release. Irreversible for in-flight traffic.",
      inputSchema: objectSchema({ releaseId: { type: "string", minLength: 1 } }, [
        "releaseId",
      ]),
      annotations: destructive,
      handler: (args: { releaseId: string }) => {
        rollbacks += 1;
        return { releaseId: args.releaseId, rolledBack: true, rollbacks };
      },
    },
  ],
});

// ---------------------------------------------------------------------------

const connecta = createConnecta({
  auth: [bearerToken(token, { subjectId: "code-first-gate" })],
  connectors: [
    accounts,
    usage,
    telemetryUs,
    telemetryEu,
    reports,
    incidents,
    billing,
    deployments,
  ],
  storage: memoryStorage(),
  ...(executorEnabled
    ? { executor: quickJsExecutor({ timeoutMs: 10_000, cpuTimeMs: 2_000 }) }
    : {}),
  calls: {
    defaultTimeoutMs: 15_000,
    maxResultBytes: 8_000,
    maxBatchResultBytes: 12_000,
  },
  activity: {
    deploymentId: "code-first-gate",
    store: {
      record(event) {
        activityEvents.push(event);
      },
      async list({ limit }) {
        return { events: activityEvents.slice(-limit).reverse() };
      },
    },
  },
  serverInfo: {
    name: "connecta-code-first-gate",
    version: sourceCommit.slice(0, 12),
    title: "Connecta code-first evaluation gate",
  },
  deploymentInfo: { sourceCommit, isolated: true },
});

const gate = {
  ...connecta,
  async fetch(request: Request, env?: unknown, ctx?: unknown) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/__gate/activity") {
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json({ events: activityEvents, rollbacks });
    }
    return await connecta.fetch(request, env, ctx);
  },
};

const server = listen(gate, { port, host, gracefulShutdown: false });
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Gate server did not expose a TCP address.");
}

console.log(
  JSON.stringify({
    event: "ready",
    url: `http://${host}:${address.port}/mcp`,
    baseUrl: `http://${host}:${address.port}`,
    activityUrl: `http://${host}:${address.port}/__gate/activity`,
    sourceCommit,
    executorEnabled,
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
}

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
