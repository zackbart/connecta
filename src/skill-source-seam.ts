import type { Effect } from "effect";
import { ConfigError } from "./config-schema.js";
import { parseFrontmatter, splitFrontmatter } from "./skill-frontmatter.js";
import type { SkillSource } from "./skill-sources.js";
import type { CredentialVault } from "./credential-contract.js";
import { vaultSecretDigest } from "./storage-digest.js";
import type { KVStorage, Logger } from "./types.js";

export const MAX_SKILLS = 1_024;
export const MAX_SKILL_FILES = 512;
export const MAX_SKILL_BYTES = 16 * 1024 * 1024;
const MAX_SKILL_DESCRIPTION = 1_024;
const MAX_SOURCE_DESCRIPTION = 120;
const MAX_FILE_PATH = 1_024;
const RESERVED_SOURCE_IDS = new Set(["connector", "connecta", "downstream"]);

/** One file of a source skill, as a snapshot reports it. */
export interface SkillSourceFile {
  /** Relative to the skill directory, `/`-separated, valid under {@link validSkillFilePath}. */
  readonly path: string;
  /** `sha256:<64 hex>` of the bytes `read` returns. */
  readonly digest: string;
  readonly size: number;
  /** The file's bytes, read under the context of the request that reads the file. */
  read(ctx: SkillSourceContext): Effect.Effect<Uint8Array, unknown>;
}

export interface SkillSourceSkill {
  /** The directory name, equal to `frontmatter.name`. */
  readonly name: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** Every file of the skill, `SKILL.md` included. */
  readonly files: readonly SkillSourceFile[];
}

/** The complete set of skills a source serves at one revision. */
export interface SkillSourceSnapshot {
  readonly skills: readonly SkillSourceSkill[];
}

/** What a source receives for one snapshot or file read, bound to the request performing it. */
export interface SkillSourceContext {
  /** The deployment's storage, unpartitioned. */
  readonly storage: KVStorage;
  /** Emits one operator warning carrying the source id and this code; a code the source did not declare logs `unknown`. */
  readonly warn: (code: string) => void;
  /** Aborts when the request ends or the skills deadline passes. */
  readonly signal: AbortSignal;
  /** Epoch milliseconds by which the read must finish. */
  readonly deadlineAt: number;
  /** Registers a credential this request sends, so no reader output, log or record carries it. */
  readonly secret: (value: string) => void;
  /** `hmac:<hex>` of a secret under the deployment's storage digest key, for a stored key or value only. */
  readonly digestSecret: (value: string) => Promise<string>;
}

/** The internal seam every source implements; failure means the source has nothing to serve. */
export interface SkillSourceDefinition {
  snapshot(ctx: SkillSourceContext): Effect.Effect<SkillSourceSnapshot, unknown>;
  /** The closed set of warning codes `warn` may log, each matching `^[a-z][a-z0-9_]{0,63}$`. */
  readonly warnings?: readonly string[];
  /** How long a reader may cache this source's content, in milliseconds; absent imposes no limit. */
  readonly cacheTtlMs?: number;
  /** When set, the deployment must have a credential vault; without one, construction throws this message. */
  readonly credentialVaultRequired?: string;
}

const definitions = new WeakMap<object, SkillSourceDefinition>();

export function skillSourceDefinition(value: unknown): SkillSourceDefinition | undefined {
  return value !== null && typeof value === "object" ? definitions.get(value) : undefined;
}

export function validSkillName(name: string): boolean {
  return name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

/** No `..` or `.` segment, leading `/`, backslash, empty segment, control character or unpaired surrogate. */
export function validSkillFilePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_FILE_PATH || path.includes("\\")) return false;
  try {
    encodeURIComponent(path);
  } catch {
    return false;
  }
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/**
 * The frontmatter of a complete `SKILL.md` whose `name` equals its directory,
 * or a reason it is invalid. Other fields pass through unchanged.
 */
export function skillFrontmatter(
  directory: string,
  bytes: Uint8Array,
): { frontmatter: Record<string, unknown> } | { invalid: string } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { invalid: "SKILL.md is not UTF-8 text" };
  }
  const split = splitFrontmatter(text);
  const frontmatter = split && parseFrontmatter(split.yaml);
  if (!frontmatter) return { invalid: "SKILL.md has no supported YAML frontmatter block" };
  return checkSkillFrontmatter(directory, frontmatter);
}

/** A parsed frontmatter mapping's `name` and `description` against the skill's directory. */
export function checkSkillFrontmatter(
  directory: string,
  frontmatter: Record<string, unknown>,
): { frontmatter: Record<string, unknown> } | { invalid: string } {
  if (frontmatter.name !== directory) return { invalid: "frontmatter name differs from the directory name" };
  const description = frontmatter.description;
  if (typeof description !== "string" || description.trim() === "" || description.length > MAX_SKILL_DESCRIPTION)
    return { invalid: `frontmatter description must be 1 to ${MAX_SKILL_DESCRIPTION} characters` };
  return { frontmatter };
}

export function assertSourceIdentity(label: string, id: unknown, description: unknown): string | undefined {
  if (typeof id !== "string" || id.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    throw new ConfigError(
      `${label} id must be lowercase letters and digits in hyphen-separated words, at most 64 characters.`,
    );
  if (RESERVED_SOURCE_IDS.has(id)) throw new ConfigError(`${label} id "${id}" is reserved.`);
  if (description === undefined) return undefined;
  const trimmed = typeof description === "string" ? description.trim() : undefined;
  if (
    trimmed === undefined ||
    trimmed.length === 0 ||
    trimmed.length > MAX_SOURCE_DESCRIPTION ||
    hasControlCharacter(trimmed)
  )
    throw new ConfigError(
      `${label} description must be one line of 1 to ${MAX_SOURCE_DESCRIPTION} characters after trimming, with no control characters.`,
    );
  return trimmed;
}

/** Brands a definition as a source after checking its id and description. */
export function defineSkillSource(
  label: string,
  id: string,
  description: string | undefined,
  definition: SkillSourceDefinition,
): SkillSource {
  const trimmed = assertSourceIdentity(label, id, description);
  if (definition.warnings?.some((code) => !/^[a-z][a-z0-9_]{0,63}$/.test(code)))
    throw new ConfigError(`${label} declares a warning code that is not lowercase snake case.`);
  if (
    definition.cacheTtlMs !== undefined &&
    (!Number.isSafeInteger(definition.cacheTtlMs) || definition.cacheTtlMs < 0)
  )
    throw new ConfigError(`${label} cache lifetime must be a whole number of milliseconds.`);
  const source = Object.freeze({ id, description: trimmed }) as SkillSource;
  definitions.set(source, definition);
  return source;
}

/** The per-request part of {@link SkillSourceContext}; the registry binds storage and warnings. */
type SkillSourceRequest = Pick<SkillSourceContext, "signal" | "deadlineAt" | "secret">;

/** A configured source as a registry view lists it. */
export interface BoundSkillSource extends Pick<SkillSource, "id" | "description"> {
  /** The longest a reader may cache this source's content, in milliseconds; undefined imposes no limit. */
  readonly cacheTtlMs: number | undefined;
}

const bindings = new WeakMap<
  BoundSkillSource,
  { definition: SkillSourceDefinition; context: (request: SkillSourceRequest) => SkillSourceContext }
>();

/** The bound source's snapshot for one skills read. */
export function readSkillSource(
  source: BoundSkillSource,
  request: SkillSourceRequest,
): Effect.Effect<SkillSourceSnapshot, unknown> {
  const binding = bindings.get(source)!;
  return binding.definition.snapshot(binding.context(request));
}

/** One file of the bound source, read under the request that reads it. */
export function readSkillFile(
  source: BoundSkillSource,
  file: SkillSourceFile,
  request: SkillSourceRequest,
): Effect.Effect<Uint8Array, unknown> {
  return file.read(bindings.get(source)!.context(request));
}

export function bindSkillSources(
  sources: readonly SkillSource[],
  storage: KVStorage,
  logger: Logger,
  vault?: CredentialVault,
): readonly BoundSkillSource[] {
  const digestSecret = (value: string) => vaultSecretDigest(vault, value);
  for (const source of sources) {
    const required = skillSourceDefinition(source)?.credentialVaultRequired;
    if (required !== undefined && !vault?.storageDigestKey) throw new ConfigError(required);
  }
  return sources.map((source) => {
    const definition = skillSourceDefinition(source)!;
    const declared = new Set(definition.warnings ?? []);
    const warn = (code: string) => {
      try {
        logger.warn("[connecta] skill source warning", {
          source: source.id,
          code: declared.has(code) ? code : "unknown",
        });
      } catch {
        return;
      }
    };
    const bound: BoundSkillSource = Object.freeze({
      id: source.id,
      description: source.description,
      cacheTtlMs: definition.cacheTtlMs,
    });
    bindings.set(bound, { definition, context: (request) => ({ ...request, storage, warn, digestSecret }) });
    return bound;
  });
}
