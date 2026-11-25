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
import { GITHUB_SKILL_SNAPSHOT_TTL_MS, MAX_GITHUB_SKILL_FILE_BYTES, skillSourceKeys } from "./storage/keys.js";

export { MAX_GITHUB_SKILL_FILE_BYTES };

/** A GitHub token, or a function the source calls before each skills read. */
export type GitHubSkillsToken = string | (() => string | Promise<string>);

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

const API_ORIGIN = "https://api.github.com";
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
const LEASE_MARGIN_MS = 1_000;
const AWAIT_INTERVAL_MS = 1_000;
const MIN_FORBIDDEN_HOLD_MS = 60_000;
const DEFAULT_RATE_LIMIT_HOLD_MS = 60_000;
const MAX_HOLD_MS = 86_400_000;
const BLOB_CONCURRENCY = 4;
const STORED_BATCH = 50;
const MAX_REDIRECTS = 3;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_SHA_BYTES = 256;
const MANIFEST_CHUNK_CHARS = 1024 * 1024;
const MAX_MANIFEST_CHUNKS = 4_096;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

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

function holdFor(response: Response, now: number): number | undefined {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter && /^\d+$/.test(retryAfter)) return now + Math.min(Number(retryAfter) * 1000, MAX_HOLD_MS);
  if (response.headers.get("x-ratelimit-remaining")?.trim() === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    return Number.isFinite(reset) && reset * 1000 > now
      ? Math.min(reset * 1000, now + MAX_HOLD_MS)
      : now + DEFAULT_RATE_LIMIT_HOLD_MS;
  }
  return response.status === 429 ? now + DEFAULT_RATE_LIMIT_HOLD_MS : undefined;
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
      if (!next || next.origin !== API_ORIGIN || next.username || next.password || hop >= MAX_REDIRECTS)
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
      Number.isSafeInteger(value.checkedAt)
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
          file: (blob: string) => skillSourceKeys.file(keyPrefix!, blob),
        };
        const io = <A>(effect: Effect.Effect<A, unknown, Storage>): Effect.Effect<A, SyncFailure> =>
          effect.pipe(
            Effect.provideService(Storage, ctx.storage),
            Effect.mapError(() => failure("storage")),
          );

        const token = yield* Effect.result(
          Effect.tryPromise({
            try: async () => {
              const value = typeof config.token === "function" ? await config.token() : config.token;
              if (value !== undefined && (typeof value !== "string" || value === "")) throw new Error("invalid");
              return value;
            },
            catch: () => failure("token_unavailable"),
          }),
        );
        if (Result.isSuccess(token) && token.success !== undefined) ctx.secret(token.success);
        const tokenBytes =
          Result.isSuccess(token) && token.success !== undefined ? encoder.encode(token.success) : undefined;

        const get = (path: string, accept: string, limit: number) =>
          Result.isFailure(token)
            ? Effect.fail(token.failure)
            : Effect.tryPromise({
                try: (signal) => githubGet(path, accept, token.success, limit, signal),
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
        const until = <A>(deadline: number, effect: Effect.Effect<A, SyncFailure>) =>
          effect.pipe(
            Effect.timeoutOption(Duration.millis(Math.max(0, deadline - Date.now()))),
            Effect.flatMap((option) =>
              Option.isNone(option) ? Effect.fail(failure("deadline")) : Effect.succeed(option.value),
            ),
          );

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
            if ((yield* digestHex("SHA-256", encoder.encode(serialized))) !== pointer.digest)
              return yield* Effect.fail(failure("snapshot_unreadable"));
            const manifest = yield* Effect.try({
              try: () => parseManifest(serialized),
              catch: () => failure("snapshot_unreadable"),
            });
            memo = { digest: pointer.digest, manifest };
            return manifest;
          });

        const serve = (pointer: Pointer): Effect.Effect<SkillSourceSnapshot, SyncFailure> =>
          loadManifest(pointer).pipe(
            Effect.map((manifest) => ({
              skills: manifest.skills.map((skill) => ({
                name: skill.name,
                frontmatter: skill.frontmatter,
                files: skill.files.map((file): SkillSourceFile => ({
                  path: file.path,
                  digest: file.digest,
                  size: file.size,
                  read: (reader: SkillSourceContext) =>
                    storageGet(keys.file(file.blob)).pipe(
                      Effect.provideService(Storage, reader.storage),
                      Effect.flatMap((stored) =>
                        stored === null
                          ? Effect.fail(failure("snapshot_unreadable"))
                          : Effect.try({
                              try: () => decodeBase64(stored),
                              catch: () => failure("snapshot_unreadable"),
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

        /** Publishes `next` over the record read as `expected`; a lost race serves whichever record won. */
        const publish = (expected: string | null, next: Pointer): Effect.Effect<Pointer, SyncFailure> =>
          Effect.gen(function* () {
            const swapped = yield* io(
              storageCompareAndSet(keys.snapshot, expected, JSON.stringify(next), {
                expiresAtMs: next.checkedAt + GITHUB_SKILL_SNAPSHOT_TTL_MS,
              }),
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

        /** The source directory's tree, walked one segment at a time so no recursive listing of the repository is needed. */
        const directoryTree = (commit: string) =>
          Effect.gen(function* () {
            const object = yield* getJson(`${repoPath}/git/commits/${commit}`);
            let sha = isObject(object) && isObject(object.tree) ? object.tree.sha : undefined;
            if (typeof sha !== "string" || !GIT_SHA.test(sha)) return yield* Effect.fail(failure("invalid_response"));
            for (const segment of segments) {
              const tree = yield* getTree(`${repoPath}/git/trees/${sha}`);
              const entry = tree.entries.find((candidate) => candidate.path === segment);
              if (!entry) return yield* Effect.fail(failure(tree.truncated ? "truncated_tree" : "path_not_found"));
              if (entry.type !== "tree" || !GIT_SHA.test(entry.sha))
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

        const sync = (commit: string, revision: string, expected: string | null, previous: Pointer | undefined) =>
          Effect.gen(function* () {
            const tree = yield* getTree(`${repoPath}/git/trees/${revision}?recursive=1`);
            if (tree.truncated) return yield* Effect.fail(failure("truncated_tree"));
            const plan = yield* Effect.try({
              try: () => planSkills(tree.entries),
              catch: (error) => asFailure(error, "invalid_response"),
            });
            const prior = previous ? yield* loadManifest(previous).pipe(Effect.option) : Option.none<Manifest>();
            const known = new Map<string, string>();
            if (Option.isSome(prior))
              for (const skill of prior.value.skills) for (const file of skill.files) known.set(file.blob, file.digest);
            const stored = new Set(
              (yield* io(storageList(keys.filePrefix))).map((key) => key.slice(keys.filePrefix.length)),
            );
            const documents = new Map<string, Uint8Array<ArrayBuffer>>();
            const wanted = new Set(plan.map((skill) => skill.document));
            const missing = new Map<string, { blob: string; size: number }>();
            for (const skill of plan)
              for (const file of skill.files) if (!stored.has(file.blob)) missing.set(file.blob, file);
            yield* Effect.forEach(
              [...missing.values()],
              (file) =>
                fetchBlob(file).pipe(
                  Effect.flatMap((bytes) =>
                    Effect.gen(function* () {
                      known.set(file.blob, `sha256:${yield* digestHex("SHA-256", bytes)}`);
                      if (wanted.has(file.blob)) documents.set(file.blob, bytes);
                      yield* io(storageSet(keys.file(file.blob), encodeBase64(bytes)));
                    }),
                  ),
                ),
              { concurrency: BLOB_CONCURRENCY, discard: true },
            );
            const unread = new Set<string>();
            for (const skill of plan) {
              if (!documents.has(skill.document)) unread.add(skill.document);
              for (const file of skill.files) if (!known.has(file.blob)) unread.add(file.blob);
            }
            const pending = [...unread];
            for (let start = 0; start < pending.length; start += STORED_BATCH) {
              const batch = pending.slice(start, start + STORED_BATCH);
              const values = yield* io(storageGetMany(batch.map(keys.file)));
              for (const [index, blob] of batch.entries()) {
                const value = values[index];
                const bytes =
                  value == null
                    ? undefined
                    : yield* Effect.try({ try: () => decodeBase64(value), catch: () => failure("storage") }).pipe(
                        Effect.option,
                        Effect.map(Option.getOrUndefined),
                      );
                if (!bytes || (yield* gitBlobSha(bytes)) !== blob) {
                  yield* io(storageDelete(keys.file(blob))).pipe(Effect.ignore);
                  return yield* Effect.fail(failure("storage"));
                }
                if (tokenBytes && containsBytes(bytes, tokenBytes))
                  return yield* Effect.fail(failure("credential_in_file"));
                known.set(blob, `sha256:${yield* digestHex("SHA-256", bytes)}`);
                if (wanted.has(blob)) documents.set(blob, bytes);
              }
            }
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
                  digest: known.get(file.blob)!,
                  size: file.size,
                })),
              });
            }
            const serialized = asciiJson({ v: 1, skills } satisfies Manifest);
            if (tokenBytes && containsBytes(encoder.encode(serialized), tokenBytes))
              return yield* Effect.fail(failure("credential_in_file"));
            const digest = yield* digestHex("SHA-256", encoder.encode(serialized));
            const chunks = Math.max(1, Math.ceil(serialized.length / MANIFEST_CHUNK_CHARS));
            if (chunks > MAX_MANIFEST_CHUNKS) return yield* Effect.fail(failure("bound_exceeded"));
            for (let index = 0; index < chunks; index++)
              yield* io(
                storageSet(
                  keys.manifest(digest, index),
                  serialized.slice(index * MANIFEST_CHUNK_CHARS, (index + 1) * MANIFEST_CHUNK_CHARS),
                ),
              );
            memo = { digest, manifest: { v: 1, skills } };
            const published = yield* publish(expected, {
              v: 1,
              commit,
              revision,
              digest,
              chunks,
              checkedAt: Date.now(),
            });
            if (published.digest === digest) {
              const keep = new Set(skills.flatMap((skill) => skill.files.map((file) => keys.file(file.blob))));
              for (let index = 0; index < chunks; index++) keep.add(keys.manifest(digest, index));
              if (previous && Option.isSome(prior)) {
                for (const skill of prior.value.skills) for (const file of skill.files) keep.add(keys.file(file.blob));
                for (let index = 0; index < previous.chunks; index++) keep.add(keys.manifest(previous.digest, index));
              }
              yield* collect(keep);
            }
            return published;
          });

        /** Removes stored files and manifest chunks no current or previous snapshot names. */
        const collect = (keep: ReadonlySet<string>) =>
          Effect.gen(function* () {
            const listed = [
              ...(yield* io(storageList(keys.filePrefix))),
              ...(yield* io(storageList(keys.manifestPrefix))),
            ];
            yield* Effect.forEach(
              listed.filter((key) => !keep.has(key)),
              (key) => io(storageDelete(key)),
              { discard: true },
            );
          }).pipe(Effect.ignore);

        const check = (raw: string | null, pointer: Pointer | undefined, budgetEnd: number) =>
          Effect.gen(function* () {
            const checkEnd = Math.min(Date.now() + CHECK_TIMEOUT_MS, budgetEnd);
            const commit = yield* until(checkEnd, commitSha);
            const renew = (next: Pointer) => publish(raw, { ...next, commit, checkedAt: Date.now() });
            if (pointer && commit === pointer.commit) return yield* renew(pointer);
            const revision = yield* until(checkEnd, directoryTree(commit));
            if (pointer && revision === pointer.revision) return yield* renew(pointer);
            return yield* until(budgetEnd, sync(commit, revision, raw, pointer));
          });

        const awaitPublished = (budgetEnd: number): Effect.Effect<SkillSourceSnapshot, SyncFailure> =>
          Effect.gen(function* () {
            while (Date.now() + AWAIT_INTERVAL_MS < budgetEnd) {
              yield* Effect.sleep(Duration.millis(AWAIT_INTERVAL_MS));
              const { pointer } = yield* readPointer;
              if (pointer) return yield* serve(pointer);
            }
            return yield* Effect.fail(failure("deadline"));
          });

        const { raw, pointer } = yield* readPointer;
        const now = Date.now();
        if (pointer && now - pointer.checkedAt < config.freshMs) return yield* serve(pointer);
        const held = yield* io(storageGet(keys.hold));
        const holdUntil = held !== null && /^\d+$/.test(held) ? Number(held) : 0;
        if (holdUntil > now) return pointer ? yield* serve(pointer) : yield* Effect.fail(failure("rate_limited"));
        const budgetEnd = ctx.deadlineAt - RESERVE_MS;
        const holder = crypto.randomUUID();
        const claimed = yield* io(
          storageCompareAndSet(keys.lease, null, holder, { expiresAtMs: ctx.deadlineAt + LEASE_MARGIN_MS }),
        );
        if (!claimed) return pointer ? yield* serve(pointer) : yield* awaitPublished(budgetEnd);
        const outcome = yield* Effect.result(check(raw, pointer, budgetEnd)).pipe(
          Effect.ensuring(io(storageCompareAndSet(keys.lease, holder, null)).pipe(Effect.ignore)),
        );
        if (Result.isSuccess(outcome)) return yield* serve(outcome.success);
        const failed = outcome.failure;
        ctx.warn(failed.code);
        const holdEnd = Math.max(
          failed.holdUntil ?? 0,
          pointer && failed.code !== "deadline" ? Date.now() + config.freshMs : 0,
        );
        if (holdEnd > Date.now())
          yield* io(storageSet(keys.hold, String(holdEnd), { expiresAtMs: holdEnd })).pipe(Effect.ignore);
        return pointer ? yield* serve(pointer) : yield* Effect.fail(failed);
      }),
  });
}
