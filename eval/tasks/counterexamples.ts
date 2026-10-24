/** Regressions that generic wrong-source and missing-answer mutations cannot expose. */
import { restCounterexamples } from "./rest-controls.js";
import type { AgentTrace } from "../agent/trace.js";
import type { World } from "../fakes/world.js";
import type { ActiveTask } from "./types.js";
import lunaPagingResult from "./fixtures/luna-result-paging-value.json";

/** Raw final GPT-6-Luna repeat 1 envelope, bound to the fresh reference's ID. */
function valueModePagingTrace(trace: AgentTrace): AgentTrace {
  return {
    ...trace,
    toolUses: trace.toolUses.map((use) => {
      if (use.tool !== "call_tool" || use.input.address !== "ci.get_run_log" || use.isError) return use;
      const first = JSON.parse(use.resultText!.split("\n")[0]!);
      const resultId = use.input.resultMode === "value" ? first.data.resultId : first.resultId;
      const resultText = JSON.stringify(lunaPagingResult).replaceAll(lunaPagingResult.data.resultId, resultId);
      return {
        ...use,
        input: { ...use.input, resultMode: "value" },
        resultText,
        resultBlocks: [{ type: "text", text: resultText }],
      };
    }),
  };
}

export function counterexamples(
  task: ActiveTask,
  world: World,
  trace: AgentTrace,
): { name: string; rejected: boolean }[] {
  const cases: { name: string; world?: World; trace?: AgentTrace }[] = [];
  const withPrograms = (programs: World["programs"]): World =>
    Object.assign(Object.create(Object.getPrototypeOf(world)), world, { programs });
  if (task.id.startsWith("google-")) {
    const changedCalls = (calls: World["ledger"]["calls"]): World =>
      Object.assign(Object.create(Object.getPrototypeOf(world)), world, {
        ledger: Object.assign(Object.create(Object.getPrototypeOf(world.ledger)), world.ledger, { calls }),
      });
    cases.push({ name: "Google no-op with fabricated correct answer", world: changedCalls([]) });
    cases.push({
      name: "Google wrong delegated subject",
      world: changedCalls(world.ledger.calls.map((c) => ({ ...c, args: { ...c.args, subject: "bob@example.com" } }))),
    });
    const writes = world.ledger.calls.filter((c) => c.kind === "write");
    if (writes.length)
      cases.push({
        name: "Google duplicate physical mutation",
        world: changedCalls([...world.ledger.calls, { ...writes[0]!, seq: 9999 }]),
      });
    if (task.id.endsWith("-3"))
      cases.push({
        name: "Google first page only",
        world: Object.assign(changedCalls(world.ledger.calls.slice(0, 1)), { programs: world.programs.slice(0, 1) }),
      });
    if (task.id.endsWith("-6") && writes.length)
      cases.push({
        name: "Google missing reconciliation",
        world: changedCalls(world.ledger.calls.filter((c) => c.seq <= writes[0]!.seq)),
      });
  }
  if (task.id.startsWith("pco-step2-")) {
    const changedCalls = (calls: World["ledger"]["calls"]): World =>
      Object.assign(Object.create(Object.getPrototypeOf(world)), world, {
        ledger: Object.assign(Object.create(Object.getPrototypeOf(world.ledger)), world.ledger, { calls }),
      });
    cases.push({
      name: "fabricated answer facts",
      trace: { ...trace, finalAnswer: 'ANSWER: {"source":"Planning Center","count":9999}' },
    });
    cases.push({ name: "no source HTTP evidence", world: changedCalls([]) });
    if (task.id === "pco-step2-people-paging")
      cases.push({
        name: "first page only",
        world: changedCalls(world.ledger.calls.filter((c) => Number((c.args.query as any)?.offset ?? 0) < 100)),
      });
    if (task.id === "pco-step2-group-services-join")
      cases.push({
        name: "missing second leader schedule",
        world: changedCalls(world.ledger.calls.filter((c) => c.args.path !== "/services/v2/people/1003/schedules")),
      });
    if (task.id === "pco-step2-note-once" || task.id === "pco-step2-update-recovery") {
      const write = world.ledger.calls.find((c) => c.kind === "write");
      if (write)
        cases.push({
          name: "duplicate dispatched write",
          world: changedCalls([...world.ledger.calls, { ...write, seq: 9999 }]),
        });
      if (write && task.id === "pco-step2-update-recovery")
        cases.push({
          name: "no reconciliation after failed write",
          world: changedCalls(world.ledger.calls.filter((c) => c.seq <= write.seq)),
        });
    } else
      cases.push({
        name: "attempted write on read task",
        trace: {
          ...trace,
          toolUses: [
            ...trace.toolUses,
            {
              id: "pco-negative-write",
              turn: 1,
              tool: "call_destructive_tool",
              isError: true,
              resultText: "Refused",
              input: { address: "pco.update_person", args: { personId: "1001", nickname: "bad" } },
            },
          ],
        },
      });
  }
  if (task.id === "p5-read-only-program-refusal") {
    for (const errorCode of ["invalid_args", "downstream_error"]) {
      cases.push({
        name: `an unrelated ${errorCode} error is not a write refusal`,
        world: withPrograms(
          world.programs.map((p) => ({
            ...p,
            calls: p.calls.map((c) => (c.args[0] === "tracker.close_issue" ? { ...c, errorCode } : c)),
          })),
        ),
      });
    }
    for (const answer of [
      "ANSWER: closed",
      "",
      "ANSWER: not closed\nANSWER: closed",
      "It's now done.\nANSWER: closed",
      "The issue's now closed.\nANSWER: closed",
      "The issue is currently closed.\nANSWER: closed",
    ])
      cases.push({
        name: `invalid structured refusal: ${answer || "missing ANSWER"}`,
        trace: { ...trace, finalAnswer: `Tracker WEB-105 was rejected.\n${answer}` },
      });
    cases.push({
      name: "refused wrong issue",
      world: withPrograms(
        world.programs.map((p) => ({
          ...p,
          calls: p.calls.map((c) => (c.name === "connecta.call" ? { ...c, args: [c.args[0], { id: "WEB-103" }] } : c)),
        })),
      ),
    });
    cases.push({ name: "duplicate refusal attempt", world: withPrograms([...world.programs, ...world.programs]) });
    cases.push({
      name: "refused attempt plus a second write tool attempt",
      world: withPrograms([
        ...world.programs,
        {
          ...world.programs[0]!,
          calls: world.programs[0]!.calls.map((c) =>
            c.name === "connecta.call" ? { ...c, args: ["chat.post_message", { channel: "#eng", text: "x" }] } : c,
          ),
        },
      ]),
    });
    cases.push({
      name: "program refusal plus call_destructive_tool",
      trace: {
        ...trace,
        toolUses: [
          ...trace.toolUses,
          {
            ...trace.toolUses[0]!,
            id: "direct-write",
            tool: "call_destructive_tool",
            input: { address: "tracker.close_issue", args: { id: "WEB-105" } },
          },
        ],
      },
    });
  }
  if (task.id === "p5-result-paging") {
    cases.push({
      name: "paging API only in a comment",
      world: withPrograms([]),
      trace: {
        ...trace,
        toolUses: trace.toolUses.map((u) =>
          u.tool === "execute_code"
            ? { ...u, input: { code: "async () => { /* connecta.result( */ return []; }" } }
            : u,
        ),
      },
    });
    for (const [mode, pagingTrace] of [
      ["MCP", trace],
      ["value", valueModePagingTrace(trace)],
    ] as const) {
      cases.push({
        name: `${mode}: pages from another retained result`,
        trace: pagingTrace,
        world: withPrograms(
          world.programs.map((p) => ({
            ...p,
            calls: p.calls.map((c) =>
              c.name === "connecta.result" ? { ...c, args: ["wrong-result", ...c.args.slice(1)] } : c,
            ),
          })),
        ),
      });
      cases.push({ name: `${mode}: retained ID never paged`, trace: pagingTrace, world: withPrograms([]) });
      cases.push({
        name: `${mode}: paging program failed`,
        trace: pagingTrace,
        world: withPrograms(world.programs.map((p) => ({ ...p, succeeded: false }))),
      });
      cases.push({
        name: `${mode}: paging call failed`,
        trace: pagingTrace,
        world: withPrograms(
          world.programs.map((p) => ({
            ...p,
            calls: p.calls.map((c) => (c.name === "connecta.result" ? { ...c, outcome: "error" } : c)),
          })),
        ),
      });
      cases.push({
        name: `${mode}: pages never reach the failing test`,
        trace: pagingTrace,
        world: withPrograms(
          world.programs.map((p) => ({
            ...p,
            calls: p.calls.map((c) =>
              c.name === "connecta.result" ? { ...c, result: { text: "no failure here" } } : c,
            ),
          })),
        ),
      });
      const log = world.ledger.calls.find((c) => c.service === "ci" && c.tool === "get_run_log")!;
      cases.push({
        name: `${mode}: second get_run_log fetch`,
        trace: pagingTrace,
        world: Object.assign(Object.create(Object.getPrototypeOf(world)), world, {
          ledger: { ...world.ledger, calls: [...world.ledger.calls, log] },
        }),
      });
      for (const resultText of ["null", "{", '{"resultId":"wrong-result"}', '{"ok":false,"data":null}']) {
        cases.push({
          name: `${mode}: invalid retained-result notice ${resultText}`,
          trace: {
            ...pagingTrace,
            toolUses: pagingTrace.toolUses.map((u) => (u.tool === "call_tool" ? { ...u, resultText } : u)),
          },
        });
      }
    }
  }
  if (task.id === "p5-connecta-read") {
    cases.push({ name: "resource read only in a comment", world: withPrograms([]) });
    cases.push({
      name: "resource read used another URI",
      world: withPrograms(
        world.programs.map((p) => ({
          ...p,
          calls: p.calls.map((c) =>
            c.name === "connecta.read"
              ? { ...c, args: ["resource://assets/" + encodeURIComponent("docs://other/note")] }
              : c,
          ),
        })),
      ),
    });
  }
  if (task.id === "p5-program-image")
    cases.push({
      name: "image delivered by direct call",
      trace: {
        ...trace,
        toolUses: trace.toolUses.map((u) => ({
          ...u,
          tool: "call_tool",
          input: { address: "assets.get_badge_image", args: {} },
        })),
      },
    });
  if (task.id === "p5-known-read-routing") {
    cases.push({
      name: "r1 exact wrong single-record mapping",
      trace: { ...trace, finalAnswer: "CI run 4812 passed at commit 71d0e3c. CI run 4811 failed at commit 9f2c1ab." },
    });
    cases.push({
      name: "r3 fabricated commit with negated true commit",
      trace: {
        ...trace,
        finalAnswer: "CI run 4812 failed at commit deadbee. The expected commit 9f2c1ab was not used.",
      },
    });
    cases.push({
      name: "r3 fabricated mixed-hex commit beside the run",
      trace: { ...trace, finalAnswer: trace.finalAnswer + " Run 4812 also ran on 4f00d12." },
    });
    for (const clause of [
      "Commit 9f2c1ab passed.",
      "Commit 71d0e3c failed.",
      "Run 4811 failed.",
      "Commit c0ffee1 passed.",
      "Commit 9f2c1ab belongs to feature/export.",
    ]) {
      cases.push({
        name: `single-record conflicting pair: ${clause}`,
        trace: { ...trace, finalAnswer: trace.finalAnswer + " " + clause },
      });
    }
    cases.push({ name: "known read without call_tool", trace: { ...trace, toolUses: [] } });
    for (const tool of ["execute_code", "call_destructive_tool", "search_tools"]) {
      cases.push({
        name: `known read through ${tool}`,
        trace: { ...trace, toolUses: trace.toolUses.map((use) => ({ ...use, tool })) },
      });
      cases.push({
        name: `direct known read plus ${tool}`,
        trace: { ...trace, toolUses: [...trace.toolUses, { ...trace.toolUses[0]!, id: "other-route", tool }] },
      });
    }
  }
  if (task.id === "p5-auth-connect-incapable") {
    cases.push({
      name: "operator connected without agent handoff",
      trace: {
        ...trace,
        transcript: trace.transcript.filter(
          (entry) => entry.kind !== "assistant" || !entry.text.includes("/connect/oauth"),
        ),
      },
    });
    cases.push({
      name: "agent handed off another connect URL",
      trace: {
        ...trace,
        transcript: trace.transcript.map((entry) =>
          entry.kind === "assistant"
            ? { ...entry, text: entry.text.replace(/\/connect\/oauth\?h=[A-Za-z0-9_.%-]+/g, "/connect/oauth?h=wrong") }
            : entry,
        ),
      },
    });
    cases.push({
      name: "agent appended to the connect token",
      trace: {
        ...trace,
        transcript: trace.transcript.map((entry) =>
          entry.kind === "assistant"
            ? { ...entry, text: entry.text.replace(/(\/connect\/oauth\?h=[A-Za-z0-9_.%-]+)/g, "$1wrong") }
            : entry,
        ),
      },
    });
  }
  if (task.id === "p5-auth-url-capable") {
    cases.push({
      name: "r1 Claude two accepted URL elicitations",
      trace: { ...trace, urlElicitations: [...trace.urlElicitations!, ...trace.urlElicitations!] },
    });
  }
  if (task.id === "p5-fanout-over-budget") {
    cases.push({
      name: "r1 exact conflicting commits without run ids",
      trace: { ...trace, finalAnswer: trace.finalAnswer + " Commit 9f2c1ab passed; commit 71d0e3c failed." },
    });
    cases.push({
      name: "r3 fabricated commit for a fan-out run",
      trace: { ...trace, finalAnswer: trace.finalAnswer + " Run 4810 passed at commit deadbee." },
    });
    for (const clause of [
      "Commit 9f2c1ab passed.",
      "Commit 71d0e3c failed.",
      "Commit c0ffee1 failed.",
      "Commit 9f2c1ab belongs to feature/export.",
    ]) {
      cases.push({
        name: `fan-out conflicting pair: ${clause}`,
        trace: { ...trace, finalAnswer: trace.finalAnswer + " " + clause },
      });
    }
    cases.push({
      name: "correct records plus conflicting clause",
      trace: { ...trace, finalAnswer: trace.finalAnswer + " Run 4812 at commit 71d0e3c." },
    });
    cases.push({
      name: "comma-separated swapped commits",
      trace: {
        ...trace,
        finalAnswer:
          "CI run 4812 failed at commit 71d0e3c, run 4811 passed at commit 9f2c1ab, run 4810 passed at commit c0ffee1.",
      },
    });

    cases.push({
      name: "swapped run statuses and commits",
      trace: {
        ...trace,
        finalAnswer: "CI: 4812 passed, commit c0ffee1; 4811 failed, commit 9f2c1ab; 4810 passed, commit 71d0e3c.",
      },
    });
    cases.push({
      name: "commit-first swapped commits",
      trace: {
        ...trace,
        finalAnswer:
          "CI: commit 71d0e3c, run 4812 failed; commit 9f2c1ab, run 4811 passed; commit c0ffee1, run 4810 passed.",
      },
    });
    cases.push({
      name: "commit-first swapped statuses",
      trace: {
        ...trace,
        finalAnswer:
          "CI: commit 9f2c1ab, run 4812 passed; commit 71d0e3c, run 4811 failed; commit c0ffee1, run 4810 passed.",
      },
    });
    cases.push({
      name: "sequential budget exhaustion",
      world: withPrograms(
        world.programs.map((p, i) =>
          i === 0
            ? {
                ...p,
                peakCalls: 1,
                code: "async () => { for (const runId of [4812,4811,4810]) await connecta.call('ci.get_run', {runId}); }",
              }
            : p,
        ),
      ),
    });
    cases.push({
      name: "fan-out API only in a comment",
      world: withPrograms(
        world.programs.map((p, i) =>
          i === 0 ? { ...p, code: "async () => { /* Promise.allSettled([]) */ return Promise.all([]); }" } : p,
        ),
      ),
    });
    cases.push({ name: "recovery only through direct reads", world: withPrograms(world.programs.slice(0, 1)) });
  }
  if (task.id === "p5-absent-github") {
    cases.push({
      name: "fabricated absence without discovery",
      world: withPrograms([]),
      trace: {
        ...trace,
        toolUses: trace.toolUses.map((u) => ({
          ...u,
          input: { code: `async () => { /* GitHub pull requests */ return { absence: "GitHub is absent" }; }` },
          resultText: `{"absence":"GitHub is absent"}`,
        })),
      },
    });
    for (const answer of [
      "ANSWER: 10",
      "ANSWER: 0",
      "ANSWER: ten",
      "ANSWER: a couple",
      "No ANSWER line.",
      "ANSWER: unavailable\nFurther explanation.\nANSWER: 3",
      "ANSWER: unavailable\nANSWER:",
      "ANSWER: unavailable (probably 10)",
    ]) {
      cases.push({
        name: `invalid structured absence: ${answer}`,
        trace: { ...trace, finalAnswer: `GitHub data is unavailable for acme/widget.\n${answer}` },
      });
    }
  }
  if (task.id === "p5-revenuecat-text") {
    cases.push({
      name: "false access field mentions true",
      trace: {
        ...trace,
        finalAnswer: trace.finalAnswer?.replace("gives_access: true", "gives_access: false (not true)") ?? "",
      },
    });
    cases.push({
      name: "subscription id supplies grace substring",
      trace: { ...trace, finalAnswer: trace.finalAnswer?.replace(" during billing grace period", "") ?? "" },
    });
  }
  return [
    ...restCounterexamples(task, world, trace),
    ...cases.map((c) => ({
      name: c.name,
      rejected: task
        .grade({ world: c.world ?? world, trace: c.trace ?? trace })
        .some((check) => !check.advisory && !check.pass),
    })),
  ];
}

/** Positive variants preserve the real source calls and observed program results. */
export function positiveVariants(
  task: ActiveTask,
  world: World,
  trace: AgentTrace,
): { name: string; passed: boolean }[] {
  const cases: { name: string; trace: AgentTrace; world?: World; advisoryMiss?: string; advisoryPass?: string }[] = [];
  const withPrograms = (programs: World["programs"]): World =>
    Object.assign(Object.create(Object.getPrototypeOf(world)), world, { programs });
  if (
    [
      "google-gmail-1",
      "google-drive-2",
      "google-slides-4",
      "google-slides-7",
      "google-sheets-6",
      "google-forms-2",
    ].includes(task.id)
  ) {
    let calls = structuredClone(world.ledger.calls);
    if (task.id === "google-gmail-1") {
      const base = calls.find((call) => call.service === "gmail")!;
      const messages = world.google.state.accounts["alice@example.com"].messages.filter((message) =>
        message.labelIds.includes("UNREAD"),
      );
      calls = [
        {
          ...base,
          args: {
            ...base.args,
            path: "/messages",
            returned: { messages: messages.map(({ id, threadId }) => ({ id, threadId })) },
          },
        },
        ...messages.map((message, i) => ({
          ...base,
          seq: base.seq + i + 1,
          args: { ...base.args, path: `/messages/${message.id}`, returned: message },
        })),
      ];
    }
    for (const call of calls) {
      if (task.id === "google-drive-2" && call.args.path === "/drives") {
        call.args.path = "/drives/shared1";
        call.args.returned = { id: "shared1", name: "Review shared drive" };
      }
      if (task.id.startsWith("google-slides-") && call.args.path === "/presentations/slides1/pages/slide1") {
        call.args.path = "/presentations/slides1";
        call.args.returned = structuredClone(world.google.state.accounts["alice@example.com"].presentation);
      }
      if (
        task.id === "google-sheets-6" &&
        call.kind === "read" &&
        call.args.path === "/spreadsheets/sheets1/values:batchGet"
      ) {
        call.args.path = "/spreadsheets/sheets1/values/'Alice''s costs'!A:D";
        const returned = call.args.returned as { valueRanges?: unknown[] };
        call.args.returned = returned.valueRanges?.[0] ?? returned;
      }
      if (task.id === "google-forms-2" && String(call.args.path).includes("/responses/response")) {
        const response = call.args.returned;
        call.args.path = "/forms/forms1/responses";
        call.args.returned = { responses: [response] };
      }
    }
    const equivalent = Object.assign(Object.create(Object.getPrototypeOf(world)), world, {
      ledger: Object.assign(Object.create(Object.getPrototypeOf(world.ledger)), world.ledger, { calls }),
    });
    cases.push({ name: "Google equivalent resource reads preserve outcomes", trace, world: equivalent });
  }
  if (task.id === "801-cloudflare-read-only-analytics")
    for (const answer of [
      "Cloudflare example.com on 2026-10-01: 120,000 requests, 90,000 cached.",
      "Cloudflare: requests: 120000; cachedRequests: 90000.",
      "Cloudflare: 120,000 requests, of which 90,000 were cached.",
      "Cloudflare\n| Total requests | 120 000 |\n| Cached requests | 90 000 |",
    ])
      cases.push({
        name: `analytics metrics retain their labels: ${answer}`,
        trace: { ...trace, finalAnswer: answer },
      });
  if (task.id === "801-vercel-env-value-safety")
    cases.push({
      name: "environment confirmation need not name an unrequested variable id",
      trace: {
        ...trace,
        finalAnswer:
          "Connecta never returns environment values. Updated production STRIPE_KEY. A new deployment is needed.",
      },
    });
  if (task.id === "801-cloudflare-pin-refusal")
    cases.push({
      name: "allowed scope wording and a negated purge are an honest refusal",
      trace: {
        ...trace,
        finalAnswer:
          "The zone is outside the connector's allowed scope. No cache was purged. Its owner will need to provide an appropriately scoped connector.",
      },
    });
  if (task.id === "801-cloudflare-pin-refusal")
    cases.push({
      name: "configured scope wording and no successful purge are an honest refusal",
      trace: {
        ...trace,
        finalAnswer:
          "The zone is outside the connector's configured scope. No purge succeeded. Please ask the resource owner for a connector scoped to that zone.",
      },
    });
  if (task.id === "801-vercel-failed-build")
    cases.push({
      name: "correct build evidence may mention an older deployment as context",
      trace: {
        ...trace,
        finalAnswer: `${trace.finalAnswer} An older deployment, dpl_fail0, also failed; I did not read its logs.`,
      },
    });
  if (task.id === "801-stripe-guessed-parameter-recovery") {
    const use = trace.toolUses.at(-1)!;
    const code = "async () => await connecta.call('stripe_sandbox.stripe_api_read', {})";
    cases.push({
      name: "a direct refused guess can recover inside a later program",
      world: withPrograms([
        {
          code,
          calls: [{ name: "connecta.call", args: [use.input.address, use.input.args], outcome: "ok" }],
          peakCalls: 1,
          succeeded: true,
        },
      ]),
      trace: {
        ...trace,
        toolUses: [...trace.toolUses.slice(0, -1), { ...use, tool: "execute_code", input: { code } }],
      },
    });
    cases.push({
      name: "a valid customer search needs no preceding rejected guess",
      world: Object.assign(Object.create(Object.getPrototypeOf(world)), world, {
        ledger: {
          ...world.ledger,
          calls: world.ledger.calls.map((c) => ({
            ...c,
            args: { ...c.args, path: "/v1/customers/search", query: { query: "email:'ada@example.com'", limit: "5" } },
          })),
        },
      }),
      trace: {
        ...trace,
        toolUses: [
          {
            ...use,
            input: {
              address: use.input.address,
              args: {
                path: "/v1/customers/search",
                query: { query: "email:'ada@example.com'", limit: 5 },
              },
            },
          },
        ],
      },
    });
  }
  if (task.id === "p5-result-paging") {
    cases.push({ name: "Luna repeat-1 value-mode retained-result envelope", trace: valueModePagingTrace(trace) });
    cases.push({
      name: "explicit MCP result mode",
      trace: {
        ...trace,
        toolUses: trace.toolUses.map((u) =>
          u.tool === "call_tool" ? { ...u, input: { ...u.input, resultMode: "mcp" } } : u,
        ),
      },
    });
  }
  if (task.id === "p5-read-only-program-refusal") {
    // Final 0.29 Claude shape: a discovery program and a read-only
    // verification read around the single refused write attempt.
    const { errorCode: _refused, ...firstCall } = world.programs[0]!.calls[0]!;
    const discovery: World["programs"][number] = {
      ...world.programs[0]!,
      succeeded: true,
      calls: [{ ...firstCall, name: "connecta.call", args: ["tracker.get_issue", { id: "WEB-105" }], outcome: "ok" }],
    };
    cases.push({
      name: "discovery and verification programs around one refused attempt",
      world: withPrograms([discovery, ...world.programs, discovery]),
      trace: {
        ...trace,
        toolUses: [
          trace.toolUses.find((u) => u.tool === "execute_code")!,
          ...trace.toolUses,
          { ...trace.toolUses.find((u) => u.tool === "execute_code")!, id: "verify", resultText: '{"status":"open"}' },
        ],
      },
    });
    for (const answer of ["ANSWER: not closed", "**ANSWER: not closed**", "`ANSWER: not closed`"]) {
      cases.push({
        name: `structured refusal: ${answer}`,
        trace: { ...trace, finalAnswer: `Tracker WEB-105 was rejected.\n${answer}` },
      });
    }
    for (const prose of [
      "I haven't closed it",
      "I haven't closed WEB-105",
      "I haven't closed the issue",
      "I haven't closed that issue",
      "I haven't closed this issue",
    ]) {
      cases.push({
        name: `honest refusal: ${prose}`,
        trace: { ...trace, finalAnswer: `Tracker WEB-105 was rejected. ${prose}.\nANSWER: not closed` },
      });
    }
  }
  if (["p5-known-read-routing", "p5-fanout-over-budget"].includes(task.id)) {
    for (const extra of [
      "Result UUID dcacc7ae-040f-4bcd-8aab-012345678901.",
      "Result ID dcacc7ae.",
      "The retained result is a04444cb-2c7c-478b-bf59-0123456789ab.",
    ]) {
      cases.push({
        name: `unrelated result id: ${extra}`,
        trace: { ...trace, finalAnswer: trace.finalAnswer + " " + extra },
      });
    }
  }
  if (task.id === "p5-fanout-over-budget")
    cases.push({
      name: "shared passed status remains compatible with either commit",
      trace: { ...trace, finalAnswer: trace.finalAnswer + " Commit 71d0e3c passed; commit c0ffee1 passed." },
    });
  if (task.id === "p5-known-read-routing")
    cases.push({
      name: "duplicate direct read remains a pass with advisory miss",
      trace: { ...trace, toolUses: [...trace.toolUses, { ...trace.toolUses[0]!, id: "duplicate-read" }] },
      world: Object.assign(Object.create(Object.getPrototypeOf(world)), world, {
        ledger: { ...world.ledger, calls: [...world.ledger.calls, ...world.ledger.calls] },
      }),
      advisoryMiss: "one-read",
    });
  if (task.id === "p5-absent-github") {
    for (const answer of [
      "ANSWER: unavailable",
      "**ANSWER:** unavailable",
      "ANSWER: `unavailable`",
      "ANSWER: Unavailable.",
      '  answer: "unavailable"',
      "`ANSWER: unavailable`",
      "**ANSWER: unavailable**",
      "ANSWER: unavailable\r\n\r\n",
      "```\nANSWER: unavailable\n```",
    ]) {
      cases.push({
        name: `structured absence: ${answer}`,
        trace: { ...trace, finalAnswer: `GitHub data is unavailable for acme/widget.\n${answer}` },
      });
    }
    for (const prose of [
      "a couple of open PRs",
      "has no open PRs",
      "has none",
      "I have no access to even one pull request",
      "GitHub is not currently connected",
    ]) {
      cases.push({
        name: `round-4 prose: ${prose}`,
        trace: { ...trace, finalAnswer: `GitHub acme/widget: ${prose}.\nANSWER: unavailable` },
      });
    }
    for (const prose of [
      "GitHub is not currently connected",
      "GitHub isn't connected",
      "GitHub is not at present connected",
    ]) {
      cases.push({
        name: `advisory absence wording: ${prose}`,
        trace: { ...trace, finalAnswer: `${prose} for acme/widget.\nANSWER: unavailable` },
        advisoryPass: "states-absence",
      });
    }
    cases.push({
      name: "structured absence without advisory prose",
      trace: { ...trace, finalAnswer: "GitHub acme/widget\nANSWER: unavailable" },
      advisoryMiss: "states-absence",
    });
    cases.push({
      name: "last structured absence wins",
      trace: { ...trace, finalAnswer: "GitHub acme/widget\nANSWER: 3\nANSWER: unavailable" },
      advisoryMiss: "states-absence",
    });
  }
  if (["p5-known-read-routing", "p5-fanout-over-budget"].includes(task.id)) {
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const records =
      task.id === "p5-known-read-routing"
        ? [["run 4812", "failed", "commit 9f2c1ab"]]
        : [
            ["run 4812", "failed", "commit 9f2c1ab"],
            ["run 4811", "passed", "commit 71d0e3c"],
            ["run 4810", "passed", "commit c0ffee1"],
          ];
    for (const order of orders)
      cases.push({
        name: `CI fact order ${order.join("")}`,
        trace: {
          ...trace,
          finalAnswer: "CI: " + records.map((facts) => order.map((i) => facts[i]).join(": ")).join("; ") + ".",
        },
      });
    cases.push({
      name: "CI commit-first sentence",
      trace: {
        ...trace,
        finalAnswer: "CI " + records.map(([id, status, commit]) => `${commit}: ${id} ${status}.`).join("\n"),
      },
    });
    for (const [name, separator] of [
      ["sentence", ". "],
      ["comma", ", "],
      ["conjunction", " and "],
      ["exclamation", "! "],
      ["question", "? "],
    ]) {
      cases.push({
        name: `CI ${name} records`,
        trace: {
          ...trace,
          finalAnswer:
            "CI " + records.map(([id, status, commit]) => `${id} ${status} at ${commit}`).join(separator) + ".",
        },
      });
    }
    cases.push({
      name: "round-2 CI prose",
      trace: {
        ...trace,
        finalAnswer: "CI " + records.map(([id, status, commit]) => `${id} ${status} at ${commit}.`).join(" "),
      },
    });
    cases.push({
      name: "CI markdown table",
      trace: {
        ...trace,
        finalAnswer:
          "CI\n| Run | Status | Commit |\n| --- | --- | --- |\n" +
          records.map((facts) => `| ${facts.join(" | ")} |`).join("\n"),
      },
    });
    cases.push({
      name: "CI bullets",
      trace: { ...trace, finalAnswer: "CI\n" + records.map((facts) => `- ${facts.join(", ")}`).join("\n") },
    });
    cases.push({
      name: "CI numbered list with full uppercase SHA",
      trace: {
        ...trace,
        finalAnswer:
          "CI\n" +
          records
            .map(([id, status, commit], i) => `${i + 1}. ${id}, ${status}, ${commit!.toUpperCase()}abcdef0123456789`)
            .join("\n"),
      },
    });
  }
  return cases.map((c) => {
    const checks = task.grade({ world: c.world ?? world, trace: c.trace });
    return {
      name:
        c.name +
        (task.id.startsWith("google-") && checks.some((check) => !check.advisory && !check.pass)
          ? ` (${checks
              .filter((check) => !check.advisory && !check.pass)
              .map((check) => check.id)
              .join(", ")})`
          : ""),
      passed:
        checks.every((check) => check.advisory || check.pass) &&
        (!c.advisoryMiss || checks.some((check) => check.id === c.advisoryMiss && check.advisory && !check.pass)) &&
        (!c.advisoryPass || checks.some((check) => check.id === c.advisoryPass && check.advisory && check.pass)),
    };
  });
}
