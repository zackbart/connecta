// Every artifact rule, once: base-version conflicts, exact-match patches,
// rollback, archive, limits, and validation, over any ArtifactStore.
//
// A write reads the head, checks its base against the stream it touches,
// writes bodies (content-addressed) and the versions the new head will
// supersede, then commits by compare-and-set of the head. The logical check
// and the physical swap are different questions on purpose: a stale base is a
// conflict the caller must resolve by re-reading, while a head that moved for
// an unrelated reason — a teammate's edit to a different document, a refresh
// landing data — is re-read and retried here, so a write never reports a
// conflict it does not have. Exactly one of two writes from the same base
// wins, because only one can swap the head its check read.
//
// Nothing here throws for a caller's mistake. Operations answer
// `{ ok: false, code, message }`, and the connector turns that into its typed
// error; a throw means storage failed.

import { sha256Hex, utf8Bytes } from "../run-journal.js";
import { markdownPage, MarkdownNestingError } from "./markdown.js";
import {
  ARTIFACT_ID,
  checkDocument,
  checkDocumentTotals,
  checkView,
  finish,
  validDocumentName,
  type CheckContext,
} from "./validate.js";
import type {
  ArtifactActor,
  ArtifactHeadRecord,
  ArtifactIssue,
  ArtifactKind,
  ArtifactStore,
  ArtifactStream,
  ArtifactValidation,
  ArtifactVersionRecord,
  ArtifactVersionOp,
} from "./types.js";

/** Physical head moves a write absorbs before giving up as busy. */
const MAX_SWAP_ATTEMPTS = 8;
/** Versions `history` returns. */
const HISTORY_LIMIT = 20;
/** Heads one listing call may examine while searching. */
const LIST_SCAN_LIMIT = 1000;
/** What the viewer adds around a page beyond its source and documents. */
const FRAME_OVERHEAD_BYTES = 4096;
/** Tombstones keep version numbers, so distinct names need their own bound. */
const DOCUMENT_NAMES_LIMIT = 64;

type ArtifactFailureCode =
  | "conflict"
  | "invalid_args"
  | "not_found"
  | "unavailable";

export interface ArtifactFailure {
  ok: false;
  code: ArtifactFailureCode;
  message: string;
  /** On a conflict: where each stream stands now. */
  current?: Record<string, number>;
  /** On invalid content: what validation found. */
  validation?: ArtifactValidation;
}

type Result<T> = ({ ok: true } & T) | ArtifactFailure;

/**
 * A deployment's render check, bound to one call: it gets the page as the
 * write would leave it — the prospective head, its source, and every live
 * document's stored JSON — and answers with warnings or a failure.
 */
export type RenderPage = (page: {
  id: string;
  head: ArtifactHeadRecord;
  source: string;
  data: Record<string, string>;
}) => Promise<{ ok: true; warnings: ArtifactIssue[] } | ArtifactFailure>;

export interface OperationsOptions extends CheckContext {
  store: ArtifactStore;
  /** Epoch milliseconds. Default `Date.now`. */
  now?: () => number;
}

interface Plan {
  ok: true;
  next: ArtifactHeadRecord;
  /** Content address → body. */
  bodies: Map<string, string>;
  /** Versions the new head supersedes, materialized before the swap. */
  supersede: [ArtifactStream, ArtifactVersionRecord][];
  warnings: ArtifactIssue[];
}

const fail = (
  code: ArtifactFailureCode,
  message: string,
  extra: Partial<Pick<ArtifactFailure, "current" | "validation">> = {},
): ArtifactFailure => ({ ok: false, code, message, ...extra });

const quoteId = (id: string) => `'${id}'`;

/** Bound on the error list a refusal carries in its message. */
const MAX_REFUSAL_CHARS = 1_800;

/**
 * A validation refusal. The message lists every finding — each names a line
 * and a fix — so an agent can repair the page from the error alone; it stays
 * under the guest error bound, pointing at `validate_artifact` for the rest.
 */
export function invalidContent(what: string, validation: ArtifactValidation): ArtifactFailure {
  const total = validation.errors.length + (validation.errorsOmitted ?? 0);
  let message = `${what} failed validation with ${total} error${total === 1 ? "" : "s"}; nothing was saved.`;
  let listed = 0;
  for (const issue of validation.errors) {
    const line = `\n- ${issue.message}`;
    if (message.length + line.length > MAX_REFUSAL_CHARS) break;
    message += line;
    listed++;
  }
  if (listed < total) {
    message += `\n- …and ${total - listed} more; run artifacts.validate_artifact to see them all.`;
  }
  return fail("invalid_args", message, { validation });
}

/** Where every stream stands, for a conflict. Bounded: revision, view, and at most 18 documents. */
function currentOf(head: ArtifactHeadRecord): Record<string, number> {
  const current: Record<string, number> = {
    revision: head.revision,
    view: head.view.version,
  };
  for (const [name, record] of Object.entries(head.documents).slice(0, 18)) {
    current[`document:${name}`] = record.version;
  }
  return current;
}

const liveDocuments = (head: ArtifactHeadRecord) =>
  Object.entries(head.documents).filter(([, record]) => !record.removed);

const dataBytesOf = (head: ArtifactHeadRecord) =>
  liveDocuments(head).reduce((sum, [, record]) => sum + record.bytes, 0);

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

export interface PatchEdit {
  find: string;
  replace: string;
}

export class ArtifactOperations {
  readonly #store: ArtifactStore;
  readonly #context: CheckContext;
  readonly #now: () => number;

  constructor(options: OperationsOptions) {
    this.#store = options.store;
    this.#context = { limits: options.limits, allowlist: options.allowlist };
    this.#now = options.now ?? Date.now;
  }

  get store(): ArtifactStore {
    return this.#store;
  }

  get context(): CheckContext {
    return this.#context;
  }

  #at(): string {
    return new Date(this.#now()).toISOString();
  }

  #checkId(id: unknown): ArtifactFailure | undefined {
    return typeof id === "string" && ARTIFACT_ID.test(id)
      ? undefined
      : fail(
          "invalid_args",
          "id must be a lowercase slug: letters, digits, and single hyphens inside, 1–64 characters, " +
            "starting and ending with a letter or digit (e.g. q3-bugs).",
        );
  }

  #checkTitle(title: unknown): ArtifactFailure | string {
    if (typeof title !== "string" || !title.trim()) {
      return fail("invalid_args", "title must be a non-empty string.");
    }
    const trimmed = title.replace(/\s+/g, " ").trim();
    if (trimmed.length > this.#context.limits.titleChars) {
      return fail(
        "invalid_args",
        `title is ${trimmed.length} characters; the limit is ${this.#context.limits.titleChars}.`,
      );
    }
    return trimmed;
  }

  #checkVersion(name: string, value: unknown, min = 1): ArtifactFailure | undefined {
    return Number.isSafeInteger(value) && (value as number) >= min
      ? undefined
      : fail("invalid_args", `${name} must be a whole number of at least ${min}.`);
  }

  #checkDocumentName(name: unknown): ArtifactFailure | undefined {
    if (validDocumentName(name)) return undefined;
    return fail(
      "invalid_args",
      `Document name ${quoteId(String(name))} is not allowed. Use 1–64 letters, digits, or _, ` +
        "starting with a letter or _, and avoid reserved object property names.",
    );
  }

  #notFound(id: string): ArtifactFailure {
    return fail(
      "not_found",
      `No artifact ${quoteId(id)}. Find ids with artifacts.list_artifacts.`,
    );
  }

  #archived(id: string): ArtifactFailure {
    return fail(
      "invalid_args",
      `Artifact ${quoteId(id)} is archived. Restore it first with artifacts.restore_artifact.`,
    );
  }

  async #body(key: string | undefined): Promise<string> {
    if (key === undefined) throw new Error("artifact version has no body");
    const body = await this.#store.body(key);
    if (body === null) throw new Error(`artifact body ${key} is missing from storage`);
    return body;
  }

  /** Read one version of one stream: the head's latest, or a stored earlier one. */
  async #version(
    id: string,
    stream: ArtifactStream,
    latest: ArtifactVersionRecord | undefined,
    version: number,
  ): Promise<ArtifactVersionRecord | undefined> {
    if (latest && latest.version === version) return latest;
    if (!latest || version > latest.version || version < 1) return undefined;
    const [record] = await this.#store.versions(id, stream, { below: version + 1, limit: 1 });
    return record?.version === version ? record : undefined;
  }

  async #history(
    id: string,
    stream: ArtifactStream,
    latest: ArtifactVersionRecord,
    limit = HISTORY_LIMIT,
  ): Promise<ArtifactVersionRecord[]> {
    const earlier = await this.#store.versions(id, stream, {
      below: latest.version,
      limit: limit - 1,
    });
    return [latest, ...earlier];
  }

  /** Read, plan, write what the plan needs, and swap; retry only physical misses. */
  async #commit(
    id: string,
    plan: (current: ArtifactHeadRecord) => Promise<Plan | ArtifactFailure>,
    render?: RenderPage,
  ): Promise<Result<{ head: ArtifactHeadRecord; warnings: ArtifactIssue[] }>> {
    for (let attempt = 0; attempt < MAX_SWAP_ATTEMPTS; attempt++) {
      const current = await this.#store.head(id);
      if (!current) return this.#notFound(id);
      const drafted = await plan(current.head);
      if (!drafted.ok) return drafted;
      const planned = await this.#rendered(id, drafted, render);
      if (!planned.ok) return planned;
      await Promise.all(
        [...planned.bodies].map(([key, body]) => this.#store.putBody(key, body)),
      );
      await Promise.all(
        planned.supersede.map(([stream, record]) =>
          this.#store.putVersion(id, stream, record.version, record),
        ),
      );
      if (await this.#store.swapHead(id, current.token, planned.next)) {
        return { ok: true, head: planned.next, warnings: planned.warnings };
      }
    }
    return fail(
      "unavailable",
      `Artifact ${quoteId(id)} kept changing while this write was being saved. Retry it.`,
    );
  }

  /**
   * Run the deployment's render check against the page a plan would commit.
   * Bodies the plan already holds are passed in; the rest are read. Warnings
   * join the plan's; a failure replaces it.
   */
  async #rendered(
    id: string,
    plan: Plan,
    render: RenderPage | undefined,
  ): Promise<Plan | ArtifactFailure> {
    if (!render) return plan;
    const known = (key: string | undefined) =>
      key !== undefined && plan.bodies.has(key)
        ? (plan.bodies.get(key) as string)
        : this.#body(key);
    const data: Record<string, string> = {};
    for (const [name, record] of liveDocuments(plan.next)) {
      data[name] = await known(record.body);
    }
    const verdict = await render({
      id,
      head: plan.next,
      source: await known(plan.next.view.body),
      data,
    });
    return verdict.ok
      ? { ...plan, warnings: [...plan.warnings, ...verdict.warnings] }
      : verdict;
  }

  #touch(head: ArtifactHeadRecord, by: ArtifactActor, at: string): ArtifactHeadRecord {
    return { ...head, revision: head.revision + 1, updatedBy: by, updatedAt: at };
  }

  #viewConflict(id: string, head: ArtifactHeadRecord, base: number): ArtifactFailure {
    return fail(
      "conflict",
      `Artifact ${quoteId(id)} view is at version ${head.view.version}, not ${base}. Re-read it with ` +
        `artifacts.get_artifact, reapply the change, and retry with baseVersion ${head.view.version}.`,
      { current: currentOf(head) },
    );
  }

  #revisionConflict(id: string, head: ArtifactHeadRecord, base: number): ArtifactFailure {
    return fail(
      "conflict",
      `Artifact ${quoteId(id)} is at revision ${head.revision}, not ${base}. Re-read it with ` +
        `artifacts.get_artifact and retry with baseRevision ${head.revision}.`,
      { current: currentOf(head) },
    );
  }

  /** Validate a view against the documents the head gives it. */
  #validateView(
    kind: ArtifactKind,
    source: string,
    title: string,
    head: ArtifactHeadRecord,
  ): ArtifactValidation {
    const findings = checkView(
      {
        kind,
        source,
        title,
        documentNames: liveDocuments(head).map(([name]) => name),
        dataBytes: dataBytesOf(head),
      },
      this.#context,
    );
    return finish(findings);
  }

  /** A document change must fit the frame, including rendered Markdown. */
  async #checkRendered(head: ArtifactHeadRecord): Promise<ArtifactFailure | undefined> {
    const total = dataBytesOf(head);
    let viewBytes = head.view.bytes;
    if (head.kind === "markdown") {
      try {
        viewBytes = utf8Bytes(markdownPage(await this.#body(head.view.body), head.title));
      } catch (error) {
        if (!(error instanceof MarkdownNestingError)) throw error;
        return invalidContent("The page", finish({
          errors: [{ code: "E_NESTING", severity: "error", message: error.message }],
          warnings: [],
        }));
      }
    }
    const rendered = viewBytes + total + FRAME_OVERHEAD_BYTES;
    if (rendered <= this.#context.limits.renderedBytes) return undefined;
    return invalidContent("The page and its documents", finish({
      errors: [{
        code: "E_TOO_LARGE",
        severity: "error",
        message: `The page plus its documents would be ${rendered.toLocaleString("en-US")} bytes; ` +
          `the limit is ${this.#context.limits.renderedBytes.toLocaleString("en-US")}. Trim the page or its documents.`,
      }],
      warnings: [],
    }));
  }

  async create(input: {
    id: string;
    title: string;
    kind: ArtifactKind;
    source: string;
    documents?: Record<string, unknown>;
    by: ArtifactActor;
    render?: RenderPage;
  }): Promise<Result<{ head: ArtifactHeadRecord; warnings: ArtifactIssue[] }>> {
    const badId = this.#checkId(input.id);
    if (badId) return badId;
    const title = this.#checkTitle(input.title);
    if (typeof title !== "string") return title;
    if (input.kind !== "html" && input.kind !== "markdown") {
      return fail("invalid_args", 'kind must be "html" or "markdown".');
    }
    if (typeof input.source !== "string") {
      return fail("invalid_args", "source must be a string.");
    }
    const documents = input.documents ?? {};
    if (documents === null || typeof documents !== "object" || Array.isArray(documents)) {
      return fail("invalid_args", "documents must be an object mapping names to JSON values.");
    }
    const errors: ArtifactIssue[] = [];
    const stored: [string, string, number][] = [];
    for (const [name, value] of Object.entries(documents)) {
      const checked = checkDocument(name, value, this.#context.limits);
      if (checked.error) errors.push(checked.error);
      else if (checked.text !== undefined) stored.push([name, checked.text, checked.bytes]);
    }
    const dataBytes = stored.reduce((sum, [, , bytes]) => sum + bytes, 0);
    const totals = checkDocumentTotals(Object.keys(documents).length, dataBytes, this.#context.limits);
    if (totals) errors.push(totals);
    const view = checkView(
      {
        kind: input.kind,
        source: input.source,
        title,
        documentNames: Object.keys(documents),
        dataBytes,
      },
      this.#context,
    );
    const validation = finish({ errors: [...errors, ...view.errors], warnings: view.warnings });
    if (!validation.ok) return invalidContent("The artifact", validation);

    const at = this.#at();
    const by = input.by;
    const bodies = new Map<string, string>();
    const viewKey = await sha256Hex(input.source);
    bodies.set(viewKey, input.source);
    const records: Record<string, ArtifactVersionRecord> = {};
    for (const [name, text, bytes] of stored) {
      const key = await sha256Hex(text);
      bodies.set(key, text);
      records[name] = { version: 1, body: key, bytes, by, at, op: "create" };
    }
    const head: ArtifactHeadRecord = {
      revision: 1,
      title,
      kind: input.kind,
      archived: false,
      createdBy: by,
      createdAt: at,
      updatedBy: by,
      updatedAt: at,
      view: { version: 1, body: viewKey, bytes: utf8Bytes(input.source), by, at, op: "create" },
      documents: records,
    };
    const rendered = await this.#rendered(
      input.id,
      { ok: true, next: head, bodies, supersede: [], warnings: validation.warnings },
      input.render,
    );
    if (!rendered.ok) return rendered;
    await Promise.all([...bodies].map(([key, body]) => this.#store.putBody(key, body)));
    if (!(await this.#store.swapHead(input.id, null, head))) {
      return fail(
        "invalid_args",
        `Artifact id ${quoteId(input.id)} is taken (archived artifacts keep their ids). ` +
          "Update it with artifacts.update_artifact, or choose another id.",
      );
    }
    return { ok: true, head, warnings: rendered.warnings };
  }

  async update(input: {
    id: string;
    baseVersion: number;
    source: string;
    title?: string;
    by: ArtifactActor;
    render?: RenderPage;
  }): Promise<Result<{ head: ArtifactHeadRecord; warnings: ArtifactIssue[] }>> {
    const badId = this.#checkId(input.id);
    if (badId) return badId;
    const badBase = this.#checkVersion("baseVersion", input.baseVersion);
    if (badBase) return badBase;
    if (typeof input.source !== "string") return fail("invalid_args", "source must be a string.");
    let title: string | undefined;
    if (input.title !== undefined) {
      const checked = this.#checkTitle(input.title);
      if (typeof checked !== "string") return checked;
      title = checked;
    }
    const key = await sha256Hex(input.source);
    return this.#commit(input.id, async (head) => {
      if (head.archived) return this.#archived(input.id);
      if (head.view.version !== input.baseVersion) {
        return this.#viewConflict(input.id, head, input.baseVersion);
      }
      const validation = this.#validateView(head.kind, input.source, title ?? head.title, head);
      if (!validation.ok) return invalidContent("The page", validation);
      return this.#replaceView(head, {
        key,
        source: input.source,
        op: "update",
        by: input.by,
        warnings: validation.warnings,
        ...(title === undefined ? {} : { title }),
      });
    }, input.render);
  }

  #replaceView(
    head: ArtifactHeadRecord,
    change: {
      key: string;
      source: string;
      op: ArtifactVersionOp;
      by: ArtifactActor;
      warnings: ArtifactIssue[];
      title?: string;
      restoredFrom?: number;
    },
  ): Plan {
    const at = this.#at();
    const view: ArtifactVersionRecord = {
      version: head.view.version + 1,
      body: change.key,
      bytes: utf8Bytes(change.source),
      by: change.by,
      at,
      op: change.op,
      ...(change.restoredFrom === undefined ? {} : { restoredFrom: change.restoredFrom }),
    };
    return {
      ok: true,
      next: {
        ...this.#touch(head, change.by, at),
        ...(change.title === undefined ? {} : { title: change.title }),
        view,
      },
      bodies: new Map([[change.key, change.source]]),
      supersede: [["view", head.view]],
      warnings: change.warnings,
    };
  }

  async patch(input: {
    id: string;
    baseVersion: number;
    edits: PatchEdit[];
    by: ArtifactActor;
    render?: RenderPage;
  }): Promise<Result<{ head: ArtifactHeadRecord; warnings: ArtifactIssue[] }>> {
    const badId = this.#checkId(input.id);
    if (badId) return badId;
    const badBase = this.#checkVersion("baseVersion", input.baseVersion);
    if (badBase) return badBase;
    const { limits } = this.#context;
    const edits = input.edits;
    if (!Array.isArray(edits) || edits.length < 1 || edits.length > limits.patchEdits) {
      return fail("invalid_args", `edits must be an array of 1 to ${limits.patchEdits} { find, replace } pairs.`);
    }
    for (const [index, edit] of edits.entries()) {
      if (
        edit === null ||
        typeof edit !== "object" ||
        typeof edit.find !== "string" ||
        typeof edit.replace !== "string"
      ) {
        return fail("invalid_args", `edit ${index + 1}: find and replace must both be strings.`);
      }
      const bytes = utf8Bytes(edit.find);
      if (bytes < 1 || bytes > limits.findBytes) {
        return fail(
          "invalid_args",
          `edit ${index + 1}: find must be 1 to ${limits.findBytes} bytes; it is ${bytes}.`,
        );
      }
    }
    let base: { key: string; source: string } | undefined;
    return this.#commit(input.id, async (head) => {
      if (head.archived) return this.#archived(input.id);
      if (head.view.version !== input.baseVersion) {
        return this.#viewConflict(input.id, head, input.baseVersion);
      }
      const cached = base;
      const source =
        cached && cached.key === head.view.body
          ? cached.source
          : await this.#body(head.view.body);
      base = { key: head.view.body ?? "", source };
      const applied = applyPatch(source, edits);
      if (typeof applied !== "string") {
        return fail(
          "invalid_args",
          `The patch was not applied; nothing changed. ${applied.join("; ")}.`,
        );
      }
      const validation = this.#validateView(head.kind, applied, head.title, head);
      if (!validation.ok) return invalidContent("The patched page", validation);
      return this.#replaceView(head, {
        key: await sha256Hex(applied),
        source: applied,
        op: "patch",
        by: input.by,
        warnings: validation.warnings,
      });
    }, input.render);
  }

  async setDocuments(input: {
    id: string;
    documents: Record<string, { baseVersion: number; value: unknown }>;
    by: ArtifactActor;
    op?: "set" | "refresh";
    runId?: string;
    render?: RenderPage;
  }): Promise<
    Result<{
      head: ArtifactHeadRecord;
      warnings: ArtifactIssue[];
    }>
  > {
    const badId = this.#checkId(input.id);
    if (badId) return badId;
    const { limits } = this.#context;
    const documents = input.documents;
    if (documents === null || typeof documents !== "object" || Array.isArray(documents)) {
      return fail("invalid_args", "documents must map names to { baseVersion, value }.");
    }
    const entries = Object.entries(documents);
    if (entries.length < 1 || entries.length > limits.documents) {
      return fail("invalid_args", `documents must name 1 to ${limits.documents} documents.`);
    }
    const changes: { name: string; base: number; text?: string; bytes: number }[] = [];
    const errors: ArtifactIssue[] = [];
    for (const [name, change] of entries) {
      if (change === null || typeof change !== "object") {
        return fail("invalid_args", `documents.${name} must be { baseVersion, value }.`);
      }
      const bad = this.#checkVersion(`documents.${name}.baseVersion`, change.baseVersion, 0);
      if (bad) return bad;
      if (!("value" in change)) {
        return fail("invalid_args", `documents.${name}.value is required; use null to remove the document.`);
      }
      if (change.value === null) {
        const named = checkDocument(name, 0, limits);
        if (named.error) errors.push(named.error);
        changes.push({ name, base: change.baseVersion, bytes: 0 });
        continue;
      }
      const checked = checkDocument(name, change.value, limits);
      if (checked.error) errors.push(checked.error);
      else changes.push({ name, base: change.baseVersion, text: checked.text ?? "", bytes: checked.bytes });
    }
    if (errors.length) {
      return invalidContent("The documents", finish({ errors, warnings: [] }));
    }
    const keyed = await Promise.all(
      changes.map(async (change) => ({
        ...change,
        key: change.text === undefined ? undefined : await sha256Hex(change.text),
      })),
    );
    const op = input.op ?? "set";
    return this.#commit(input.id, async (head) => {
      if (head.archived) return this.#archived(input.id);
      const stale = keyed.filter(
        (change) => (head.documents[change.name]?.version ?? 0) !== change.base,
      );
      if (stale.length) {
        const described = stale.slice(0, 3).map((change) => {
          const now = head.documents[change.name]?.version ?? 0;
          return now === 0
            ? `'${change.name}' does not exist yet (use baseVersion 0), not version ${change.base}`
            : `'${change.name}' is at version ${now}, not ${change.base}`;
        });
        return fail(
          "conflict",
          `Artifact ${quoteId(input.id)} document ${described.join("; ")}. Re-read with artifacts.get_document, ` +
            "reapply the change, and retry with the current baseVersion.",
          { current: currentOf(head) },
        );
      }
      for (const change of keyed) {
        const existing = head.documents[change.name];
        if (change.key === undefined && (!existing || existing.removed)) {
          return fail(
            "invalid_args",
            `Artifact ${quoteId(input.id)} has no document '${change.name}' to remove.`,
          );
        }
      }
      const at = this.#at();
      const next: Record<string, ArtifactVersionRecord> = { ...head.documents };
      const supersede: [ArtifactStream, ArtifactVersionRecord][] = [];
      const bodies = new Map<string, string>();
      for (const change of keyed) {
        const existing = head.documents[change.name];
        if (existing) supersede.push([`doc:${change.name}`, existing]);
        const version = (existing?.version ?? 0) + 1;
        next[change.name] =
          change.key === undefined
            ? { version, bytes: 0, by: input.by, at, op, removed: true, ...(input.runId ? { runId: input.runId } : {}) }
            : {
                version,
                body: change.key,
                bytes: change.bytes,
                by: input.by,
                at,
                op,
                ...(input.runId ? { runId: input.runId } : {}),
              };
        if (change.key !== undefined && change.text !== undefined) bodies.set(change.key, change.text);
      }
      const nextHead: ArtifactHeadRecord = { ...this.#touch(head, input.by, at), documents: next };
      if (Object.keys(next).length > DOCUMENT_NAMES_LIMIT &&
          Object.keys(next).length > Object.keys(head.documents).length) {
        return fail(
          "invalid_args",
          `Artifact ${quoteId(input.id)} has used ${DOCUMENT_NAMES_LIMIT} distinct document names. ` +
            "Reuse an existing name or create another artifact; removed names keep their version history.",
        );
      }
      const live = liveDocuments(nextHead);
      const total = dataBytesOf(nextHead);
      const totals = checkDocumentTotals(live.length, total, limits);
      if (totals) return invalidContent("The documents", finish({ errors: [totals], warnings: [] }));
      const tooLarge = await this.#checkRendered(nextHead);
      if (tooLarge) return tooLarge;
      return { ok: true, next: nextHead, bodies, supersede, warnings: [] };
    }, input.render);
  }

  async rollback(input: {
    id: string;
    target: "view" | "document";
    name?: string;
    version: number;
    baseVersion: number;
    by: ArtifactActor;
    render?: RenderPage;
  }): Promise<Result<{ head: ArtifactHeadRecord; warnings: ArtifactIssue[] }>> {
    const badId = this.#checkId(input.id);
    if (badId) return badId;
    if (input.target !== "view" && input.target !== "document") {
      return fail("invalid_args", 'target must be "view" or "document".');
    }
    const badVersion = this.#checkVersion("version", input.version) ?? this.#checkVersion("baseVersion", input.baseVersion);
    if (badVersion) return badVersion;
    if (input.target === "document" && (typeof input.name !== "string" || !input.name)) {
      return fail("invalid_args", 'name is required when target is "document".');
    }
    if (input.target === "document") {
      const badName = this.#checkDocumentName(input.name);
      if (badName) return badName;
    }
    const name = input.name ?? "";
    const stream: ArtifactStream = input.target === "view" ? "view" : `doc:${name}`;
    return this.#commit(input.id, async (head) => {
      if (head.archived) return this.#archived(input.id);
      const latest = input.target === "view" ? head.view : head.documents[name];
      if (!latest) {
        return fail("not_found", `Artifact ${quoteId(input.id)} has no document '${name}'.`);
      }
      if (latest.version !== input.baseVersion) {
        return input.target === "view"
          ? this.#viewConflict(input.id, head, input.baseVersion)
          : fail(
              "conflict",
              `Artifact ${quoteId(input.id)} document '${name}' is at version ${latest.version}, not ${input.baseVersion}. ` +
                `Re-read it with artifacts.get_document and retry with baseVersion ${latest.version}.`,
              { current: currentOf(head) },
            );
      }
      if (input.version === latest.version) {
        return fail("invalid_args", `Version ${input.version} is already the current one; nothing to roll back.`);
      }
      const target = await this.#version(input.id, stream, latest, input.version);
      if (!target) {
        return fail(
          "not_found",
          `There is no version ${input.version} to roll back to; the latest is ${latest.version}.`,
        );
      }
      const at = this.#at();
      const record: ArtifactVersionRecord = {
        version: latest.version + 1,
        bytes: target.bytes,
        by: input.by,
        at,
        op: "rollback",
        restoredFrom: target.version,
        ...(target.body === undefined ? {} : { body: target.body }),
        ...(target.removed ? { removed: true as const } : {}),
      };
      if (input.target === "view") {
        const source = await this.#body(target.body);
        const validation = this.#validateView(head.kind, source, head.title, head);
        if (!validation.ok) return invalidContent(`View version ${target.version}`, validation);
        return {
          ok: true,
          next: { ...this.#touch(head, input.by, at), view: record },
          bodies: new Map(),
          supersede: [["view", latest]],
          warnings: validation.warnings,
        };
      }
      if (!target.removed) {
        // Limits may have tightened since; the restored value must fit today's.
        const checked = checkDocument(name, JSON.parse(await this.#body(target.body)) as unknown, this.#context.limits);
        if (checked.error) {
          return invalidContent(`Document '${name}' version ${target.version}`, finish({ errors: [checked.error], warnings: [] }));
        }
      }
      const nextHead: ArtifactHeadRecord = {
        ...this.#touch(head, input.by, at),
        documents: { ...head.documents, [name]: record },
      };
      const totals = checkDocumentTotals(liveDocuments(nextHead).length, dataBytesOf(nextHead), this.#context.limits);
      if (totals) return invalidContent("The documents", finish({ errors: [totals], warnings: [] }));
      const tooLarge = await this.#checkRendered(nextHead);
      if (tooLarge) return tooLarge;
      return { ok: true, next: nextHead, bodies: new Map(), supersede: [[stream, latest]], warnings: [] };
    }, input.render);
  }

  async setArchived(input: {
    id: string;
    baseRevision: number;
    archived: boolean;
    by: ArtifactActor;
  }): Promise<Result<{ head: ArtifactHeadRecord; warnings: ArtifactIssue[] }>> {
    const badId = this.#checkId(input.id);
    if (badId) return badId;
    const bad = this.#checkVersion("baseRevision", input.baseRevision);
    if (bad) return bad;
    return this.#commit(input.id, async (head) => {
      if (head.revision !== input.baseRevision) {
        return this.#revisionConflict(input.id, head, input.baseRevision);
      }
      if (head.archived === input.archived) {
        return fail(
          "invalid_args",
          `Artifact ${quoteId(input.id)} is ${input.archived ? "already archived" : "not archived"}.`,
        );
      }
      const at = this.#at();
      return {
        ok: true,
        next: { ...this.#touch(head, input.by, at), archived: input.archived },
        bodies: new Map(),
        supersede: [],
        warnings: [],
      };
    });
  }

  async get(
    id: string,
    options: { version?: number; includeSource?: boolean } = {},
  ): Promise<
    Result<{
      head: ArtifactHeadRecord;
      view: ArtifactVersionRecord;
      source?: string;
      history: ArtifactVersionRecord[];
    }>
  > {
    const badId = this.#checkId(id);
    if (badId) return badId;
    if (options.version !== undefined) {
      const bad = this.#checkVersion("version", options.version);
      if (bad) return bad;
    }
    const current = await this.#store.head(id);
    if (!current) return this.#notFound(id);
    const { head } = current;
    const view = await this.#version(id, "view", head.view, options.version ?? head.view.version);
    if (!view) {
      return fail("not_found", `Artifact ${quoteId(id)} has no view version ${options.version}; the latest is ${head.view.version}.`);
    }
    const history = await this.#history(id, "view", head.view);
    return {
      ok: true,
      head,
      view,
      history,
      ...(options.includeSource === false ? {} : { source: await this.#body(view.body) }),
    };
  }

  async getDocument(
    id: string,
    name: string,
    version?: number,
  ): Promise<
    Result<{
      head: ArtifactHeadRecord;
      record: ArtifactVersionRecord;
      value: unknown;
      history: ArtifactVersionRecord[];
    }>
  > {
    const badId = this.#checkId(id);
    if (badId) return badId;
    if (typeof name !== "string" || !name) return fail("invalid_args", "name is required.");
    const badName = this.#checkDocumentName(name);
    if (badName) return badName;
    if (version !== undefined) {
      const bad = this.#checkVersion("version", version);
      if (bad) return bad;
    }
    const current = await this.#store.head(id);
    if (!current) return this.#notFound(id);
    const latest = current.head.documents[name];
    if (!latest) {
      const names = liveDocuments(current.head).map(([candidate]) => candidate);
      return fail(
        "not_found",
        `Artifact ${quoteId(id)} has no document '${name}' (it has: ${names.length ? names.join(", ") : "none"}).`,
      );
    }
    const record = await this.#version(id, `doc:${name}`, latest, version ?? latest.version);
    if (!record) {
      return fail("not_found", `Document '${name}' has no version ${version}; the latest is ${latest.version}.`);
    }
    const value = record.removed ? null : (JSON.parse(await this.#body(record.body)) as unknown);
    const history = await this.#history(id, `doc:${name}`, latest);
    return { ok: true, head: current.head, record, value, history };
  }

  /** The page a viewer renders: a view version and exactly the documents asked for (all current ones by default). */
  async page(
    id: string,
    pin: { view?: number; documents?: Record<string, number> } = {},
  ): Promise<
    Result<{
      head: ArtifactHeadRecord;
      view: ArtifactVersionRecord;
      source: string;
      documents: Record<string, { record: ArtifactVersionRecord; value: unknown }>;
    }>
  > {
    const badId = this.#checkId(id);
    if (badId) return badId;
    const current = await this.#store.head(id);
    if (!current) return this.#notFound(id);
    const { head } = current;
    const view = await this.#version(id, "view", head.view, pin.view ?? head.view.version);
    if (!view) return this.#notFound(id);
    const wanted: [string, number][] = pin.documents
      ? Object.entries(pin.documents)
      : liveDocuments(head).map(([name, record]) => [name, record.version]);
    const documents: Record<string, { record: ArtifactVersionRecord; value: unknown }> = {};
    for (const [name, version] of wanted) {
      const badName = this.#checkDocumentName(name);
      if (badName) return badName;
      const record = await this.#version(id, `doc:${name}`, head.documents[name], version);
      if (!record) return this.#notFound(id);
      if (record.removed) continue;
      documents[name] = { record, value: JSON.parse(await this.#body(record.body)) as unknown };
    }
    return { ok: true, head, view, source: await this.#body(view.body), documents };
  }

  async list(options: {
    query?: string;
    includeArchived?: boolean;
    limit: number;
    cursor?: string;
  }): Promise<Result<{ items: { id: string; head: ArtifactHeadRecord }[]; nextCursor?: string }>> {
    if (options.cursor !== undefined && !ARTIFACT_ID.test(options.cursor)) {
      return fail("invalid_args", "cursor is not one this listing returned.");
    }
    const needle = options.query?.trim().toLowerCase();
    const items: { id: string; head: ArtifactHeadRecord }[] = [];
    let after = options.cursor;
    let scanned = 0;
    for (;;) {
      const page = await this.#store.heads({
        ...(after === undefined ? {} : { after }),
        limit: Math.min(100, LIST_SCAN_LIMIT - scanned),
      });
      for (const item of page.heads) {
        scanned++;
        after = item.id;
        if (item.head.archived && !options.includeArchived) continue;
        if (
          needle &&
          !item.head.title.toLowerCase().includes(needle) &&
          !item.id.includes(needle)
        ) continue;
        items.push(item);
        if (items.length >= options.limit) {
          const more = page.next !== undefined || page.heads.at(-1)?.id !== item.id;
          return more ? { ok: true, items, nextCursor: item.id } : { ok: true, items };
        }
      }
      if (page.next === undefined) return { ok: true, items };
      if (scanned >= LIST_SCAN_LIMIT) {
        return after === undefined ? { ok: true, items } : { ok: true, items, nextCursor: after };
      }
    }
  }
}

/**
 * Apply every edit to `source` at once, each against the original text: every
 * `find` must occur exactly once and no two may overlap. Returns the new text,
 * or every reason it could not.
 */
export function applyPatch(source: string, edits: readonly PatchEdit[]): string | string[] {
  const problems: string[] = [];
  const spans: { start: number; end: number; replace: string; index: number }[] = [];
  for (const [index, edit] of edits.entries()) {
    const hits: number[] = [];
    for (let at = source.indexOf(edit.find); at >= 0 && hits.length < 4; at = source.indexOf(edit.find, at + 1)) {
      hits.push(at);
    }
    if (hits.length === 0) {
      problems.push(
        `edit ${index + 1}: find matched 0 times; copy it exactly from the current source (artifacts.get_artifact), whitespace included`,
      );
      continue;
    }
    if (hits.length > 1) {
      let total = hits.length;
      if (total > 3) {
        total = 0;
        for (let at = source.indexOf(edit.find); at >= 0; at = source.indexOf(edit.find, at + 1)) total++;
      }
      const lines = hits.slice(0, 3).map((at) => lineOf(source, at));
      problems.push(
        `edit ${index + 1}: find matched ${total} times (lines ${lines.join(", ")}${total > 3 ? ", …" : ""}); ` +
          "include surrounding text so it matches once",
      );
      continue;
    }
    const start = hits[0] ?? 0;
    spans.push({ start, end: start + edit.find.length, replace: edit.replace, index });
  }
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    const previous = spans[i - 1];
    const current = spans[i];
    if (previous && current && current.start < previous.end) {
      problems.push(
        `edits ${Math.min(previous.index, current.index) + 1} and ${Math.max(previous.index, current.index) + 1} overlap ` +
          `(line ${lineOf(source, current.start)}); merge them into one edit`,
      );
    }
  }
  if (problems.length) return problems.slice(0, 20);
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += source.slice(cursor, span.start) + span.replace;
    cursor = span.end;
  }
  return out + source.slice(cursor);
}
