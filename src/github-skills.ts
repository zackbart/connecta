import { Duration, Effect, Option, Result } from "effect";
import { bytesToHex, decodeBase64, encodeBase64 } from "./bytes.js";
import { ConfigError } from "./config-schema.js";
import { REDIRECT_STATUSES } from "./http-policy.js";
import { parseDocument } from "yaml";
import { MAX_FRONTMATTER_BYTES, splitFrontmatter } from "./skill-frontmatter.js";
import { Storage } from "./runtime/services.js";
import {
  storageCompareAndSet,
  storageDelete,
  storageGet,
  storageGetMany,
  storageList,
  storageSet,
} from "./runtime/storage.js";
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
const TOKEN_TAG = /^(?:none|[0-9a-f]{32})$/;

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
  readonly checkedAt: number;
  /** The token tag every file this snapshot names was checked against: `none` without a token. */
  readonly tokenTag: string;
  /** The tag of the token most recently resolved for this record; the snapshot is served only when they match. */
  readonly resolvedTag: string;
  /** Set when a file or manifest chunk this record names was found missing or corrupt; the next check resyncs. */
  readonly repair?: true;
}

interface ManifestFile {
  readonly path: string;
  readonly blob: string;
  readonly digest: string;
  readonly size: number;
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

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  const first = needle[0]!;
  for (let index = haystack.indexOf(first); index !== -1; index = haystack.indexOf(first, index + 1)) {
    if (index + needle.length > haystack.length) return false;
    let match = true;
    for (let offset = 1; offset < needle.length; offset++) {
      if (haystack[index + offset] !== needle[offset]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
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
      Number.isSafeInteger(value.checkedAt) &&
      typeof value.tokenTag === "string" &&
      TOKEN_TAG.test(value.tokenTag) &&
      typeof value.resolvedTag === "string" &&
      TOKEN_TAG.test(value.resolvedTag) &&
      (value.repair === undefined || value.repair === true)
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
          Number.isSafeInteger(file.size),
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
  let keyPrefix: string | undefined;
  let memo: { digest: string; manifest: Manifest } | undefined;

  return defineSkillSource(label, id, description, {
    warnings: WARNING_CODES,
    cacheTtlMs: config.freshMs,
    snapshot: (ctx: SkillSourceContext) =>
      Effect.gen(function* () {
        keyPrefix ??= skillSourceKeys.prefix(
          id,
          (yield* digestHex(
            "SHA-256",
            encoder.encode(JSON.stringify([config.owner, config.name, config.path, config.ref])),
          )).slice(0, 32),
        );
        const keys = {
          snapshot: skillSourceKeys.snapshot(keyPrefix),
          lease: skillSourceKeys.lease(keyPrefix),
          hold: skillSourceKeys.hold(keyPrefix),
          manifestPrefix: skillSourceKeys.manifestPrefix(keyPrefix),
          filePrefix: skillSourceKeys.filePrefix(keyPrefix),
          manifest: (digest: string, index: number) => skillSourceKeys.manifest(keyPrefix!, digest, index),
          file: (blob: string, digest: string, tag: string) =>
            skillSourceKeys.file(keyPrefix!, blob, digest.slice("sha256:".length), tag),
        };
        /** One storage operation. It is uninterruptible, so a deadline waits for it rather than leaving it in flight. */
        const io = <A>(effect: Effect.Effect<A, unknown, Storage>): Effect.Effect<A, SyncFailure> =>
          effect.pipe(
            Effect.provideService(Storage, ctx.storage),
            Effect.mapError(() => failure("storage")),
            Effect.uninterruptible,
          );

        let token: string | undefined;
        let tokenBytes: Uint8Array | undefined;
        let tokenTag = "none";
        let tokenResolved = false;
        /** Resolves the token for a check, under the check's deadline; GitHub is never contacted without it. */
        const resolveToken = (deadline: number): Effect.Effect<void, SyncFailure> =>
          resolveTokenValue(deadline).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                tokenResolved = true;
              }),
            ),
          );
        const resolveTokenValue = (deadline: number): Effect.Effect<void, SyncFailure> =>
          typeof config.token !== "function"
            ? Effect.sync(() => {
                token = config.token as string | undefined;
              }).pipe(
                Effect.flatMap(() =>
                  token === undefined
                    ? Effect.void
                    : Effect.tryPromise({
                        try: () => ctx.digestSecret(token!),
                        catch: () => failure("token_unavailable"),
                      }).pipe(
                        Effect.map((digest) => {
                          ctx.secret(token!);
                          tokenBytes = encoder.encode(token!);
                          tokenTag = digest.replace(/^hmac:/, "").slice(0, 32);
                        }),
                      ),
                ),
              )
            : until(
                deadline,
                Effect.tryPromise({
                  try: (signal) => Promise.resolve((config.token as Exclude<GitHubSkillsToken, string>)({ signal })),
                  catch: () => failure("token_unavailable"),
                }).pipe(
                  Effect.flatMap((value) =>
                    typeof value === "string" && value !== ""
                      ? Effect.sync(() => {
                          token = value;
                        })
                      : Effect.fail(failure("token_unavailable")),
                  ),
                ),
                "token_unavailable",
              ).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    if (token === undefined) return;
                    ctx.secret(token);
                    tokenBytes = encoder.encode(token);
                    const digest = yield* Effect.tryPromise({
                      try: () => ctx.digestSecret(token!),
                      catch: () => failure("token_unavailable"),
                    });
                    tokenTag = digest.replace(/^hmac:/, "").slice(0, 32);
                  }),
                ),
              );

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

        const loadManifest = (pointer: Pointer): Effect.Effect<Manifest, SyncFailure> =>
          Effect.gen(function* () {
            if (memo?.digest === pointer.digest) return memo.manifest;
            const chunks = yield* io(
              storageGetMany(
                Array.from({ length: pointer.chunks }, (_, index) => keys.manifest(pointer.digest, index)),
              ),
            );
            if (chunks.some((chunk) => chunk === null)) return yield* Effect.fail(failure("snapshot_unreadable"));
            const serialized = chunks.join("");
            if ((yield* digestHex("SHA-256", encoder.encode(serialized))) !== pointer.digest) {
              for (let index = 0; index < pointer.chunks; index++)
                yield* io(storageDelete(keys.manifest(pointer.digest, index))).pipe(Effect.ignore);
              return yield* Effect.fail(failure("snapshot_unreadable"));
            }
            const manifest = yield* Effect.try({
              try: () => parseManifest(serialized),
              catch: () => failure("snapshot_unreadable"),
            });
            memo = { digest: pointer.digest, manifest };
            return manifest;
          });

        /** Whether a snapshot's files were checked against the token most recently resolved for it. */
        const servable = (pointer: Pointer | undefined): pointer is Pointer =>
          pointer !== undefined &&
          pointer.tokenTag === pointer.resolvedTag &&
          (!tokenResolved || pointer.tokenTag === tokenTag);

        /**
         * Marks the stored record for repair when it is still `pointer`'s snapshot: the record goes stale, so the
         * next skills read checks regardless of `freshFor`, and that check resyncs even an unchanged revision,
         * fetching only what is missing.
         */
        const markRepair = (pointer: Pointer, storage: KVStorage) =>
          Effect.gen(function* () {
            const raw = yield* storageGet(keys.snapshot);
            const current = parsePointer(raw);
            if (!current || current.digest !== pointer.digest || current.repair) return;
            yield* storageCompareAndSet(
              keys.snapshot,
              raw,
              JSON.stringify({ ...current, checkedAt: 0, repair: true } satisfies Pointer),
              { expiresAtMs: current.checkedAt + GITHUB_SKILL_SNAPSHOT_TTL_MS },
            );
          }).pipe(Effect.provideService(Storage, storage), Effect.ignore, Effect.uninterruptible);

        const serve = (pointer: Pointer): Effect.Effect<SkillSourceSnapshot, SyncFailure> =>
          loadManifest(pointer).pipe(
            Effect.tapError((error) =>
              error.code === "snapshot_unreadable" ? markRepair(pointer, ctx.storage) : Effect.void,
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
                    storageGet(keys.file(file.blob, file.digest, pointer.tokenTag)).pipe(
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
                          if (stored !== null)
                            yield* storageDelete(keys.file(file.blob, file.digest, pointer.tokenTag)).pipe(
                              Effect.provideService(Storage, reader.storage),
                              Effect.ignore,
                              Effect.uninterruptible,
                            );
                          yield* markRepair(pointer, reader.storage);
                          return yield* Effect.fail(failure("snapshot_unreadable"));
                        }),
                      ),
                    ),
                })),
              })),
            })),
          );

        const readPointer = io(storageGet(keys.snapshot)).pipe(
          Effect.map((raw) => ({ raw, pointer: parsePointer(raw) })),
        );

        let lease: { holder: string; budgetEnd: number; expiresAt: number } | undefined;
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
          return (yield* io(storageGet(keys.lease))) === lease!.holder;
        });
        /**
         * Extends the lease while the holder makes progress, once half its lifetime has passed, so an interrupted
         * holder's lease lapses within {@link LEASE_TTL_MS}. Losing the lease fails the work.
         */
        const extendLease = Effect.gen(function* () {
          if (!lease) return;
          if (Date.now() < lease.expiresAt - LEASE_TTL_MS / 2) return;
          const expiresAt = leaseExpiry();
          if (
            !withinLease() ||
            !(yield* io(storageCompareAndSet(keys.lease, lease.holder, lease.holder, { expiresAtMs: expiresAt })))
          )
            return yield* Effect.fail(failure("deadline"));
          lease.expiresAt = expiresAt;
        });

        /**
         * Publishes `next` over the record read as `expected`. It starts only while this request holds the lease
         * and its deadline has not passed, and the compare-and-set itself is uninterruptible, so no publish lands
         * after the request returns or during another holder's cleanup. A lost race serves whichever record won.
         */
        const publish = (expected: string | null, next: Pointer): Effect.Effect<Pointer, SyncFailure> =>
          Effect.gen(function* () {
            if (!(yield* leaseHeld)) return yield* Effect.fail(failure("deadline"));
            const swapped = yield* Effect.suspend(() =>
              withinLease()
                ? io(
                    storageCompareAndSet(keys.snapshot, expected, JSON.stringify(next), {
                      expiresAtMs: next.checkedAt + GITHUB_SKILL_SNAPSHOT_TTL_MS,
                    }),
                  )
                : Effect.fail(failure("deadline")),
            );
            if (swapped) return next;
            const { pointer } = yield* readPointer;
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

        const fetchBlob = (file: { blob: string; size: number }) =>
          get(`${repoPath}/git/blobs/${file.blob}`, RAW_MEDIA, file.size).pipe(
            Effect.flatMap((bytes) =>
              Effect.gen(function* () {
                if (bytes.length !== file.size || (yield* gitBlobSha(bytes)) !== file.blob)
                  return yield* Effect.fail(failure("invalid_response"));
                if (tokenBytes && containsBytes(bytes, tokenBytes))
                  return yield* Effect.fail(failure("credential_in_file"));
                return bytes;
              }),
            ),
          );

        /** Stored files by Git blob SHA: the SHA-256 digest and the token tags their keys carry. */
        const storedFiles = io(storageList(keys.filePrefix)).pipe(
          Effect.map((listed) => {
            const stored = new Map<string, { digest: string; tags: Set<string> }>();
            for (const key of listed) {
              const match = /^([0-9a-f]{40}):([0-9a-f]{64}):(none|[0-9a-f]{32})$/.exec(
                key.slice(keys.filePrefix.length),
              );
              if (!match) continue;
              const entry = stored.get(match[1]!) ?? { digest: `sha256:${match[2]!}`, tags: new Set<string>() };
              entry.tags.add(match[3]!);
              stored.set(match[1]!, entry);
            }
            return stored;
          }),
        );

        /** Stored file values read in one batch, each checked against its Git blob SHA. */
        const readStored = (entries: readonly (readonly [string, string])[]) =>
          Effect.gen(function* () {
            const values = yield* io(storageGetMany(entries.map(([, key]) => key)));
            const read: [string, Uint8Array<ArrayBuffer>][] = [];
            for (const [index, [blob, key]] of entries.entries()) {
              const value = values[index];
              const bytes =
                value == null
                  ? undefined
                  : yield* Effect.try({ try: () => decodeBase64(value), catch: () => failure("storage") }).pipe(
                      Effect.option,
                      Effect.map(Option.getOrUndefined),
                    );
              if (!bytes || (yield* gitBlobSha(bytes)) !== blob) {
                yield* io(storageDelete(key)).pipe(Effect.ignore);
                return yield* Effect.fail(failure("storage"));
              }
              read.push([blob, bytes]);
            }
            return read;
          });

        /** Deletes every stored value of `blob`, while this request holds the lease. */
        const discardBlob = (blob: string) =>
          Effect.gen(function* () {
            if (!(yield* leaseHeld)) return;
            for (const key of yield* io(storageList(`${keys.filePrefix}${blob}:`))) {
              if (!withinLease()) return;
              yield* io(storageDelete(key));
            }
          }).pipe(Effect.ignore);

        /**
         * Rechecks stored files against the current token in batches of {@link STORED_BATCH}, rewriting each under
         * the current tag. A file holding the token has every stored value deleted and fails the recheck.
         */
        const recheckStored = (entries: readonly (readonly [string, string, string])[]) =>
          Effect.gen(function* () {
            const bytesByBlob = new Map<string, Uint8Array<ArrayBuffer>>();
            for (let start = 0; start < entries.length; start += STORED_BATCH) {
              yield* extendLease;
              const batch = entries.slice(start, start + STORED_BATCH);
              const read = yield* readStored(batch.map(([blob, , key]) => [blob, key] as const));
              for (const [index, [blob, bytes]] of read.entries()) {
                if (tokenBytes && containsBytes(bytes, tokenBytes)) {
                  yield* discardBlob(blob);
                  return yield* Effect.fail(failure("credential_in_file"));
                }
                yield* io(storageSet(keys.file(blob, batch[index]![1], tokenTag), encodeBase64(bytes)));
                bytesByBlob.set(blob, bytes);
              }
            }
            return bytesByBlob;
          });

        /**
         * Everything a snapshot of `revision` needs except its publish. Each file is stored under the current token
         * tag only after its bytes were checked against the token: a missing file is fetched, and a file stored
         * under another tag is read and rewritten under this one. A resumed sync reads no other stored file body:
         * digests and tags are in the keys. `SKILL.md` documents not read here are read in one batch.
         */
        const prepare = (commit: string, revision: string) =>
          Effect.gen(function* () {
            const tree = yield* getTree(`${repoPath}/git/trees/${revision}?recursive=1`);
            if (tree.truncated) return yield* Effect.fail(failure("truncated_tree"));
            const plan = yield* Effect.try({
              try: () => planSkills(tree.entries),
              catch: (error) => asFailure(error, "invalid_response"),
            });
            const stored = yield* storedFiles;
            const digests = new Map<string, string>();
            const documents = new Map<string, Uint8Array<ArrayBuffer>>();
            const wanted = new Set(plan.map((skill) => skill.document));
            const missing = new Map<string, { blob: string; size: number }>();
            const recheck: (readonly [string, string, string])[] = [];
            for (const skill of plan)
              for (const file of skill.files) {
                const entry = stored.get(file.blob);
                if (!entry) missing.set(file.blob, file);
                else {
                  digests.set(file.blob, entry.digest);
                  if (!entry.tags.has(tokenTag) && !recheck.some(([blob]) => blob === file.blob))
                    recheck.push([file.blob, entry.digest, keys.file(file.blob, entry.digest, [...entry.tags][0]!)]);
                }
              }
            const accept = (blob: string, bytes: Uint8Array<ArrayBuffer>) =>
              Effect.gen(function* () {
                if (tokenBytes && containsBytes(bytes, tokenBytes))
                  return yield* Effect.fail(failure("credential_in_file"));
                const digest = `sha256:${yield* digestHex("SHA-256", bytes)}`;
                yield* extendLease;
                yield* io(storageSet(keys.file(blob, digest, tokenTag), encodeBase64(bytes)));
                digests.set(blob, digest);
                if (wanted.has(blob)) documents.set(blob, bytes);
              });
            for (const [blob, bytes] of yield* recheckStored(recheck)) if (wanted.has(blob)) documents.set(blob, bytes);
            yield* Effect.forEach(
              [...missing.values()],
              (file) => fetchBlob(file).pipe(Effect.flatMap((bytes) => accept(file.blob, bytes))),
              { concurrency: BLOB_CONCURRENCY, discard: true },
            );
            const unread = [...wanted]
              .filter((blob) => !documents.has(blob))
              .map((blob): [string, string] => [blob, keys.file(blob, digests.get(blob)!, tokenTag)]);
            for (const [blob, bytes] of yield* readStored(unread)) documents.set(blob, bytes);
            const skills: ManifestSkill[] = [];
            for (const skill of plan) {
              const frontmatter = yamlFrontmatter(documents.get(skill.document)!);
              if (!frontmatter) return yield* Effect.fail(failure("invalid_skill"));
              const parsed = checkSkillFrontmatter(skill.name, frontmatter);
              if ("invalid" in parsed)
                return yield* Effect.fail(failure(frontmatter.name !== skill.name ? "name_mismatch" : "invalid_skill"));
              skills.push({
                name: skill.name,
                frontmatter: parsed.frontmatter,
                files: skill.files.map((file) => ({
                  path: file.path,
                  blob: file.blob,
                  digest: digests.get(file.blob)!,
                  size: file.size,
                })),
              });
            }
            const serialized = asciiJson({ v: 1, skills } satisfies Manifest);
            if (tokenBytes && containsBytes(encoder.encode(serialized), tokenBytes))
              return yield* Effect.fail(failure("credential_in_file"));
            if (serialized.length > MAX_MANIFEST_BYTES) return yield* Effect.fail(failure("manifest_too_large"));
            const digest = yield* digestHex("SHA-256", encoder.encode(serialized));
            const chunks = Math.max(1, Math.ceil(serialized.length / MANIFEST_CHUNK_CHARS));
            const written = new Set(yield* io(storageList(`${keys.manifestPrefix}${digest}:`)));
            for (let index = 0; index < chunks; index++) {
              if (written.has(keys.manifest(digest, index))) continue;
              yield* extendLease;
              yield* io(
                storageSet(
                  keys.manifest(digest, index),
                  serialized.slice(index * MANIFEST_CHUNK_CHARS, (index + 1) * MANIFEST_CHUNK_CHARS),
                ),
              );
            }
            const manifest: Manifest = { v: 1, skills };
            return {
              manifest,
              next: {
                v: 1,
                commit,
                revision,
                digest,
                chunks,
                checkedAt: 0,
                tokenTag,
                resolvedTag: tokenTag,
              } as Pointer,
            };
          });

        /**
         * Removes stored files and manifest chunks that neither the snapshot just published nor the one it replaced
         * names. It runs only while the record in storage is still that snapshot and this request holds the lease,
         * and every publish requires the lease, so no snapshot can be published during the deletes.
         */
        /** Every storage key a snapshot record names: its manifest chunks and its files under its token tag. */
        const namedBy = (pointer: Pointer) =>
          loadManifest(pointer).pipe(
            Effect.map((manifest) => {
              const named = new Set<string>();
              for (let index = 0; index < pointer.chunks; index++) named.add(keys.manifest(pointer.digest, index));
              for (const skill of manifest.skills)
                for (const file of skill.files) named.add(keys.file(file.blob, file.digest, pointer.tokenTag));
              return named;
            }),
          );

        /**
         * Removes stored files and manifest chunks that neither the snapshot just published nor the one it replaced
         * names, while this request holds the lease. The record is reread immediately before each delete and a key
         * it names is never deleted. A delete already in flight when another request republishes is not prevented
         * by this; repair covers it.
         */
        const collect = (keep: ReadonlySet<string>) =>
          Effect.gen(function* () {
            const listed = [
              ...(yield* io(storageList(keys.filePrefix))),
              ...(yield* io(storageList(keys.manifestPrefix))),
            ];
            if (!(yield* leaseHeld)) return;
            let seen: { raw: string; named: Set<string> } | undefined;
            for (const key of listed) {
              if (keep.has(key)) continue;
              const { raw, pointer } = yield* readPointer;
              if (!pointer || raw === null) return;
              if (seen?.raw !== raw) seen = { raw, named: yield* namedBy(pointer) };
              if (seen.named.has(key)) continue;
              if (!withinLease()) return;
              yield* io(storageDelete(key));
            }
          }).pipe(Effect.ignore);

        /**
         * After a token change, rechecks every file the stored snapshot names against the new token, from storage
         * alone, and records the snapshot as checked against it. The record is first marked with the new token, so
         * no request serves it until the recheck completes; progress is kept in the files' keys. A file holding the
         * token has its stored values deleted and the snapshot is withdrawn.
         */
        const recheckSnapshot = (raw: string | null, pointer: Pointer) =>
          Effect.gen(function* () {
            let current = pointer;
            let currentRaw = raw;
            if (current.resolvedTag !== tokenTag) {
              current = yield* publish(currentRaw, { ...current, resolvedTag: tokenTag });
              currentRaw = JSON.stringify(current);
              if (current.tokenTag === tokenTag) return { raw: currentRaw, pointer: current };
            }
            const manifest = yield* loadManifest(current);
            const stored = yield* storedFiles;
            const entries: (readonly [string, string, string])[] = [];
            const seen = new Set<string>();
            for (const skill of manifest.skills)
              for (const file of skill.files) {
                const entry = stored.get(file.blob);
                if (!entry) return yield* Effect.fail(failure("snapshot_unreadable"));
                if (entry.tags.has(tokenTag) || seen.has(file.blob)) continue;
                seen.add(file.blob);
                entries.push([file.blob, file.digest, keys.file(file.blob, file.digest, [...entry.tags][0]!)]);
              }
            const rechecked = yield* Effect.result(recheckStored(entries));
            if (Result.isFailure(rechecked)) {
              if (rechecked.failure.code === "credential_in_file" && (yield* leaseHeld))
                yield* io(storageCompareAndSet(keys.snapshot, currentRaw, null)).pipe(Effect.ignore);
              return yield* Effect.fail(rechecked.failure);
            }
            const next = yield* publish(currentRaw, { ...current, tokenTag, resolvedTag: tokenTag });
            return { raw: JSON.stringify(next), pointer: next };
          });

        const check = (initialRaw: string | null, initial: Pointer | undefined, budgetEnd: number) =>
          Effect.gen(function* () {
            let raw = initialRaw;
            let pointer = initial;
            const checkEnd = Math.min(Date.now() + CHECK_TIMEOUT_MS, budgetEnd);
            yield* resolveToken(checkEnd);
            if (pointer && pointer.tokenTag !== tokenTag) {
              if (pointer.repair) {
                if (pointer.resolvedTag !== tokenTag) {
                  pointer = yield* publish(raw, { ...pointer, resolvedTag: tokenTag });
                  raw = JSON.stringify(pointer);
                }
              } else ({ raw, pointer } = yield* until(budgetEnd, recheckSnapshot(raw, pointer)));
            }
            const commit = yield* until(checkEnd, commitSha);
            const current = pointer?.tokenTag === tokenTag && !pointer.repair ? pointer : undefined;
            const renew = (next: Pointer) => publish(raw, { ...next, commit, checkedAt: Date.now() });
            if (current && commit === current.commit) return yield* renew(current);
            const revision = yield* until(checkEnd, directoryTree(commit));
            if (current && revision === current.revision) return yield* renew(current);
            const prepared = yield* until(budgetEnd, prepare(commit, revision));
            const published = yield* publish(raw, { ...prepared.next, checkedAt: Date.now() });
            if (published.digest !== prepared.next.digest) return published;
            memo = { digest: published.digest, manifest: prepared.manifest };
            const keep = new Set<string>();
            for (const skill of prepared.manifest.skills)
              for (const file of skill.files) keep.add(keys.file(file.blob, file.digest, published.tokenTag));
            for (let index = 0; index < published.chunks; index++) keep.add(keys.manifest(published.digest, index));
            const prior = pointer ? yield* loadManifest(pointer).pipe(Effect.option) : Option.none<Manifest>();
            if (pointer && Option.isSome(prior)) {
              for (const skill of prior.value.skills)
                for (const file of skill.files) keep.add(keys.file(file.blob, file.digest, pointer.tokenTag));
              for (let index = 0; index < pointer.chunks; index++) keep.add(keys.manifest(pointer.digest, index));
            }
            yield* until(budgetEnd, collect(keep)).pipe(Effect.ignore);
            return published;
          });

        /** Serves `pointer` only when it passes the one serving gate, {@link servable}. */
        const serveEligible = (pointer: Pointer | undefined): Effect.Effect<SkillSourceSnapshot, SyncFailure> =>
          servable(pointer) ? serve(pointer) : Effect.fail(failure("snapshot_unreadable"));

        /**
         * Holds the lease as `holder` and checks: rereads the snapshot and hold first, so a claim made on stale
         * state serves what is now stored. A failure's hold is stored before the lease is released. Every snapshot
         * returned is the record as stored after the check, through the serving gate.
         */
        const checkUnderLease = (
          holder: string,
          budgetEnd: number,
          expiresAt: number,
        ): Effect.Effect<SkillSourceSnapshot, SyncFailure> =>
          Effect.gen(function* () {
            lease = { holder, budgetEnd, expiresAt };
            const release = io(storageCompareAndSet(keys.lease, holder, null)).pipe(Effect.ignore);
            const current = yield* readPointer;
            const heldNow = yield* io(storageGet(keys.hold));
            const heldUntil = heldNow !== null && /^\d+$/.test(heldNow) ? Number(heldNow) : 0;
            const fresh = servable(current.pointer) && Date.now() - current.pointer.checkedAt < config.freshMs;
            if (heldUntil > Date.now() || fresh) {
              yield* release;
              return servable(current.pointer)
                ? yield* serve(current.pointer)
                : yield* Effect.fail(failure("rate_limited"));
            }
            const outcome = yield* Effect.result(check(current.raw, current.pointer, budgetEnd));
            if (Result.isSuccess(outcome)) {
              yield* release;
              return yield* serveEligible(outcome.success);
            }
            const failed = outcome.failure;
            ctx.warn(failed.code);
            const latest = yield* readPointer.pipe(Effect.orElseSucceed(() => ({ raw: null, pointer: undefined })));
            const inService = servable(latest.pointer) ? latest.pointer : undefined;
            const holdEnd = Math.max(
              failed.holdUntil ?? 0,
              inService && failed.code !== "deadline" ? Date.now() + config.freshMs : 0,
            );
            if (holdEnd > Date.now())
              yield* io(storageSet(keys.hold, String(holdEnd), { expiresAtMs: holdEnd })).pipe(Effect.ignore);
            yield* release;
            return inService ? yield* serve(inService) : yield* Effect.fail(failed);
          });

        /** Claims the lease for {@link LEASE_TTL_MS}, or the request's deadline if sooner; the expiry when claimed. */
        const claim = (holder: string) =>
          Effect.suspend(() => {
            const expiresAt = leaseExpiry();
            return io(storageCompareAndSet(keys.lease, null, holder, { expiresAtMs: expiresAt })).pipe(
              Effect.map((claimed) => (claimed ? expiresAt : undefined)),
            );
          });

        /**
         * With nothing stored and another request syncing, waits for its snapshot, claiming the lease itself if
         * that request's lease expires first.
         */
        const awaitPublished = (holder: string, budgetEnd: number): Effect.Effect<SkillSourceSnapshot, SyncFailure> =>
          Effect.gen(function* () {
            while (Date.now() + AWAIT_INTERVAL_MS < budgetEnd) {
              yield* Effect.sleep(Duration.millis(AWAIT_INTERVAL_MS));
              const { pointer } = yield* readPointer;
              if (servable(pointer)) return yield* serve(pointer);
              const claimed = yield* claim(holder);
              if (claimed !== undefined) return yield* checkUnderLease(holder, budgetEnd, claimed);
            }
            return yield* Effect.fail(failure("deadline"));
          });

        const { pointer: stored } = yield* readPointer;
        const pointer = servable(stored) ? stored : undefined;
        const now = Date.now();
        if (pointer && now - pointer.checkedAt < config.freshMs) {
          const served = yield* Effect.result(serve(pointer));
          if (Result.isSuccess(served)) return served.success;
          if (served.failure.code !== "snapshot_unreadable") return yield* Effect.fail(served.failure);
        }
        const held = yield* io(storageGet(keys.hold));
        const holdUntil = held !== null && /^\d+$/.test(held) ? Number(held) : 0;
        if (holdUntil > now) return pointer ? yield* serve(pointer) : yield* Effect.fail(failure("rate_limited"));
        const remaining = Math.max(0, ctx.deadlineAt - now);
        const budgetEnd = ctx.deadlineAt - Math.min(RESERVE_MS, Math.floor(remaining * RESERVE_FRACTION));
        const holder = crypto.randomUUID();
        const claimed = yield* claim(holder);
        if (claimed !== undefined) return yield* checkUnderLease(holder, budgetEnd, claimed);
        const { pointer: latest } = yield* readPointer;
        return servable(latest) ? yield* serve(latest) : yield* awaitPublished(holder, budgetEnd);
      }),
  });
}
