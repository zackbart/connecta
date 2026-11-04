/**
 * Result-shaping study analysis. Reads saved agent result files, no network.
 *
 *   node --import tsx eval/result-shaping-report.ts breakdown <file...>
 *   node --import tsx eval/result-shaping-report.ts compare <dir>   (rs1-<surface>-<runner>-<arm>.json)
 *   node --import tsx eval/result-shaping-report.ts mechanisms <dir>
 *   node --import tsx eval/result-shaping-report.ts noise <file...>   (byte classes per connector)
 *
 * breakdown fits, per file, total prompt tokens ≈ base × turns + rate × (result
 * chars × later turns) + rate₂ × (model-written chars × later turns), because a
 * result stays in context for every later request. The fit gives each source's
 * share without assuming a characters-per-token ratio.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyResult, mergeReports } from "./result-shaping/noise.js";

interface Use {
  id: string;
  tool: string;
  input?: Record<string, unknown>;
  isError?: boolean;
  resultText?: string;
  native?: { address: string; readOnly: boolean };
}
interface Entry {
  kind: string;
  id?: string;
  text?: string;
  inputChars?: number;
}
interface Trial {
  task: string;
  status: string;
  model: string;
  repeat: number;
  checks?: { id: string; pass: boolean; advisory?: boolean; detail?: string }[];
  metrics?: {
    tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
    toolErrors: number;
    firstTurnInputTokens?: number;
    modelTurns?: number;
    costUsd?: number;
    downstream?: { reads: number; writes: number; duplicateReads: number; duplicateWrites: number };
  };
  saved?: { trace: { toolUses: Use[]; transcript: Entry[] } };
}
const load = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as { trials: Trial[]; config: { resultArm?: string } };
const promptTokens = (t: Trial) =>
  t.metrics!.tokens.input + t.metrics!.tokens.cacheRead + t.metrics!.tokens.cacheCreation;

/** discovery | guide | data, by what the call or program did. */
export function resultKind(use: Use): "discovery" | "data" {
  if (["ToolSearch", "search_tools", "skills", "authorize_connector"].includes(use.tool)) return "discovery";
  if (use.tool === "execute_code") {
    const code = String(use.input?.code ?? "");
    if (/connecta\.(call|result)\(/.test(code)) return "data";
    return /connecta\.(search|describe|skill|skills)\(/.test(code) ? "discovery" : "data";
  }
  return "data";
}

function modelSteps(t: Trial) {
  const uses = new Map(t.saved!.trace.toolUses.map((use) => [use.id, use]));
  const steps: { written: number; results: { kind: string; chars: number }[] }[] = [];
  let current: (typeof steps)[number] | undefined;
  let afterResult = true;
  for (const entry of t.saved!.trace.transcript) {
    if (entry.kind === "assistant" || entry.kind === "tool_use") {
      if (afterResult || !current) {
        current = { written: 0, results: [] };
        steps.push(current);
        afterResult = false;
      }
      current.written += entry.kind === "assistant" ? (entry.text?.length ?? 0) : (entry.inputChars ?? 0);
    } else if (entry.kind === "tool_result" && current) {
      const use = uses.get(entry.id!);
      current.results.push({
        kind: use ? resultKind(use) : "data",
        chars: use?.resultText?.length ?? entry.text?.length ?? 0,
      });
      afterResult = true;
    }
  }
  return steps;
}

function leastSquares(X: number[][], y: number[]): number[] {
  const p = X[0]!.length;
  const A = Array.from({ length: p }, () => Array<number>(p + 1).fill(0));
  X.forEach((row, i) => {
    for (let j = 0; j < p; j++) {
      for (let k = 0; k < p; k++) A[j]![k]! += row[j]! * row[k]!;
      A[j]![p]! += row[j]! * y[i]!;
    }
  });
  for (let i = 0; i < p; i++) {
    let pivot = i;
    for (let r = i + 1; r < p; r++) if (Math.abs(A[r]![i]!) > Math.abs(A[pivot]![i]!)) pivot = r;
    [A[i], A[pivot]] = [A[pivot]!, A[i]!];
    for (let r = 0; r < p; r++) {
      if (r === i) continue;
      const factor = A[r]![i]! / A[i]![i]!;
      for (let c = i; c <= p; c++) A[r]![c]! -= factor * A[i]![c]!;
    }
  }
  return A.map((row, i) => row[p]! / row[i]!);
}

function breakdown(files: string[]) {
  const rows = files.map((file) => {
    const trials = load(file).trials.filter((t) => t.metrics && t.saved);
    const features = trials.map((t) => {
      const steps = modelSteps(t);
      const out = { turns: steps.length, data: 0, discovery: 0, written: 0, dataChars: 0, discoveryChars: 0 };
      steps.forEach((step, index) => {
        const later = steps.length - 1 - index;
        out.written += step.written * later;
        for (const result of step.results) {
          if (result.kind === "data") {
            out.data += result.chars * later;
            out.dataChars += result.chars;
          } else {
            out.discovery += result.chars * later;
            out.discoveryChars += result.chars;
          }
        }
      });
      return out;
    });
    const y = trials.map(promptTokens);
    const [base, rate, writtenRate] = leastSquares(
      features.map((f) => [f.turns, f.data + f.discovery, f.written]),
      y,
    ) as [number, number, number];
    const total = y.reduce((a, b) => a + b, 0);
    const sum = (key: keyof (typeof features)[number]) => features.reduce((a, f) => a + f[key], 0);
    const predicted = features.map((f) => f.turns * base + (f.data + f.discovery) * rate + f.written * writtenRate);
    const mean = total / y.length;
    const r2 = 1 - y.reduce((a, v, i) => a + (v - predicted[i]!) ** 2, 0) / y.reduce((a, v) => a + (v - mean) ** 2, 0);
    const share = (value: number) => `${((100 * value) / total).toFixed(0)}%`;
    return {
      file: file.split("/").pop()!.replace(".json", ""),
      trials: trials.length,
      meanTokens: Math.round(mean),
      turns: +(sum("turns") / trials.length).toFixed(1),
      definitionsAndSystem: share(base * sum("turns")),
      dataResults: share(rate * sum("data")),
      discoveryResults: share(rate * sum("discovery")),
      modelWritten: share(writtenRate * sum("written")),
      charsPerToken: +(1 / rate).toFixed(2),
      dataKB: +(sum("dataChars") / 1000 / trials.length).toFixed(1),
      discoveryKB: +(sum("discoveryChars") / 1000 / trials.length).toFixed(1),
      r2: +r2.toFixed(2),
    };
  });
  console.table(rows);
}

function resultBytes(t: Trial, kind?: string) {
  return t
    .saved!.trace.toolUses.filter((use) => !kind || resultKind(use) === kind)
    .reduce((sum, use) => sum + new TextEncoder().encode(use.resultText ?? "").length, 0);
}

const fired = (t: Trial) =>
  t.saved!.trace.toolUses.filter(
    (use) => use.resultText?.startsWith('{"truncated":true') && /"(rows|text)":\{/.test(use.resultText.slice(0, 2_000)),
  ).length;
const leanFired = (t: Trial) =>
  t.saved!.trace.toolUses.filter((use) => /connecta: (null and empty|whitespace)/.test(use.resultText ?? "")).length;

function loadStudy(dir: string) {
  const out: { surface: string; runner: string; arm: string; trial: Trial }[] = [];
  for (const name of readdirSync(dir)) {
    const match = /^rs1-(six|native)-(claude|codex)-(control|lean|preview)(?:-[a-z0-9]+)?\.json$/.exec(name);
    if (!match) continue;
    for (const trial of load(join(dir, name)).trials)
      if (trial.metrics && trial.saved) out.push({ surface: match[1]!, runner: match[2]!, arm: match[3]!, trial });
  }
  return out;
}

/** Percentile bootstrap of the mean, with a fixed-seed generator so reruns match. */
function bootstrap(values: number[], draws = 4_000): [number, number] {
  if (!values.length) return [0, 0];
  let state = 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
  const means = Array.from({ length: draws }, () => {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(next() * values.length)]!;
    return sum / values.length;
  }).sort((a, b) => a - b);
  return [means[Math.floor(draws * 0.025)]!, means[Math.floor(draws * 0.975)]!];
}

function compare(dir: string, treatment: "preview" | "lean", onlyTasks?: Set<string>) {
  const study = loadStudy(dir);
  const groups = new Map<string, Map<string, Trial[]>>();
  for (const { surface, runner, arm, trial } of study) {
    if (arm !== "control" && arm !== treatment) continue;
    const key = `${surface}/${runner}/${trial.task}`;
    const cell = groups.get(key) ?? new Map<string, Trial[]>();
    (cell.get(arm) ?? cell.set(arm, []).get(arm)!).push(trial);
    groups.set(key, cell);
  }
  const summarize = (select: (key: string) => boolean, label: string) => {
    const pairs: { c: Trial[]; t: Trial[] }[] = [];
    for (const [key, cell] of groups)
      if (select(key) && cell.get(treatment)?.length)
        pairs.push({ c: cell.get("control") ?? [], t: cell.get(treatment)! });
    if (!pairs.length) return undefined;
    const flat = (side: "c" | "t") => pairs.flatMap((pair) => pair[side]);
    const mean = (trials: Trial[], value: (t: Trial) => number) =>
      trials.length ? trials.reduce((a, t) => a + value(t), 0) / trials.length : 0;
    const deltas = pairs
      .filter((pair) => pair.c.length && pair.t.length)
      .map((pair) => mean(pair.t, promptTokens) - mean(pair.c, promptTokens));
    const [low, high] = bootstrap(deltas);
    const c = flat("c"),
      t = flat("t");
    const pass = (trials: Trial[]) => trials.filter((x) => x.status === "pass").length;
    return {
      group: label,
      trialsC: c.length,
      trialsT: t.length,
      passC: pass(c),
      passT: pass(t),
      tokensC: Math.round(mean(c, promptTokens)),
      tokensT: Math.round(mean(t, promptTokens)),
      pct: `${((100 * (mean(t, promptTokens) - mean(c, promptTokens))) / mean(c, promptTokens)).toFixed(1)}%`,
      deltaCI95: `${Math.round(low)}..${Math.round(high)}`,
      resultKBC: +(mean(c, (x) => resultBytes(x)) / 1000).toFixed(1),
      resultKBT: +(mean(t, (x) => resultBytes(x)) / 1000).toFixed(1),
      toolErrC: +mean(c, (x) => x.metrics!.toolErrors).toFixed(2),
      toolErrT: +mean(t, (x) => x.metrics!.toolErrors).toFixed(2),
      dupC: c.reduce((a, x) => a + (x.metrics!.downstream?.duplicateWrites ?? 0), 0),
      dupT: t.reduce((a, x) => a + (x.metrics!.downstream?.duplicateWrites ?? 0), 0),
      fired: t.reduce((a, x) => a + (treatment === "preview" ? fired(x) : leanFired(x)), 0),
    };
  };
  const task = (key: string) => key.split("/")[2]!;
  const tasks = [...new Set([...groups.keys()].map(task))].filter((id) => !onlyTasks || onlyTasks.has(id));
  const rows = [
    summarize((key) => tasks.includes(task(key)), "ALL"),
    ...["six", "native"].flatMap((surface) =>
      ["claude", "codex"].map((runner) =>
        summarize(
          (key) => key.startsWith(`${surface}/${runner}/`) && tasks.includes(task(key)),
          `${surface}/${runner}`,
        ),
      ),
    ),
    ...tasks.map((id) => summarize((key) => task(key) === id, id)),
  ].filter(Boolean);
  console.log(`\n${treatment} vs control`);
  console.table(rows);
  return study;
}

function failures(dir: string) {
  for (const { surface, runner, arm, trial } of loadStudy(dir)) {
    if (trial.status === "pass") continue;
    const failed = (trial.checks ?? []).filter((check) => !check.pass && !check.advisory);
    console.log(
      `${arm} ${surface}/${runner} ${trial.task} #${trial.repeat} ${trial.status}: ${failed
        .map((check) => `${check.id}${check.detail ? ` (${check.detail.slice(0, 160).replace(/\n/g, " ")})` : ""}`)
        .join("; ")}`,
    );
  }
}

/** What agents did right after a preview, and whether they reused the handle or re-read the vendor. */
function mechanisms(dir: string) {
  const next: Record<string, number> = {};
  for (const { arm, surface, runner, trial } of loadStudy(dir)) {
    if (arm === "lean") continue;
    const uses = trial.saved!.trace.toolUses;
    uses.forEach((use, index) => {
      if (!use.resultText?.startsWith('{"truncated":true')) return;
      const after = uses[index + 1];
      const code = String(after?.input?.code ?? "");
      const kind = !after
        ? "end"
        : after.tool === "execute_code"
          ? /connecta\.result\(/.test(code)
            ? /JSON\.parse|\.split\(|\.filter\(/.test(code)
              ? "program: handle + reduce"
              : "program: page raw"
            : /connecta\.call\(/.test(code)
              ? "program: re-read + reduce"
              : "program: other"
          : after.tool;
      const key = `${arm} ${surface} ${runner} -> ${kind}`;
      next[key] = (next[key] ?? 0) + 1;
    });
  }
  console.table(
    Object.entries(next)
      .sort()
      .map(([route, count]) => ({ route, count })),
  );
}

/** Native's overhead over six under each arm, on the tasks every cell ran. */
function nativeOverhead(dir: string) {
  const study = loadStudy(dir).filter((row) => row.arm === "control" || row.arm === "preview");
  const tasks = [...new Set(study.filter((row) => row.arm === "preview").map((row) => row.trial.task))];
  const firedTasks = new Set(study.filter((row) => row.arm === "preview" && fired(row.trial)).map((r) => r.trial.task));
  const groups = [
    ["all", tasks],
    ["never fired", tasks.filter((task) => !firedTasks.has(task))],
  ] as const;
  const rows = groups.flatMap(([group, subset]) =>
    ["claude", "codex"].flatMap((runner) =>
      ["control", "preview"].map((arm) => {
        const cell = (surface: string) =>
          study.filter(
            (row) =>
              row.runner === runner && row.arm === arm && row.surface === surface && subset.includes(row.trial.task),
          );
        const mean = (surface: string, value: (t: Trial) => number) =>
          cell(surface).reduce((a, row) => a + value(row.trial), 0) / cell(surface).length;
        const six = mean("six", promptTokens);
        const native = mean("native", promptTokens);
        return {
          group,
          runner,
          arm,
          n: cell("six").length,
          six: Math.round(six),
          native: Math.round(native),
          overhead: `${((100 * (native - six)) / six).toFixed(0)}%`,
          sixResultKB: +(mean("six", (t) => resultBytes(t)) / 1000).toFixed(1),
          nativeResultKB: +(mean("native", (t) => resultBytes(t)) / 1000).toFixed(1),
          sixData: +(mean("six", (t) => resultBytes(t, "data")) / 1000).toFixed(1),
          nativeData: +(mean("native", (t) => resultBytes(t, "data")) / 1000).toFixed(1),
          sixPass: cell("six").filter((row) => row.trial.status === "pass").length,
          nativePass: cell("native").filter((row) => row.trial.status === "pass").length,
        };
      }),
    ),
  );
  console.table(rows);
}

/** Tasks where preview fired against tasks where it never did, which are a placebo for noise. */
function firing(dir: string) {
  const previewTasks = new Set(
    loadStudy(dir)
      .filter((row) => row.arm === "preview")
      .map((row) => row.trial.task),
  );
  const study = loadStudy(dir).filter(
    (row) => (row.arm === "control" || row.arm === "preview") && previewTasks.has(row.trial.task),
  );
  const firedTasks = new Set(study.filter((row) => row.arm === "preview" && fired(row.trial)).map((r) => r.trial.task));
  const groups = { fired: (id: string) => firedTasks.has(id), placebo: (id: string) => !firedTasks.has(id) };
  const out = Object.entries(groups).map(([label, select]) => {
    const cells = new Map<string, { control: Trial[]; preview: Trial[] }>();
    for (const row of study) {
      if (!select(row.trial.task)) continue;
      const key = `${row.surface}/${row.runner}/${row.trial.task}`;
      const cell = cells.get(key) ?? { control: [], preview: [] };
      cell[row.arm as "control" | "preview"].push(row.trial);
      cells.set(key, cell);
    }
    const mean = (trials: Trial[]) => trials.reduce((a, t) => a + promptTokens(t), 0) / trials.length;
    const deltas = [...cells.values()].map((cell) => mean(cell.preview) - mean(cell.control));
    const control = [...cells.values()].flatMap((cell) => cell.control);
    const preview = [...cells.values()].flatMap((cell) => cell.preview);
    const [low, high] = bootstrap(deltas);
    const cost = (trials: Trial[]) => {
      const priced = trials.filter((t) => t.metrics!.costUsd !== undefined);
      return priced.length ? priced.reduce((a, t) => a + t.metrics!.costUsd!, 0) / priced.length : 0;
    };
    return {
      label,
      tasks: new Set(control.map((t) => t.task)).size,
      trialsC: control.length,
      trialsT: preview.length,
      passC: control.filter((t) => t.status === "pass").length,
      passT: preview.filter((t) => t.status === "pass").length,
      tokensC: Math.round(mean(control)),
      tokensT: Math.round(mean(preview)),
      pct: `${((100 * (mean(preview) - mean(control))) / mean(control)).toFixed(1)}%`,
      pairedCI95: `${Math.round(low)}..${Math.round(high)}`,
      claudeCostC: +cost(control).toFixed(4),
      claudeCostT: +cost(preview).toFixed(4),
      dataKBC: +(control.reduce((a, t) => a + resultBytes(t, "data"), 0) / control.length / 1000).toFixed(1),
      dataKBT: +(preview.reduce((a, t) => a + resultBytes(t, "data"), 0) / preview.length / 1000).toFixed(1),
      vendorReadsC: +(control.reduce((a, t) => a + (t.metrics!.downstream?.reads ?? 0), 0) / control.length).toFixed(2),
      vendorReadsT: +(preview.reduce((a, t) => a + (t.metrics!.downstream?.reads ?? 0), 0) / preview.length).toFixed(2),
    };
  });
  console.table(out);
  console.log("fired tasks:", [...firedTasks].join(", "));
}

/** Byte classes of every whole direct read in saved trials, per connector. */
function noise(files: string[]) {
  const reports = new Map<string, ReturnType<typeof classifyResult>[]>();
  for (const file of files)
    for (const trial of load(file).trials)
      for (const use of trial.saved?.trace.toolUses ?? []) {
        const direct = use.native ? use.native.readOnly : use.tool === "call_tool";
        const text = use.resultText ?? "";
        if (!direct || use.isError || !text || text.startsWith('{"truncated":true')) continue;
        const connector = String(use.input?.address ?? use.tool).split(/\.|__/)[0]!;
        (reports.get(connector) ?? reports.set(connector, []).get(connector)!).push(classifyResult(text));
      }
  console.table(
    [...reports].map(([connector, list]) => {
      const merged = mergeReports(list);
      const share = (bytes: number) => +((100 * bytes) / (merged.compactBytes || 1)).toFixed(1);
      return {
        connector,
        results: merged.results,
        KB: +(merged.rawBytes / 1000).toFixed(1),
        whitespace: merged.whitespaceBytes,
        nulls: share(merged.classes.nullsEmpties),
        urls: share(merged.classes.urlValues),
        links: share(merged.classes.linkBlocks),
        audit: share(merged.classes.auditFields),
        tags: share(merged.classes.vendorTags),
        html: share(merged.classes.htmlDuplicates),
        repeatedKeys: share(merged.repeatedKeyBytes),
        duplicates: share(merged.duplicateBytes),
        deep: share(merged.deepBytes),
      };
    }),
  );
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "breakdown") breakdown(rest);
else if (mode === "compare") {
  compare(rest[0]!, "preview");
  compare(rest[0]!, "lean", new Set(["pco-step2-plan-join", "cloudflare-step2-dns-recovery"]));
  firing(rest[0]!);
  nativeOverhead(rest[0]!);
  failures(rest[0]!);
} else if (mode === "mechanisms") mechanisms(rest[0]!);
else if (mode === "noise") noise(rest);
else throw new Error("Usage: result-shaping-report.ts breakdown|compare|mechanisms|noise ...");
