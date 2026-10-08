import { activityEventVisible } from "./activity-disclosure.js";
import { operatorActivityContext } from "./activity-context.js";
import { bindActivityRequest } from "../activity-request.js";
import { configValuePaths } from "../config-value-sources.js";
import { Effect } from "effect";
import type { ActivityOutcome, ActivityRequestContext } from "../activity.js";
import { intersectAccess, type ConnectorAccess } from "../connector-access.js";
import { describedTools } from "../described.js";
import { resolveDiscoveryConcurrency } from "../concurrency.js";
import type { OperatorConnectorOverlay, OperatorGrant, OperatorPool, OperatorUiContract } from "../operator-ui/contract.js";
import { recordedToolName } from "../operator-record.js";
import type { RegistryView } from "../registry.js";
import { closeScope } from "../runtime/connector-scope.js";
import { withDeadlineEffect } from "../runtime/run.js";
import type { Connector } from "../types.js";
import { uiProblemFor } from "../ui.js";
import { authorized, serveOperator, visibleRegistry, type Answer, type Authorized } from "./operator.js";
import { mayManageConnector, mayViewArtifacts, privateJson, type RouteContext } from "./shared.js";

const attempt = <A>(operation: () => Promise<A>) => Effect.tryPromise({ try: operation, catch: (error) => error });
const validName = (name: string) => recordedToolName({ name }) === name;

function grants(access: ConnectorAccess, ids: readonly string[]): OperatorGrant[] {
  return ids.filter(id => access.connectorIds === "all" || access.connectorIds.includes(id)).map(connectorId => {
    const tools = access.toolAccess?.get(connectorId);
    return {
      connectorId,
      tools: tools ? [...tools].filter(validName).map(name => ({
        name, requireReadOnly: access.guardedToolAccess?.get(connectorId)?.has(name) === true,
      })) : "all",
    };
  });
}

function toolVisible(authz: Authorized, id: string, name: string, classification?: "read" | "write"): boolean {
  return validName(name) && (!authz.toolAccess?.get(id) || authz.toolAccess.get(id)!.has(name)) &&
    (!authz.guardedToolAccess?.get(id)?.has(name) || classification === "read");
}

function observe(context: RouteContext, registry: RegistryView, connector: Connector, activity: ActivityRequestContext | undefined): Effect.Effect<OperatorConnectorOverlay> {
  const { opts, baseUrl, request, defer } = context;
  const scope = {};
  if (activity) bindActivityRequest(scope, activity);
  const id = connector.id;
  return withDeadlineEffect(signal => Effect.gen(function* () {
    const drift = yield* attempt(() => registry.credentialDriftFor(id));
    const status = drift ? { state: "auth_required" as const } : yield* attempt(() => registry.statusFor(id, baseUrl, scope, { signal, ...(defer ? { defer } : {}) }));
    let catalogFailed = false;
    const tools = status.state === "ok" ? yield* attempt(() => registry.getTools(id, baseUrl, scope, { signal, ...(defer ? { defer } : {}) })).pipe(
      Effect.catch(() => { catalogFailed = true; return Effect.succeed([]); }),
    ) : [];
    const problem = uiProblemFor(connector, status.state, { credentialDrift: Boolean(drift), catalogFailed });
    return {
      id,
      status: status.state,
      ...(status.registrationPath ? { auth: { registrationPath: status.registrationPath } } : {}),
      ...(problem ? { problem } : {}),
      // Catalog metadata is allowed for authenticated operators. Only the name
      // and its derived address are withheld when they fail the record grammar.
      tools: describedTools(tools).map(tool => {
        const name = recordedToolName(tool);
        return { ...tool, name, address: `${id}.${name}`, classification: tool.classification === "read" ? "read" as const : "write" as const };
      }),
      catalogAgeMs: registry.catalogAgeMs(id),
      lastCall: null,
    };
  }), {
    timeoutMs: opts.config.discovery.probeTimeoutMs,
    signal: request.signal,
    timeoutError: new Error("Operator config observation timed out."),
  }).pipe(
    Effect.catchDefect(defect => Effect.fail(defect)),
    Effect.catch(() => Effect.succeed<OperatorConnectorOverlay>({ id, status: "error", problem: "connector_unavailable", tools: [], catalogAgeMs: registry.catalogAgeMs(id), lastCall: null })),
    Effect.ensuring(Effect.suspend(() => closeScope(connector, registry.contextFor(id, baseUrl, scope), defer))),
  );
}

const OUTCOMES: ReadonlySet<ActivityOutcome> = new Set(["success", "error", "timeout", "cancelled", "paused", "approved"]);
const isTimestamp = (value: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));

function lastCalls(context: RouteContext, authz: Authorized, registry: RegistryView, rows: OperatorConnectorOverlay[], admittedPools: ReadonlySet<string>): Effect.Effect<OperatorUiContract["live"]["activity"]> {
  const activity = context.opts.config.activity;
  if (!activity?.store.list) return Effect.succeed("unconfigured");
  if (!authz.operator) return Effect.succeed("forbidden");
  return Effect.gen(function* () {
    const permitted = activity.readGate
      ? yield* attempt(async () => await activity.readGate!(authz.actor) === true).pipe(Effect.orElseSucceed(() => false))
      : true;
    if (!permitted) return "forbidden" as const;
    return yield* Effect.gen(function* () {
      const byId = new Map(rows.map(row => [row.id, row]));
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
          if (!activityEventVisible(context, authz, registry, admittedPools, event)) continue;
          if (!row.lastCall || event.occurredAt > row.lastCall.at) row.lastCall = { at: event.occurredAt, outcome: event.outcome };
        }
        cursor = page.nextCursor;
        if (!cursor || seen.has(cursor)) break;
        seen.add(cursor);
      }
      return "available" as const;
    }).pipe(
      Effect.catchDefect(defect => Effect.fail(defect)),
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
    const visible = registry.listConnectors();
    const ids = visible.map(c => c.id);
    const pools: OperatorPool[] = [];
    for (const [name, pool] of opts.pools) {
      const admitted = yield* attempt(async () => await pool.grant(authz.identity) === true).pipe(Effect.orElseSucceed(() => false));
      if (admitted) pools.push({ name, path: `/mcp/${name}`, trust: pool.trust, grants: grants(intersectAccess(authz, pool.access), ids) });
    }
    const config = structuredClone(opts.configDescription);
    config.connectors = config.connectors.filter(c => ids.includes(c.id)).map(c => ({
      ...c,
      ...(c.tools ? { tools: c.tools.filter(tool => toolVisible(authz, c.id, tool.name, tool.classification)) } : {}),
    }));
    config.classification = Object.fromEntries(Object.entries(config.classification).filter(([id]) => ids.includes(id)).map(([id, tools]) => [id,
      Object.fromEntries(Object.entries(tools).filter(([name, classification]) => toolVisible(authz, id, name, classification))),
    ]));
    config.pools = config.pools.flatMap(pool => {
      const admitted = pools.find(p => p.name === pool.name);
      if (!admitted) return [];
      return [{ ...pool, tools: admitted.grants.flatMap(grant => grant.tools === "all" ? [grant.connectorId] : grant.tools.map(tool => `${grant.connectorId}.${tool.name}`)) }];
    });
    const requestActivity = operatorActivityContext(context, authz);
    const rows = yield* Effect.forEach(visible, c => observe(context, registry, c, requestActivity), { concurrency: resolveDiscoveryConcurrency(opts.config.discovery.concurrency) });
    const activity = yield* lastCalls(context, authz, registry, rows, new Set(pools.map(pool => pool.name)));
    const contract: OperatorUiContract = {
      schemaVersion: 1,
      config,
      configSources: Object.fromEntries(configValuePaths(config).map(path => [path, opts.configValueSources?.[path] ?? "config"])),
      live: { connectors: rows, activity },
      you: {
        interactive: authz.identity.interactive,
        grants: grants(authz, ids),
        trust: opts.config.trust,
        pools,
        permissions: {
          activity: activity === "available" || activity === "unavailable",
          accessTokenManagement: Boolean(opts.config.accessTokens && authz.accessTokenManagement && authz.identity.principal),
          artifacts: Boolean(opts.config.artifacts && mayViewArtifacts(authz, opts.registry)),
          connectors: visible.map(c => ({ id: c.id, use: true,
            manageSharedAuth: c.authScope !== "personal" && mayManageConnector(authz, c),
            connectPersonal: c.authScope === "personal" && mayManageConnector(authz, c),
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
