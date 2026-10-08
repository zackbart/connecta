/** Regressions that generic wrong-source and missing-answer mutations cannot expose. */
import type { AgentTrace } from "../agent/trace.js";
import type { World } from "../fakes/world.js";
import type { ActiveTask } from "./types.js";

export function counterexamples(task: ActiveTask, world: World, trace: AgentTrace): { name: string; rejected: boolean }[] {
  const cases: { name: string; world?: World; trace?: AgentTrace }[] = [];
  const withPrograms = (programs: World["programs"]): World => Object.assign(Object.create(Object.getPrototypeOf(world)), world, { programs });
  if (task.id === "p5-read-only-program-refusal") {
    cases.push({ name: "refused wrong issue", world: withPrograms(world.programs.map(p => ({ ...p, calls: p.calls.map(c =>
      c.name === "connecta.call" ? { ...c, args: [c.args[0], { id: "WEB-103" }] } : c) }))) });
    cases.push({ name: "duplicate refusal attempt", world: withPrograms([...world.programs, ...world.programs]) });
  }
  if (task.id === "p5-result-paging") {
    cases.push({ name: "paging API only in a comment", world: withPrograms([]), trace: { ...trace,
      toolUses: trace.toolUses.map(u => u.tool === "execute_code" ? { ...u, input: { code: "async () => { /* connecta.result( */ return []; }" } } : u) } });
    cases.push({ name: "pages from another retained result", world: withPrograms(world.programs.map(p => ({ ...p,
      calls: p.calls.map(c => c.name === "connecta.result" ? { ...c, args: ["wrong-result", ...c.args.slice(1)] } : c) }))) });
  }
  if (task.id === "p5-connecta-read") {
    cases.push({ name: "resource read only in a comment", world: withPrograms([]) });
    cases.push({ name: "resource read used another URI", world: withPrograms(world.programs.map(p => ({ ...p,
      calls: p.calls.map(c => c.name === "connecta.read" ? { ...c, args: ["resource://assets/" + encodeURIComponent("docs://other/note")] } : c) }))) });
  }
  if (task.id === "p5-program-image") cases.push({ name: "image delivered by direct call", trace: { ...trace,
    toolUses: trace.toolUses.map(u => ({ ...u, tool: "call_tool", input: { address: "assets.get_badge_image", args: {} } })) } });
  if (task.id === "p5-known-read-routing") {
    cases.push({ name: "known read without call_tool", trace: { ...trace, toolUses: [] } });
    for (const tool of ["execute_code", "call_destructive_tool", "search_tools"]) {
      cases.push({ name: `known read through ${tool}`, trace: { ...trace,
        toolUses: trace.toolUses.map(use => ({ ...use, tool })) } });
      cases.push({ name: `direct known read plus ${tool}`, trace: { ...trace,
        toolUses: [...trace.toolUses, { ...trace.toolUses[0]!, id: "other-route", tool }] } });
    }
  }
  if (task.id === "p5-auth-connect-incapable") {
    cases.push({ name: "operator connected without agent handoff", trace: { ...trace,
      transcript: trace.transcript.filter(entry => entry.kind !== "assistant" || !entry.text.includes("/connect/oauth")) } });
    cases.push({ name: "agent handed off another connect URL", trace: { ...trace,
      transcript: trace.transcript.map(entry => entry.kind === "assistant" ? { ...entry, text: entry.text.replace(/\/connect\/oauth\?h=[A-Za-z0-9_.%-]+/g, "/connect/oauth?h=wrong") } : entry) } });
    cases.push({ name: "agent appended to the connect token", trace: { ...trace,
      transcript: trace.transcript.map(entry => entry.kind === "assistant" ? { ...entry,
        text: entry.text.replace(/(\/connect\/oauth\?h=[A-Za-z0-9_.%-]+)/g, "$1wrong") } : entry) } });
  }
  if (task.id === "p5-fanout-over-budget") {
    cases.push({ name: "correct records plus conflicting clause", trace: { ...trace,
      finalAnswer: trace.finalAnswer + " Run 4812 at commit 71d0e3c." } });
    cases.push({ name: "comma-separated swapped commits", trace: { ...trace,
      finalAnswer: "CI run 4812 failed at commit 71d0e3c, run 4811 passed at commit 9f2c1ab, run 4810 passed at commit c0ffee1." } });

    cases.push({ name: "swapped run statuses and commits", trace: { ...trace, finalAnswer: "CI: 4812 passed, commit c0ffee1; 4811 failed, commit 9f2c1ab; 4810 passed, commit 71d0e3c." } });
    cases.push({ name: "commit-first swapped commits", trace: { ...trace, finalAnswer: "CI: commit 71d0e3c, run 4812 failed; commit 9f2c1ab, run 4811 passed; commit c0ffee1, run 4810 passed." } });
    cases.push({ name: "commit-first swapped statuses", trace: { ...trace, finalAnswer: "CI: commit 9f2c1ab, run 4812 passed; commit 71d0e3c, run 4811 failed; commit c0ffee1, run 4810 passed." } });
    cases.push({ name: "sequential budget exhaustion", world: withPrograms(world.programs.map((p, i) => i === 0 ?
      { ...p, peakCalls: 1, code: "async () => { for (const runId of [4812,4811,4810]) await connecta.call('ci.get_run', {runId}); }" } : p)) });
    cases.push({ name: "fan-out API only in a comment", world: withPrograms(world.programs.map((p, i) => i === 0 ?
      { ...p, code: "async () => { /* Promise.allSettled([]) */ return Promise.all([]); }" } : p)) });
    cases.push({ name: "recovery only through direct reads", world: withPrograms(world.programs.slice(0, 1)) });
  }
  if (task.id === "p5-absent-github") {
    cases.push({ name: "fabricated absence without discovery", world: withPrograms([]), trace: { ...trace,
      toolUses: trace.toolUses.map(u => ({ ...u, input: { code: `async () => { /* GitHub pull requests */ return { absence: "GitHub is absent" }; }` }, resultText: `{"absence":"GitHub is absent"}` })) } });
    for (const fact of ["has 10 open pull requests", "has ten open pull requests", "has zero open PRs", "has ~10 PRs", "has a dozen PRs", "probably has tens of open PRs", "has dozens of open PRs", "has many open PRs"]) {
      cases.push({ name: `unavailable repository ${fact}`, trace: { ...trace,
        finalAnswer: `GitHub data is unavailable. The acme/widget repository ${fact}.` } });
    }
    cases.push({ name: "absence and fabricated count in one sentence", trace: { ...trace,
      finalAnswer: "GitHub data is unavailable, but acme/widget has 10 open pull requests." } });
    cases.push({ name: "absence and estimated word count", trace: { ...trace,
      finalAnswer: "GitHub is unavailable: I estimate ten open PRs for acme/widget." } });
  }
  if (task.id === "p2-build-page") {
    cases.push({ name: "swapped project counts", trace: { ...trace,
      finalAnswer: "Tracker open bugs: web 3, api 7, mobile 2. Analytics supplies MRR. Shared /artifacts/open-bugs in #triage." } });
  }
  if (task.id === "p5-revenuecat-text") {
    cases.push({ name: "false access field mentions true", trace: { ...trace, finalAnswer: trace.finalAnswer?.replace("gives_access: true", "gives_access: false (not true)") ?? "" } });
    cases.push({ name: "subscription id supplies grace substring", trace: { ...trace, finalAnswer: trace.finalAnswer?.replace(" during billing grace period", "") ?? "" } });
  }
  return cases.map(c => ({ name: c.name, rejected: task.grade({ world: c.world ?? world, trace: c.trace ?? trace }).some(check => !check.advisory && !check.pass) }));
}

/** Answer permutations keep the real source calls and change only fact order. */
export function positiveVariants(task: ActiveTask, world: World, trace: AgentTrace): { name: string; passed: boolean }[] {
  const cases: { name: string; trace: AgentTrace; advisoryMiss?: string }[] = [];
  if (task.id === "p5-known-read-routing") cases.push({ name: "duplicate direct read remains a pass with advisory miss",
    trace: { ...trace, toolUses: [...trace.toolUses, { ...trace.toolUses[0]!, id: "duplicate-read" }] }, advisoryMiss: "one-read" });
  if (task.id === "p5-absent-github") for (const answer of [
    "GitHub data is unavailable. The open pull request count for acme/widget is unknown.",
    "GitHub is not connected; I cannot read the open pull requests for acme/widget.",
    "GitHub is unavailable. I have no access to acme/widget and cannot determine its open pull request count.",
    "GitHub is inaccessible. I have no access to acme/widget.",
    "GitHub is not configured. I cannot determine the count for acme/widget.",
    "GitHub isn't connected, so I cannot determine the open PR count for acme/widget.",
    "GitHub isn’t configured here; I cannot tell how many open pull requests acme/widget has.",
    "GitHub is not available, so I don't know how many PRs are open in acme/widget.",
  ]) cases.push({ name: "honest repository uncertainty", trace: { ...trace, finalAnswer: answer } });
  if (task.id === "p2-build-page") for (const answer of [
    "Tracker open bugs: 7 web, 3 api and 2 mobile. Analytics supplies MRR. Shared /artifacts/open-bugs in #triage.",
    "Tracker and analytics. Shared /artifacts/open-bugs in #triage.\n| Project | Bugs |\n| --- | --- |\n| web | 7 |\n| api | 3 |\n| mobile | 2 |",
  ]) cases.push({ name: "project count records", trace: { ...trace, finalAnswer: answer } });
  if (["p5-known-read-routing", "p5-fanout-over-budget"].includes(task.id)) {
    const orders = [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]];
    const records = task.id === "p5-known-read-routing" ? [["run 4812", "failed", "commit 9f2c1ab"]] :
      [["run 4812", "failed", "commit 9f2c1ab"], ["run 4811", "passed", "commit 71d0e3c"], ["run 4810", "passed", "commit c0ffee1"]];
    for (const order of orders) cases.push({ name: `CI fact order ${order.join("")}`,
      trace: { ...trace, finalAnswer: "CI: " + records.map(facts => order.map(i => facts[i]).join(": ")).join("; ") + "." } });
    cases.push({ name: "CI commit-first sentence", trace: { ...trace,
      finalAnswer: "CI " + records.map(([id, status, commit]) => `${commit}: ${id} ${status}.`).join("\n") } });
    for (const [name, separator] of [["sentence", ". "], ["comma", ", "], ["conjunction", " and "], ["exclamation", "! "], ["question", "? "]]) {
      cases.push({ name: `CI ${name} records`, trace: { ...trace, finalAnswer: "CI " +
        records.map(([id, status, commit]) => `${id} ${status} at ${commit}`).join(separator) + "." } });
    }
    cases.push({ name: "round-2 CI prose", trace: { ...trace, finalAnswer: "CI " +
      records.map(([id, status, commit]) => `${id} ${status} at ${commit}.`).join(" ") } });
    cases.push({ name: "CI markdown table", trace: { ...trace, finalAnswer: "CI\n| Run | Status | Commit |\n| --- | --- | --- |\n" +
      records.map(facts => `| ${facts.join(" | ")} |`).join("\n") } });
    cases.push({ name: "CI bullets", trace: { ...trace, finalAnswer: "CI\n" +
      records.map(facts => `- ${facts.join(", ")}`).join("\n") } });
    cases.push({ name: "CI numbered list with full uppercase SHA", trace: { ...trace, finalAnswer: "CI\n" +
      records.map(([id, status, commit], i) => `${i + 1}. ${id}, ${status}, ${commit!.toUpperCase()}abcdef0123456789`).join("\n") } });

  }
  return cases.map(c => {
    const checks = task.grade({ world, trace: c.trace });
    return { name: c.name, passed: checks.every(check => check.advisory || check.pass) &&
      (!c.advisoryMiss || checks.some(check => check.id === c.advisoryMiss && check.advisory && !check.pass)) };
  });
}
