/**
 * One verified Worker bundle per batch. Each trial used to bundle for itself, so a
 * source edit landing between trials, or between two arms' bundles, served different
 * code under the same clean label with no reload to notice.
 *
 * The identity hashes the exact bytes esbuild bundled, read once through a plugin so
 * no edit can slip between hashing and bundling, keyed by path from the checkout root.
 * Identical sources therefore share one identity across separate worktrees.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { build, type Plugin } from "esbuild";
import { ROOT } from "./meta.js";

export interface WorkerGraph {
  /** Identity of everything bundled: every input's path and bytes. */
  hash: string;
  /** What each trial serves, and the bytes each must still hold when it ends. */
  bundle: Uint8Array;
  bundleHash: string;
  inputs: number;
  /** The commit whose tree the bundled sources were checked against. */
  head: string | undefined;
  /** Every bundled tracked file equals `head`, and no untracked source was bundled. */
  matchesHead: boolean;
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function gitOutput(root: string, args: string[], input?: string): string | undefined {
  const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, input });
  return run.status === 0 ? run.stdout : undefined;
}

/** Whether these bytes are exactly the commit's, with nothing untracked mixed in. */
function matchesCommit(root: string, inputs: Map<string, Uint8Array>): boolean {
  const tree = gitOutput(root, ["ls-tree", "-r", "--full-tree", "HEAD"]);
  if (tree === undefined) return false;
  const blobs = new Map(
    tree
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t") as [string, string];
        return [path, meta.split(" ")[2]!] as const;
      }),
  );
  const unknown: string[] = [];
  for (const [path, bytes] of inputs) {
    const blob = blobs.get(path);
    if (blob === undefined) {
      unknown.push(path);
      continue;
    }
    const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (actual !== blob) return false;
  }
  if (!unknown.length) return true;
  // Installed packages aren't in the commit, and the lockfile pins them in the harness
  // hash. Generated files must match their generators; anything else is a stray source.
  const ignored = gitOutput(root, ["check-ignore", "--stdin"], `${unknown.join("\n")}\n`);
  const covered = new Set((ignored ?? "").split("\n").filter(Boolean));
  return unknown.every(
    (path) => covered.has(path) && (isInstalled(path) || generatedMatches(root, path, inputs.get(path)!)),
  );
}

const isInstalled = (path: string) => path.startsWith("node_modules/");
/** Ignored files the commit defines only through a generator. */
const GENERATORS: Record<string, string[]> = {
  "src/operator-ui/generated.ts": ["scripts/build-operator-ui.mjs", "--check"],
};

/** What was bundled is on disk, and the commit's own generator would write those bytes. */
function generatedMatches(root: string, path: string, bundled: Uint8Array): boolean {
  const generator = GENERATORS[path];
  if (!generator) return false;
  const onDisk = readFileSync(join(root, path));
  if (!onDisk.equals(bundled)) return false;
  return spawnSync(process.execPath, generator, { cwd: root, stdio: "ignore" }).status === 0;
}

export async function freezeWorkerGraph(
  main = join(ROOT, "eval", "deploy", "worker-agent.ts"),
  root = ROOT,
): Promise<WorkerGraph> {
  const inputs = new Map<string, Uint8Array>();
  const record: Plugin = {
    name: "record-graph-inputs",
    setup(context) {
      context.onLoad({ filter: /.*/, namespace: "file" }, async ({ path }) => {
        const contents = await readFile(path);
        inputs.set(relative(root, path).split(sep).join("/"), contents);
        return { contents, loader: "default" };
      });
    },
  };
  const tsconfig = join(ROOT, "tsconfig.json");
  const built = await build({
    entryPoints: [main],
    absWorkingDir: root,
    outfile: join(root, "worker-graph.mjs"),
    write: false,
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
    tsconfig,
    logLevel: "silent",
    plugins: [record],
  });
  const bundle = built.outputFiles[0]!.contents;
  const listing = [...inputs]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([path, bytes]) => `${path}\0${sha256(bytes)}\n`)
    .join("");
  return {
    hash: sha256(`${sha256(await readFile(tsconfig))}\n${listing}`).slice(0, 32),
    bundle,
    bundleHash: sha256(bundle),
    inputs: inputs.size,
    head: gitOutput(root, ["rev-parse", "--short=12", "HEAD"])?.trim(),
    matchesHead: matchesCommit(root, inputs),
  };
}

/**
 * Refuse a batch whose clean label would misdescribe what it serves. A dirty batch
 * says so, and a comparison refuses it; a clean one must serve exactly its commit.
 */
export function refuseMislabelledGraph(graph: WorkerGraph, git: { commit: string; dirty: boolean }): void {
  if (graph.head !== git.commit)
    throw new Error(
      `Batch refused: this batch records commit ${git.commit}, but its Worker graph was checked against ${graph.head}. HEAD moved while it started.`,
    );
  if (!git.dirty && !graph.matchesHead)
    throw new Error(
      `Batch refused: this batch is recorded clean at ${git.commit}, but its Worker graph differs from that commit. A source file changed while it started.`,
    );
}

const PAIRS = join(homedir(), ".cache", "connecta-eval-pairs");

/**
 * Arms of one comparison may run from separate worktrees, so they agree through the
 * machine: the first arm records its graph, and a later arm with another one refuses
 * before spending a trial. Link makes the first write atomic. A rerun needs a new pair id.
 */
export async function claimPairGraph(pairId: string, hash: string, directory = PAIRS): Promise<void> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${encodeURIComponent(pairId)}.graph`);
  const temporary = `${path}.${process.pid}.${Date.now()}`;
  await writeFile(temporary, hash);
  try {
    await link(temporary, path);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  const claimed = await readFile(path, "utf8");
  if (claimed !== hash)
    throw new Error(
      `Batch refused: pair ${pairId} is serving Worker graph ${claimed}, but this checkout's is ${hash}. Arms of a pair must serve the same sources.`,
    );
}
