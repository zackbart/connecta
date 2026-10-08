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
  if (task.id === "p5-program-image") cases.push({ name: "image delivered by direct call", trace: { ...trace,
    toolUses: trace.toolUses.map(u => ({ ...u, tool: "call_tool", input: { address: "assets.get_badge_image", args: {} } })) } });
  if (task.id === "p5-fanout-over-budget") {
    cases.push({ name: "swapped run statuses and commits", trace: { ...trace, finalAnswer: "CI: 4812 passed, commit c0ffee1; 4811 failed, commit 9f2c1ab; 4810 passed, commit 71d0e3c." } });
    cases.push({ name: "sequential budget exhaustion", world: withPrograms(world.programs.map((p, i) => i === 0 ?
      { ...p, peakCalls: 1, code: "async () => { for (const runId of [4812,4811,4810]) await connecta.call('ci.get_run', {runId}); }" } : p)) });
    cases.push({ name: "fan-out API only in a comment", world: withPrograms(world.programs.map((p, i) => i === 0 ?
      { ...p, code: "async () => { /* Promise.allSettled([]) */ return Promise.all([]); }" } : p)) });
    cases.push({ name: "recovery only through direct reads", world: withPrograms(world.programs.slice(0, 1)) });
  }
  if (task.id === "p5-absent-github") cases.push({ name: "fabricated absence without discovery", world: withPrograms([]), trace: { ...trace,
    toolUses: trace.toolUses.map(u => ({ ...u, input: { code: `async () => { /* GitHub pull requests */ return { absence: "GitHub is absent" }; }` }, resultText: `{"absence":"GitHub is absent"}` })) } });
  if (task.id === "p5-revenuecat-text") {
    cases.push({ name: "false access field mentions true", trace: { ...trace, finalAnswer: trace.finalAnswer?.replace("gives_access: true", "gives_access: false (not true)") ?? "" } });
    cases.push({ name: "subscription id supplies grace substring", trace: { ...trace, finalAnswer: trace.finalAnswer?.replace(" during billing grace period", "") ?? "" } });
  }
  return cases.map(c => ({ name: c.name, rejected: task.grade({ world: c.world ?? world, trace: c.trace ?? trace }).some(check => !check.advisory && !check.pass) }));
}
