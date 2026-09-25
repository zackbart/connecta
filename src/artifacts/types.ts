// The artifacts module's public data shapes and the storage contract behind
// them. Web-API only, and reachable only from the `./artifacts` subpath.

/** How a page's source is interpreted: self-contained HTML, or Markdown rendered at read time. */
export type ArtifactKind = "html" | "markdown";

/**
 * Who made a version. The same shape as an activity actor, taken from the
 * inbound authorization that admitted the call — never from its arguments.
 */
export interface ArtifactActor {
  kind: string;
  id?: string;
  namespace?: string;
}

/** What produced a version. */
export type ArtifactVersionOp =
  | "create"
  | "update"
  | "patch"
  | "rollback"
  | "set"
  | "refresh";

/**
 * A version stream: the view (the page source), one per named data document,
 * and the refresh program.
 */
export type ArtifactStream = "view" | `doc:${string}` | "refresh";

/** One immutable version in one stream. Written once, never rewritten. */
export interface ArtifactVersionRecord {
  /** 1-based and dense within its stream. */
  version: number;
  /** Content address of the body (a SHA-256 hex digest). Absent on a removal. */
  body?: string;
  /** UTF-8 bytes of the body; 0 on a removal. */
  bytes: number;
  by: ArtifactActor;
  /** ISO-8601 instant the version was committed. */
  at: string;
  op: ArtifactVersionOp;
  /** Set by a rollback: the version whose body this one reuses. */
  restoredFrom?: number;
  /** Set on a version a refresh run produced. */
  runId?: string;
  /** A document removal. The name keeps its history and its numbering. */
  removed?: true;
}

/**
 * The one mutable record per artifact. Every write is a compare-and-set of
 * this record, which carries the latest version of every stream; earlier
 * versions live beside it, immutable.
 */
export interface ArtifactHeadRecord {
  /** Increments on every write of any kind. */
  revision: number;
  title: string;
  kind: ArtifactKind;
  archived: boolean;
  createdBy: ArtifactActor;
  createdAt: string;
  updatedBy: ArtifactActor;
  updatedAt: string;
  view: ArtifactVersionRecord;
  /** Latest version of every document name ever set, removals included. */
  documents: Record<string, ArtifactVersionRecord>;
}

/** One refresh run, as history keeps it. */
export interface ArtifactRunRecord {
  runId: string;
  /** ISO-8601; with `runId`, what orders history. */
  startedAt: string;
  finishedAt?: string;
  status: "running" | "succeeded" | "unchanged" | "failed" | "superseded";
  trigger: "schedule" | { manual: ArtifactActor };
  /** The refresh program version the run executed. */
  programVersion: number;
  /** The data version the run produced, when it produced one. */
  documentVersion?: number;
  errorCode?: string;
  /** Bounded failure message, for agents reading run history only. */
  message?: string;
  /** Bounded captured console output, for agents reading run history only. */
  logs?: string;
}

/**
 * Where an artifact store keeps bodies when they should not sit in the key
 * value store itself — an R2 bucket on Workers. Keys are content addresses,
 * so `put` of an existing key writes the same bytes again.
 */
export interface ArtifactBlobStore {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | null>;
}

/**
 * The storage primitives the artifacts module needs, and nothing else: every
 * rule — conflicts, patches, limits, validation — lives above this contract,
 * once. `kvArtifactStore` is the reference implementation.
 */
export interface ArtifactStore {
  /** The head and an opaque token for `swapHead`, or null when absent. */
  head(id: string): Promise<{ head: ArtifactHeadRecord; token: string } | null>;
  /**
   * Atomically replace the head when its token is still `expected` (null:
   * create only when absent). Of N concurrent swaps from one token exactly one
   * returns true.
   */
  swapHead(
    id: string,
    expected: string | null,
    next: ArtifactHeadRecord,
  ): Promise<boolean>;
  /** Heads in id order after `after`, and the cursor to continue from. */
  heads(options: {
    after?: string;
    limit: number;
  }): Promise<{ heads: { id: string; head: ArtifactHeadRecord }[]; next?: string }>;
  /** Content-addressed and idempotent. */
  putBody(key: string, body: string): Promise<void>;
  body(key: string): Promise<string | null>;
  /** Idempotent: a version's record never changes once written. */
  putVersion(
    id: string,
    stream: ArtifactStream,
    version: number,
    record: ArtifactVersionRecord,
  ): Promise<void>;
  /** Stored versions below `below` (all when omitted), newest first. */
  versions(
    id: string,
    stream: ArtifactStream,
    options: { below?: number; limit: number },
  ): Promise<ArtifactVersionRecord[]>;
  /** Insert or replace one run by `runId`; retains the newest 50. */
  putRun(id: string, run: ArtifactRunRecord): Promise<void>;
  /** Newest first. */
  runs(id: string, limit: number): Promise<ArtifactRunRecord[]>;
}

/**
 * Size and shape bounds. Every write checks them, the guide states them, and a
 * deployment may only tighten them.
 */
export interface ArtifactLimits {
  /** A page's source, in UTF-8 bytes. Default 1 MiB. */
  sourceBytes: number;
  /** One document, serialized, in UTF-8 bytes. Default 512 KiB. */
  documentBytes: number;
  /** Live documents per artifact. Default 16. */
  documents: number;
  /** Every live document together. Default 4 MiB. */
  totalDocumentBytes: number;
  /** Source plus injected data, as the viewer builds it. Default 5 MiB. */
  renderedBytes: number;
  /** Title length in characters. Default 160. */
  titleChars: number;
  /** Edits in one patch. Default 50. */
  patchEdits: number;
  /** One edit's `find`, in UTF-8 bytes. Default 16 KiB. */
  findBytes: number;
  /** A refresh program's source, in UTF-8 bytes. Default 64 KiB. */
  programBytes: number;
  /** Console output kept per refresh run, in UTF-8 bytes. Default 8 KiB. */
  runLogBytes: number;
  /** Object and array nesting in a document. Default 64. */
  jsonDepth: number;
}

export const DEFAULT_ARTIFACT_LIMITS: Readonly<ArtifactLimits> = Object.freeze({
  sourceBytes: 1024 * 1024,
  documentBytes: 512 * 1024,
  documents: 16,
  totalDocumentBytes: 4 * 1024 * 1024,
  renderedBytes: 5 * 1024 * 1024,
  titleChars: 160,
  patchEdits: 50,
  findBytes: 16 * 1024,
  programBytes: 64 * 1024,
  runLogBytes: 8 * 1024,
  jsonDepth: 64,
});

/** Refresh runs a store keeps per artifact. */
export const ARTIFACT_RUNS_RETAINED = 50;

/**
 * Origins a page may load from. Scripts come from `scripts`; stylesheets and
 * `preconnect` hints from `styles`; web fonts from `fonts`. Each entry is an
 * exact `https:` origin, and the viewer's CSP names exactly these.
 */
export interface ArtifactAllowlist {
  scripts: readonly string[];
  styles: readonly string[];
  fonts: readonly string[];
}

export const DEFAULT_ARTIFACT_ALLOWLIST: Readonly<ArtifactAllowlist> =
  Object.freeze({
    scripts: Object.freeze([]),
    styles: Object.freeze([]),
    fonts: Object.freeze([]),
  });

/** One validation finding. `line` and `column` are 1-based, into the source. */
export interface ArtifactIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  line?: number;
  column?: number;
}

/** What validation found. `ok` is exactly "no errors"; warnings never block a save. */
export interface ArtifactValidation {
  ok: boolean;
  errors: ArtifactIssue[];
  warnings: ArtifactIssue[];
  /** Errors beyond the 20 reported. */
  errorsOmitted?: number;
}
