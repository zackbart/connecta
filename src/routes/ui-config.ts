import { activityEventVisible } from "./activity-disclosure.js";
import { operatorActivityContext } from "./activity-context.js";
import { bindActivityRequest } from "../activity-request.js";
import { configValuePaths } from "../config-value-sources.js";
import { Effect } from "effect";
import type { ActivityOutcome, ActivityRequestContext } from "../activity.js";
import type { ConnectorAccess } from "../connector-access.js";
import { describedTools } from "../described.js";
import { resolveDiscoveryConcurrency } from "../concurrency.js";
import type {
  OperatorConnectorOverlay,
  OperatorGrant,
  OperatorPool,
  OperatorUiContract,
} from "../operator-ui/contract.js";
import { recordedToolName } from "../operator-record.js";
import type { RegistryView } from "../registry.js";
import { closeScope } from "../runtime/connector-scope.js";
import { withDeadlineEffect } from "../runtime/run.js";
import type { Connector } from "../types.js";
import { uiProblemFor } from "../ui.js";
import { authorized, refuse, serveOperator, visibleRegistry, type Answer, type Authorized } from "./operator.js";
import { managesAgentTokens, mayManageConnector, privateJson, readsActivity, type RouteContext } from "./shared.js";

const attempt = <A>(operation: () => Promise<A>) => Effect.tryPromise({ try: operation, catch: (error) => error });
const validName = (name: string) => recordedToolName({ name }) === name;

function grants(access: ConnectorAccess, ids: readonly string[]): OperatorGrant[] {
  return ids
    .filter((id) => access.connectorIds === "all" || access.connectorIds.includes(id))
    .map((connectorId) => {
      const tools = access.toolAccess?.get(connectorId);
      return {
        connectorId,
        tools: tools ? [...tools].filter(validName).map((name) => ({ name, requireReadOnly: false })) : "all",
      };
    });
}

function observe(
  context: RouteContext,
  registry: RegistryView,
  connector: Connector,
  activity: ActivityRequestContext | undefined,
): Effect.Effect<OperatorConnectorOverlay> {
  const { opts, baseUrl, request, defer } = context;
  const scope = {};
  if (activity) bindActivityRequest(scope, activity);
  const id = connector.id;
  return withDeadlineEffect(
    (signal) =>
      Effect.gen(function* () {
        const drift = yield* attempt(() => registry.credentialDriftFor(id));
        const status = drift
          ? { state: "auth_required" as const }
          : yield* attempt(() => registry.statusFor(id, baseUrl, scope, { signal, ...(defer ? { defer } : {}) }));
        let catalogFailed = false;
        const tools =
          status.state === "ok"
            ? yield* attempt(() => registry.getTools(id, baseUrl, scope, { signal, ...(defer ? { defer } : {}) })).pipe(
                Effect.catch(() => {
                  catalogFailed = true;
                  return Effect.succeed([]);
                }),
              )
            : [];
        const problem = uiProblemFor(connector, status.state, { credentialDrift: Boolean(drift), catalogFailed });
        return {
          id,
          status: status.state,
          ...(status.registrationPath ? { auth: { registrationPath: status.registrationPath } } : {}),
          ...(problem ? { problem } : {}),
          // Catalog metadata is allowed for authenticated operators. Only the name
          // and its derived address are withheld when they fail the record grammar.
          tools: describedTools(tools).map((tool) => {
            const name = recordedToolName(tool);
            return {
              ...tool,
              name,
              address: `${id}.${name}`,
              classification: tool.classification === "read" ? ("read" as const) : ("write" as const),
            };
          }),
          catalogAgeMs: registry.catalogAgeMs(id),
          lastCall: null,
        };
      }),
    {
      timeoutMs: opts.config.discovery.probeTimeoutMs,
      signal: request.signal,
      timeoutError: new Error("Operator config observation timed out."),
    },
  ).pipe(
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.catch(() =>
      Effect.succeed<OperatorConnectorOverlay>({
        id,
        status: "error",
        problem: "connector_unavailable",
        tools: [],
        catalogAgeMs: registry.catalogAgeMs(id),
        lastCall: null,
      }),
    ),
    Effect.ensuring(Effect.suspend(() => closeScope(connector, registry.contextFor(id, baseUrl, scope), defer))),
  );
}

const OUTCOMES: ReadonlySet<ActivityOutcome> = new Set([
  "success",
  "error",
  "timeout",
  "cancelled",
  "paused",
  "approved",
]);
const isTimestamp = (value: string) =>
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));

function lastCalls(
  context: RouteContext,
  authz: Authorized,
  registry: RegistryView,
  rows: OperatorConnectorOverlay[],
): Effect.Effect<OperatorUiContract["live"]["activity"]> {
  const activity = context.opts.config.activity;
  if (!activity?.store.list) return Effect.succeed("unconfigured");
  if (!readsActivity(context.opts, authz)) return Effect.succeed("forbidden");
  return Effect.gen(function* () {
    const permitted = activity.readGate
      ? yield* attempt(async () => (await activity.readGate!(authz.actor)) === true).pipe(
          Effect.orElseSucceed(() => false),
        )
      : true;
    if (!permitted) return "forbidden" as const;
    return yield* Effect.gen(function* () {
      const byId = new Map(rows.map((row) => [row.id, row]));
      let cursor: string | undefined;
      const seen = new Set<string>();
      // Bound the read even when a custom reader repeats a cursor or ignores
      // its requested page size. Each page belongs to the request fiber, so
      // cancellation cannot start the next page.
      for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
        const page = yield* attempt(() => activity.store.list!({ limit: 100, ...(cursor ? { cursor } : {}) }));
        for (const event of page.events.slice(0, 100)) {
          if (event.kind === "catalog_drift") continue;
          const row = byId.get(event.connectorId);
          if (!row || !isTimestamp(event.occurredAt) || !OUTCOMES.has(event.outcome)) continue;
          if (!activityEventVisible(context, authz, registry, event)) continue;
          if (!row.lastCall || event.occurredAt > row.lastCall.at)
            row.lastCall = { at: event.occurredAt, outcome: event.outcome };
        }
        cursor = page.nextCursor;
        if (!cursor || seen.has(cursor)) break;
        seen.add(cursor);
      }
      return "available" as const;
    }).pipe(
      Effect.catchDefect((defect) => Effect.fail(defect)),
      Effect.orElseSucceed(() => {
        for (const row of rows) row.lastCall = null;
        return "unavailable" as const;
      }),
    );
  });
}

function configRead(context: RouteContext): Effect.Effect<Response, Answer> {
  const { opts } = context;
  return Effect.gen(function* () {
    const authz = yield* authorized(context);
    const registry = yield* visibleRegistry(context, authz);
    const selected = context.url.searchParams.get("connector");
    const visible = registry.listConnectors().filter((connector) => selected === null || connector.id === selected);
    if (selected !== null && visible.length === 0) return yield* refuse("unknown connector", 404);
    const ids = visible.map((c) => c.id);
    // Only maintainers reach here (#837), and a maintainer's view is every
    // pool's declared tools, never intersected with anything else.
    const pools: OperatorPool[] = [...opts.pools].map(([name, pool]) => ({
      name,
      path: `/mcp/${name}`,
      readOnly: pool.readOnly,
      grants: grants(pool.access, ids),
    }));
    // Contract v1 still names whether code gates plain /mcp; maintainers do
    // whenever inbound auth is configured. describeConfig() no longer says.
    const config = { ...structuredClone(opts.configDescription), hasGrant: opts.config.auth.length > 0 };
    // A connector-filtered read (`?connector=`) discloses only that connector.
    config.connectors = config.connectors
      .filter((c) => ids.includes(c.id))
      .map((c) => ({
        ...c,
        ...(c.tools ? { tools: c.tools.filter((tool) => validName(tool.name)) } : {}),
      }));
    config.classification = Object.fromEntries(
      Object.entries(config.classification)
        .filter(([id]) => ids.includes(id))
        .map(([id, tools]) => [id, Object.fromEntries(Object.entries(tools).filter(([name]) => validName(name)))]),
    );
    config.pools = config.pools.map((pool) => ({
      ...pool,
      tools: (pools.find((p) => p.name === pool.name)?.grants ?? []).flatMap((grant) =>
        grant.tools === "all" ? [grant.connectorId] : grant.tools.map((tool) => `${grant.connectorId}.${tool.name}`),
      ),
    }));
    const requestActivity = operatorActivityContext(context, authz);
    const rows = yield* Effect.forEach(visible, (c) => observe(context, registry, c, requestActivity), {
      concurrency: resolveDiscoveryConcurrency(opts.config.discovery.concurrency),
    });
    const activity = yield* lastCalls(context, authz, registry, rows);
    const contract: OperatorUiContract = {
      schemaVersion: 1,
      config,
      configSources: Object.fromEntries(
        configValuePaths(config).map((path) => [
          path,
          // hasGrant is v1's own leaf: code sets it exactly when inbound auth is configured.
          path === "config.hasGrant"
            ? config.hasGrant
              ? "config"
              : "default"
            : (opts.configValueSources?.[path] ?? "config"),
        ]),
      ),
      live: { connectors: rows, activity },
      you: {
        interactive: authz.identity.interactive,
        grants: grants({ connectorIds: "all" }, ids),
        readOnly: opts.config.readOnly,
        pools,
        permissions: {
          activity: activity === "available" || activity === "unavailable",
          accessTokenManagement: Boolean(opts.config.accessTokens) && managesAgentTokens(opts, authz),
          connectors: visible.map((c) => ({
            id: c.id,
            use: true,
            manageSharedAuth: c.authScope !== "personal" && mayManageConnector(opts, authz, c),
            connectPersonal: c.authScope === "personal" && mayManageConnector(opts, authz, c),
          })),
        },
      },
    };
    return privateJson(contract);
  });
}

export async function routeUiConfig(context: RouteContext): Promise<Response | null> {
  if (context.path !== "/ui/api/config") return null;
  if (context.request.method !== "GET") return privateJson({ error: "method not allowed" }, { status: 405 });
  return serveOperator(configRead(context), context.request.signal);
}
