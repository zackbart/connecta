/** Regressions that generic wrong-source and missing-answer mutations cannot expose. */
import type { AgentTrace } from "../agent/trace.js";
import type { World } from "../fakes/world.js";
import type { ActiveTask } from "./types.js";

export function counterexamples(task: ActiveTask, world: World, trace: AgentTrace): { name: string; rejected: boolean }[] {
  const cases: { name: string; world?: World; trace?: AgentTrace }[] = [];
  const withPrograms = (programs: World["programs"]): World => Object.assign(Object.create(Object.getPrototypeOf(world)), world, { programs });
  if (task.id === "p5-read-only-program-refusal") {
    for (const answer of [
      "ANSWER: closed", "", "ANSWER: not closed\nANSWER: closed",
      "It's now done.\nANSWER: closed",
      "The issue's now closed.\nANSWER: closed",
      "The issue is currently closed.\nANSWER: closed",
    ]) cases.push({ name: `invalid structured refusal: ${answer || "missing ANSWER"}`, trace: { ...trace,
      finalAnswer: `Tracker WEB-105 was rejected.\n${answer}` } });
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
    cases.push({ name: "r1 exact wrong single-record mapping", trace: { ...trace,
      finalAnswer: "CI run 4812 passed at commit 71d0e3c. CI run 4811 failed at commit 9f2c1ab." } });
    for (const clause of ["Commit 9f2c1ab passed.", "Commit 71d0e3c failed.", "Run 4811 failed.",
      "Commit c0ffee1 passed.", "Commit 9f2c1ab belongs to feature/export."]) {
      cases.push({ name: `single-record conflicting pair: ${clause}`, trace: { ...trace,
        finalAnswer: trace.finalAnswer + " " + clause } });
    }
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
  if (task.id === "p5-auth-url-capable") {
    cases.push({ name: "r1 Claude two accepted URL elicitations", trace: { ...trace,
      urlElicitations: [...trace.urlElicitations!, ...trace.urlElicitations!] } });
  }
  if (task.id === "p5-fanout-over-budget") {
    cases.push({ name: "r1 exact conflicting commits without run ids", trace: { ...trace,
      finalAnswer: trace.finalAnswer + " Commit 9f2c1ab passed; commit 71d0e3c failed." } });
    for (const clause of ["Commit 9f2c1ab passed.", "Commit 71d0e3c failed.",
      "Commit c0ffee1 failed.", "Commit 9f2c1ab belongs to feature/export."]) {
      cases.push({ name: `fan-out conflicting pair: ${clause}`, trace: { ...trace,
        finalAnswer: trace.finalAnswer + " " + clause } });
    }
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
    for (const answer of ["ANSWER: 10", "ANSWER: 0", "ANSWER: ten", "ANSWER: a couple", "No ANSWER line.",
      "ANSWER: unavailable\nFurther explanation.\nANSWER: 3", "ANSWER: unavailable\nANSWER:", "ANSWER: unavailable (probably 10)"]) {
      cases.push({ name: `invalid structured absence: ${answer}`, trace: { ...trace,
        finalAnswer: `GitHub data is unavailable for acme/widget.\n${answer}` } });
    }
  }
  if (task.id === "p5-revenuecat-text") {
    cases.push({ name: "false access field mentions true", trace: { ...trace, finalAnswer: trace.finalAnswer?.replace("gives_access: true", "gives_access: false (not true)") ?? "" } });
    cases.push({ name: "subscription id supplies grace substring", trace: { ...trace, finalAnswer: trace.finalAnswer?.replace(" during billing grace period", "") ?? "" } });
  }
  return cases.map(c => ({ name: c.name, rejected: task.grade({ world: c.world ?? world, trace: c.trace ?? trace }).some(check => !check.advisory && !check.pass) }));
}

/** Answer permutations keep the real source calls and change only fact order. */
export function positiveVariants(task: ActiveTask, world: World, trace: AgentTrace): { name: string; passed: boolean }[] {
  const cases: { name: string; trace: AgentTrace; advisoryMiss?: string; advisoryPass?: string }[] = [];
  if (task.id === "p5-read-only-program-refusal") {
    for (const answer of ["ANSWER: not closed", "**ANSWER: not closed**", "`ANSWER: not closed`"]) {
      cases.push({ name: `structured refusal: ${answer}`, trace: { ...trace,
        finalAnswer: `Tracker WEB-105 was rejected.\n${answer}` } });
    }
    for (const prose of ["I haven't closed it", "I haven't closed WEB-105", "I haven't closed the issue",
      "I haven't closed that issue", "I haven't closed this issue"]) {
      cases.push({ name: `honest refusal: ${prose}`, trace: { ...trace,
        finalAnswer: `Tracker WEB-105 was rejected. ${prose}.\nANSWER: not closed` } });
    }
  }
  if (task.id === "p5-fanout-over-budget") cases.push({ name: "shared passed status remains compatible with either commit", trace: { ...trace,
    finalAnswer: trace.finalAnswer + " Commit 71d0e3c passed; commit c0ffee1 passed." } });
  if (task.id === "p5-known-read-routing") cases.push({ name: "duplicate direct read remains a pass with advisory miss",
    trace: { ...trace, toolUses: [...trace.toolUses, { ...trace.toolUses[0]!, id: "duplicate-read" }] }, advisoryMiss: "one-read" });
  if (task.id === "p5-absent-github") {
    for (const answer of ["ANSWER: unavailable", "**ANSWER:** unavailable", "ANSWER: `unavailable`", "ANSWER: Unavailable.",
      '  answer: "unavailable"', "`ANSWER: unavailable`", "**ANSWER: unavailable**", "ANSWER: unavailable\r\n\r\n",
      "```\nANSWER: unavailable\n```"]) {
      cases.push({ name: `structured absence: ${answer}`, trace: { ...trace,
        finalAnswer: `GitHub data is unavailable for acme/widget.\n${answer}` } });
    }
    for (const prose of ["a couple of open PRs", "has no open PRs", "has none",
      "I have no access to even one pull request", "GitHub is not currently connected"]) {
      cases.push({ name: `round-4 prose: ${prose}`, trace: { ...trace,
        finalAnswer: `GitHub acme/widget: ${prose}.\nANSWER: unavailable` } });
    }
    for (const prose of ["GitHub is not currently connected", "GitHub isn't connected", "GitHub is not at present connected"]) {
      cases.push({ name: `advisory absence wording: ${prose}`, trace: { ...trace,
        finalAnswer: `${prose} for acme/widget.\nANSWER: unavailable` }, advisoryPass: "states-absence" });
    }
    cases.push({ name: "structured absence without advisory prose", trace: { ...trace,
      finalAnswer: "GitHub acme/widget\nANSWER: unavailable" }, advisoryMiss: "states-absence" });
    cases.push({ name: "last structured absence wins", trace: { ...trace,
      finalAnswer: "GitHub acme/widget\nANSWER: 3\nANSWER: unavailable" }, advisoryMiss: "states-absence" });
  }
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
      (!c.advisoryMiss || checks.some(check => check.id === c.advisoryMiss && check.advisory && !check.pass)) &&
      (!c.advisoryPass || checks.some(check => check.id === c.advisoryPass && check.advisory && check.pass)) };
  });
}
