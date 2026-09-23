/** Provenance stamped on every result file, so two files can be compared honestly. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface RunMeta {
  createdAt: string;
  /**
   * `srcTree` is the git tree of `src/` — the code actually measured. It
   * stays equal across harness-only commits, which is what makes a baseline
   * taken on a harness branch a baseline of main.
   */
  git: { commit: string; branch: string; dirty: boolean; srcTree: string; srcDirty: boolean };
  packageVersion: string;
  node: string;
  platform: string;
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function runMeta(): RunMeta {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  return {
    createdAt: new Date().toISOString(),
    git: {
      commit: git(["rev-parse", "--short=12", "HEAD"]),
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
      dirty: git(["status", "--porcelain", "--untracked-files=no"]) !== "",
      srcTree: git(["rev-parse", "--short=12", "HEAD:src"]),
      srcDirty: git(["status", "--porcelain", "--", "src", "examples", "templates"]) !== "",
    },
    packageVersion: manifest.version,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
}

export function stamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** `--name value` and `--flag` parsing for the eval CLIs. */
export function flags(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out.set(arg.slice(2), next);
      index += 1;
    } else {
      out.set(arg.slice(2), "true");
    }
  }
  return out;
}
