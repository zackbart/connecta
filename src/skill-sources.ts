import { Effect } from "effect";
import { bytesToHex } from "./bytes.js";
import { ConfigError } from "./config-schema.js";
import {
  assertSourceIdentity,
  defineSkillSource,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILLS,
  skillFrontmatter,
  validSkillFilePath,
  validSkillName,
  type SkillSourceFile,
  type SkillSourceSkill,
  type SkillSourceSnapshot,
} from "./skill-source-seam.js";

declare const SKILL_SOURCE: unique symbol;

/**
 * A deployment's own Agent Skills, passed in `createConnecta({ skills })`.
 * Build one with `inlineSkills`; a custom source is not a published contract.
 */
export interface SkillSource {
  /** Unique among sources; names the source in skill names, URIs and pool `skills`. */
  readonly id: string;
  /** One line shown with the id in the `skills` tool's description. */
  readonly description: string | undefined;
  readonly [SKILL_SOURCE]: true;
}

/** One skill's files by path relative to its directory, `SKILL.md` included. */
export type InlineSkillFiles = Readonly<Record<string, string | Uint8Array>>;

const encoder = new TextEncoder();

/**
 * Agent Skills given in deployment code: each key is a skill's directory name,
 * each value its files by relative path, `SKILL.md` included. Text is stored
 * as UTF-8; a `Uint8Array` is copied and served byte-exact. Every skill is
 * checked here, so a mistake fails construction rather than a later read.
 */
export function inlineSkills(
  id: string,
  skills: Readonly<Record<string, InlineSkillFiles>>,
  options: { description?: string } = {},
): SkillSource {
  const label = `inlineSkills(${JSON.stringify(String(id))})`;
  assertSourceIdentity(label, id, options.description);
  if (skills === null || typeof skills !== "object" || Array.isArray(skills))
    throw new ConfigError(`${label} skills must be an object of skill directories.`);
  const names = Object.keys(skills).sort();
  if (names.length > MAX_SKILLS) throw new ConfigError(`${label} has more than ${MAX_SKILLS} skills.`);
  const prepared = names.map((name) => {
    const path = `${label}.${name}`;
    if (!validSkillName(name))
      throw new ConfigError(`${path}: a skill directory name must satisfy the Agent Skills name rule.`);
    const files = skills[name];
    if (files === null || typeof files !== "object" || Array.isArray(files))
      throw new ConfigError(`${path} must be an object of files by relative path.`);
    const entries = Object.entries(files);
    if (entries.length > MAX_SKILL_FILES) throw new ConfigError(`${path} has more than ${MAX_SKILL_FILES} files.`);
    let total = 0;
    const bytesByPath = entries
      .map(([file, content]): [string, Uint8Array<ArrayBuffer>] => {
        if (!validSkillFilePath(file))
          throw new ConfigError(
            `${path} file ${JSON.stringify(file)} must be a relative path without ".", "..", empty segments or backslashes.`,
          );
        if (typeof content !== "string" && !(content instanceof Uint8Array))
          throw new ConfigError(`${path} file ${JSON.stringify(file)} must be a string or a Uint8Array.`);
        const bytes = new Uint8Array(typeof content === "string" ? encoder.encode(content) : content);
        total += bytes.length;
        return [file, bytes];
      })
      .sort(([a], [b]) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a < b ? -1 : a > b ? 1 : 0));
    if (total > MAX_SKILL_BYTES) throw new ConfigError(`${path} exceeds ${MAX_SKILL_BYTES} bytes.`);
    const document = bytesByPath[0]?.[0] === "SKILL.md" ? bytesByPath[0][1] : undefined;
    if (!document) throw new ConfigError(`${path} has no SKILL.md.`);
    const parsed = skillFrontmatter(name, document);
    if ("invalid" in parsed) throw new ConfigError(`${path}: ${parsed.invalid}.`);
    return { name, frontmatter: parsed.frontmatter, files: bytesByPath };
  });
  let snapshot: SkillSourceSnapshot | undefined;
  return defineSkillSource(label, id, options.description, {
    snapshot: () =>
      snapshot
        ? Effect.succeed(snapshot)
        : Effect.forEach(prepared, (skill) =>
            Effect.forEach(skill.files, ([path, bytes]) =>
              Effect.tryPromise({
                try: () => crypto.subtle.digest("SHA-256", bytes),
                catch: (error) => error,
              }).pipe(
                Effect.map((digest): SkillSourceFile => ({
                  path,
                  digest: `sha256:${bytesToHex(new Uint8Array(digest))}`,
                  size: bytes.length,
                  read: () => Effect.sync(() => bytes.slice()),
                })),
              ),
            ).pipe(
              Effect.map((files): SkillSourceSkill => ({ name: skill.name, frontmatter: skill.frontmatter, files })),
            ),
          ).pipe(
            Effect.map((skills) => {
              snapshot = Object.freeze({ skills });
              return snapshot;
            }),
          ),
  });
}
