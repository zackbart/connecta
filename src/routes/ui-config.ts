// `GET /ui/api/config`: operator contract v2 (#837, decisions/0006), the
// operator page's only gate. A maintainer gets the unfiltered view; a human
// pool member gets exactly their own projection; anyone else gets the private
// 404 every operator route gives them, and a signed-out caller the auth
// provider's challenge.
import { activityEventVisible } from "./activity-disclosure.js";
import { operatorActivityContext } from "./activity-context.js";
import { actorKey, principalActor, resolveActorLabels } from "./actor-labels.js";
import { bindActivityRequest } from "../activity-request.js";
import { AGENT_NAMESPACE } from "../agent-identity.js";
import { configValuePaths } from "../config-value-sources.js";
import { Effect } from "effect";
import type { ActivityOutcome, ActivityRequestContext } from "../activity.js";
import type { ConnectorAccess } from "../connector-access.js";
import { credentialTestRule, storedCredentialShape } from "../credential-rules.js";
import { describedTools } from "../described.js";
import { resolveDiscoveryConcurrency } from "../concurrency.js";
import { identityStorageKey } from "../identity.js";
import type {
  OperatorAgent,
  OperatorConnectorOverlay,
  OperatorConnectorPoolCell,
  OperatorGrant,
  OperatorMember,
  OperatorMemberConnector,
  OperatorMemberManage,
  OperatorPoolV2,
  OperatorRunsAs,
  OperatorUiContractV2,
} from "../operator-ui/contract.js";
import { oauthConnectUnavailable } from "../oauth-handoff.js";
import { failureRecord, logFailure, recordedToolName } from "../operator-record.js";
import type { RegistryView } from "../registry.js";
import { closeScope } from "../runtime/connector-scope.js";
import { withDeadlineEffect } from "../runtime/run.js";
import type { Connector, ConnectorStatus, IdentityReference, ToolDef } from "../types.js";
import { uiProblemFor } from "../ui.js";
import { workspaceSubjectOf } from "../workspace-subject.js";
import { authorized, refuse, scopeFor, serveOperator, type Answer, type Authorized } from "./operator.js";
import { isMaintainer, isMember, type ResolvedPool } from "../membership.js";
import { admitsMaintainer, mayManageConnector, privateJson, readsActivity, type RouteContext } from "./shared.js";

const attempt = <A>(operation: () => Promise<A>) => Effect.tryPromise({ try: operation, catch: (error) => error });
const validName = (name: string) => recordedToolName({ name }) === name;
const classified = (tool: { classification?: string }) =>
  tool.classification === "read" ? ("read" as const) : ("write" as const);

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

/** Whether a pool serves this connector at all. */
const servesConnector = (pool: ResolvedPool, id: string) =>
  pool.access.connectorIds === "all" || pool.access.connectorIds.includes(id);

/** The humans a pool lists, as references; agents are never people. */
const humansOf = (pool: ResolvedPool): IdentityReference[] =>
  pool.members.flatMap((member) => (member.kind === "human" ? [{ namespace: member.namespace, id: member.id }] : []));

const referenceKey = (reference: IdentityReference) => JSON.stringify([reference.namespace, reference.id]);

/**
 * One bounded probe of a connector, closed however it ends: the work runs
 * under the deployment's probe deadline and the request's signal, a failure
 * or defect becomes `fallback`, and the connector scope it opened is closed.
 */
function probe<A>(
  context: RouteContext,
  registry: RegistryView,
  connector: Connector,
  scope: object,
  work: (signal: AbortSignal) => Effect.Effect<A, unknown>,
  fallback: () => A,
): Effect.Effect<A> {
  const { opts, baseUrl, request, defer } = context;
  return withDeadlineEffect(work, {
    timeoutMs: opts.config.discovery.probeTimeoutMs,
    signal: request.signal,
    timeoutError: new Error("Operator config observation timed out."),
  }).pipe(
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.catch(() => Effect.sync(fallback)),
    Effect.ensuring(
      Effect.suspend(() => closeScope(connector, registry.contextFor(connector.id, baseUrl, scope), defer)),
    ),
  );
}

/**
 * One read the config build makes outside a connector probe — the vault, the
 * token slots, activity — under the same deadline and request signal. A
 * stalled store must never hang the page, so a read that fails, stalls or
 * loses its caller becomes `fallback`, which callers keep fail-closed.
 */
function bounded<A, B, E = never>(
  context: RouteContext,
  read: () => Effect.Effect<A, unknown>,
  fallback: (error: unknown) => Effect.Effect<B, E>,
): Effect.Effect<A | B, E> {
  return withDeadlineEffect(() => read(), {
    timeoutMs: context.opts.config.discovery.probeTimeoutMs,
    signal: context.request.signal,
    timeoutError: new Error("Operator config read timed out."),
  }).pipe(
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.catch(fallback),
  );
}

function requestScope(activity: ActivityRequestContext | undefined): object {
  const scope = {};
  if (activity) bindActivityRequest(scope, activity);
  return scope;
}

/**
 * Status first, then the catalog only when status is ok, as the operator
 * page has always read a connector. `catalogFailed` tells a failed listing
 * apart from an empty one.
 */
function observed(
  context: RouteContext,
  registry: RegistryView,
  connector: Connector,
  scope: object,
  signal: AbortSignal,
): Effect.Effect<{ status: ConnectorStatus; drift: boolean; tools: ToolDef[]; catalogFailed: boolean }, unknown> {
  const { baseUrl, defer } = context;
  const id = connector.id;
  return Effect.gen(function* () {
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
              return Effect.succeed<ToolDef[]>([]);
            }),
          )
        : [];
    return { status, drift: Boolean(drift), tools, catalogFailed };
  });
}

function observe(
  context: RouteContext,
  registry: RegistryView,
  connector: Connector,
  activity: ActivityRequestContext | undefined,
): Effect.Effect<OperatorConnectorOverlay> {
  const scope = requestScope(activity);
  const id = connector.id;
  return probe(
    context,
    registry,
    connector,
    scope,
    (signal) =>
      Effect.map(observed(context, registry, connector, scope, signal), ({ status, drift, tools, catalogFailed }) => {
        const problem = uiProblemFor(connector, status.state, { credentialDrift: drift, catalogFailed });
        return {
          id,
          status: status.state,
          ...(status.registrationPath ? { auth: { registrationPath: status.registrationPath } } : {}),
          ...(problem ? { problem } : {}),
          // Catalog metadata is allowed for authenticated maintainers. Only the
          // name and its derived address are withheld when they fail the record grammar.
          tools: describedTools(tools).map((tool) => {
            const name = recordedToolName(tool);
            return { ...tool, name, address: `${id}.${name}`, classification: classified(tool) };
          }),
          catalogAgeMs: registry.catalogAgeMs(id),
          lastCall: null,
        };
      }),
    (): OperatorConnectorOverlay => ({
      id,
      status: "error",
      problem: "connector_unavailable",
      tools: [],
      catalogAgeMs: registry.catalogAgeMs(id),
      lastCall: null,
    }),
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

/**
 * One bounded scan of recent activity fills each row's last call and each
 * declared agent's `lastSeenAt` from the rows this maintainer may see. Agent
 * rows are recorded under the access-token directory with the agent's name.
 */
function scanActivity(
  context: RouteContext,
  authz: Authorized,
  registry: RegistryView,
  rows: OperatorConnectorOverlay[],
  agents: readonly OperatorAgent[],
): Effect.Effect<OperatorUiContractV2["live"]["activity"]> {
  const activity = context.opts.config.activity;
  if (!activity?.store.list) return Effect.succeed("unconfigured");
  if (!readsActivity(context.opts, authz)) return Effect.succeed("forbidden");
  return Effect.gen(function* () {
    const permitted = activity.readGate
      ? yield* bounded(
          context,
          () => attempt(async () => (await activity.readGate!(authz.actor)) === true),
          () => Effect.succeed(false),
        )
      : true;
    if (!permitted) return "forbidden" as const;
    const scan = Effect.gen(function* () {
      const byId = new Map(rows.map((row) => [row.id, row]));
      const byAgent = new Map(agents.map((agent) => [agent.name, agent]));
      let cursor: string | undefined;
      const seen = new Set<string>();
      // Bound the read even when a custom reader repeats a cursor or ignores
      // its requested page size. Each page belongs to the request fiber, so
      // cancellation cannot start the next page.
      for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
        const page = yield* attempt(() => activity.store.list!({ limit: 100, ...(cursor ? { cursor } : {}) }));
        for (const event of page.events.slice(0, 100)) {
          if (!isTimestamp(event.occurredAt)) continue;
          // A last call is a call; any row recorded for an agent, a catalog
          // refresh included, is a sign it was seen.
          const row =
            event.kind !== "catalog_drift" && OUTCOMES.has(event.outcome) ? byId.get(event.connectorId) : undefined;
          const agent =
            (event.actor.kind === "access_token" || event.actor.kind === "vercel_oidc") &&
            event.actor.namespace === AGENT_NAMESPACE &&
            event.actor.id
              ? byAgent.get(event.actor.id)
              : undefined;
          if ((!row && !agent) || !activityEventVisible(context, authz, registry, event)) continue;
          if (row && (!row.lastCall || event.occurredAt > row.lastCall.at))
            row.lastCall = { at: event.occurredAt, outcome: event.outcome };
          if (agent && (!agent.lastSeenAt || event.occurredAt > agent.lastSeenAt)) agent.lastSeenAt = event.occurredAt;
        }
        cursor = page.nextCursor;
        if (!cursor || seen.has(cursor)) break;
        seen.add(cursor);
      }
      return "available" as const;
    });
    return yield* bounded(
      context,
      () => scan,
      () =>
        Effect.sync(() => {
          for (const row of rows) row.lastCall = null;
          for (const agent of agents) agent.lastSeenAt = null;
          return "unavailable" as const;
        }),
    );
  });
}

/**
 * Directory labels for listed people, from the same lookup activity actor
 * labels use, and only on an interactive read, as there. A deployment without
 * a directory (Cloudflare Access) labels nobody.
 */
function humanLabels(
  context: RouteContext,
  authz: Authorized,
  people: readonly IdentityReference[],
): Effect.Effect<(person: IdentityReference) => string | null> {
  const auth = authz.identity.interactive ? context.opts.config.auth : [];
  const actors = people.flatMap((person) => principalActor(person, auth) ?? []);
  return Effect.map(resolveActorLabels(actors, auth), (labels) => (person: IdentityReference) => {
    const actor = principalActor(person, auth);
    return (actor && labels.get(actorKey(actor))) ?? null;
  });
}

type SharedRunsAs = Extract<OperatorRunsAs, { kind: "shared" }>;
const MISSING: SharedRunsAs = { kind: "shared", source: "missing", savedAt: null };

/**
 * Where a shared connector's credential comes from (`OperatorSharedSource`).
 * A declared slot is "vault" or "missing"; shared OAuth is "oauth" unless the
 * connector reports it needs authorizing; a remote MCP server that declares
 * no auth is "unauthenticated"; everything else lives in deployment code.
 */
function sharedSource(
  context: RouteContext,
  connector: Connector,
  row: OperatorConnectorOverlay | undefined,
): Effect.Effect<SharedRunsAs> {
  const { opts } = context;
  if (connector.credential) {
    const vault = opts.config.vault;
    if (!vault) return Effect.succeed(MISSING);
    return bounded(
      context,
      () =>
        attempt(() => vault.metadata(connector.id)).pipe(
          Effect.map((metadata): SharedRunsAs =>
            metadata ? { kind: "shared", source: "vault", savedAt: metadata.updatedAt } : MISSING,
          ),
        ),
      // An unreadable or stalled vault claims nothing was saved; the overlay says why.
      () => Effect.succeed(MISSING),
    );
  }
  const described = opts.configDescription.connectors.find((c) => c.id === connector.id);
  if (connector.startAuth || described?.auth?.mode === "oauth") {
    // Only a connector asking to be authorized has no grant; any other
    // state, a credential prompt or an error included, has one. A grant
    // carries no saved-at time of its own.
    return Effect.succeed(
      row?.status === "auth_required" ? MISSING : { kind: "shared", source: "oauth", savedAt: null },
    );
  }
  if (described?.auth?.mode === "none" && described.source.kind === "remote-mcp") {
    return Effect.succeed({ kind: "shared", source: "unauthenticated", savedAt: null });
  }
  return Effect.succeed({ kind: "shared", source: "config", savedAt: null });
}

/**
 * The people among `people` who have connected this personal connector in
 * their own partition: a stored credential of the declared shape, or a status
 * of "ok". Counted, never listed.
 */
function connectedPeople(
  context: RouteContext,
  connector: Connector,
  people: readonly IdentityReference[],
): Effect.Effect<ReadonlySet<string>> {
  const { opts, baseUrl, defer } = context;
  const connected = new Set<string>();
  return Effect.forEach(
    people,
    (person) =>
      Effect.gen(function* () {
        const principalKey = yield* Effect.promise(() => identityStorageKey(person));
        const credential = connector.credential;
        let ok: boolean;
        if (credential) {
          const vault = opts.config.vault;
          // An unreadable or stalled partition is not counted as connected.
          ok = vault
            ? yield* bounded(
                context,
                () =>
                  attempt(() => vault.metadata(connector.id, principalKey)).pipe(
                    Effect.map(
                      (metadata) => storedCredentialShape(credential, metadata?.fields ?? null).state === "valid",
                    ),
                  ),
                () => Effect.succeed(false),
              )
            : false;
        } else {
          const registry = opts.registry.scoped({ connectorIds: [connector.id], principalKey });
          const scope = {};
          ok = yield* probe(
            context,
            registry,
            connector,
            scope,
            (signal) =>
              Effect.map(
                attempt(() =>
                  registry.statusFor(connector.id, baseUrl, scope, { signal, ...(defer ? { defer } : {}) }),
                ),
                (status) => status.state === "ok",
              ),
            () => false,
          );
        }
        if (ok) connected.add(referenceKey(person));
      }),
    { concurrency: resolveDiscoveryConcurrency(opts.config.discovery.concurrency), discard: true },
  ).pipe(Effect.as(connected));
}

/** Every connector × endpoint cell: plain /mcp (`pool: null`) and each pool that serves it. */
function matrixFor(
  context: RouteContext,
  visible: readonly Connector[],
  rows: readonly OperatorConnectorOverlay[],
  ownersVisible: boolean,
): Effect.Effect<OperatorConnectorPoolCell[]> {
  const { opts } = context;
  const pools = [...opts.pools];
  return Effect.forEach(
    visible,
    (connector) =>
      Effect.gen(function* () {
        const columns: Array<{ pool: string | null; resolved?: ResolvedPool }> = [
          { pool: null },
          ...pools
            .filter(([, pool]) => servesConnector(pool, connector.id))
            .map(([pool, resolved]) => ({ pool, resolved })),
        ];
        const humans = (resolved: ResolvedPool | undefined) => (resolved ? humansOf(resolved) : [...opts.maintainers]);
        const workspace = workspaceSubjectOf(connector);
        let runsAs: (resolved: ResolvedPool | undefined, humansHere: IdentityReference[]) => OperatorRunsAs;
        if (workspace?.kind === "fixed") {
          runsAs = () => ({ kind: "workspaceFixed", subject: workspace.subject });
        } else if (workspace) {
          runsAs = (resolved) => ({
            kind: "workspace",
            humans: "self",
            // Plain /mcp admits no agents; a pool's agents act as its owner.
            agents: resolved && ownersVisible ? (resolved.owner ?? null) : null,
          });
        } else if (connector.authScope === "personal") {
          const everyone = new Map<string, IdentityReference>();
          for (const column of columns)
            for (const person of humans(column.resolved)) everyone.set(referenceKey(person), person);
          const connected = yield* connectedPeople(context, connector, [...everyone.values()]);
          runsAs = (_, humansHere) => ({
            kind: "personal",
            connectedMembers: humansHere.filter((person) => connected.has(referenceKey(person))).length,
            members: humansHere.length,
          });
        } else {
          const shared = yield* sharedSource(
            context,
            connector,
            rows.find((row) => row.id === connector.id),
          );
          runsAs = () => shared;
        }
        return columns.map(({ pool, resolved }): OperatorConnectorPoolCell => {
          const tools = resolved?.access.toolAccess?.get(connector.id);
          return {
            connectorId: connector.id,
            pool,
            tools: tools ? [...tools].filter(validName) : "all",
            runsAs: runsAs(resolved, humans(resolved)),
          };
        });
      }),
    { concurrency: resolveDiscoveryConcurrency(opts.config.discovery.concurrency) },
  ).pipe(Effect.map((cells) => cells.flat()));
}

function maintainerRead(context: RouteContext, authz: Authorized): Effect.Effect<Response, Answer> {
  const { opts } = context;
  return Effect.gen(function* () {
    const registry = opts.registry.scoped(scopeFor(authz));
    const selected = context.url.searchParams.get("connector");
    const visible = registry.listConnectors().filter((connector) => selected === null || connector.id === selected);
    if (selected !== null && visible.length === 0) return yield* refuse("unknown connector", 404);
    const ids = visible.map((c) => c.id);
    const allIds = registry.listConnectors().map((c) => c.id);
    const config = structuredClone(opts.configDescription);
    // A connector-filtered read (`?connector=`) discloses only that connector
    // in the config snapshot, its overlay and its matrix cells.
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
    // A pool owner is a Workspace mailbox address. Only an authenticated
    // maintainer reads it; an open deployment's anonymous caller, which this
    // route admits, gets null, the same as an unset owner (#837).
    const ownersVisible = opts.config.auth.length > 0 && isMaintainer(opts.maintainers, authz.identity);
    config.pools = config.pools.map((pool) => ({
      ...pool,
      owner: ownersVisible ? pool.owner : null,
      tools: grants(opts.pools.get(pool.name)?.access ?? { connectorIds: [] }, ids).flatMap((grant) =>
        grant.tools === "all" ? [grant.connectorId] : grant.tools.map((tool) => `${grant.connectorId}.${tool.name}`),
      ),
    }));
    const people = new Map<string, IdentityReference>();
    for (const person of [...opts.maintainers, ...[...opts.pools.values()].flatMap(humansOf)])
      people.set(referenceKey(person), person);
    const requestActivity = operatorActivityContext(context, authz);
    const [rows, label, slots] = yield* Effect.all(
      [
        Effect.forEach(visible, (c) => observe(context, registry, c, requestActivity), {
          concurrency: resolveDiscoveryConcurrency(opts.config.discovery.concurrency),
        }),
        humanLabels(context, authz, [...people.values()]),
        // Every declared agent's slot, exactly as GET /ui/access-tokens lists
        // it. Without them the agents list cannot be whole, so a failed read
        // fails the view rather than dropping agents from it.
        opts.config.accessTokens
          ? bounded(
              context,
              () => attempt(() => opts.config.accessTokens!.slots()),
              (error) => {
                logFailure(opts.config.logger, "operator agent slots read failed", failureRecord({}, error));
                return refuse("agent token slots could not be read", 503);
              },
            )
          : Effect.succeed([]),
      ],
      { concurrency: "unbounded" },
    );
    const human = (person: IdentityReference): OperatorMember => ({
      kind: "human",
      namespace: person.namespace,
      id: person.id,
      label: label(person),
    });
    const pools: OperatorPoolV2[] = [...opts.pools].map(([name, pool]) => ({
      name,
      humanPath: `/mcp/${name}`,
      agentPath: `/agent/${name}`,
      readOnly: pool.readOnly,
      surface: pool.native ? "native" : "meta",
      executeCode: pool.native?.executeCode !== false,
      owner: ownersVisible ? (pool.owner ?? null) : null,
      tools: grants(pool.access, allIds),
      members: pool.members.map((member) =>
        member.kind === "agent" ? { kind: "agent", name: member.name } : human(member),
      ),
    }));
    const agents: OperatorAgent[] = slots.map(({ name, ...token }) => ({
      name,
      pools: [...opts.pools]
        .filter(([, pool]) => pool.members.some((member) => member.kind === "agent" && member.name === name))
        .map(([pool]) => pool),
      token,
      lastSeenAt: null,
    }));
    const activity = yield* scanActivity(context, authz, registry, rows, agents);
    const matrix = yield* matrixFor(context, visible, rows, ownersVisible);
    const contract: OperatorUiContractV2 = {
      schemaVersion: 2,
      role: "maintainer",
      config,
      configSources: Object.fromEntries(
        configValuePaths(config).map((path) => [path, opts.configValueSources?.[path] ?? "config"]),
      ),
      live: { connectors: rows, activity },
      root: { path: "/mcp", readOnly: opts.config.readOnly, maintainers: opts.maintainers.map(human) },
      pools,
      agents,
      matrix,
      connectors: [],
      you: { interactive: authz.identity.interactive },
    };
    return privateJson(contract);
  });
}

/**
 * What this member may do with one personal connector, from three facts: the
 * member's own permission, what the deployment makes available (a vault for
 * credentials; signed OAuth hand-off for connect), and the connector's hooks.
 * Credential `test` and `clear` also need a value stored in the member's own
 * partition, so the actions alone tell the page whether one is.
 */
function memberManage(
  context: RouteContext,
  authz: Authorized,
  connector: Connector,
): Effect.Effect<OperatorMemberManage> {
  const { opts } = context;
  const principalKey = authz.principalKey;
  if (connector.authScope !== "personal" || !principalKey || !mayManageConnector(opts, authz, connector)) {
    return Effect.succeed({ kind: "none" });
  }
  const credential = connector.credential;
  if (credential) {
    const vault = opts.config.vault;
    if (!vault) return Effect.succeed({ kind: "none" });
    const card = {
      kind: "credential" as const,
      label: credential.label,
      ...(credential.description ? { description: credential.description } : {}),
      ...(credential.fields?.length
        ? {
            fields: credential.fields.map((field) => ({
              name: field.name,
              label: field.label,
              ...(field.description ? { description: field.description } : {}),
            })),
          }
        : {}),
    };
    return bounded(
      context,
      () =>
        attempt(() => vault.metadata(connector.id, principalKey)).pipe(
          Effect.map((metadata): OperatorMemberManage => {
            if (!metadata) return { ...card, actions: ["save"] };
            const shape = storedCredentialShape(credential, metadata.fields ?? null);
            const testable = credentialTestRule(connector).mode !== null && shape.state === "valid";
            return { ...card, actions: testable ? ["save", "test", "clear"] : ["save", "clear"] };
          }),
        ),
      // Unreadable or stalled: whether a value is stored is unknown, so
      // nothing that needs one is offered.
      () => Effect.succeed<OperatorMemberManage>({ ...card, actions: ["save"] }),
    );
  }
  const connect = Boolean(
    connector.startAuth && connector.finishAuth && connector.verifyState && !oauthConnectUnavailable(opts),
  );
  const disconnect = Boolean(connector.disconnectAuth);
  if (!connect && !disconnect) return Effect.succeed({ kind: "none" });
  return Effect.succeed({
    kind: "oauth",
    actions: [...(connect ? (["connect", "restart"] as const) : []), ...(disconnect ? (["disconnect"] as const) : [])],
  });
}

/**
 * One connector in a member's pools: the tools those pools grant, with the
 * registry's classification, and for a personal connector the member's own
 * connection. A shared connector's status is the deployment's and is never
 * read here; only its catalog is.
 */
function memberConnector(
  context: RouteContext,
  authz: Authorized,
  registry: RegistryView,
  connector: Connector,
  pools: ReadonlyArray<[string, ResolvedPool]>,
  activity: ActivityRequestContext | undefined,
): Effect.Effect<OperatorMemberConnector> {
  const { baseUrl, defer } = context;
  const id = connector.id;
  const personal = connector.authScope === "personal";
  const serving = pools.filter(([, pool]) => servesConnector(pool, id));
  const granted = serving.some(([, pool]) => !pool.access.toolAccess?.has(id))
    ? "all"
    : new Set(serving.flatMap(([, pool]) => [...pool.access.toolAccess!.get(id)!]));
  const scope = requestScope(activity);
  type Seen = { connection: OperatorMemberConnector["connection"]; tools: ToolDef[] };
  return Effect.gen(function* () {
    const seen = yield* probe<Seen>(
      context,
      registry,
      connector,
      scope,
      (signal) =>
        personal
          ? Effect.map(
              observed(context, registry, connector, scope, signal),
              ({ status, drift, tools, catalogFailed }) => {
                const problem = uiProblemFor(connector, status.state, { credentialDrift: drift, catalogFailed });
                return { connection: { state: status.state, ...(problem ? { problem } : {}) }, tools };
              },
            )
          : attempt(() => registry.getTools(id, baseUrl, scope, { signal, ...(defer ? { defer } : {}) })).pipe(
              Effect.orElseSucceed((): ToolDef[] => []),
              Effect.map((tools) => ({ connection: null, tools })),
            ),
      () => ({ connection: personal ? { state: "error", problem: "connector_unavailable" } : null, tools: [] }),
    );
    const manage = yield* memberManage(context, authz, connector);
    const addresses = new Set<string>();
    const tools = describedTools(seen.tools).flatMap((tool) => {
      // A name outside the record grammar is withheld entirely, not shown as a placeholder.
      if (!validName(tool.name) || (granted !== "all" && !granted.has(tool.name))) return [];
      const address = `${id}.${tool.name}`;
      if (addresses.has(address)) return [];
      addresses.add(address);
      return [{ address, classification: classified(tool) }];
    });
    return {
      id,
      title: connector.title ?? id,
      pools: serving.map(([name]) => name),
      authScope: personal ? ("personal" as const) : ("shared" as const),
      tools,
      connection: personal ? seen.connection : null,
      manage: personal ? manage : { kind: "none" as const },
    };
  });
}

/** The human pool memberships of this identity. An agent is never a member here. */
function memberPools(context: RouteContext, authz: Authorized): Array<[string, ResolvedPool]> {
  return [...context.opts.pools].filter(([, pool]) =>
    pool.members.some((member) => member.kind === "human" && isMember(member, authz.identity)),
  );
}

function memberRead(
  context: RouteContext,
  authz: Authorized,
  pools: Array<[string, ResolvedPool]>,
): Effect.Effect<Response, Answer> {
  const { opts } = context;
  return Effect.gen(function* () {
    const allIds = opts.registry.listConnectors().map((c) => c.id);
    const ids = new Set(allIds.filter((id) => pools.some(([, pool]) => servesConnector(pool, id))));
    const registry = opts.registry.scoped(scopeFor(authz, [...ids]));
    const selected = context.url.searchParams.get("connector");
    const visible = registry
      .listConnectors()
      .filter((connector) => ids.has(connector.id) && (selected === null || connector.id === selected));
    if (selected !== null && visible.length === 0) return yield* refuse("unknown connector", 404);
    const activity = operatorActivityContext(context, authz);
    const connectors = yield* Effect.forEach(
      visible,
      (connector) => memberConnector(context, authz, registry, connector, pools, activity),
      { concurrency: resolveDiscoveryConcurrency(opts.config.discovery.concurrency) },
    );
    const contract: OperatorUiContractV2 = {
      schemaVersion: 2,
      role: "member",
      config: null,
      configSources: null,
      live: { connectors: [], activity: "forbidden" },
      root: null,
      pools: pools.map(([name, pool]) => ({
        name,
        humanPath: `/mcp/${name}`,
        agentPath: `/agent/${name}`,
        readOnly: pool.readOnly,
        surface: pool.native ? "native" : "meta",
        executeCode: pool.native?.executeCode !== false,
        owner: null,
        tools: grants(pool.access, allIds),
        members: [],
      })),
      agents: [],
      matrix: [],
      connectors,
      you: { interactive: authz.identity.interactive },
    };
    return privateJson(contract);
  });
}

function configRead(context: RouteContext): Effect.Effect<Response, Answer> {
  return Effect.gen(function* () {
    const authz = yield* authorized(context);
    if (admitsMaintainer(context.opts, authz)) return yield* maintainerRead(context, authz);
    const pools = memberPools(context, authz);
    if (pools.length > 0) return yield* memberRead(context, authz, pools);
    return yield* refuse("not found", 404);
  });
}

export async function routeUiConfig(context: RouteContext): Promise<Response | null> {
  if (context.path !== "/ui/api/config") return null;
  if (context.request.method !== "GET") return privateJson({ error: "method not allowed" }, { status: 405 });
  return serveOperator(configRead(context), context.request.signal);
}
