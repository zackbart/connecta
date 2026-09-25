// The built-in `artifacts` connector: reads are explicitly read-only, writes
// are not — so discovery, `call_tool`, and the guide treat them as writes —
// but every write is a new immutable version anyone can roll back, so the
// connector's own default exempts them from approval inside programs
// (`approval: "never"`), and `execute.approval` can switch that off.
//
// Who made each version comes from the caller core attached to the context,
// never from arguments.

import { api } from "../connectors/api.js";
import { callerOf } from "../connector-caller.js";
import { ConnectorCallError } from "../errors.js";
import type { Connector, ConnectorContext, JsonSchema } from "../types.js";
import { buildFrameDocument, frameCsp, type ArtifactGlobal } from "./document.js";
import { buildGuide, GUIDE_SUMMARY } from "./guide.js";
import {
  invalidContent,
  type ArtifactFailure,
  type ArtifactOperations,
  type RenderPage,
} from "./operations.js";
import { scriptSafeJson } from "./json.js";
import type {
  ArtifactActor,
  ArtifactAllowlist,
  ArtifactHeadRecord,
  ArtifactIssue,
  ArtifactKind,
  ArtifactLimits,
  ArtifactValidation,
  ArtifactVersionRecord,
} from "./types.js";
import { validateWithContext } from "./validate.js";

/** What a deployment's render check is handed: exactly what the viewer loads. */
export interface ArtifactRenderCheckInput {
  /** The complete frame document, data injected. */
  document: string;
  /** The Content-Security-Policy the viewer serves it under. */
  csp: string;
  kind: ArtifactKind;
  /** Aborted when the check's 20-second deadline or the call's own passes. */
  signal: AbortSignal;
}

export type ArtifactRenderCheckResult =
  | { ok: true; warnings?: string[] }
  | { ok: false; errors: string[] };

/**
 * A real render check — a headless browser, say — run on `validate_artifact`
 * and on every write that changes what a page renders. It must answer within
 * 20 seconds; a throw or a timeout fails the write as retryable `unavailable`
 * and saves nothing.
 */
export type ArtifactRenderCheck = (
  input: ArtifactRenderCheckInput,
) => Promise<ArtifactRenderCheckResult>;

const RENDER_DEADLINE_MS = 20_000;
const MAX_RENDER_FINDINGS = 10;
const MAX_RENDER_FINDING_CHARS = 300;

const READ = { readOnlyHint: true } as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const id: JsonSchema = {
  type: "string",
  description: "The artifact's id: its URL slug, e.g. q3-bugs.",
  minLength: 1,
  maxLength: 64,
};
const kind: JsonSchema = { type: "string", enum: ["html", "markdown"] };
const version = (description: string): JsonSchema => ({
  type: "integer",
  minimum: 1,
  description,
});
const documentValues: JsonSchema = {
  type: "object",
  description:
    "Documents by name, each mapped straight to its JSON value (no wrapper): " +
    '{ "data": { "rows": [...] } } is read by the page as artifact.data.data.rows.',
  additionalProperties: true,
};

/** Bound what a hook said: at most 10 findings of 300 characters. */
function renderFindings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .slice(0, MAX_RENDER_FINDINGS)
    .map((value) =>
      value.length > MAX_RENDER_FINDING_CHARS
        ? `${value.slice(0, MAX_RENDER_FINDING_CHARS - 1)}…`
        : value,
    );
}

type RenderVerdict =
  | { ok: true; warnings: ArtifactIssue[] }
  | { ok: false; errors: ArtifactIssue[] }
  | { ok: false; unavailable: string };

/** Run a hook under its 20-second deadline and the call's own signal. Never throws. */
export async function runRenderCheck(
  hook: ArtifactRenderCheck,
  input: { document: string; csp: string; kind: ArtifactKind },
  callSignal: AbortSignal | undefined,
): Promise<RenderVerdict> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => controller.abort(callSignal?.reason);
  callSignal?.addEventListener("abort", onAbort, { once: true });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new Error("The render check did not answer within 20 seconds.");
      controller.abort(reason);
      reject(reason);
    }, RENDER_DEADLINE_MS);
  });
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  try {
    const result = (await Promise.race([
      hook({ ...input, signal: controller.signal }),
      deadline,
      aborted,
    ])) as ArtifactRenderCheckResult | undefined;
    if (result?.ok === true) {
      return {
        ok: true,
        warnings: renderFindings(result.warnings).map((message) => ({
          code: "W_RENDER",
          severity: "warning",
          message: `Render check: ${message}`,
        })),
      };
    }
    if (result?.ok === false) {
      const errors = renderFindings(result.errors);
      return {
        ok: false,
        errors: (errors.length ? errors : ["the page failed to render"]).map((message) => ({
          code: "E_RENDER",
          severity: "error",
          message: `Render check: ${message}`,
        })),
      };
    }
    return { ok: false, unavailable: "The render check answered with something other than { ok }." };
  } catch {
    return {
      ok: false,
      unavailable: "The render check failed to run or did not answer in time; nothing was saved. Retry the write.",
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    callSignal?.removeEventListener("abort", onAbort);
    // Settle the race's losers so neither rejects unhandled.
    deadline.catch(() => {});
    aborted.catch(() => {});
    controller.abort();
  }
}

/** The page's `window.artifact` minus data, for a head. */
function globalFor(
  artifactId: string,
  head: ArtifactHeadRecord,
  view: ArtifactVersionRecord,
  documents: Record<string, ArtifactVersionRecord>,
  snapshot: boolean,
): ArtifactGlobal {
  return {
    id: artifactId,
    title: head.title,
    view: { version: view.version },
    documents: Object.fromEntries(
      Object.entries(documents).map(([name, record]) => [
        name,
        { version: record.version, updatedAt: record.at },
      ]),
    ),
    snapshot,
  };
}

function failure(result: ArtifactFailure): ConnectorCallError {
  return new ConnectorCallError(
    result.code,
    result.message,
    result.current ? { current: result.current } : {},
  );
}

const warningsOf = (warnings: ArtifactIssue[]) =>
  warnings.length ? { warnings: warnings.map((issue) => issue.message) } : {};

const history = (records: ArtifactVersionRecord[]) =>
  records.map((record) => ({
    version: record.version,
    by: record.by,
    at: record.at,
    op: record.op,
    ...(record.restoredFrom !== undefined ? { restoredFrom: record.restoredFrom } : {}),
    ...(record.runId !== undefined ? { runId: record.runId } : {}),
    ...(record.removed ? { removed: true } : {}),
  }));

export interface ArtifactsConnectorOptions {
  operations: ArtifactOperations;
  allowlist: ArtifactAllowlist;
  limits: ArtifactLimits;
  renderCheck?: ArtifactRenderCheck;
  /** Where pages are served, when not the deployment's own origin. */
  origin?: string;
}

export function artifactsConnector(options: ArtifactsConnectorOptions): Connector {
  const ops = options.operations;
  const csp = frameCsp(options.allowlist);
  const hook = options.renderCheck;
  const actorOf = (ctx: ConnectorContext): ArtifactActor =>
    callerOf(ctx)?.identity.actor ?? { kind: "unknown" };
  const originOf = (ctx: ConnectorContext) =>
    options.origin ?? new URL(ctx.baseUrl).origin;
  const urlOf = (ctx: ConnectorContext, artifactId: string) =>
    `${originOf(ctx)}/artifacts/${artifactId}`;
  const snapshotUrlOf = (
    ctx: ConnectorContext,
    artifactId: string,
    view: number,
    documents: Record<string, ArtifactVersionRecord>,
  ) => {
    const pins = Object.entries(documents)
      .filter(([, record]) => !record.removed)
      // Names are identifiers and versions digits, so the pins need no escaping.
      .map(([name, record]) => `d=${name}:${record.version}`);
    return `${urlOf(ctx, artifactId)}/v/${view}${pins.length ? `?${pins.join("&")}` : ""}`;
  };

  const renderFor = (ctx: ConnectorContext): RenderPage | undefined =>
    hook
      ? async ({ id: artifactId, head, source, data }) => {
          const verdict = await runRenderCheck(
            hook,
            {
              document: buildFrameDocument({
                kind: head.kind,
                source,
                global: globalFor(artifactId, head, head.view, liveOf(head), false),
                data,
              }),
              csp,
              kind: head.kind,
            },
            ctx.signal,
          );
          if (verdict.ok) return verdict;
          if ("unavailable" in verdict) {
            return { ok: false, code: "unavailable", message: verdict.unavailable };
          }
          const validation: ArtifactValidation = { ok: false, errors: verdict.errors, warnings: [] };
          return invalidContent("The page", validation);
        }
      : undefined;

  const unwrap = <T extends { ok: true }>(result: T | ArtifactFailure): T => {
    if (!result.ok) throw failure(result);
    return result;
  };

  const connector = api("artifacts", {
    title: "Artifacts",
    description:
      "Team pages over stored data: publish, edit, and share HTML or Markdown pages whose numbers live in versioned JSON documents.",
    usageGuide: {
      content: buildGuide({
        allowlist: options.allowlist,
        limits: options.limits,
        renderCheck: hook !== undefined,
      }),
      summary: GUIDE_SUMMARY,
    },
    tools: [
      {
        name: "list_artifacts",
        description: "List artifacts in id order, with each one's url; query searches titles and ids.",
        annotations: READ,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", maxLength: 200, description: "Case-insensitive title or id substring." },
            includeArchived: { type: "boolean", description: "Include archived artifacts. Default false." },
            limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 50." },
            cursor: { type: "string", maxLength: 64, description: "nextCursor from the previous page." },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            artifacts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  kind: { type: "string" },
                  viewVersion: { type: "integer" },
                  revision: { type: "integer" },
                  updatedAt: { type: "string" },
                  updatedBy: { type: "object" },
                  archived: { type: "boolean" },
                  url: { type: "string" },
                },
              },
            },
            nextCursor: { type: "string" },
          },
        },
        handler: async (args, ctx) => {
          const listed = unwrap(
            await ops.list({
              limit: args.limit ?? 50,
              ...(args.query !== undefined ? { query: args.query } : {}),
              ...(args.includeArchived ? { includeArchived: true } : {}),
              ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
            }),
          );
          return {
            artifacts: listed.items.map(({ id: artifactId, head }) => ({
              id: artifactId,
              title: head.title,
              kind: head.kind,
              viewVersion: head.view.version,
              revision: head.revision,
              updatedAt: head.updatedAt,
              updatedBy: head.updatedBy,
              archived: head.archived,
              url: urlOf(ctx, artifactId),
            })),
            ...(listed.nextCursor !== undefined ? { nextCursor: listed.nextCursor } : {}),
          };
        },
      },
      {
        name: "get_artifact",
        description: "Read an artifact: its view source and history, document versions, revision, url, and snapshotUrl.",
        annotations: READ,
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: {
            id,
            version: version("A past view version. Default: the current one."),
            includeSource: { type: "boolean", description: "Return the view source. Default true." },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            kind: { type: "string" },
            revision: { type: "integer" },
            archived: { type: "boolean" },
            url: { type: "string" },
            snapshotUrl: { type: "string" },
            view: { type: "object" },
            documents: { type: "array" },
            history: { type: "array" },
          },
        },
        handler: async (args, ctx) => {
          const got = unwrap(
            await ops.get(args.id, {
              ...(args.version !== undefined ? { version: args.version } : {}),
              includeSource: args.includeSource !== false,
            }),
          );
          const live = liveOf(got.head);
          return {
            id: args.id,
            title: got.head.title,
            kind: got.head.kind,
            revision: got.head.revision,
            archived: got.head.archived,
            url: urlOf(ctx, args.id),
            snapshotUrl: snapshotUrlOf(ctx, args.id, got.view.version, live),
            view: {
              version: got.view.version,
              ...(got.source !== undefined ? { source: got.source } : {}),
              by: got.view.by,
              at: got.view.at,
              op: got.view.op,
              ...(got.view.restoredFrom !== undefined ? { restoredFrom: got.view.restoredFrom } : {}),
            },
            documents: Object.entries(live).map(([name, record]) => ({
              name,
              version: record.version,
              bytes: record.bytes,
              by: record.by,
              at: record.at,
            })),
            history: history(got.history),
          };
        },
      },
      {
        name: "get_document",
        description: "Read one data document's value, at its current or a past version, with its history.",
        annotations: READ,
        inputSchema: {
          type: "object",
          required: ["id", "name"],
          properties: {
            id,
            name: { type: "string", minLength: 1, maxLength: 64 },
            version: version("A past version. Default: the current one."),
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            version: { type: "integer" },
            value: {},
            by: { type: "object" },
            at: { type: "string" },
            history: { type: "array" },
          },
        },
        handler: async (args) => {
          const got = unwrap(await ops.getDocument(args.id, args.name, args.version));
          return {
            name: args.name,
            version: got.record.version,
            value: got.value,
            by: got.record.by,
            at: got.record.at,
            ...(got.record.runId !== undefined ? { runId: got.record.runId } : {}),
            ...(got.record.removed ? { removed: true } : {}),
            history: history(got.history),
          };
        },
      },
      {
        name: "validate_artifact",
        description: "Check a page and sample documents exactly as a save would, without saving. Errors name a line and the fix.",
        annotations: READ,
        inputSchema: {
          type: "object",
          required: ["kind", "source"],
          properties: {
            kind,
            source: { type: "string" },
            documents: documentValues,
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            errors: { type: "array" },
            warnings: { type: "array" },
            errorsOmitted: { type: "integer" },
            renderCheck: { type: "object" },
          },
        },
        handler: async (args, ctx) => {
          const documents: Record<string, unknown> = args.documents ?? {};
          const validation = validateWithContext(
            { kind: args.kind, source: args.source, documents, title: "Preview" },
            ops.context,
          );
          if (!validation.ok || !hook) return validation;
          const data: Record<string, string> = {};
          const records: Record<string, ArtifactVersionRecord> = {};
          const at = new Date().toISOString();
          for (const [name, value] of Object.entries(documents)) {
            data[name] = scriptSafeJson(value);
            records[name] = { version: 1, bytes: 0, by: { kind: "preview" }, at, op: "create" };
          }
          const verdict = await runRenderCheck(
            hook,
            {
              document: buildFrameDocument({
                kind: args.kind,
                source: args.source,
                global: {
                  id: "preview",
                  title: "Preview",
                  view: { version: 1 },
                  documents: Object.fromEntries(
                    Object.keys(records).map((name) => [name, { version: 1, updatedAt: at }]),
                  ),
                  snapshot: false,
                },
                data,
              }),
              csp,
              kind: args.kind,
            },
            ctx.signal,
          );
          if ("unavailable" in verdict) {
            throw new ConnectorCallError("unavailable", verdict.unavailable);
          }
          return verdict.ok
            ? {
                ...validation,
                warnings: [...validation.warnings, ...verdict.warnings],
                renderCheck: { ok: true },
              }
            : {
                ...validation,
                ok: false,
                errors: verdict.errors,
                renderCheck: { ok: false },
              };
        },
      },
      {
        name: "create_artifact",
        description:
          "Publish a new page. Put its numbers in documents (the page's script reads each as " +
          "window.artifact.data.<name>), not in the HTML. Validate it first.",
        annotations: WRITE,
        inputSchema: {
          type: "object",
          required: ["id", "title", "kind", "source"],
          properties: {
            id,
            title: { type: "string", minLength: 1, maxLength: 1000 },
            kind,
            source: { type: "string" },
            documents: documentValues,
          },
          additionalProperties: false,
        },
        handler: async (args, ctx) => {
          const render = renderFor(ctx);
          const created = unwrap(
            await ops.create({
              id: args.id,
              title: args.title,
              kind: args.kind,
              source: args.source,
              ...(args.documents !== undefined ? { documents: args.documents } : {}),
              by: actorOf(ctx),
              ...(render ? { render } : {}),
            }),
          );
          return {
            id: args.id,
            revision: created.head.revision,
            url: urlOf(ctx, args.id),
            view: { version: created.head.view.version },
            documents: Object.fromEntries(
              Object.entries(created.head.documents).map(([name, record]) => [name, record.version]),
            ),
            ...warningsOf(created.warnings),
          };
        },
      },
      {
        name: "update_artifact",
        description: "Replace a page's whole source (and optionally its title). For small edits use patch_artifact.",
        annotations: WRITE,
        inputSchema: {
          type: "object",
          required: ["id", "baseVersion", "source"],
          properties: {
            id,
            baseVersion: version("The view version you read; a newer one fails with conflict."),
            source: { type: "string" },
            title: { type: "string", minLength: 1, maxLength: 1000 },
          },
          additionalProperties: false,
        },
        handler: async (args, ctx) => {
          const render = renderFor(ctx);
          const updated = unwrap(
            await ops.update({
              id: args.id,
              baseVersion: args.baseVersion,
              source: args.source,
              ...(args.title !== undefined ? { title: args.title } : {}),
              by: actorOf(ctx),
              ...(render ? { render } : {}),
            }),
          );
          return {
            id: args.id,
            revision: updated.head.revision,
            view: { version: updated.head.view.version },
            url: urlOf(ctx, args.id),
            ...warningsOf(updated.warnings),
          };
        },
      },
      {
        name: "patch_artifact",
        description: "Edit a page by exact find-and-replace: each find must match once, all apply at once, or nothing changes.",
        annotations: WRITE,
        inputSchema: {
          type: "object",
          required: ["id", "baseVersion", "edits"],
          properties: {
            id,
            baseVersion: version("The view version you read; a newer one fails with conflict."),
            edits: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: {
                type: "object",
                required: ["find", "replace"],
                properties: {
                  find: { type: "string", minLength: 1, description: "Exact text occurring once in the current source." },
                  replace: { type: "string" },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        handler: async (args, ctx) => {
          const render = renderFor(ctx);
          const patched = unwrap(
            await ops.patch({
              id: args.id,
              baseVersion: args.baseVersion,
              edits: args.edits,
              by: actorOf(ctx),
              ...(render ? { render } : {}),
            }),
          );
          return {
            id: args.id,
            revision: patched.head.revision,
            view: { version: patched.head.view.version },
            url: urlOf(ctx, args.id),
            ...warningsOf(patched.warnings),
          };
        },
      },
      {
        name: "set_documents",
        description: "Set, create (baseVersion 0), or remove (value null) data documents, atomically.",
        annotations: WRITE,
        inputSchema: {
          type: "object",
          required: ["id", "documents"],
          properties: {
            id,
            documents: {
              type: "object",
              minProperties: 1,
              maxProperties: 16,
              additionalProperties: {
                type: "object",
                required: ["baseVersion", "value"],
                properties: {
                  baseVersion: {
                    type: "integer",
                    minimum: 0,
                    description: "The document's current version; 0 to create it.",
                  },
                  value: { description: "Any JSON value; null removes the document." },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        handler: async (args, ctx) => {
          const render = renderFor(ctx);
          const set = unwrap(
            await ops.setDocuments({
              id: args.id,
              documents: args.documents,
              by: actorOf(ctx),
              ...(render ? { render } : {}),
            }),
          );
          return {
            id: args.id,
            revision: set.head.revision,
            documents: Object.fromEntries(
              Object.keys(args.documents).map((name) => {
                const record = set.head.documents[name];
                return [name, { version: record?.version ?? 0, ...(record?.removed ? { removed: true } : {}) }];
              }),
            ),
            ...warningsOf(set.warnings),
          };
        },
      },
      {
        name: "rollback_artifact",
        description: "Restore an earlier view or document version as a new version; history is never rewritten.",
        annotations: WRITE,
        inputSchema: {
          type: "object",
          required: ["id", "target", "version", "baseVersion"],
          properties: {
            id,
            target: { type: "string", enum: ["view", "document"] },
            name: { type: "string", description: 'The document, when target is "document".' },
            version: version("The version to restore."),
            baseVersion: version("The current version of that view or document."),
          },
          additionalProperties: false,
        },
        handler: async (args, ctx) => {
          const render = renderFor(ctx);
          const rolled = unwrap(
            await ops.rollback({
              id: args.id,
              target: args.target,
              ...(args.name !== undefined ? { name: args.name } : {}),
              version: args.version,
              baseVersion: args.baseVersion,
              by: actorOf(ctx),
              ...(render ? { render } : {}),
            }),
          );
          const record =
            args.target === "view" ? rolled.head.view : rolled.head.documents[args.name ?? ""];
          return {
            id: args.id,
            revision: rolled.head.revision,
            target: args.target,
            ...(args.name !== undefined ? { name: args.name } : {}),
            version: record?.version,
            restoredFrom: args.version,
            ...warningsOf(rolled.warnings),
          };
        },
      },
      {
        name: "archive_artifact",
        description: "Archive an artifact: hidden from the library, writes refused, restorable.",
        annotations: WRITE,
        inputSchema: {
          type: "object",
          required: ["id", "baseRevision"],
          properties: { id, baseRevision: version("The artifact's current revision.") },
          additionalProperties: false,
        },
        handler: async (args, ctx) => {
          const archived = unwrap(
            await ops.setArchived({ id: args.id, baseRevision: args.baseRevision, archived: true, by: actorOf(ctx) }),
          );
          return { id: args.id, revision: archived.head.revision, archived: true };
        },
      },
      {
        name: "restore_artifact",
        description: "Restore an archived artifact.",
        annotations: WRITE,
        inputSchema: {
          type: "object",
          required: ["id", "baseRevision"],
          properties: { id, baseRevision: version("The artifact's current revision.") },
          additionalProperties: false,
        },
        handler: async (args, ctx) => {
          const restored = unwrap(
            await ops.setArchived({ id: args.id, baseRevision: args.baseRevision, archived: false, by: actorOf(ctx) }),
          );
          return { id: args.id, revision: restored.head.revision, archived: false };
        },
      },
    ],
  });
  return { ...connector, approval: "never" };
}

/** Every live document record on a head. */
function liveOf(head: ArtifactHeadRecord): Record<string, ArtifactVersionRecord> {
  return Object.fromEntries(
    Object.entries(head.documents).filter(([, record]) => !record.removed),
  );
}
