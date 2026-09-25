/**
 * One self-contained HTML evidence report: no scripts, no external assets,
 * readable from a file:// URL or an attachment. Given baseline files it adds a
 * comparison view; given none it is just the evidence.
 */
import type { TrialResult } from "../agent/run.js";
import type { TranscriptEntry } from "../agent/trace.js";
import {
  summarize,
  type AgentResultFile,
  type PerfResultFile,
  type ResultFile,
  type SmokeResultFile,
} from "./summary.js";

const esc = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const DISPLAY_RESULT_CHARS = 2_500;

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return "–";
  return ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
function fmtUsd(value: number | undefined): string {
  return value === undefined ? "–" : `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
}
function fmtNum(value: number | undefined, digits = 1): string {
  if (value === undefined) return "–";
  if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(0)}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}
function fmtPct(value: number | undefined): string {
  return value === undefined ? "–" : `${Math.round(value * 100)}%`;
}
function fmtBytes(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}
function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function rateClass(rate: number | undefined): string {
  if (rate === undefined) return "na";
  if (rate >= 0.999) return "good";
  if (rate >= 0.5) return "mid";
  return "bad";
}

function delta(current: number | undefined, base: number | undefined, format: (value: number) => string, lowerIsBetter = true): string {
  if (current === undefined || base === undefined) return `<span class="muted">–</span>`;
  const diff = current - base;
  const relative = base !== 0 ? diff / Math.abs(base) : 0;
  const neutral = Math.abs(relative) < 0.1;
  const better = lowerIsBetter ? diff < 0 : diff > 0;
  const cls = neutral ? "flat" : better ? "better" : "worse";
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
  return `<span class="${cls}">${sign}${format(Math.abs(diff))}${base !== 0 ? ` (${sign}${Math.round(Math.abs(relative) * 100)}%)` : ""}</span>`;
}

// ------------------------------------------------------------------- agent

function matrix(file: AgentResultFile): string {
  const cells = summarize(file.trials);
  const models = file.config.models;
  const rows = file.tasks.map((task) => {
    const tds = models.map((model) => {
      const cell = cells.find((candidate) => candidate.task === task.id && candidate.model === model);
      if (!cell) return `<td class="na">not run</td>`;
      return `<td class="cell ${rateClass(cell.passRate)}">
        <div class="rate">${cell.passed}/${cell.trials - cell.errored}${cell.errored ? ` <span class="err">+${cell.errored} err</span>` : ""}</div>
        <div class="sub">${fmtMs(cell.medianWallMs)} · ${fmtUsd(cell.medianCostUsd)} · ${fmtNum(cell.meanMetaCalls)} calls</div>
        <div class="sub">reads ${fmtNum(cell.meanReads)} · writes ${fmtNum(cell.meanWrites)}${cell.duplicateWrites ? ` · <b class="worse">${cell.duplicateWrites} dup writes</b>` : ""}</div>
      </td>`;
    });
    return `<tr><th><a href="#task-${esc(task.id)}">${esc(task.id)}</a><div class="sub">${esc(task.title)}</div></th>${tds.join("")}</tr>`;
  });
  const totals = models.map((model) => {
    const trials = file.trials.filter((trial) => trial.model === model);
    const graded = trials.filter((trial) => trial.status !== "error");
    const passed = graded.filter((trial) => trial.status === "pass").length;
    const cost = trials.reduce((sum, trial) => sum + (trial.metrics.costUsd ?? 0), 0);
    return `<td class="cell ${rateClass(graded.length ? passed / graded.length : undefined)}"><div class="rate">${passed}/${graded.length} (${fmtPct(graded.length ? passed / graded.length : undefined)})</div><div class="sub">total ${fmtUsd(cost)}</div></td>`;
  });
  return `<table class="matrix"><thead><tr><th>task</th>${models.map((model) => `<th>${esc(shortModel(model))}</th>`).join("")}</tr></thead>
  <tbody>${rows.join("")}<tr class="total"><th>all tasks</th>${totals.join("")}</tr></tbody></table>
  <p class="note">Cell: passed/graded trials, then median wall time · median cost · mean meta-tool calls; mean downstream reads and writes. Errors (API, rate limit, harness) are excluded from the rate and counted separately.</p>`;
}

function comparison(current: AgentResultFile, base: AgentResultFile): string {
  const now = summarize(current.trials);
  const then = summarize(base.trials);
  const rows = now.map((cell) => {
    const old = then.find((candidate) => candidate.task === cell.task && candidate.model === cell.model);
    if (!old) return `<tr><td>${esc(cell.task)}</td><td>${esc(shortModel(cell.model))}</td><td colspan="7" class="muted">no baseline cell</td></tr>`;
    const rateDelta = delta(cell.passRate, old.passRate, (value) => `${Math.round(value * 100)}pp`, false).replace(/ \(.*?\)/, "");
    return `<tr><td>${esc(cell.task)}</td><td>${esc(shortModel(cell.model))}</td>
      <td>${fmtPct(old.passRate)} → ${fmtPct(cell.passRate)} ${rateDelta}</td>
      <td>${delta(cell.medianWallMs, old.medianWallMs, fmtMs)}</td>
      <td>${delta(cell.medianCostUsd, old.medianCostUsd, (value) => fmtUsd(value))}</td>
      <td>${delta(cell.meanTokens, old.meanTokens, (value) => fmtNum(value, 0))}</td>
      <td>${delta(cell.meanMetaCalls, old.meanMetaCalls, (value) => fmtNum(value))}</td>
      <td>${delta(cell.meanReads, old.meanReads, (value) => fmtNum(value))}</td>
      <td>${delta(cell.duplicateWrites, old.duplicateWrites, (value) => fmtNum(value, 0))}</td></tr>`;
  });
  return `<table class="compare"><thead><tr><th>task</th><th>model</th><th>pass rate</th><th>median wall</th><th>median cost</th><th>mean tokens</th><th>meta calls</th><th>downstream reads</th><th>dup writes</th></tr></thead><tbody>${rows.join("")}</tbody></table>
  <p class="note">Baseline: ${esc(base.meta.git.branch)}@${esc(base.meta.git.commit)} (${esc(base.meta.createdAt.slice(0, 16))}, ${base.trials.length} trials). Deltas within ±10% are shown flat. Green is better.</p>`;
}

function transcriptHtml(entries: TranscriptEntry[]): string {
  return entries
    .map((entry) => {
      switch (entry.kind) {
        case "user":
          return `<div class="t user"><span class="who">user · turn ${entry.turn}</span><pre>${esc(entry.text)}</pre></div>`;
        case "assistant":
          return `<div class="t asst"><span class="who">assistant</span><pre>${esc(entry.text)}</pre></div>`;
        case "operator":
          return `<div class="t op"><span class="who">operator</span><pre>${esc(entry.text)}</pre></div>`;
        case "tool_use": {
          const input = entry.input as Record<string, unknown> | string;
          const code = typeof input === "object" && typeof input.code === "string" ? input.code : undefined;
          const rest = typeof input === "object" && code !== undefined ? { ...input, code: undefined } : input;
          return `<div class="t use"><span class="who">→ ${esc(entry.tool)}</span>${code ? `<pre class="code">${esc(code)}</pre>` : ""}<pre>${esc(typeof rest === "string" ? rest : JSON.stringify(rest, null, 1))}</pre></div>`;
        }
        case "tool_result": {
          const shown = entry.text.length > DISPLAY_RESULT_CHARS ? `${entry.text.slice(0, DISPLAY_RESULT_CHARS)}… [${entry.chars - DISPLAY_RESULT_CHARS} more chars]` : entry.text;
          return `<div class="t res${entry.isError ? " error" : ""}"><span class="who">← result${entry.isError ? " (isError)" : ""} · ${fmtBytes(entry.chars)}</span><pre>${esc(shown)}</pre></div>`;
        }
        case "turn_end":
          return `<div class="t end">turn ${entry.turn} ended: ${esc(entry.subtype)}${entry.numTurns === undefined ? "" : ` · ${entry.numTurns} model turns`}${entry.durationMs === undefined ? "" : ` · ${fmtMs(entry.durationMs)}`}</div>`;
      }
    })
    .join("");
}

function trialHtml(trial: TrialResult): string {
  const m = trial.metrics;
  const checks = trial.checks
    .map((item) => `<li class="${item.pass ? "ok" : item.advisory ? "adv" : "no"}">${item.pass ? "✓" : item.advisory ? "○" : "✗"} ${esc(item.description)}${item.detail ? ` <span class="muted">— ${esc(item.detail)}</span>` : ""}${item.advisory ? ` <span class="tag">advisory</span>` : ""}</li>`)
    .join("");
  const approvals = trial.approvals.exercised.length
    ? trial.approvals.exercised.map((use) => `<li>turn ${use.turn}: <b>${esc(use.tool)}</b> ${esc(use.target ?? "")}${use.reason ? ` — “${esc(use.reason)}”` : ""}${use.isError ? ` <span class="worse">(error)</span>` : ""}</li>`).join("")
    : `<li class="muted">none</li>`;
  const downstream = Object.entries(m.downstream.byTool).map(([tool, count]) => `${esc(tool)}×${count}`).join(", ") || "none";
  return `<details class="trial ${trial.status}"><summary><span class="badge ${trial.status}">${trial.status}</span> ${esc(shortModel(trial.model))} #${trial.repeat}
    <span class="muted">${fmtMs(m.wallMs)} · ${fmtUsd(m.costUsd)} · ${Object.entries(m.metaTools).map(([tool, count]) => `${tool}×${count}`).join(" ")}</span>${trial.error ? ` <span class="worse">${esc(trial.error)}</span>` : ""}</summary>
    <div class="grid">
      <div><h4>Checks</h4><ul class="checks">${checks || `<li class="muted">not graded</li>`}</ul></div>
      <div><h4>Metrics</h4><table class="kv">
        <tr><td>wall / API</td><td>${fmtMs(m.wallMs)} / ${fmtMs(m.apiMs)}</td></tr>
        <tr><td>turns (user / model)</td><td>${m.conversationTurns} / ${m.modelTurns ?? "unknown"}</td></tr>
        <tr><td>tokens in / out</td><td>${fmtNum(m.tokens.input, 0)} + cache ${fmtNum(m.tokens.cacheRead, 0)}r/${fmtNum(m.tokens.cacheCreation, 0)}w / ${fmtNum(m.tokens.output, 0)}</td></tr>
        <tr><td>cost</td><td>${fmtUsd(m.costUsd)}</td></tr>
        <tr><td>meta-tool calls</td><td>${Object.entries(m.metaTools).map(([tool, count]) => `${esc(tool)}×${count}`).join(", ") || "none"}${Object.keys(m.otherTools).length ? `; other: ${esc(JSON.stringify(m.otherTools))}` : ""}</td></tr>
        <tr><td>tool errors</td><td>${m.toolErrors}</td></tr>
        <tr><td>confirmation nudges</td><td>${m.confirmationNudges ?? 0}</td></tr>
        <tr><td>downstream</td><td>${m.downstream.reads} reads, ${m.downstream.writes} writes, ${m.downstream.duplicateReads} dup reads, ${m.downstream.duplicateWrites} dup writes, ${m.downstream.errors} errors</td></tr>
        <tr><td>by tool</td><td>${downstream}</td></tr>
      </table>
      <h4>Approvals exercised</h4><ul class="checks">${approvals}</ul>
      <p class="note">Pre-approved: ${esc(trial.approvals.allowed.join(", "))}${trial.approvals.denied.length ? `; denied: ${esc(trial.approvals.denied.join(", "))}` : ""}. Gated (not read-only): ${esc(trial.approvals.gated.join(", "))}. Permission denials: ${trial.approvals.permissionDenials.length}.</p></div>
    </div>
    <h4>Transcript</h4><div class="transcript">${transcriptHtml(trial.transcript)}</div>
  </details>`;
}

function agentSection(file: AgentResultFile, base: AgentResultFile | undefined): string {
  const tasks = file.tasks
    .map((task) => {
      const trials = file.trials.filter((trial) => trial.task === task.id);
      const byModel = file.config.models
        .map((model) => trials.filter((trial) => trial.model === model).sort((a, b) => a.repeat - b.repeat).map(trialHtml).join(""))
        .join("");
      return `<section class="task" id="task-${esc(task.id)}"><h3>${esc(task.title)} <code>${esc(task.id)}</code></h3><p>${esc(task.measures)}</p>${byModel}</section>`;
    })
    .join("");
  const planned = file.planned.length
    ? `<h2>Planned tasks (not run)</h2><p class="note">Written down for the phases that build their surfaces. Documentation only; the runner never executes them.</p>
      <table class="compare"><thead><tr><th>phase</th><th>task</th><th>measures</th><th>grading sketch</th></tr></thead><tbody>
      ${file.planned.map((task) => `<tr><td>${esc(task.introducedIn)}</td><td><b>${esc(task.title)}</b><div class="sub">${esc(task.id)}</div></td><td>${esc(task.measures)}</td><td><ul>${task.sketch.grading.map((line) => `<li>${esc(line)}</li>`).join("")}</ul></td></tr>`).join("")}
      </tbody></table>`
    : "";
  return `<h2>Agent task evals</h2>
    <p class="note">${file.trials.length} trials · models ${file.config.models.map(shortModel).join(", ")} · ${file.config.repeats} repeat(s) · concurrency ${file.config.concurrency} · ${esc(file.codexVersion ?? file.claudeVersion ?? "unknown runner")}${file.config.effort ? ` · effort ${esc(file.config.effort)}` : ""}${file.config.runner === "codex" ? "" : ` · MCP output cap ${esc(file.config.mcpOutputTokens ?? "host default")}`}${file.stopped ? ` · <b class="worse">stopped early: ${esc(file.stopped)}</b>` : ""}</p>
    ${matrix(file)}
    ${base ? `<h2>Baseline vs current</h2>${comparison(file, base)}` : ""}
    <h2>Trials</h2>${tasks}${planned}`;
}

// -------------------------------------------------------------- perf / smoke

function perfSection(file: PerfResultFile, base: PerfResultFile | undefined): string {
  const bundle = file.bundle;
  const baseOps = new Map(base?.latency.operations.map((op) => [op.name, op]) ?? []);
  return `<h2>Bundle and latency</h2>
  <table class="compare"><thead><tr><th>measure</th><th>current</th>${base ? "<th>baseline</th><th>delta</th>" : ""}</tr></thead><tbody>
    <tr><td>root entry, minified (${esc(bundle.platform)})</td><td>${fmtBytes(bundle.minifiedBytes)}</td>${base ? `<td>${fmtBytes(base.bundle.minifiedBytes)}</td><td>${delta(bundle.minifiedBytes, base.bundle.minifiedBytes, fmtBytes)}</td>` : ""}</tr>
    <tr><td>root entry, minified + gzip</td><td><b>${fmtBytes(bundle.gzipBytes)}</b></td>${base ? `<td>${fmtBytes(base.bundle.gzipBytes)}</td><td>${delta(bundle.gzipBytes, base.bundle.gzipBytes, fmtBytes)}</td>` : ""}</tr>
    ${file.latency.operations.map((op) => {
      const old = baseOps.get(op.name);
      return `<tr><td>${esc(op.name)} p50 (p90, min–max; n=${file.latency.samples})</td><td>${op.p50Ms.toFixed(1)}ms (${op.p90Ms.toFixed(1)}, ${op.minMs.toFixed(1)}–${op.maxMs.toFixed(1)})</td>${base ? `<td>${old ? `${old.p50Ms.toFixed(1)}ms` : "–"}</td><td>${old ? delta(op.p50Ms, old.p50Ms, (value) => `${value.toFixed(1)}ms`) : "–"}</td>` : ""}</tr>`;
    }).join("")}
  </tbody></table>
  <p class="note">Bundle: esbuild, ${esc(bundle.entry)}, platform ${esc(bundle.platform)}, ESM, minified, all dependencies bundled, gzip level 9. Latency: ${esc(file.latency.deployment)}, measured over real loopback HTTP after one warm-up.</p>
  <details><summary>Largest bundle inputs</summary><table class="kv">${bundle.topInputs.map((input) => `<tr><td>${esc(input.path)}</td><td>${fmtBytes(input.bytes)}</td></tr>`).join("")}</table></details>`;
}

function smokeSection(file: SmokeResultFile): string {
  return `<h2>Deployment smoke</h2>${file.targets
    .map((target) => `<section class="smoke"><h3><span class="badge ${target.status === "pass" ? "pass" : target.status === "fail" ? "fail" : "error"}">${target.status}</span> ${esc(target.target)}</h3><p class="note">${esc(target.description)}${target.reason ? ` — ${esc(target.reason)}` : ""}</p>
      <ul class="checks">${target.checks.map((item) => `<li class="${item.pass ? "ok" : "no"}">${item.pass ? "✓" : "✗"} ${esc(item.name)} <span class="muted">${fmtMs(item.ms)}${item.detail ? ` — ${esc(item.detail)}` : ""}</span></li>`).join("")}</ul>
      ${target.screenshot ? `<details><summary>Operator UI screenshot</summary><img alt="operator UI" src="data:image/png;base64,${target.screenshot}"></details>` : ""}</section>`)
    .join("")}`;
}

// --------------------------------------------------------------------- page

const CSS = `
:root{--fg:#1d2024;--muted:#6b7280;--line:#e5e7eb;--bg:#fff;--soft:#f6f7f9;--good:#dcfce7;--goodfg:#166534;--mid:#fef3c7;--midfg:#92400e;--bad:#fee2e2;--badfg:#991b1b;--accent:#3b5bdb}
@media (prefers-color-scheme:dark){:root{--fg:#e6e8eb;--muted:#9aa3ad;--line:#2b3036;--bg:#15181b;--soft:#1d2126;--good:#14361f;--goodfg:#86efac;--mid:#3a2e10;--midfg:#fcd34d;--bad:#3b1618;--badfg:#fca5a5;--accent:#8ea2ff}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:1280px;margin:0 auto;padding:28px 24px 80px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:34px 0 10px;padding-top:12px;border-top:1px solid var(--line)}h3{font-size:15px;margin:22px 0 4px}h4{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:12px 0 6px}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);padding:1px 5px;border-radius:4px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:7px 9px;border-bottom:1px solid var(--line)}thead th{font-size:12px;color:var(--muted);font-weight:600}
.matrix td.cell{border-left:3px solid transparent}.cell.good{background:var(--good)}.cell.mid{background:var(--mid)}.cell.bad{background:var(--bad)}.cell .rate{font-weight:650;font-size:15px}
.sub{font-size:12px;color:var(--muted)}.note{font-size:12px;color:var(--muted)}.muted{color:var(--muted)}.err{color:var(--badfg);font-size:12px}
.better{color:var(--goodfg);font-weight:600}.worse{color:var(--badfg);font-weight:600}.flat{color:var(--muted)}
tr.total th,tr.total td{border-top:2px solid var(--line)}
.meta{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--muted);font-size:12px;margin-bottom:8px}
details.trial{border:1px solid var(--line);border-radius:8px;margin:6px 0;background:var(--bg)}details.trial>summary{cursor:pointer;padding:8px 10px;list-style:none}details.trial[open]>summary{border-bottom:1px solid var(--line)}
details.trial>*:not(summary){margin-left:12px;margin-right:12px}
.badge{display:inline-block;min-width:44px;text-align:center;font-size:11px;font-weight:700;text-transform:uppercase;border-radius:4px;padding:1px 6px}.badge.pass{background:var(--good);color:var(--goodfg)}.badge.fail{background:var(--bad);color:var(--badfg)}.badge.error{background:var(--mid);color:var(--midfg)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}@media (max-width:900px){.grid{grid-template-columns:1fr}}
ul.checks{list-style:none;padding:0;margin:0}ul.checks li{padding:2px 0}li.ok{color:var(--goodfg)}li.no{color:var(--badfg)}li.adv{color:var(--midfg)}.tag{font-size:10px;border:1px solid var(--line);border-radius:3px;padding:0 4px;color:var(--muted)}
table.kv td{padding:3px 6px;font-size:12px}table.kv td:first-child{color:var(--muted);white-space:nowrap;width:1%}
.transcript{margin-bottom:12px}.t{border-left:3px solid var(--line);padding:2px 10px;margin:6px 0}.t pre{margin:2px 0;white-space:pre-wrap;word-break:break-word;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.t .who{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}.t.user{border-color:var(--accent)}.t.asst{border-color:#8b5cf6}.t.use{border-color:#0ea5e9;background:var(--soft)}.t.res{border-color:#94a3b8}.t.res.error{border-color:var(--badfg)}.t.op{border-color:#f59e0b}.t.end{font-size:11px;color:var(--muted);border:0}
pre.code{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:6px}
img{max-width:100%;border:1px solid var(--line);border-radius:6px}
`;

export function renderReport(input: { current: ResultFile[]; baseline: ResultFile[]; notes?: string }): string {
  const find = <K extends ResultFile["kind"]>(files: ResultFile[], kind: K) =>
    files.find((file) => file.kind === kind) as Extract<ResultFile, { kind: K }> | undefined;
  const agent = find(input.current, "connecta-eval/agent");
  const perf = find(input.current, "connecta-eval/perf");
  const smoke = find(input.current, "connecta-eval/smoke");
  const meta = (agent ?? perf ?? smoke)?.meta;
  const baseAgent = find(input.baseline, "connecta-eval/agent");
  const basePerf = find(input.baseline, "connecta-eval/perf");
  const baseMeta = (baseAgent ?? basePerf)?.meta;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>connecta eval — ${esc(meta?.git.branch ?? "")}@${esc(meta?.git.commit ?? "")}</title><style>${CSS}</style></head><body><main>
<h1>connecta evaluation report</h1>
<div class="meta">${meta ? `<span>${esc(meta.git.branch)}@${esc(meta.git.commit)}${meta.git.dirty ? " (dirty)" : ""}</span><span>src tree ${esc(meta.git.srcTree)}${meta.git.srcDirty ? " (modified)" : ""}</span><span>connecta ${esc(meta.packageVersion)}</span><span>${esc(meta.createdAt.replace("T", " ").slice(0, 16))} UTC</span><span>node ${esc(meta.node)} · ${esc(meta.platform)}</span>` : ""}${baseMeta ? `<span>baseline ${esc(baseMeta.git.branch)}@${esc(baseMeta.git.commit)} (src tree ${esc(baseMeta.git.srcTree)})</span>` : ""}</div>
<p class="note">Agents are graded on the fake downstream servers' final state and call ledger, never on their prose. A trial passes when every required check passes; advisory checks are recorded for comparison only.</p>
${input.notes ? `<h2>Observations</h2>${input.notes.split(/\n\s*\n/).map((paragraph) => `<p>${esc(paragraph.trim())}</p>`).join("")}` : ""}
${agent ? agentSection(agent, baseAgent) : ""}
${perf ? perfSection(perf, basePerf) : ""}
${smoke ? smokeSection(smoke) : ""}
</main></body></html>
`;
}
