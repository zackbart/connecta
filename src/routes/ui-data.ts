// The Effect core of the operator payload: `buildUiData` in src/ui.ts is its
// Promise face, and the `/ui/connectors/<id>` route yields it directly.
//
// Every visible connector is one slot of a bounded fan-out: its probe runs
// under a deadline, any failure becomes that connector's error row rather
// than the payload's, and its connector scope closes as the slot ends,
// however it ends.

import { Effect } from "effect";
import { resolveDiscoveryConcurrency } from "../concurrency.js";
import type { DeferredWork } from "../connector-scope.js";
import type { CredentialVault } from "../credential-contract.js";
import {
  credentialTestRule,
  describeUndeclaredCredentialFields,
  storedCredentialShape,
} from "../credential-rules.js";
import type {
  CredentialManagementCapability,
  UiConnector,
  UiData,
  UiTool,
} from "../operator-ui/model.js";
import type { RegistryView } from "../registry.js";
import { closeScope } from "../runtime/connector-scope.js";
import { withDeadlineEffect } from "../runtime/run.js";
import type { Connector, ConnectorStatus } from "../types.js";
import { uiProblemFor, uiToolSafety } from "../ui.js";
import { CONNECTA_VERSION } from "../version.js";

export interface UiDataOptions {
  serverInfo: { name: string; version: string };
  credentialVault?: CredentialVault | undefined;
  activityEnabled: boolean;
  credentialManagement: CredentialManagementCapability;
  defer?: DeferredWork | undefined;
  oauthManagement: boolean;
  discoveryConcurrency?: number | undefined;
  personalCredentialOwner?: string | undefined;
  mayManage?: ((id: string) => boolean) | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

interface Observed {
  status: ConnectorStatus;
  tools: UiTool[];
  catalogFailed: boolean;
}

const DETAIL_TIMEOUT_MS = 30_000;
const DETAIL_TIMED_OUT = "Connection details timed out. Retry this connection.";

function attempt<A>(operation: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: (error) => error });
}

export function uiData(
  registry: RegistryView,
  baseUrl: string,
  options: UiDataOptions,
): Effect.Effect<UiData> {
  return Effect.suspend(() => {
    const requestScope = {};
    const vault = options.credentialVault;
    const owner = options.personalCredentialOwner;
    /**
     * A connector's status message stops here. It can quote a downstream error
     * body — and a downstream error body can quote the secret it just rejected —
     * so the payload carries only the classified `problem` and the raw text goes
     * to the deployment's log, where an operator debugging the failure already
     * looks. An `ok` status's message is informational and simply dropped.
     */
    const logStatus = (
      id: string,
      state: ConnectorStatus["state"] | "failed",
      message: string | undefined,
    ) => {
      if (!message || state === "ok") return;
      const logger = registry.contextFor(id, baseUrl, requestScope).logger;
      const line = `[connecta] connector "${id}" operator status ${state}: ${message}`;
      if (state === "auth_required") logger.info(line);
      else logger.warn(line);
    };

    // Status first, then the catalog only when status is ok. A failed status
    // read is an error status, not a failed row: the row still reports the
    // connector's credential.
    const observe = (
      c: Connector,
      drift: string | undefined,
      signal: AbortSignal,
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
          registry.statusFor(c.id, baseUrl, requestScope, { signal }),
        );
        if (status.state !== "ok" || signal.aborted) {
          return { status, tools: [], catalogFailed: false };
        }
        return yield* attempt(async () =>
          (await registry.getTools(c.id, baseUrl, requestScope, { signal })).map(
            (t): UiTool => ({
              name: t.name,
              address: `${c.id}.${t.name}`,
              ...(t.description ? { description: t.description } : {}),
              safety: uiToolSafety(t),
            }),
          ),
        ).pipe(
          Effect.map((tools) => ({ status, tools, catalogFailed: false })),
          // The registry owns the failed catalog observation; the page only
          // needs to know there was one.
          Effect.catch(() =>
            Effect.succeed({ status, tools: [], catalogFailed: !signal.aborted }),
          ),
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed<Observed>({
            status: {
              state: "error",
              message:
                error instanceof Error
                  ? error.message
                  : "Connection details unavailable",
            },
            tools: [],
            catalogFailed: false,
          }),
        ),
      );
    };

    // The credential card, for someone who may manage this connector's auth.
    // Never fails: a vault that cannot be read is the card's own error.
    const credentialFor = (
      c: Connector,
    ): Effect.Effect<UiConnector["credential"]> => {
      const mayManageAuth =
        options.mayManage?.(c.id) ??
        (c.authScope === "personal" ? Boolean(owner) : options.oauthManagement);
      const declared = c.credential;
      if (!declared || !vault || !mayManageAuth) return Effect.succeed(undefined);
      // One rule, shared with the test route: only the hook matching the
      // declared credential shape can run, so the button is offered only
      // where a click can succeed (src/credentials.ts).
      const testRule = credentialTestRule(c);
      const credentialFields = (
        metadata?: Awaited<ReturnType<CredentialVault["metadata"]>>,
      ) =>
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
        const metadata = await vault.metadata(
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
          ...(metadata
            ? { lastFour: metadata.lastFour, updatedAt: metadata.updatedAt }
            : {}),
          testable: testRule.mode !== null && shape.state !== "mismatch",
          ...(shape.state === "mismatch"
            ? { error: shape.message, problem: "credential_mismatch" as const }
            : {}),
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
            ...(fields?.length ? { fields } : {}),
            configured: false,
            removable: true,
            testable: testRule.mode !== null,
            error: "Stored credential could not be read.",
            problem: "credential_unreadable" as const,
          });
        }),
      );
    };

    const detail = (c: Connector, signal: AbortSignal) =>
      Effect.gen(function* () {
        const drift = yield* attempt(() => registry.credentialDriftFor(c.id));
        // One deadline covers the whole row. The status and catalog reads once
        // had a second one of the same length inside it, which could only fire
        // after this one had already ended the row.
        const { status, tools, catalogFailed } = yield* observe(c, drift, signal);
        const credential = yield* credentialFor(c);
        logStatus(c.id, status.state, status.message);
        const problem = uiProblemFor(c, status.state, {
          credentialDrift: Boolean(drift),
          catalogFailed,
        });
        return {
          id: c.id,
          authScope: c.authScope ?? "shared",
          ...(c.title ? { title: c.title } : {}),
          ...(c.description !== undefined ? { description: c.description } : {}),
          status: status.state,
          ...(problem ? { problem } : {}),
          toolCount: tools.length,
          tools,
          // Counts only, and only when a refresh in this runtime produced them.
          // `Registry.statusFor` already rebuilt the report through
          // `boundedCatalogDrift`, so what lands here cannot carry a name or a
          // schema even if the plugin seam returned one.
          ...(status.catalogDrift ? { catalogDrift: status.catalogDrift } : {}),
          ...(status.catalogAccess ? { catalogAccess: status.catalogAccess } : {}),
          oauth: Boolean(c.startAuth && c.disconnectAuth),
          ...(credential ? { credential } : {}),
        } satisfies UiConnector;
      });

    const unavailable = (c: Connector, error: unknown) =>
      Effect.sync((): UiConnector => {
        logStatus(c.id, "failed", error instanceof Error ? error.message : String(error));
        return {
          id: c.id,
          ...(c.title ? { title: c.title } : {}),
          authScope: c.authScope ?? "shared",
          status: "error",
          problem: "connector_unavailable",
          oauth: Boolean(c.startAuth && c.disconnectAuth),
          toolCount: 0,
          tools: [],
        };
      });

    const row = (c: Connector): Effect.Effect<UiConnector> =>
      withDeadlineEffect((signal) => detail(c, signal), {
        timeoutMs: options.timeoutMs ?? DETAIL_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutError: new Error(DETAIL_TIMED_OUT),
      }).pipe(
        // A hook that throws where it should reject fails its own row too.
        Effect.catchDefect((defect) => Effect.fail(defect)),
        Effect.catch((error) => unavailable(c, error)),
        Effect.ensuring(
          Effect.suspend(() =>
            closeScope(
              c,
              registry.contextFor(c.id, baseUrl, requestScope),
              options.defer,
            ),
          ),
        ),
      );

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
