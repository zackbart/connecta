import { describedTools } from "../described.js";
import type { OperatorTool } from "../operator-ui/contract.js";
// The Effect core of the operator payload: `buildUiData` in src/ui.ts is its
// Promise face, and the `/ui/connectors/<id>` route yields it directly.
//
// Every visible connector is one slot of a bounded fan-out: its probe runs
// under a deadline, any failure becomes that connector's error row rather
// than the payload's, and its connector scope closes as the slot ends,
// however it ends.

import { Effect } from "effect";
import { bindActivityRequest } from "../activity-request.js";
import { resolveDiscoveryConcurrency } from "../concurrency.js";
import type { DeferredWork } from "../connector-scope.js";
import type { CredentialVault } from "../credential-contract.js";
import { credentialReads } from "../credential-reads.js";
import { credentialTestRule, describeUndeclaredCredentialFields, storedCredentialShape } from "../credential-rules.js";
import { readVerification } from "../credential-verification.js";
import { failureRecord, failureStatus, logFailure, recordedToolName, statusFailure } from "../operator-record.js";
import type {
  CredentialManagementCapability,
  UiConnector,
  UiData,
  UiTool,
  UiVerification,
} from "../operator-ui/model.js";
import type { RegistryView } from "../registry.js";
import { closeScope } from "../runtime/connector-scope.js";
import { requestReads } from "../runtime/request-scope.js";
import { withDeadlineEffect } from "../runtime/run.js";
import type { Connector, ConnectorStatus } from "../types.js";
import { uiProblemFor } from "../ui.js";
import { CONNECTA_VERSION } from "../version.js";
import {
  prepareStatusSlot,
  readStatusObservation,
  storeStatusObservation,
  type StatusObservation,
  type StatusSlot,
} from "../connector-status.js";

export interface UiDataOptions {
  activityContext?: import("../activity.js").ActivityRequestContext | undefined;
  serverInfo: { name: string; version: string };
  credentialVault?: CredentialVault | undefined;
  activityEnabled: boolean;
  credentialManagement: CredentialManagementCapability;
  defer?: DeferredWork | undefined;
  oauthManagement: boolean;
  oauthConnectUrl?: ((id: string) => Promise<string>) | undefined;
  discoveryConcurrency?: number | undefined;
  personalCredentialOwner?: string | undefined;
  mayManage?: ((id: string) => boolean) | undefined;
  timeoutMs?: number | undefined;
  /**
   * A shorter deadline for the status and catalog observation alone. When it
   * ends first the row reports `connector_timeout` and keeps everything it
   * learned without the downstream, its credential card included.
   */
  observeTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Record what a live read observed for this viewer, before answering. With
   * `"stored"`, answer instead from a current stored observation when there
   * is one: its state, problem and tool count without the tools, and
   * everything local (credential, drift, permissions, auth links) fresh.
   */
  statusObservation?: "record" | "stored" | undefined;
}

interface Observed {
  status: ConnectorStatus;
  tools: OperatorTool[];
  catalogFailed: boolean;
  timedOut?: boolean;
  verification?: UiVerification | undefined;
}

const DETAIL_TIMEOUT_MS = 30_000;
const DETAIL_TIMED_OUT = "Connection details timed out. Retry this connection.";
const OBSERVE_TIMED_OUT = "Connector did not answer before the operator page's deadline.";

function attempt<A>(operation: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: (error) => error });
}

export function uiData(registry: RegistryView, baseUrl: string, options: UiDataOptions): Effect.Effect<UiData> {
  return Effect.suspend(() => {
    const vault = options.credentialVault;
    const owner = options.personalCredentialOwner;
    /**
     * A connector's status message stops here: the payload carries only the
     * classified `problem`, and the log a record of the state and, when
     * connecta described the failure itself, that failure's typed facts. The
     * message is never logged, whatever it looks like: a connector's own
     * `status()` can quote a downstream error body, which can quote the
     * secret it just rejected (INV-6). Non-error `ok` and `per_caller` states are dropped.
     */
    const logStatus = (
      id: string,
      state: ConnectorStatus["state"] | "failed",
      failure: unknown,
      requestScope: object,
    ) => {
      if (state === "ok" || state === "per_caller") return;
      const logger = registry.contextFor(id, baseUrl, requestScope).logger;
      logFailure(
        logger,
        "operator status",
        failureRecord({ connector: id, state }, failure),
        state === "auth_required" ? "info" : "warn",
      );
    };

    // A stored row: the observation's state and problem, and no tools. They
    // stay in the catalog cache (INV-8), and the browser's live read, which
    // follows in its own request, shows them. Reading them here could connect,
    // and the row's scope would wait for that listing to end.
    // The credential's stored verification is local, so it is read fresh here too.
    const observeStored = (
      c: Connector,
      stored: StatusObservation,
      drift: string | undefined,
      requestScope: object,
    ): Effect.Effect<Observed> =>
      drift
        ? Effect.succeed({ status: { state: "auth_required", message: drift }, tools: [], catalogFailed: false })
        : Effect.map(verificationFor(c, requestScope), (verification) => ({
            status: { state: stored.state },
            tools: [],
            catalogFailed: stored.problem === "catalog_failed",
            ...(stored.problem === "connector_timeout" ? { timedOut: true } : {}),
            verification,
          }));

    /**
     * The stored last verification of an operator-managed credential
     * (src/credential-verification.ts). Read only, never probed (INV-10). A
     * record counts only for the save it observed, whose revision the card's
     * memoized vault read already holds; a vault without revisions has none
     * to match.
     */
    const verificationFor = (c: Connector, requestScope: object): Effect.Effect<UiVerification | undefined> =>
      c.credential && vault
        ? attempt(async () => {
            const metadata = await credentialReads(vault, requestReads(requestScope)).metadata(
              c.id,
              c.authScope === "personal" ? owner : undefined,
            );
            return metadata?.revision
              ? readVerification(registry.contextFor(c.id, baseUrl, requestScope).storage, metadata.revision)
              : undefined;
          }).pipe(Effect.orElseSucceed(() => undefined))
        : Effect.succeed(undefined);

    // Status first, then the catalog only when status is ok. A failed status
    // read is an error status, not a failed row: the row still reports the
    // connector's credential.
    const observe = (
      c: Connector,
      drift: string | undefined,
      signal: AbortSignal,
      requestScope: object,
    ): Effect.Effect<Observed> => {
      if (drift) {
        return Effect.succeed({
          status: { state: "auth_required", message: drift },
          tools: [],
          catalogFailed: false,
        });
      }
      return Effect.gen(function* () {
        const status = yield* attempt(() =>
          registry.statusFor(c.id, baseUrl, requestScope, {
            signal,
            ...(options.defer ? { defer: options.defer } : {}),
          }),
        );
        const verification = yield* verificationFor(c, requestScope);
        if (status.state !== "ok" || signal.aborted) {
          return { status, tools: [], catalogFailed: false, verification };
        }
        // A catalog is configuration the operator chose to load, and its
        // descriptions are the agent's too, so the page shows them as text.
        // A name outside MCP's tool-name grammar is withheld here as in every
        // record (INV-6), and so is the address built from it.
        return yield* attempt(async () =>
          (
            await registry.getTools(c.id, baseUrl, requestScope, {
              signal,
              ...(options.defer ? { defer: options.defer } : {}),
            })
          )
            .flatMap((t) => describedTools([t]))
            .map((t): OperatorTool => ({
              ...t,
              name: recordedToolName(t),
              address: `${c.id}.${recordedToolName(t)}`,
              classification: t.classification === "read" ? "read" : "write",
            })),
        ).pipe(
          Effect.map((tools) => ({ status, tools, catalogFailed: false, verification })),
          // The registry owns the failed catalog observation; the page only
          // needs to know there was one.
          Effect.catch(() => Effect.succeed({ status, tools: [], catalogFailed: !signal.aborted, verification })),
          // Loading the catalog may replace an earlier clean observation.
          // Read this view's current bounded facts without another status probe.
          Effect.map((observed) => ({
            ...observed,
            status: registry.withCatalogObservations(c.id, baseUrl, observed.status),
          })),
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed<Observed>({
            status: failureStatus(c.id, error),
            tools: [],
            catalogFailed: false,
          }),
        ),
      );
    };

    // The observation under its own deadline. Its abort reaches the status
    // and catalog reads through `inner`, which then settle as an error or a
    // failed catalog; either way the reason on `inner` says the deadline
    // ended them, so the row is a timeout rather than a failure.
    const observeWithin = (
      c: Connector,
      drift: string | undefined,
      signal: AbortSignal,
      requestScope: object,
      timeoutMs: number,
    ): Effect.Effect<Observed, unknown> => {
      const timeoutError = new Error(OBSERVE_TIMED_OUT);
      const timedOut = (): Observed => ({
        status: failureStatus(c.id, timeoutError),
        tools: [],
        catalogFailed: false,
        timedOut: true,
      });
      return withDeadlineEffect(
        (inner) =>
          observe(c, drift, inner, requestScope).pipe(
            Effect.map((observed) => (inner.reason === timeoutError ? timedOut() : observed)),
          ),
        { timeoutMs, signal, timeoutError },
      ).pipe(Effect.catch((error) => (error === timeoutError ? Effect.succeed(timedOut()) : Effect.fail(error))));
    };

    // The credential card, for someone who may manage this connector's auth.
    // Never fails: a vault that cannot be read is the card's own error.
    const credentialFor = (c: Connector, requestScope: object): Effect.Effect<UiConnector["credential"]> => {
      const mayManageAuth =
        options.mayManage?.(c.id) ?? (c.authScope === "personal" ? Boolean(owner) : options.oauthManagement);
      const declared = c.credential;
      if (!declared || !vault || !mayManageAuth) return Effect.succeed(undefined);
      // One rule, shared with the test route: only the hook matching the
      // declared credential shape can run, so the button is offered only
      // where a click can succeed (src/credentials.ts).
      const testRule = credentialTestRule(c);
      const credentialFields = (metadata?: Awaited<ReturnType<CredentialVault["metadata"]>>) =>
        declared.fields?.map((field) => {
          const fieldMetadata = metadata?.fields?.[field.name];
          return {
            name: field.name,
            label: field.label,
            ...(field.description ? { description: field.description } : {}),
            ...(field.placeholder ? { placeholder: field.placeholder } : {}),
            inputType: field.inputType ?? "password",
            configured: Boolean(fieldMetadata),
            ...(fieldMetadata
              ? {
                  lastFour: fieldMetadata.lastFour,
                  updatedAt: fieldMetadata.updatedAt,
                }
              : {}),
          };
        });
      const card = {
        label: declared.label,
        ...(declared.description ? { description: declared.description } : {}),
        ...(declared.placeholder ? { placeholder: declared.placeholder } : {}),
      };
      return attempt(async (): Promise<UiConnector["credential"]> => {
        // Memoized per request: the card only displays what the drift and
        // status reads of this same detail already read.
        const metadata = await credentialReads(vault, requestReads(requestScope)).metadata(
          c.id,
          c.authScope === "personal" ? owner : undefined,
        );
        const fields = credentialFields(metadata);
        const shape = storedCredentialShape(declared, metadata?.fields ?? null);
        return {
          ...card,
          ...(fields?.length ? { fields } : {}),
          configured: shape.state === "valid",
          removable: Boolean(metadata),
          ...(metadata ? { lastFour: metadata.lastFour, updatedAt: metadata.updatedAt } : {}),
          testable: testRule.mode !== null && shape.state !== "mismatch",
          ...(shape.state === "mismatch" ? { error: shape.message, problem: "credential_mismatch" as const } : {}),
          // A dropped field leaves its secret in the vault, and the field
          // list below only renders fields the connector still declares —
          // so without this line there is nowhere an operator could see it.
          ...(shape.state === "valid" && shape.undeclared.length
            ? { notice: describeUndeclaredCredentialFields(shape.undeclared) }
            : {}),
        };
      }).pipe(
        Effect.catch(() => {
          const fields = credentialFields();
          return Effect.succeed({
            ...card,
            ...(fields?.length ? { fields: fields.map((field) => ({ ...field, configured: null })) } : {}),
            configured: null,
            removable: true,
            testable: testRule.mode !== null,
            error: "Stored credential could not be read.",
            problem: "credential_unreadable" as const,
          });
        }),
      );
    };

    // Where this row records what it observed. A live read prepares only the
    // generation; a stored read looks the observation up and, finding none,
    // records the live read it falls back to.
    const statusLookup = (
      c: Connector,
      requestScope: object,
    ): Effect.Effect<{ slot?: StatusSlot; observation?: StatusObservation }> =>
      options.statusObservation === "stored"
        ? readStatusObservation(registry, c.id, baseUrl, requestScope)
        : options.statusObservation === "record"
          ? Effect.map(prepareStatusSlot(registry, c.id, baseUrl, requestScope), (slot) => (slot ? { slot } : {}))
          : Effect.succeed({});

    const detail = (c: Connector, signal: AbortSignal, requestScope: object, recording: { slot?: StatusSlot }) =>
      Effect.gen(function* () {
        // The status slot is read before the probe starts, so an invalidation
        // during it leaves the observation under the generation it replaced.
        const [drift, stored] = yield* Effect.all(
          [attempt(() => registry.credentialDriftFor(c.id, requestScope)), statusLookup(c, requestScope)],
          { concurrency: 2 },
        );
        const observation = stored.observation;
        const statusSlot = observation ? undefined : stored.slot;
        // The row's own deadline may end it below; it records from here.
        if (statusSlot) recording.slot = statusSlot;
        // One deadline covers the whole row. The status and catalog reads once
        // had a second one of the same length inside it, which could only fire
        // after this one had already ended the row.
        // The operator page's shorter observation deadline, when it has one,
        // bounds only the downstream: the credential card below is local
        // storage and still renders, so a slow vendor's slot stays fixable.
        const { status, tools, catalogFailed, timedOut, verification } = observation
          ? yield* observeStored(c, observation, drift, requestScope)
          : options.observeTimeoutMs === undefined
            ? yield* observe(c, drift, signal, requestScope)
            : yield* observeWithin(c, drift, signal, requestScope, options.observeTimeoutMs);
        const credential = yield* credentialFor(c, requestScope);
        logStatus(c.id, status.state, statusFailure(status), requestScope);
        const problem = timedOut
          ? ("connector_timeout" as const)
          : uiProblemFor(c, status.state, {
              credentialDrift: Boolean(drift),
              catalogFailed,
            });
        const toolCount = observation ? observation.toolCount : tools.length;
        // Started only while the caller is still here, then awaited to its
        // end even if the row's deadline or the caller ends it meanwhile.
        if (statusSlot && !signal.aborted && !options.signal?.aborted)
          yield* Effect.uninterruptible(
            storeStatusObservation(statusSlot, {
              state: status.state,
              ...(problem ? { problem } : {}),
              toolCount,
              observedAt: Date.now(),
            }),
          );
        return {
          id: c.id,
          authScope: c.authScope ?? "shared",
          ...(c.title ? { title: c.title } : {}),
          ...(c.description !== undefined ? { description: c.description } : {}),
          status: status.state,
          ...(problem ? { problem } : {}),
          toolCount,
          tools: tools.map((tool): UiTool => ({
            name: tool.name,
            address: tool.address,
            ...(tool.description ? { description: tool.description } : {}),
            safety: tool.classification === "read" ? "runs_in_programs" : "needs_approval",
          })),
          overlay: {
            id: c.id,
            status: status.state,
            tools,
            ...(problem ? { problem } : {}),
            ...(status.registrationPath ? { auth: { registrationPath: status.registrationPath } } : {}),
            catalogAgeMs: registry.catalogAgeMs(c.id),
            lastCall: null,
            ...(observation ? { observedAgeMs: Math.max(0, Date.now() - observation.observedAt) } : {}),
          },
          ...(observation ? { observedAgeMs: Math.max(0, Date.now() - observation.observedAt) } : {}),
          // Counts only, and only when a refresh in this runtime produced them.
          // `Registry.withCatalogObservations` rebuilt the report through
          ...(status.catalogAccess ? { catalogAccess: status.catalogAccess } : {}),
          ...(status.resourceTemplateRefusals ? { resourceTemplateRefusals: status.resourceTemplateRefusals } : {}),
          ...(status.state === "auth_required" && c.startAuth && options.mayManage?.(c.id) && options.oauthConnectUrl
            ? { authorizationUrl: yield* attempt(() => options.oauthConnectUrl!(c.id)) }
            : {}),
          oauth: Boolean(c.startAuth && c.disconnectAuth),
          ...(status.registrationPath ? { registrationPath: status.registrationPath } : {}),
          ...(verification ? { verification } : {}),
          ...(credential ? { credential } : {}),
        } satisfies UiConnector;
      });

    const unavailable = (c: Connector, error: unknown, requestScope: object, timeoutError: Error) =>
      Effect.sync((): UiConnector => {
        logStatus(c.id, "failed", error, requestScope);
        // The row's own deadline is a timeout too, whichever ran out first.
        const problem = error === timeoutError ? "connector_timeout" : "connector_unavailable";
        return {
          id: c.id,
          ...(c.title ? { title: c.title } : {}),
          authScope: c.authScope ?? "shared",
          status: "error",
          problem,
          oauth: Boolean(c.startAuth && c.disconnectAuth),
          toolCount: 0,
          tools: [],
          overlay: {
            id: c.id,
            status: "error",
            problem,
            tools: [],
            catalogAgeMs: registry.catalogAgeMs(c.id),
            lastCall: null,
          },
        };
      });

    // The row's own deadline ended the read: record that timeout before the
    // response, so the next stored read parks this row too. A caller who has
    // already left records nothing. Once started, the write is awaited to its
    // end, never raced or detached: storage writes cannot be withdrawn once
    // sent, so the request settles only after it does, bounded by the storage
    // layer like every other awaited write (INV-7).
    const recordRowTimeout = (slot: StatusSlot | undefined): Effect.Effect<void> =>
      !slot || options.signal?.aborted
        ? Effect.void
        : Effect.uninterruptible(
            storeStatusObservation(slot, {
              state: "error",
              problem: "connector_timeout",
              toolCount: 0,
              observedAt: Date.now(),
            }),
          );

    const row = (c: Connector): Effect.Effect<UiConnector> =>
      Effect.suspend(() => {
        // A row ends independently. Revoking its probe must not revoke a live
        // sibling that happens to belong to the same operator payload.
        const requestScope = {};
        if (options.activityContext) bindActivityRequest(requestScope, options.activityContext);
        const timeoutError = new Error(DETAIL_TIMED_OUT);
        const recording: { slot?: StatusSlot } = {};
        return withDeadlineEffect((signal) => detail(c, signal, requestScope, recording), {
          timeoutMs: options.timeoutMs ?? DETAIL_TIMEOUT_MS,
          ...(options.signal ? { signal: options.signal } : {}),
          timeoutError,
        }).pipe(
          // A hook that throws where it should reject fails its own row too.
          Effect.catchDefect((defect) => Effect.fail(defect)),
          Effect.catch((error) =>
            Effect.andThen(
              recordRowTimeout(error === timeoutError ? recording.slot : undefined),
              unavailable(c, error, requestScope, timeoutError),
            ),
          ),
          Effect.ensuring(
            Effect.suspend(() => closeScope(c, registry.contextFor(c.id, baseUrl, requestScope), options.defer)),
          ),
        );
      });

    return Effect.forEach(registry.listConnectors(), row, {
      concurrency: resolveDiscoveryConcurrency(options.discoveryConcurrency),
    }).pipe(
      Effect.map((connectors) => ({
        serverInfo: options.serverInfo,
        connectaVersion: CONNECTA_VERSION,
        connectors,
        activityEnabled: options.activityEnabled,
        credentialManagement: options.credentialManagement,
        oauthManagement: options.oauthManagement || Boolean(owner),
      })),
    );
  });
}
