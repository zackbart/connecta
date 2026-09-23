/**
 * `npm run eval:report -- --current <files|dir> [--baseline <files|dir>] [--notes <txt>] --out <report.html>`
 *
 * `--notes` is plain text, blank-line-separated paragraphs, rendered as the
 * report's observations — what a human concluded from the numbers.
 * Renders any mix of agent, perf, and smoke result files into one HTML
 * report. `--current` and `--baseline` take comma-separated JSON files or a
 * directory of them; with a baseline the report adds the comparison view.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { renderReport } from "./report/html.js";
import type { ResultFile } from "./report/summary.js";
import { flags } from "./support/meta.js";

async function load(spec: string | undefined): Promise<ResultFile[]> {
  if (!spec) return [];
  const files: ResultFile[] = [];
  for (const part of spec.split(",").map((entry) => resolve(entry.trim()))) {
    const paths = (await stat(part)).isDirectory()
      ? (await readdir(part)).filter((name) => name.endsWith(".json")).sort().map((name) => join(part, name))
      : [part];
    for (const path of paths) {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { kind?: unknown };
      if (typeof parsed.kind === "string" && parsed.kind.startsWith("connecta-eval/")) {
        files.push(parsed as ResultFile);
      }
    }
  }
  return files;
}

const args = flags(process.argv.slice(2));
const current = await load(args.get("current"));
if (!current.length) throw new Error("--current names no connecta-eval result files");
const out = resolve(args.get("out") ?? "eval-report.html");
await mkdir(dirname(out), { recursive: true });
const notesPath = args.get("notes");
await writeFile(
  out,
  renderReport({
    current,
    baseline: await load(args.get("baseline")),
    ...(notesPath ? { notes: await readFile(resolve(notesPath), "utf8") } : {}),
  }),
);
console.error(`[report] ${out}`);
