import { Duration, Effect, Option, Result } from "effect";
import { bytesToHex, decodeBase64, encodeBase64 } from "./bytes.js";
import { ConfigError } from "./config-schema.js";
import { REDIRECT_STATUSES } from "./http-policy.js";
import { parseDocument } from "yaml";
import { MAX_FRONTMATTER_BYTES, splitFrontmatter } from "./skill-frontmatter.js";
import { Storage } from "./runtime/services.js";
import { storageCompareAndSet, storageGet, storageGetMany, storageList, storageSet } from "./runtime/storage.js";
import {
  assertSourceIdentity,
  defineSkillSource,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILLS,
  checkSkillFrontmatter,
  validSkillFilePath,
  validSkillName,
  type SkillSourceContext,
  type SkillSourceFile,
  type SkillSourceSnapshot,
} from "./skill-source-seam.js";
import type { SkillSource } from "./skill-sources.js";
import type { KVStorage } from "./types.js";
import { SentSecrets } from "./sent-secrets.js";
import { GITHUB_SKILL_SNAPSHOT_TTL_MS, MAX_GITHUB_SKILL_FILE_BYTES, skillSourceKeys } from "./storage/keys.js";

export { MAX_GITHUB_SKILL_FILE_BYTES };

/**
 * A GitHub token, or a function the source calls when it contacts GitHub. The function receives a signal that
 * aborts when the check's deadline passes.
 */
export type GitHubSkillsToken = string | ((context: { signal: AbortSignal }) => string | Promise<string>);

export interface GitHubSkillsOptions {
  /** `owner/name`. */
  readonly repo: string;
  /** A directory in the repository, `/`-separated with no leading or trailing `/`; `""` for the root. */
  readonly path: string;
  /** A branch, tag or commit SHA. */
  readonly ref: string;
  /** Sent only to `https://api.github.com`. Needs read access to the repository's contents. */
  readonly token?: GitHubSkillsToken;
  /** One line shown with the source id in the `skills` tool's description. */
  readonly description?: string;
  /** Seconds a snapshot is served without contacting GitHub: default 300, from 30 to 86,400. */
  readonly freshFor?: number;
}

const API_HOST = "api.github.com";
const API_ORIGIN = `https://${API_HOST}`;
const API_VERSION = "2026-03-10";
const USER_AGENT = "connecta-skill-source";
const JSON_MEDIA = "application/vnd.github+json";
const SHA_MEDIA = "application/vnd.github.sha";
const RAW_MEDIA = "application/vnd.github.raw+json";
const DEFAULT_FRESH_SECONDS = 300;
const MIN_FRESH_SECONDS = 30;
const MAX_FRESH_SECONDS = 86_400;
const CHECK_TIMEOUT_MS = 10_000;
const RESERVE_MS = 2_000;
const RESERVE_FRACTION = 0.2;
const LEASE_MARGIN_MS = 1_000;
const AWAIT_INTERVAL_MS = 1_000;
const MIN_FORBIDDEN_HOLD_MS = 60_000;
const DEFAULT_RATE_LIMIT_HOLD_MS = 60_000;
const MAX_HOLD_MS = 86_400_000;
const BLOB_CONCURRENCY = 4;
const STORED_BATCH = 64;
const MAX_REDIRECTS = 3;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_SHA_BYTES = 256;
const MANIFEST_CHUNK_CHARS = 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_CHUNKS = MAX_MANIFEST_BYTES / MANIFEST_CHUNK_CHARS;
const LEASE_TTL_MS = 30_000;
const LEASE_SAFETY_MS = 2_000;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ROW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESTORE_AGE_MS = 15 * 24 * 60 * 60 * 1000;
const MAX_REPAIR_BLOBS = 64;

/** Typed, payload-free reasons a check or sync fails; each is one operator warning code. */
const WARNING_CODES = [
  "token_unavailable",
  "network",
  "redirect_refused",
  "unauthorized",
  "forbidden",
  "not_found",
  "http_status",
  "rate_limited",
  "deadline",
  "invalid_response",
  "path_not_found",
  "truncated_tree",
  "invalid_skill",
  "name_mismatch",
  "symlink",
  "submodule",
  "bound_exceeded",
  "file_too_large",
  "credential_in_file",
  "storage",
  "snapshot_unreadable",
  "manifest_too_large",
] as const;
type FailureCode = (typeof WARNING_CODES)[number];

class SyncFailure {
  constructor(
    readonly code: FailureCode,
    readonly holdUntil?: number,
  ) {}
}

const failure = (code: FailureCode, holdUntil?: number) => new SyncFailure(code, holdUntil);
const asFailure = (error: unknown, code: FailureCode) => (error instanceof SyncFailure ? error : failure(code));

interface Pointer {
  readonly v: 1;
  readonly commit: string;
  readonly revision: string;
  readonly digest: string;
  readonly chunks: number;
  /** When each manifest chunk was written; its key carries the time. */
  readonly chunkTimes: readonly number[];
  readonly checkedAt: number;
  /** When the oldest file or chunk this snapshot relies on was written. */
  readonly oldestRow: number;
  /** Files and chunks found missing or corrupt; the next check refetches them, regardless of `freshFor`. */
  readonly repair?: { readonly blobs: readonly string[]; readonly chunks: boolean; readonly all?: true };
}

interface ManifestFile {
  readonly path: string;
  readonly blob: string;
  readonly digest: string;
  readonly size: number;
  /** When the stored row holding the file's bytes was written; its key carries the time. */
  readonly writtenAt: number;
}

interface ManifestSkill {
  readonly name: string;
  readonly frontmatter: Record<string, unknown>;
  readonly files: readonly ManifestFile[];
}

interface Manifest {
  readonly v: 1;
  readonly skills: readonly ManifestSkill[];
}

interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
  readonly size?: number;
}

interface PlannedSkill {
  readonly name: string;
  readonly document: string;
  readonly files: readonly { path: string; blob: string; size: number }[];
}

const encoder = new TextEncoder();
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validRef(ref: string): boolean {
  try {
    encodeURIComponent(ref);
  } catch {
    return false;
  }
  return (
    ref.length > 0 &&
    ref.length <= 255 &&
    !hasControlCharacter(ref) &&
    !/[~^:?*[\\]|\.\.|@\{|\/\/|^[/-]|\/$|\.lock$|\.$/.test(ref)
  );
}

function validRepo(repo: string): boolean {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(repo);
  return match !== null && match[2] !== "." && match[2] !== "..";
}

function parseOptions(label: string, options: GitHubSkillsOptions) {
  if (!isObject(options)) throw new ConfigError(`${label} options must be an object.`);
  const { repo, path, ref, token, freshFor } = options;
  if (typeof repo !== "string" || !validRepo(repo)) throw new ConfigError(`${label} repo must be "owner/name".`);
  if (typeof path !== "string" || (path !== "" && !validSkillFilePath(path)))
    throw new ConfigError(
      `${label} path must be "" for the repository root or a "/"-separated directory without ".", "..", empty segments, backslashes or a leading or trailing "/".`,
    );
  if (typeof ref !== "string" || !validRef(ref))
    throw new ConfigError(`${label} ref must be a branch, tag or commit SHA.`);
  if (token !== undefined && typeof token !== "function" && (typeof token !== "string" || token === ""))
    throw new ConfigError(`${label} token must be a non-empty string or a function returning one.`);
  const fresh = freshFor ?? DEFAULT_FRESH_SECONDS;
  if (!Number.isInteger(fresh) || fresh < MIN_FRESH_SECONDS || fresh > MAX_FRESH_SECONDS)
    throw new ConfigError(
      `${label} freshFor must be a whole number of seconds from ${MIN_FRESH_SECONDS} to ${MAX_FRESH_SECONDS}.`,
    );
  const [owner, name] = repo.split("/") as [string, string];
  return { owner, name, path, ref, token, freshMs: fresh * 1000 };
}

/** JSON whose every character is ASCII, so its string length is its UTF-8 byte length. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

const digestHex = (algorithm: "SHA-1" | "SHA-256", bytes: Uint8Array) =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest(algorithm, bytes as Uint8Array<ArrayBuffer>),
    catch: () => failure("storage"),
  }).pipe(Effect.map((digest) => bytesToHex(new Uint8Array(digest))));

/** Git's object id for a blob: SHA-1 over `blob <size>\0` and the bytes. */
function gitBlobSha(bytes: Uint8Array): Effect.Effect<string, SyncFailure> {
  const header = encoder.encode(`blob ${bytes.length}\0`);
  const framed = new Uint8Array(header.length + bytes.length);
  framed.set(header);
  framed.set(bytes, header.length);
  return digestHex("SHA-1", framed);
}

/** The latest time GitHub's rate-limit headers allow the next request, or undefined when they name none. */
function holdFor(response: Response, now: number): number | undefined {
  const times: number[] = [];
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter && /^\d+$/.test(retryAfter)) times.push(now + Number(retryAfter) * 1000);
  if (response.headers.get("x-ratelimit-remaining")?.trim() === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    times.push(Number.isFinite(reset) && reset * 1000 > now ? reset * 1000 : now + DEFAULT_RATE_LIMIT_HOLD_MS);
  }
  if (times.length === 0 && response.status === 429) times.push(now + DEFAULT_RATE_LIMIT_HOLD_MS);
  return times.length === 0 ? undefined : Math.min(Math.max(...times), now + MAX_HOLD_MS);
}

function statusFailure(response: Response): SyncFailure {
  if (response.status === 403 || response.status === 429) {
    const until = holdFor(response, Date.now());
    if (until !== undefined) return failure("rate_limited", until);
  }
  switch (response.status) {
    case 401:
      return failure("unauthorized");
    case 403:
      return failure("forbidden", Date.now() + MIN_FORBIDDEN_HOLD_MS);
    case 404:
      return failure("not_found");
    default:
      return failure("http_status");
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    return;
  }
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    await discard(response);
    throw failure("invalid_response");
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw failure("invalid_response");
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/**
 * One GET to the GitHub REST API. The token goes only to `https://api.github.com`:
 * a redirect is followed only to that origin, and any other target fails the request.
 */
async function githubGet(
  path: string,
  accept: string,
  token: string | undefined,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  let target = new URL(path, API_ORIGIN);
  for (let hop = 0; ; hop++) {
    const headers: Record<string, string> = {
      Accept: accept,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": USER_AGENT,
    };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await fetch(target.href, { method: "GET", headers, redirect: "manual", signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw failure("network");
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      await discard(response);
      const location = response.headers.get("location");
      let next: URL | undefined;
      try {
        next = location ? new URL(location, target) : undefined;
      } catch {
        next = undefined;
      }
      if (
        !next ||
        next.protocol !== "https:" ||
        next.hostname !== API_HOST ||
        next.port !== "" ||
        next.username ||
        next.password ||
        hop >= MAX_REDIRECTS
      )
        throw failure("redirect_refused");
      target = next;
      continue;
    }
    if (!response.ok) {
      await discard(response);
      throw statusFailure(response);
    }
    return readBounded(response, limit);
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw failure("invalid_response");
  }
}

function parseTree(value: unknown): { truncated: boolean; entries: TreeEntry[] } {
  if (!isObject(value) || !Array.isArray(value.tree) || typeof value.truncated !== "boolean")
    throw failure("invalid_response");
  const entries = value.tree.map((entry: unknown): TreeEntry => {
    if (
      !isObject(entry) ||
      typeof entry.path !== "string" ||
      entry.path === "" ||
      typeof entry.mode !== "string" ||
      typeof entry.type !== "string" ||
      typeof entry.sha !== "string" ||
      (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0))
    )
      throw failure("invalid_response");
    return entry as unknown as TreeEntry;
  });
  return { truncated: value.truncated, entries };
}

/**
 * The skills a recursive tree of the source directory holds: each immediate
 * child directory with a `SKILL.md`, checked against every structural bound
 * before any file is fetched.
 */
function planSkills(entries: readonly TreeEntry[]): PlannedSkill[] {
  const directories = new Set<string>();
  const contents = new Map<string, TreeEntry[]>();
  for (const entry of entries) {
    const slash = entry.path.indexOf("/");
    if (slash === -1) {
      if (entry.type === "tree") directories.add(entry.path);
      continue;
    }
    const top = entry.path.slice(0, slash);
    let list = contents.get(top);
    if (!list) contents.set(top, (list = []));
    list.push(entry);
  }
  const names = [...directories]
    .filter((name) => contents.get(name)?.some((entry) => entry.path === `${name}/SKILL.md`))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (names.length > MAX_SKILLS) throw failure("bound_exceeded");
  return names.map((name) => {
    if (!validSkillName(name)) throw failure("invalid_skill");
    const files: { path: string; blob: string; size: number }[] = [];
    let total = 0;
    for (const entry of contents.get(name)!) {
      if (entry.mode === "120000") throw failure("symlink");
      if (entry.mode === "160000" || entry.type === "commit") throw failure("submodule");
      if (entry.type === "tree") continue;
      if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755") || !GIT_SHA.test(entry.sha))
        throw failure("invalid_response");
      const path = entry.path.slice(name.length + 1);
      if (!validSkillFilePath(path)) throw failure("invalid_skill");
      if (entry.size === undefined) throw failure("invalid_response");
      if (entry.size > MAX_GITHUB_SKILL_FILE_BYTES) throw failure("file_too_large");
      total += entry.size;
      files.push({ path, blob: entry.sha, size: entry.size });
    }
    if (files.length > MAX_SKILL_FILES || total > MAX_SKILL_BYTES) throw failure("bound_exceeded");
    const document = files.find((file) => file.path === "SKILL.md");
    if (!document) throw failure("invalid_skill");
    return { name, document: document.blob, files };
  });
}

const MAX_YAML_ALIASES = 100;

/** A value that a JSON round trip returns unchanged. */
function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (Array.isArray(value)) return value.every((item, index) => index in value && jsonValue(item, depth + 1));
  if (isObject(value) && Object.getPrototypeOf(value) === Object.prototype)
    return Object.values(value).every((item) => jsonValue(item, depth + 1));
  return false;
}

/** Converts parsed YAML maps to plain objects, refusing a non-string or `__proto__` key. */
function plainValue(value: unknown): unknown {
  if (value instanceof Map) {
    const object: Record<string, unknown> = {};
    for (const [key, item] of value) {
      if (typeof key !== "string" || key === "__proto__") throw new Error("key");
      object[key] = plainValue(item);
    }
    return object;
  }
  return Array.isArray(value) ? value.map(plainValue) : value;
}

/**
 * A `SKILL.md`'s frontmatter as a YAML 1.2 core-schema parser reads it: one
 * mapping with string keys, no duplicate key, at most 32 KiB and within the
 * parser's alias limits, holding only values a JSON round trip keeps.
 */
function yamlFrontmatter(document: Uint8Array): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(document);
  } catch {
    return undefined;
  }
  const split = splitFrontmatter(text);
  if (!split || encoder.encode(split.yaml).byteLength > MAX_FRONTMATTER_BYTES) return undefined;
  try {
    const parsed = parseDocument(split.yaml, {
      version: "1.2",
      schema: "core",
      uniqueKeys: true,
      merge: false,
    });
    if (parsed.errors.length > 0) return undefined;
    const value = plainValue(parsed.toJS({ mapAsMap: true, maxAliasCount: MAX_YAML_ALIASES }));
    return isObject(value) && jsonValue(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function parsePointer(raw: string | null): Pointer | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    const repair = isObject(value) ? value.repair : undefined;
    if (
      isObject(value) &&
      value.v === 1 &&
      typeof value.commit === "string" &&
      GIT_SHA.test(value.commit) &&
      typeof value.revision === "string" &&
      GIT_SHA.test(value.revision) &&
      typeof value.digest === "string" &&
      SHA256.test(value.digest) &&
      Number.isSafeInteger(value.chunks) &&
      (value.chunks as number) >= 1 &&
      (value.chunks as number) <= MAX_MANIFEST_CHUNKS &&
      Array.isArray(value.chunkTimes) &&
      value.chunkTimes.length === value.chunks &&
      value.chunkTimes.every((time: unknown) => Number.isSafeInteger(time)) &&
      Number.isSafeInteger(value.checkedAt) &&
      Number.isSafeInteger(value.oldestRow) &&
      (repair === undefined ||
        (isObject(repair) &&
          typeof repair.chunks === "boolean" &&
          (repair.all === undefined || repair.all === true) &&
          Array.isArray(repair.blobs) &&
          repair.blobs.length <= MAX_REPAIR_BLOBS &&
          repair.blobs.every((blob: unknown) => typeof blob === "string" && GIT_SHA.test(blob))))
    )
      return value as unknown as Pointer;
  } catch {
    return undefined;
  }
  return undefined;
}

function parseManifest(serialized: string): Manifest {
  const value: unknown = JSON.parse(serialized);
  if (!isObject(value) || value.v !== 1 || !Array.isArray(value.skills)) throw failure("snapshot_unreadable");
  for (const skill of value.skills as unknown[]) {
    if (
      !isObject(skill) ||
      typeof skill.name !== "string" ||
      !isObject(skill.frontmatter) ||
      !Array.isArray(skill.files) ||
      !skill.files.every(
        (file: unknown) =>
          isObject(file) &&
          typeof file.path === "string" &&
          typeof file.blob === "string" &&
          GIT_SHA.test(file.blob) &&
          typeof file.digest === "string" &&
          Number.isSafeInteger(file.size) &&
          Number.isSafeInteger(file.writtenAt),
      )
    )
      throw failure("snapshot_unreadable");
  }
  return value as unknown as Manifest;
}

/**
 * Agent Skills read from a directory of a GitHub repository: each immediate
 * child directory of `path` that holds a `SKILL.md` is one skill. Snapshots
 * live in the deployment's storage, so every process and isolate serves the
 * same one; a snapshot is revalidated after `freshFor` seconds by one caller
 * at a time and expires seven days after its last revalidation.
 */
export function githubSkills(id: string, options: GitHubSkillsOptions): SkillSource {
  const label = `githubSkills(${JSON.stringify(String(id))})`;
  const description = isObject(options) ? options.description : undefined;
  assertSourceIdentity(label, id, description);
  const config = parseOptions(label, options);
  const repoPath = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.name)}`;
  const segments = config.path === "" ? [] : config.path.split("/");
  const refPath = config.ref.split("/").map(encodeURIComponent).join("/");
  const configKey = JSON.stringify([config.owner, config.name, config.path, config.ref]);
  let tokenlessPrefix: string | undefined;
  /**
   * Per binding (one deployment's vault key), the partition each token digests to and the partition a function
   * token last resolved to in this process.
   */
  const bindings = new WeakMap<
    SkillSourceContext["digestSecret"],
    { prefixes: Map<string, string>; remembered: { token: string; prefix: string } | undefined }
  >();
  let memo: { prefix: string; digest: string; manifest: Manifest } | undefined;

  return defineSkillSource(label, id, description, {
    warnings: WARNING_CODES,
    cacheTtlMs: config.freshMs,
    ...(config.token === undefined
      ? {}
      : {
          credentialVaultRequired: `${label} has a token, which needs a credential vault so every process derives the same storage partition for it: configure the deployment's credential vault, or remove the token for a public repository.`,
        }),
    snapshot: (ctx: SkillSourceContext) =>
      Effect.gen(function* () {
        let binding = bindings.get(ctx.digestSecret);
        if (!binding) bindings.set(ctx.digestSecret, (binding = { prefixes: new Map(), remembered: undefined }));
        const { prefixes } = binding;
        /** One storage operation. It is uninterruptible, so a deadline waits for it rather than leaving it in flight. */
        const io = <A>(effect: Effect.Effect<A, unknown, Storage>): Effect.Effect<A, SyncFailure> =>
          effect.pipe(
            Effect.provideService(Storage, ctx.storage),
            Effect.mapError(() => failure("storage")),
            Effect.uninterruptible,
          );
        function until<A>(
          deadline: number,
          effect: Effect.Effect<A, SyncFailure>,
          code: FailureCode = "deadline",
        ): Effect.Effect<A, SyncFailure> {
          return effect.pipe(
            Effect.timeoutOption(Duration.millis(Math.max(0, deadline - Date.now()))),
            Effect.flatMap((option) =>
              Option.isNone(option) ? Effect.fail(failure(code)) : Effect.succeed(option.value),
            ),
          );
        }

        /**
         * The storage partition for this source and token: a digest of the repository, path, ref and token, keyed
         * by the credential vault's storage digest key when there is a token. Nothing stored under one token is
         * read, reused or served under another.
         */
        const partitionFor = (token: string | undefined): Effect.Effect<string, SyncFailure> => {
          if (token === undefined)
            return tokenlessPrefix !== undefined
              ? Effect.succeed(tokenlessPrefix)
              : digestHex("SHA-256", encoder.encode(`${configKey}\0none`)).pipe(
                  Effect.map((digest) => (tokenlessPrefix = skillSourceKeys.prefix(id, digest.slice(0, 32)))),
                );
          const known = prefixes.get(token);
          if (known !== undefined) return Effect.succeed(known);
          return Effect.tryPromise({
            try: () => ctx.digestSecret(`${configKey}\0${token}`),
            catch: () => failure("token_unavailable"),
          }).pipe(
            Effect.map((digest) => {
              const prefix = skillSourceKeys.prefix(id, digest.replace(/^hmac:/, "").slice(0, 32));
              prefixes.clear();
              prefixes.set(token, prefix);
              return prefix;
            }),
          );
        };

        const remaining = Math.max(0, ctx.deadlineAt - Date.now());
        const budgetEnd = ctx.deadlineAt - Math.min(RESERVE_MS, Math.floor(remaining * RESERVE_FRACTION));
        const checkEnd = Math.min(Date.now() + CHECK_TIMEOUT_MS, budgetEnd);

        if (typeof config.token !== "function") {
          if (config.token !== undefined) ctx.secret(config.token);
          return yield* partition(yield* partitionFor(config.token), config.token);
        }
        const tokenFunction = config.token;
        const startedWith = binding.remembered;
        if (startedWith) {
          ctx.secret(startedWith.token);
          const fresh = yield* freshSnapshot(startedWith.prefix);
          if (fresh) return fresh;
        }
        const resolved = yield* Effect.result(
          until(
            checkEnd,
            Effect.tryPromise({
              try: (signal) => Promise.resolve(tokenFunction({ signal })),
              catch: () => failure("token_unavailable"),
            }).pipe(
              Effect.flatMap((value) =>
                typeof value === "string" && value !== ""
                  ? Effect.succeed(value)
                  : Effect.fail(failure("token_unavailable")),
              ),
            ),
            "token_unavailable",
          ),
        );
        if (Result.isFailure(resolved)) {
          ctx.warn("token_unavailable");
          if (!startedWith) return yield* Effect.fail(resolved.failure);
          const stored = yield* storedSnapshot(startedWith.prefix);
          return stored ?? (yield* Effect.fail(resolved.failure));
        }
        ctx.secret(resolved.success);
        const prefix = yield* partitionFor(resolved.success);
        binding.remembered = { token: resolved.success, prefix };
        return yield* partition(prefix, resolved.success);

        /** The partition's snapshot when it is stored, fresh and needs no repair. */
        function freshSnapshot(prefix: string) {
          return Effect.gen(function* () {
            const { pointer } = yield* readPointer(prefix);
            if (!pointer || pointer.repair || Date.now() - pointer.checkedAt >= config.freshMs) return undefined;
            const served = yield* Effect.result(serve(prefix, pointer));
            return Result.isSuccess(served) ? served.success : undefined;
          });
        }

        /** The partition's stored snapshot, whatever its age. */
        function storedSnapshot(prefix: string) {
          return Effect.gen(function* () {
            const { pointer } = yield* readPointer(prefix);
            if (!pointer) return undefined;
            const served = yield* Effect.result(serve(prefix, pointer));
            return Result.isSuccess(served) ? served.success : undefined;
          });
        }

        function keysFor(prefix: string) {
          return {
            snapshot: skillSourceKeys.snapshot(prefix),
            lease: skillSourceKeys.lease(prefix),
            hold: skillSourceKeys.hold(prefix),
            filePrefix: skillSourceKeys.filePrefix(prefix),
            manifestDigestPrefix: (digest: string) => skillSourceKeys.manifestDigestPrefix(prefix, digest),
            manifest: (digest: string, index: number, writtenAt: number) =>
              skillSourceKeys.manifest(prefix, digest, index, writtenAt),
            file: (blob: string, digest: string, writtenAt: number) =>
              skillSourceKeys.file(prefix, blob, digest.slice("sha256:".length), writtenAt),
          };
        }

        function readPointer(prefix: string) {
          return io(storageGet(skillSourceKeys.snapshot(prefix))).pipe(
            Effect.map((raw) => ({ raw, pointer: parsePointer(raw) })),
          );
        }

        function loadManifest(prefix: string, pointer: Pointer): Effect.Effect<Manifest, SyncFailure> {
          return Effect.gen(function* () {
            if (memo?.prefix === prefix && memo.digest === pointer.digest) return memo.manifest;
            const keys = keysFor(prefix);
            const chunks = yield* io(
              storageGetMany(
                pointer.chunkTimes.map((writtenAt, index) => keys.manifest(pointer.digest, index, writtenAt)),
              ),
            );
            if (chunks.some((chunk) => chunk === null)) return yield* Effect.fail(failure("snapshot_unreadable"));
            const serialized = chunks.join("");
            if ((yield* digestHex("SHA-256", encoder.encode(serialized))) !== pointer.digest)
              return yield* Effect.fail(failure("snapshot_unreadable"));
            const manifest = yield* Effect.try({
              try: () => parseManifest(serialized),
              catch: () => failure("snapshot_unreadable"),
            });
            memo = { prefix, digest: pointer.digest, manifest };
            return manifest;
          });
        }

        /**
         * Records on the stored snapshot that a file or its manifest was found missing or corrupt, when the record is
         * still `pointer`'s snapshot. The record goes stale, so the next skills read checks regardless of `freshFor`
         * and refetches exactly those rows; nothing is deleted.
         */
        function markRepair(prefix: string, pointer: Pointer, storage: KVStorage, blob?: string) {
          return Effect.gen(function* () {
            const key = skillSourceKeys.snapshot(prefix);
            const raw = yield* storageGet(key);
            const current = parsePointer(raw);
            if (!current || current.digest !== pointer.digest) return;
            const blobs = new Set(current.repair?.blobs ?? []);
            if (blob !== undefined) blobs.add(blob);
            const next: Pointer =
              blobs.size > MAX_REPAIR_BLOBS || current.repair?.all
                ? { ...current, repair: { blobs: [], chunks: true, all: true } }
                : {
                    ...current,
                    repair: { blobs: [...blobs], chunks: (current.repair?.chunks ?? false) || blob === undefined },
                  };
            yield* storageCompareAndSet(key, raw, JSON.stringify(next), { expiresAtMs: recordExpiry(current) });
          }).pipe(Effect.provideService(Storage, storage), Effect.ignore, Effect.uninterruptible);
        }

        function serve(prefix: string, pointer: Pointer): Effect.Effect<SkillSourceSnapshot, SyncFailure> {
          const keys = keysFor(prefix);
          return loadManifest(prefix, pointer).pipe(
            Effect.tapError((error) =>
              error.code === "snapshot_unreadable" ? markRepair(prefix, pointer, ctx.storage) : Effect.void,
            ),
            Effect.map((manifest) => ({
              skills: manifest.skills.map((skill) => ({
                name: skill.name,
                frontmatter: skill.frontmatter,
                files: skill.files.map((file): SkillSourceFile => ({
                  path: file.path,
                  digest: file.digest,
                  size: file.size,
                  read: (reader: SkillSourceContext) =>
                    storageGet(keys.file(file.blob, file.digest, file.writtenAt)).pipe(
                      Effect.provideService(Storage, reader.storage),
                      Effect.mapError(() => failure("storage")),
                      Effect.flatMap((stored) =>
                        Effect.gen(function* () {
                          const bytes =
                            stored === null
                              ? undefined
                              : yield* Effect.try({ try: () => decodeBase64(stored), catch: () => undefined }).pipe(
                                  Effect.orElseSucceed(() => undefined),
                                );
                          if (bytes && `sha256:${yield* digestHex("SHA-256", bytes)}` === file.digest) return bytes;
                          yield* markRepair(prefix, pointer, reader.storage, file.blob);
                          return yield* Effect.fail(failure("snapshot_unreadable"));
                        }),
                      ),
                    ),
                })),
              })),
            })),
          );
        }

        /** The latest a snapshot record may live: seven days after its check, and never past its oldest row. */
        function recordExpiry(pointer: Pointer) {
          return Math.min(pointer.checkedAt + GITHUB_SKILL_SNAPSHOT_TTL_MS, pointer.oldestRow + ROW_TTL_MS);
        }

        /** Serves, checks or syncs the snapshot of one storage partition. */
        function partition(prefix: string, token: string | undefined): Effect.Effect<SkillSourceSnapshot, SyncFailure> {
          const keys = keysFor(prefix);
          /**
           * The output boundary's own checker with this sync's token registered: anything it would rewrite, the
           * token in any form its encoding lattice recognizes, is refused at intake, so stored content needs no
           * redaction for the token it was synced with.
           */
          const intake = token === undefined ? undefined : new SentSecrets();
          intake?.secret(token!);
          const holdsToken = (value: unknown) => intake !== undefined && intake.changes(value);
          /** A file as a reader is served it: valid UTF-8 as text, anything else as a base64 blob. */
          const served = (bytes: Uint8Array) => {
            try {
              return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
            } catch {
              return { blob: encodeBase64(bytes) };
            }
          };
          const pointerNow = readPointer(prefix);

          const get = (path: string, accept: string, limit: number) =>
            Effect.tryPromise({
              try: (signal) => githubGet(path, accept, token, limit, signal),
              catch: (error) => asFailure(error, "network"),
            });
          const getJson = (path: string) =>
            get(path, JSON_MEDIA, MAX_JSON_BYTES).pipe(
              Effect.flatMap((bytes) =>
                Effect.try({ try: () => parseJson(bytes), catch: (error) => asFailure(error, "invalid_response") }),
              ),
            );
          const getTree = (path: string) =>
            getJson(path).pipe(
              Effect.flatMap((value) =>
                Effect.try({ try: () => parseTree(value), catch: (error) => asFailure(error, "invalid_response") }),
              ),
            );

          let lease:
            | { holder: string; value: string; budgetEnd: number; expiresAt: number; renewing: boolean }
            | undefined;
          /** The stored lease value: the holder and the expiry it last wrote, so every renewal names what it replaces. */
          const leaseValue = (holder: string, expiresAt: number) => `${holder}:${expiresAt}`;
          const leaseExpiry = () =>
            Math.min(Date.now() + LEASE_TTL_MS, ctx.deadlineAt + LEASE_SAFETY_MS + LEASE_MARGIN_MS);
          /** Synchronous: the request is live, its budget has not ended, and its lease has time left. */
          const withinLease = () =>
            lease !== undefined &&
            !ctx.signal.aborted &&
            Date.now() < Math.min(lease.budgetEnd, lease.expiresAt - LEASE_SAFETY_MS);
          /** Whether this request still holds the check lease, before its budget ends and storage expires the lease. */
          const leaseHeld = Effect.gen(function* () {
            if (!withinLease()) return false;
            return (yield* io(storageGet(keys.lease))) === lease!.value;
          });
          /**
           * Extends the lease while the holder makes progress, once less than half of {@link LEASE_TTL_MS} remains,
           * so an interrupted holder's lease lapses within that lifetime. One renewal runs at a time, it is a
           * compare-and-set against the value this holder last wrote, and it is written only when it moves the
           * expiry later, so a delayed renewal can never shorten the lease. Losing the lease fails the work.
           */
          const extendLease = Effect.gen(function* () {
            const held = lease;
            if (!held || held.renewing || Date.now() < held.expiresAt - LEASE_TTL_MS / 2) return;
            const expiresAt = leaseExpiry();
            if (expiresAt <= held.expiresAt) return;
            if (!withinLease()) return yield* Effect.fail(failure("deadline"));
            const value = leaseValue(held.holder, expiresAt);
            held.renewing = true;
            const renewed = yield* io(
              storageCompareAndSet(keys.lease, held.value, value, { expiresAtMs: expiresAt }),
            ).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  held.renewing = false;
                }),
              ),
            );
            if (!renewed) return yield* Effect.fail(failure("deadline"));
            held.value = value;
            held.expiresAt = expiresAt;
          });

          /**
           * Publishes `next` over the record read as `expected`. It starts only while this request holds the lease
           * and its deadline has not passed, rechecked immediately before the compare-and-set is dispatched, and the
           * compare-and-set itself is uninterruptible, so no publish lands after the request returns. A lost race
           * serves whichever record won.
           */
          const publish = (expected: string | null, next: Pointer): Effect.Effect<Pointer, SyncFailure> =>
            Effect.gen(function* () {
              if (!(yield* leaseHeld)) return yield* Effect.fail(failure("deadline"));
              const swapped = yield* Effect.suspend(() =>
                withinLease()
                  ? io(
                      storageCompareAndSet(keys.snapshot, expected, JSON.stringify(next), {
                        expiresAtMs: recordExpiry(next),
                      }),
                    )
                  : Effect.fail(failure("deadline")),
              );
              if (swapped) return next;
              const { pointer } = yield* pointerNow;
              return pointer ?? (yield* Effect.fail(failure("storage")));
            });

          const commitSha = get(`${repoPath}/commits/${refPath}`, SHA_MEDIA, MAX_SHA_BYTES).pipe(
            Effect.flatMap((bytes) => {
              const sha = new TextDecoder().decode(bytes).trim();
              return GIT_SHA.test(sha) ? Effect.succeed(sha) : Effect.fail(failure("invalid_response"));
            }),
          );

          /**
           * The source directory's tree, walked one segment at a time so no recursive listing of the repository is
           * needed. Any tree GitHub reports as truncated fails the check.
           */
          const directoryTree = (commit: string) =>
            Effect.gen(function* () {
              const object = yield* getJson(`${repoPath}/git/commits/${commit}`);
              let sha = isObject(object) && isObject(object.tree) ? object.tree.sha : undefined;
              if (typeof sha !== "string" || !GIT_SHA.test(sha)) return yield* Effect.fail(failure("invalid_response"));
              for (const segment of segments) {
                const tree = yield* getTree(`${repoPath}/git/trees/${sha}`);
                if (tree.truncated) return yield* Effect.fail(failure("truncated_tree"));
                const entry = tree.entries.find((candidate) => candidate.path === segment);
                if (!entry || entry.type !== "tree" || !GIT_SHA.test(entry.sha))
                  return yield* Effect.fail(failure("path_not_found"));
                sha = entry.sha;
              }
              return sha as string;
            });

          /** A fetched blob's bytes, checked against its Git SHA and refused when they hold the token in any form. */
          const fetchBlob = (file: { blob: string; size: number }) =>
            get(`${repoPath}/git/blobs/${file.blob}`, RAW_MEDIA, file.size).pipe(
              Effect.flatMap((bytes) =>
                Effect.gen(function* () {
                  if (bytes.length !== file.size || (yield* gitBlobSha(bytes)) !== file.blob)
                    return yield* Effect.fail(failure("invalid_response"));
                  if (holdsToken(served(bytes))) return yield* Effect.fail(failure("credential_in_file"));
                  return bytes;
                }),
              ),
            );

          /** Stored files by Git blob SHA: the newest row's digest and write time, as its key carries them. */
          const storedFiles = io(storageList(keys.filePrefix)).pipe(
            Effect.map((listed) => {
              const stored = new Map<string, { digest: string; writtenAt: number }>();
              for (const key of listed) {
                const match = /^([0-9a-f]{40}):([0-9a-f]{64}):(\d+)$/.exec(key.slice(keys.filePrefix.length));
                if (!match) continue;
                const writtenAt = Number(match[3]);
                const known = stored.get(match[1]!);
                if (!known || writtenAt > known.writtenAt)
                  stored.set(match[1]!, { digest: `sha256:${match[2]!}`, writtenAt });
              }
              return stored;
            }),
          );

          /** Stored rows read in one batch; a row missing or not matching its Git blob SHA reads as absent. */
          const readStored = (entries: readonly (readonly [string, string])[]) =>
            Effect.gen(function* () {
              const values = yield* io(storageGetMany(entries.map(([, key]) => key)));
              const read = new Map<string, Uint8Array<ArrayBuffer>>();
              for (const [index, [blob]] of entries.entries()) {
                const value = values[index];
                const bytes =
                  value == null
                    ? undefined
                    : yield* Effect.try({ try: () => decodeBase64(value), catch: () => undefined }).pipe(
                        Effect.orElseSucceed(() => undefined),
                      );
                if (bytes && (yield* gitBlobSha(bytes)) === blob) read.set(blob, bytes);
              }
              return read;
            });

          /**
           * Everything a snapshot of `revision` needs except its publish. A stored row in this partition is reused
           * when it was written within {@link RESTORE_AGE_MS} and is not marked for repair; anything else is fetched
           * and stored with a {@link ROW_TTL_MS} expiry. A resumed sync reads no stored file body except the
           * `SKILL.md` documents it did not fetch, and skips manifest chunks already stored for the same manifest.
           * Anything fetched that contains the token fails the sync before it, or anything derived from it, is stored.
           */
          const prepare = (commit: string, revision: string, repair: Pointer["repair"]) =>
            Effect.gen(function* () {
              const tree = yield* getTree(`${repoPath}/git/trees/${revision}?recursive=1`);
              if (tree.truncated) return yield* Effect.fail(failure("truncated_tree"));
              const plan = yield* Effect.try({
                try: () => planSkills(tree.entries),
                catch: (error) => asFailure(error, "invalid_response"),
              });
              const reuseAfter = repair?.all ? Infinity : Date.now() - RESTORE_AGE_MS;
              const broken = new Set(repair?.blobs ?? []);
              const stored = yield* storedFiles;
              const rows = new Map<string, { digest: string; writtenAt: number }>();
              const documents = new Map<string, Uint8Array<ArrayBuffer>>();
              const wanted = new Set(plan.map((skill) => skill.document));
              const missing = new Map<string, { blob: string; size: number }>();
              for (const skill of plan)
                for (const file of skill.files) {
                  const row = stored.get(file.blob);
                  if (row && row.writtenAt >= reuseAfter && !broken.has(file.blob)) rows.set(file.blob, row);
                  else missing.set(file.blob, file);
                }
              const unread = [...wanted]
                .filter((blob) => rows.has(blob))
                .map((blob): [string, string] => [
                  blob,
                  keys.file(blob, rows.get(blob)!.digest, rows.get(blob)!.writtenAt),
                ]);
              for (let start = 0; start < unread.length; start += STORED_BATCH) {
                const batch = unread.slice(start, start + STORED_BATCH);
                const read = yield* readStored(batch);
                for (const [blob] of batch) {
                  const bytes = read.get(blob);
                  if (bytes) documents.set(blob, bytes);
                  else {
                    rows.delete(blob);
                    missing.set(
                      blob,
                      plan.flatMap((skill) => skill.files).find((file) => file.blob === blob)!,
                    );
                  }
                }
              }
              yield* Effect.forEach(
                [...missing.values()],
                (file) =>
                  fetchBlob(file).pipe(
                    Effect.flatMap((bytes) =>
                      Effect.gen(function* () {
                        const digest = `sha256:${yield* digestHex("SHA-256", bytes)}`;
                        const writtenAt = Date.now();
                        yield* extendLease;
                        yield* io(
                          storageSet(keys.file(file.blob, digest, writtenAt), encodeBase64(bytes), {
                            expiresAtMs: writtenAt + ROW_TTL_MS,
                          }),
                        );
                        rows.set(file.blob, { digest, writtenAt });
                        if (wanted.has(file.blob)) documents.set(file.blob, bytes);
                      }),
                    ),
                  ),
                { concurrency: BLOB_CONCURRENCY, discard: true },
              );
              const skills: ManifestSkill[] = [];
              for (const skill of plan) {
                const frontmatter = yamlFrontmatter(documents.get(skill.document)!);
                if (!frontmatter) return yield* Effect.fail(failure("invalid_skill"));
                const parsed = checkSkillFrontmatter(skill.name, frontmatter);
                if ("invalid" in parsed)
                  return yield* Effect.fail(
                    failure(frontmatter.name !== skill.name ? "name_mismatch" : "invalid_skill"),
                  );
                skills.push({
                  name: skill.name,
                  frontmatter: parsed.frontmatter,
                  files: skill.files.map((file) => ({
                    path: file.path,
                    blob: file.blob,
                    digest: rows.get(file.blob)!.digest,
                    size: file.size,
                    writtenAt: rows.get(file.blob)!.writtenAt,
                  })),
                });
              }
              const serialized = asciiJson({ v: 1, skills } satisfies Manifest);
              if (holdsToken(skills) || holdsToken(serialized))
                return yield* Effect.fail(failure("credential_in_file"));
              if (serialized.length > MAX_MANIFEST_BYTES) return yield* Effect.fail(failure("manifest_too_large"));
              const digest = yield* digestHex("SHA-256", encoder.encode(serialized));
              const chunks = Math.max(1, Math.ceil(serialized.length / MANIFEST_CHUNK_CHARS));
              const written = new Map<number, number>();
              const chunkPrefix = keys.manifestDigestPrefix(digest);
              for (const key of yield* io(storageList(chunkPrefix))) {
                const match = /^(\d+):(\d+)$/.exec(key.slice(chunkPrefix.length));
                if (!match) continue;
                const [index, writtenAt] = [Number(match[1]), Number(match[2])];
                if (writtenAt >= reuseAfter && !repair?.chunks && writtenAt > (written.get(index) ?? -1))
                  written.set(index, writtenAt);
              }
              const chunkTimes: number[] = [];
              for (let index = 0; index < chunks; index++) {
                const reused = written.get(index);
                if (reused !== undefined) {
                  chunkTimes.push(reused);
                  continue;
                }
                const writtenAt = Date.now();
                yield* extendLease;
                yield* io(
                  storageSet(
                    keys.manifest(digest, index, writtenAt),
                    serialized.slice(index * MANIFEST_CHUNK_CHARS, (index + 1) * MANIFEST_CHUNK_CHARS),
                    { expiresAtMs: writtenAt + ROW_TTL_MS },
                  ),
                );
                chunkTimes.push(writtenAt);
              }
              const oldestRow = Math.min(...chunkTimes, ...[...rows.values()].map((row) => row.writtenAt));
              const manifest: Manifest = { v: 1, skills };
              const next: Pointer = { v: 1, commit, revision, digest, chunks, chunkTimes, checkedAt: 0, oldestRow };
              return { manifest, next };
            });

          /**
           * Checks the revision and syncs it when it changed, when the snapshot needs repair, or when its oldest row
           * is older than {@link RESTORE_AGE_MS}, in which case every file is fetched and stored again.
           */
          /**
           * The snapshot in service, held in memory before a sync step starts, so a step cut short by time or by the
           * platform refusing further operations still ends the request by serving it with no further store read.
           */
          let inService: SkillSourceSnapshot | undefined;

          /**
           * Checks the revision and syncs it when it changed, when the snapshot needs repair, or when rows it relies
           * on are older than {@link RESTORE_AGE_MS}. Before a sync step with a snapshot in service, the snapshot is
           * loaded into memory and, for an unchanged revision, its record renewed. The step then fetches and stores
           * every pending file within the request's time budget and publishes in the same request.
           */
          const check = (initialRaw: string | null, pointer: Pointer | undefined) =>
            Effect.gen(function* () {
              let raw = initialRaw;
              const commit = yield* until(checkEnd, commitSha);
              const current =
                pointer && !pointer.repair && pointer.oldestRow >= Date.now() - RESTORE_AGE_MS ? pointer : undefined;
              const renew = (next: Pointer) => publish(raw, { ...next, commit, checkedAt: Date.now() });
              if (current && commit === current.commit) return yield* renew(current);
              const revision = yield* until(checkEnd, directoryTree(commit));
              if (current && revision === current.revision) return yield* renew(current);
              if (pointer) {
                const loaded = yield* Effect.result(serve(prefix, pointer));
                if (Result.isSuccess(loaded)) inService = loaded.success;
                if (revision === pointer.revision) {
                  const renewed = yield* renew(pointer);
                  raw = JSON.stringify(renewed);
                }
              }
              const prepared = yield* until(budgetEnd, prepare(commit, revision, pointer?.repair));
              const published = yield* publish(raw, { ...prepared.next, checkedAt: Date.now() });
              if (published.digest === prepared.next.digest)
                memo = { prefix, digest: published.digest, manifest: prepared.manifest };
              return published;
            });

          /**
           * Holds the lease as `holder` and checks: rereads the snapshot and hold first, so a claim made on stale
           * state serves what is now stored. A failure's hold is stored before the lease is released, and a failed
           * check serves the record as stored afterwards.
           */
          const checkUnderLease = (
            holder: string,
            expiresAt: number,
          ): Effect.Effect<SkillSourceSnapshot, SyncFailure> =>
            Effect.gen(function* () {
              lease = { holder, value: leaseValue(holder, expiresAt), budgetEnd, expiresAt, renewing: false };
              const release = Effect.suspend(() => io(storageCompareAndSet(keys.lease, lease!.value, null))).pipe(
                Effect.ignore,
              );
              const current = yield* pointerNow;
              const heldNow = yield* io(storageGet(keys.hold));
              const heldUntil = heldNow !== null && /^\d+$/.test(heldNow) ? Number(heldNow) : 0;
              const fresh =
                current.pointer && !current.pointer.repair && Date.now() - current.pointer.checkedAt < config.freshMs;
              if (heldUntil > Date.now() || fresh) {
                yield* release;
                return current.pointer
                  ? yield* serve(prefix, current.pointer)
                  : yield* Effect.fail(failure("rate_limited"));
              }
              const outcome = yield* Effect.result(check(current.raw, current.pointer));
              if (Result.isSuccess(outcome)) {
                yield* release;
                return yield* serve(prefix, outcome.success);
              }
              const failed = outcome.failure;
              ctx.warn(failed.code);
              if (inService) {
                const until = Math.max(
                  failed.holdUntil ?? 0,
                  failed.code === "deadline" || failed.code === "storage" ? 0 : Date.now() + config.freshMs,
                );
                if (until > Date.now())
                  yield* io(storageSet(keys.hold, String(until), { expiresAtMs: until })).pipe(Effect.ignore);
                yield* release;
                return inService;
              }
              const latest = yield* pointerNow.pipe(Effect.orElseSucceed(() => ({ raw: null, pointer: undefined })));
              const holdEnd = Math.max(
                failed.holdUntil ?? 0,
                latest.pointer && failed.code !== "deadline" ? Date.now() + config.freshMs : 0,
              );
              if (holdEnd > Date.now())
                yield* io(storageSet(keys.hold, String(holdEnd), { expiresAtMs: holdEnd })).pipe(Effect.ignore);
              yield* release;
              return latest.pointer ? yield* serve(prefix, latest.pointer) : yield* Effect.fail(failed);
            });

          /** Claims the lease for {@link LEASE_TTL_MS}, or the request's deadline if sooner; the expiry when claimed. */
          const claim = (holder: string) =>
            Effect.suspend(() => {
              const expiresAt = leaseExpiry();
              return io(
                storageCompareAndSet(keys.lease, null, leaseValue(holder, expiresAt), { expiresAtMs: expiresAt }),
              ).pipe(Effect.map((claimed) => (claimed ? expiresAt : undefined)));
            });

          /**
           * With nothing stored and another request syncing, waits for its snapshot, claiming the lease itself if
           * that request's lease expires first.
           */
          const awaitPublished = (holder: string): Effect.Effect<SkillSourceSnapshot, SyncFailure> =>
            Effect.gen(function* () {
              while (Date.now() + AWAIT_INTERVAL_MS < budgetEnd) {
                yield* Effect.sleep(Duration.millis(AWAIT_INTERVAL_MS));
                const { pointer } = yield* pointerNow;
                if (pointer) return yield* serve(prefix, pointer);
                const claimed = yield* claim(holder);
                if (claimed !== undefined) return yield* checkUnderLease(holder, claimed);
              }
              return yield* Effect.fail(failure("deadline"));
            });

          return Effect.gen(function* () {
            const { pointer } = yield* pointerNow;
            const now = Date.now();
            if (pointer && !pointer.repair && now - pointer.checkedAt < config.freshMs) {
              const served = yield* Effect.result(serve(prefix, pointer));
              if (Result.isSuccess(served)) return served.success;
              if (served.failure.code !== "snapshot_unreadable") return yield* Effect.fail(served.failure);
            }
            const held = yield* io(storageGet(keys.hold));
            const holdUntil = held !== null && /^\d+$/.test(held) ? Number(held) : 0;
            if (holdUntil > now)
              return pointer ? yield* serve(prefix, pointer) : yield* Effect.fail(failure("rate_limited"));
            const holder = crypto.randomUUID();
            const claimed = yield* claim(holder);
            if (claimed !== undefined) return yield* checkUnderLease(holder, claimed);
            const { pointer: latest } = yield* pointerNow;
            return latest ? yield* serve(prefix, latest) : yield* awaitPublished(holder);
          });
        }
      }),
  });
}
