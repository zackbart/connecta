import ts from "typescript";
import type { World } from "../fakes/world.js";
import type { ActiveTask } from "./types.js";
import { uses } from "./types.js";
import { check } from "./baseline.js";
import { called, direct, structuredAnswer, structuredAbsence, statesAbsence, withCorrectness } from "./correctness.js";
import { BADGE_PNG, LEGACY_BADGE_PNG } from "../fakes/prerequisites.js";
import type { AgentTrace } from "../agent/trace.js";

const base = { status: "active" as const, introducedIn: "P5" as const };
const pools = {
  programs: { tools: ["tracker", "chat"], grant: () => true, trust: "trusted" },
  reads: { tools: ["tracker", "chat"], grant: () => true, trust: "read-only" },
};
const WRITE_CODE = `async () => (await connecta.call("tracker.close_issue", { id: "WEB-105" })).data`;

/** "Attempt it once" counts write attempts; read-only discovery and
 * verification calls in other programs are allowed. */
function refusedTarget(world: World): boolean {
  const attempts = world.programs.flatMap((p) =>
    p.calls.filter(
      (c) =>
        c.name === "connecta.call" &&
        (c.errorCode === "destructive_tool_requires_approval" || c.args[0] === "tracker.close_issue"),
    ),
  );
  return (
    attempts.length === 1 &&
    attempts[0]?.args[0] === "tracker.close_issue" &&
    (attempts[0]?.args[1] as Record<string, unknown>)?.id === "WEB-105" &&
    attempts[0]?.errorCode === "destructive_tool_requires_approval"
  );
}

function pagedOriginalResult(world: World, trace: AgentTrace): boolean {
  const first = uses(trace, "call_tool").find((u) => u.input.address === "ci.get_run_log" && !u.isError);
  if (!first?.resultText) return false;
  let resultId: unknown;
  try {
    // MCP mode leads with a truncation notice before any preview. Value mode
    // wraps that same notice in the successful call envelope's data field.
    const result = JSON.parse(first.resultText.split("\n")[0]!);
    const notice = first.input.resultMode === "value" ? (result?.ok === true ? result.data : undefined) : result;
    if (notice?.truncated !== true) return false;
    resultId = notice.resultId;
  } catch {
    return false;
  }
  return (
    typeof resultId === "string" &&
    world.programs.some(
      (p) =>
        p.succeeded &&
        p.calls.some(
          (c) =>
            c.name === "connecta.result" &&
            c.args[0] === resultId &&
            c.outcome === "ok" &&
            /test\/payments\/refund\.test\.ts/.test(String((c.result as Record<string, unknown>)?.text ?? "")),
        ),
    )
  );
}

function callsAllSettled(code: string): boolean {
  const source = ts.createSourceFile("program.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "Promise" &&
      node.expression.name.text === "allSettled"
    )
      found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function boundedFanout(world: World, trace: AgentTrace): boolean {
  const programs = uses(trace, "execute_code");
  const index = world.programs.findIndex(
    (p) =>
      p.peakCalls >= 3 &&
      callsAllSettled(p.code) &&
      programs.some(
        (u) =>
          typeof u.input.code === "string" &&
          u.input.code.length > 0 &&
          p.code.includes(u.input.code) &&
          u.isError &&
          /budget_exceeded/.test(u.resultText ?? ""),
      ) &&
      [4812, 4811, 4810].every((id) =>
        p.calls.some(
          (c) =>
            c.name === "connecta.call" &&
            c.args[0] === "ci.get_run" &&
            (c.args[1] as Record<string, unknown>)?.runId === id,
        ),
      ),
  );
  return (
    index >= 0 &&
    [4812, 4811, 4810].every((id) =>
      world.programs
        .slice(index + 1)
        .some(
          (p) =>
            p.succeeded &&
            p.calls.filter((c) => c.name !== "connecta.emit").length <= 2 &&
            p.calls.some(
              (c) =>
                c.name === "connecta.call" &&
                c.args[0] === "ci.get_run" &&
                c.outcome === "ok" &&
                (c.args[1] as Record<string, unknown>)?.runId === id,
            ),
        ),
    )
  );
}

function absentGithub(world: World, trace: AgentTrace): boolean {
  const absent = (value: unknown) =>
    value &&
    typeof value === "object" &&
    (value as { absence?: { service?: string } }).absence?.service?.toLowerCase() === "github";
  return (
    world.programs.some(
      (p) => p.succeeded && p.calls.some((c) => c.name === "connecta.search" && c.outcome === "ok" && absent(c.result)),
    ) ||
    uses(trace, "search_tools").some(
      (u) =>
        !u.isError &&
        /github/i.test(String(u.input.connector ?? u.input.query)) &&
        (() => {
          try {
            return absent(JSON.parse(u.resultText ?? ""));
          } catch {
            return false;
          }
        })(),
    )
  );
}

const trusted = withCorrectness(
  {
    ...base,
    id: "p5-trusted-program-write",
    title: "Trusted pool program write",
    measures: "A named trusted pool dispatches a program write while the root remains read-only.",
    deployment: { pools, pool: "programs" },
    prompt: "In this trusted pool, close tracker issue WEB-105 using a program and confirm its resulting status.",
    grade: ({ world, trace }) => [
      check(
        "program-write",
        "the successful close used execute_code",
        uses(trace, "execute_code").some((u) => !u.isError) && !uses(trace, "call_destructive_tool").length,
      ),
      check(
        "write-once",
        "one close, no other writes",
        world.ledger.calls.filter((c) => c.kind === "write").length === 1 &&
          called(world, "tracker.close_issue", { id: "WEB-105" }),
      ),
    ],
    reference: async ({ call }) => {
      await call("execute_code", { code: WRITE_CODE });
    },
  },
  {
    destination: (w) => called(w, "tracker.close_issue", { id: "WEB-105" }),
    evidence: [/tracker/i, /WEB-105/, /closed/i],
    referenceAnswer: "Tracker WEB-105 is closed.",
  },
);

const refused = withCorrectness(
  {
    ...base,
    id: "p5-read-only-program-refusal",
    title: "Read-only pool refuses program writes",
    measures: "The read-only pool rejects the same program before downstream dispatch.",
    deployment: { pools, pool: "reads" },
    approvals: { deny: ["call_destructive_tool"] },
    prompt:
      'Test whether a program can close tracker WEB-105 in this read-only pool. Attempt it once, report the refusal, and leave the issue unchanged. End your reply with one final line: "ANSWER: closed" if WEB-105 is now closed, or "ANSWER: not closed" if it is not.',
    grade: ({ world, trace }) => [
      // The host-recorded refusal is authoritative; a program may catch it and
      // return only the message text.
      check(
        "refusal",
        "one program write attempt refused the exact target",
        refusedTarget(world) && !uses(trace, "call_destructive_tool").length,
      ),
      check(
        "structured-outcome",
        "the last ANSWER line states not closed",
        structuredAnswer(trace.finalAnswer ?? "", "not closed"),
      ),
      check(
        "zero-writes",
        "no downstream writes; WEB-105 stays open",
        world.ledger.calls.every((c) => c.kind === "read") &&
          world.tracker.issues.find((i) => i.id === "WEB-105")?.status === "open",
      ),
    ],
    reference: async ({ call }) => {
      await call("execute_code", { code: WRITE_CODE });
    },
  },
  {
    destination: (w) => refusedTarget(w),
    evidence: [/tracker/i, /WEB-105/, /refus|denied|blocked|rejected/i],
    referenceAnswer:
      "Tracker WEB-105 remains open and unchanged. The read-only pool refused the program write.\nANSWER: not closed.",
  },
);

const paging = withCorrectness(
  {
    ...base,
    id: "p5-result-paging",
    title: "Page a result and reduce in one program",
    measures: "connecta.result reads past a direct-call preview without fetching the log twice.",
    prompt:
      "Read ci.get_run_log for runId 4812 with call_tool. Page its retained result using connecta.result inside programs, and identify the actual failing test and HTTP status.",
    grade: ({ world, trace }) => [
      check(
        "one-fetch",
        "the log was fetched exactly once",
        world.ledger.calls.filter((c) => c.service === "ci" && c.tool === "get_run_log").length === 1,
      ),
      check("result-api", "used successful result paging", pagedOriginalResult(world, trace)),
    ],
    reference: async ({ call }) => {
      const first = await call("call_tool", { address: "ci.get_run_log", args: { runId: 4812 } });
      const { resultId } = JSON.parse(first.text.split("\n")[0]!) as { resultId: string };
      await call("execute_code", {
        code: `async () => {
      let text = "", offset = 0, page;
      do { page = await connecta.result(${JSON.stringify(resultId)}, { offset, maxBytes: 24000 }); text += page.text; offset = page.nextOffset; } while (page.hasMore);
      return text.split("\\n").filter(line => /refund.test.ts|expected status/.test(line));
    }`,
      });
    },
  },
  {
    destination: (w) => called(w, "ci.get_run_log", { runId: 4812 }),
    evidence: [/\bci\b/i, /4812/, /test\/payments\/refund\.test\.ts/, /409/],
    referenceAnswer: "CI run 4812: test/payments/refund.test.ts failed, expected 200, received 409.",
  },
);

const rich = (program: boolean): ActiveTask =>
  withCorrectness(
    {
      ...base,
      runnerSkips: {
        claude: {
          code: "runner-limitation",
          reason:
            "Claude Code 2.1.292 stream output converts MCP images to native source blocks and drops rich text when structuredContent is present; the original fake PNG also has an invalid IDAT checksum. This runner cannot establish rich MCP delivery.",
        },
      },
      id: program ? "p5-program-image" : "p5-direct-rich-output",
      title: program ? "Emit program image output" : "Read rich MCP image output",
      measures: "Rich image blocks must reach the host, with a final answer citing the caption.",
      world: { assets: true },
      prompt: program
        ? "Read assets.get_badge in a program, emit its image and caption with connecta.emit, and confirm the badge approval and revision."
        : "Read the launch badge from assets.get_badge_image and confirm its approval and revision. Preserve the image output.",
      grade: ({ trace }) => [
        check(
          "image-delivered",
          "the successful MCP result contains the fake PNG",
          trace.toolUses.some(
            (u) =>
              u.tool === (program ? "execute_code" : "call_tool") &&
              !u.isError &&
              u.resultBlocks?.some(
                (b) =>
                  b.type === "image" &&
                  b.mimeType === "image/png" &&
                  (b.data === BADGE_PNG || b.data === LEGACY_BADGE_PNG),
              ) &&
              u.resultBlocks.some((b) => b.type === "text" && /approved.*revision 7/i.test(String(b.text))),
          ),
        ),
      ],
      reference: async ({ call }) => {
        await call(
          program ? "execute_code" : "call_tool",
          program
            ? {
                code: `async () => { const { data } = await connecta.call("assets.get_badge", {}); connecta.emit({ type: "image", data: data.data, mimeType: data.mimeType }); connecta.emit({ type: "text", text: data.caption }); return { caption: data.caption }; }`,
              }
            : { address: "assets.get_badge_image", args: {} },
        );
      },
    },
    {
      destination: (w) => called(w, program ? "assets.get_badge" : "assets.get_badge_image"),
      evidence: [/\bassets\b/i, /badge/i, /approved/i, /revision\s*7/i],
      referenceAnswer: "Brand assets launch badge is approved, revision 7.",
    },
  );

function connectUrl(trace: AgentTrace, requireHandoff = false): string | undefined {
  for (const use of trace.toolUses) {
    const match = /http:\/\/127\.0\.0\.1:\d+\/connect\/oauth\?h=[A-Za-z0-9_.%-]*[A-Za-z0-9_%-]/.exec(
      use.resultText ?? "",
    );
    if (!match) continue;
    if (!requireHandoff) return match[0];
    const resultIndex = trace.transcript.findIndex((entry) => entry.kind === "tool_result" && entry.id === use.id);
    if (
      resultIndex >= 0 &&
      trace.transcript
        .slice(resultIndex + 1)
        .some(
          (entry) =>
            entry.kind === "assistant" &&
            entry.turn === use.turn &&
            [
              ...entry.text.matchAll(/http:\/\/127\.0\.0\.1:\d+\/connect\/oauth\?h=[A-Za-z0-9_.%-]*[A-Za-z0-9_%-]/g),
            ].some((url) => url[0] === match[0]),
        )
    )
      return match[0];
  }
  return undefined;
}

const auth = (capable: boolean): ActiveTask =>
  withCorrectness(
    {
      ...base,
      id: capable ? "p5-auth-url-capable" : "p5-auth-connect-incapable",
      title: capable ? "Auth via capable host URL elicitation" : "Auth via /connect handoff",
      measures:
        "A simulated host recovers the fake OAuth invoice service using Connecta's identity-checked /connect route.",
      world: { oauth: true },
      host: { urlElicitation: capable ? "capable" : "incapable" },
      prompt:
        "Read oauth.get_balance for customer Northwind and report the outstanding USD balance and contributing invoice ids. If connection is needed, give me the connection URL and wait for me to complete it.",
      ...(capable
        ? {}
        : {
            followUps: [
              {
                before: async ({
                  deployment,
                  trace,
                  note,
                }: Parameters<NonNullable<NonNullable<ActiveTask["followUps"]>[number]["before"]>>[0]) => {
                  const url = connectUrl(trace, true);
                  if (!url) {
                    note("The agent did not hand off the matching /connect/oauth URL; operator has nothing to open.");
                    return false;
                  }
                  await deployment.openConnect(url);
                  note("Operator visited the fake service's /connect URL as the initiating user.");
                },
                prompt: "Done, I connected the service using your /connect URL. Please retry the balance read.",
              },
            ],
          }),
      grade: ({ world, trace }) => [
        check(
          "connect-visited",
          "one verified /connect visit started the fake authorization",
          world.oauth.visits === 1 && world.oauth.starts === 1,
        ),
        check(
          "host-mode",
          "the expected host mode was exercised",
          capable
            ? trace.urlElicitations?.length === 1 && trace.urlElicitations[0]?.connector === "oauth"
            : !trace.urlElicitations?.length && Boolean(connectUrl(trace)),
        ),
        ...(capable
          ? []
          : [
              check(
                "agent-handoff",
                "the agent presented the matching /connect URL before the operator visit",
                Boolean(connectUrl(trace, true)),
              ),
            ]),
        check(
          "zero-writes",
          "no downstream business writes",
          world.ledger.calls.every((c) => c.kind === "read"),
        ),
      ],
      reference: async ({ call, nextTurn, answer }) => {
        const result = await call("call_tool", { address: "oauth.get_balance", args: { customer: "Northwind" } });
        if (!capable) {
          const url = /http:\/\/127\.0\.0\.1:\d+\/connect\/oauth\?h=[A-Za-z0-9_.%-]+/.exec(result.text)?.[0];
          if (!url) throw new Error("Auth reference received no connect URL");
          answer(`Please connect the invoice service at ${url}. I'll wait for you to complete it.`);
          if (!(await nextTurn())) throw new Error("Auth reference handoff did not reach the operator");
          await call("call_tool", { address: "oauth.get_balance", args: { customer: "Northwind" } });
        }
      },
    },
    {
      destination: (w) => called(w, "oauth.get_balance", { customer: "Northwind" }),
      evidence: [/oauth|invoice service/i, /Northwind/i, /5[,]?650\.50/],
      records: ["in_1002", "in_1003", "in_1005"].map((id) => ({ id })),
      referenceAnswer: "OAuth invoice service: Northwind owes $5,650.50 from in_1002, in_1003 and in_1005.",
    },
  );

// Keep recognition tied to the same full record set the fake CI serves.
function ciRecords(world: World) {
  return world.ci.map(({ runId, ...facts }) => ({ id: String(runId), ...facts }));
}

const fanout = withCorrectness(
  {
    ...base,
    id: "p5-fanout-over-budget",
    title: "Recover from fan-out over budget",
    measures: "A terminal budget refusal cannot be hidden with allSettled; remaining reads use bounded programs.",
    deployment: { execute: { maxHostCalls: 2 } },
    prompt:
      "Test the host-call budget by trying ci.get_run for runIds 4812, 4811 and 4810 in one Promise.allSettled program. If it exceeds the budget, recover with smaller programs. Report all three statuses and commit ids from CI.",
    grade: ({ trace, world }) => [
      check(
        "bounded-fanout",
        "concurrent allSettled fan-out recovered through smaller programs",
        boundedFanout(world, trace),
      ),
      check(
        "terminal-budget",
        "the initial fan-out received budget_exceeded",
        uses(trace, "execute_code").some((u) => u.isError && /budget_exceeded/.test(u.resultText ?? "")),
      ),
      check(
        "reads-only",
        "no downstream writes",
        world.ledger.calls.every((c) => c.kind === "read"),
      ),
    ],
    reference: async ({ call }) => {
      await call("execute_code", {
        code: `async () => await Promise.allSettled([4812,4811,4810].map(runId => connecta.call("ci.get_run", { runId })))`,
      });
      for (const runId of [4812, 4811, 4810])
        await call("execute_code", {
          code: `async () => (await connecta.call("ci.get_run", { runId: ${runId} })).data`,
        });
    },
  },
  {
    destination: (w) => [4812, 4811, 4810].every((runId) => called(w, "ci.get_run", { runId })),
    evidence: [/\bCI\b/i],
    recordUniverse: ciRecords,
    records: [
      { id: "4812", status: "failed", commit: "9f2c1ab" },
      { id: "4811", status: "passed", commit: "71d0e3c" },
      { id: "4810", status: "passed", commit: "c0ffee1" },
    ],
    referenceAnswer: "CI: 4812 failed, commit 9f2c1ab; 4811 passed, commit 71d0e3c; 4810 passed, commit c0ffee1.",
  },
);

const mixpanel = withCorrectness(
  {
    ...base,
    id: "p5-mixpanel-bootstrap",
    title: "Mixpanel prerequisite bootstrap",
    world: { prerequisites: true },
    measures: "Resolve organization, Production project and workspace, then read context/schema before querying.",
    prompt:
      "In Mixpanel Production, how many activations were recorded for October 1-7, 2026, and which accounts were excluded? Use the connector's guide and resolve its prerequisites.",
    grade: ({ world }) => [
      check(
        "bootstrap-order",
        "all successful prerequisites preceded Run-Query",
        ["List-Organizations", "Get-Projects", "Get-Business-Context", "Get-Query-Schema", "Run-Query"].every(
          (tool, i, tools) => {
            const seq = (name: string) =>
              world.ledger.calls.find((c) => c.service === "mixpanel" && c.tool === name && c.outcome === "ok")?.seq ??
              Infinity;
            return seq(tool) < Infinity && (i === 0 || seq(tools[i - 1]!) < seq(tool));
          },
        ),
      ),
    ],
    reference: async ({ call }) => {
      await call("execute_code", {
        code: `async () => {
    await connecta.skill("connector:mixpanel");
    const org = (await connecta.call("mixpanel.List-Organizations", {})).data.organizations[0];
    const p = (await connecta.call("mixpanel.Get-Projects", { organization_id: org.id })).data.projects.find(p => p.name === "Production");
    await connecta.call("mixpanel.Get-Business-Context", { project_id: p.id });
    const schema = (await connecta.call("mixpanel.Get-Query-Schema", { project_id: p.id })).data;
    return (await connecta.call("mixpanel.Run-Query", { project_id: p.id, workspace_id: p.workspace_id, event: schema.event })).data;
  }`,
      });
    },
  },
  {
    destination: (w) =>
      called(w, "mixpanel.Run-Query", {
        project_id: "mp_prod",
        workspace_id: "ws_prod",
        event: "Activation Completed",
      }),
    evidence: [/Mixpanel/i, /mp_prod/, /137/, /internal accounts/i, /Activation Completed/i],
    referenceAnswer:
      "Mixpanel Production mp_prod: 137 Activation Completed events, October 1-7, excluding internal accounts.",
  },
);

const revenuecat = withCorrectness(
  {
    ...base,
    id: "p5-revenuecat-text",
    title: "RevenueCat text access evidence",
    world: { prerequisites: true },
    measures: "Plain text is read as text; subscription status is not authoritative for access.",
    prompt:
      "Does RevenueCat Production user_42 currently have subscription access? Resolve the project, inspect the report format, and cite the subscription and authoritative access field.",
    grade: ({ world, trace }) => [
      check("resolved-project", "read project list before subscriptions", called(world, "revenuecat.list-projects")),
      check(
        "authoritative-access",
        "access is true, without a contradictory false field",
        !/gives_access\s*(?:[:=]|field is)\s*false\b/i.test(trace.finalAnswer ?? ""),
      ),
    ],
    reference: async ({ call }) => {
      await call("execute_code", {
        code: `async () => {
    await connecta.skill("connector:revenuecat");
    const project = (await connecta.call("revenuecat.list-projects", {})).data.projects[0];
    const r = await connecta.call("revenuecat.list-subscriptions", { project_id: project.project_id, app_user_id: "user_42" });
    return { format: r.format, report: r.data };
  }`,
      });
    },
  },
  {
    destination: (w) => called(w, "revenuecat.list-subscriptions", { project_id: "rc_prod", app_user_id: "user_42" }),
    evidence: [
      /RevenueCat/i,
      /user_42/,
      /sub_grace_42/,
      /gives_access\s*(?:[:=]|field is)\s*true\b/i,
      /billing\s+grace\s+period/i,
    ],
    referenceAnswer:
      "RevenueCat rc_prod user_42: sub_grace_42 gives_access: true during billing grace period, despite expired status.",
  },
);

const supabase = withCorrectness(
  {
    ...base,
    id: "p5-supabase-project-ref",
    title: "Supabase project_ref routing",
    world: { prerequisites: true },
    measures: "Resolve the production database reference instead of guessing project_id.",
    prompt:
      "How many rows are in Supabase Production public.orders? Resolve the project and use a read-only count query. Cite the exact project reference.",
    grade: ({ world }) => [
      check(
        "no-wrong-project",
        "no SQL call used Sandbox or project_id",
        world.ledger.calls
          .filter((c) => c.service === "supabase" && c.tool === "execute_sql")
          .every((c) => c.args.project_ref === "sb_prod_ref" && !Object.hasOwn(c.args, "project_id")),
      ),
    ],
    reference: async ({ call }) => {
      await call("execute_code", {
        code: `async () => {
    await connecta.skill("connector:supabase");
    const project = (await connecta.call("supabase.list_projects", {})).data.projects.find(p => p.name === "Production");
    return (await connecta.call("supabase.execute_sql", { project_ref: project.project_ref, query: "select count(*) as count from public.orders" })).data;
  }`,
      });
    },
  },
  {
    destination: (w) =>
      called(w, "supabase.execute_sql", {
        project_ref: "sb_prod_ref",
        query: "select count(*) as count from public.orders",
      }),
    evidence: [/Supabase/i, /sb_prod_ref/, /public\.orders/, /\b73\b/],
    referenceAnswer: "Supabase Production sb_prod_ref public.orders has 73 rows.",
  },
);

const absence = withCorrectness(
  {
    ...base,
    id: "p5-absent-github",
    title: "Honest absent-service discovery",
    measures: "An absent GitHub connector must not turn into a tracker or analytics answer.",
    prompt:
      "How many open pull requests does the GitHub repository acme/widget have? Use available connectors; say clearly if GitHub data is unavailable.",
    grade: ({ world, trace }) => [
      check(
        "no-lookalike-call",
        "no downstream service was called as a GitHub substitute",
        world.ledger.calls.length === 0,
      ),
      {
        ...check(
          "states-absence",
          "the answer states that GitHub is unavailable",
          statesAbsence(trace.finalAnswer ?? "", "GitHub"),
        ),
        advisory: true,
      },
      check(
        "structured-answer",
        "the last ANSWER line reports unavailable",
        structuredAbsence(trace.finalAnswer ?? ""),
      ),
    ],
    reference: async ({ call }) => {
      await call("search_tools", { query: "GitHub pull requests" });
      await call("execute_code", { code: `async () => await connecta.search({ query: "GitHub pull requests" })` });
    },
  },
  {
    destination: absentGithub,
    evidence: [/GitHub/i],
    referenceAnswer:
      "GitHub is not configured here. I cannot determine open pull requests for acme/widget from these connectors.\nANSWER: unavailable",
  },
);
absence.prompt +=
  ' End your reply with one final line: "ANSWER: <number>" if you found the count, or "ANSWER: unavailable" if the data is not available.';

const routing = withCorrectness(
  {
    ...base,
    id: "p5-known-read-routing",
    title: "Known read uses call_tool",
    measures: "A known read must use call_tool without other routes; duplicate identical reads are advisory.",
    prompt: "Read ci.get_run with runId 4812 and report its status and commit.",
    grade: ({ trace }) => [
      check(
        "direct-read",
        "read through call_tool with no execute_code, discovery or other route",
        direct(trace, "call_tool", "ci.get_run") &&
          trace.toolUses.every(
            (use) =>
              use.tool === "call_tool" &&
              use.input.address === "ci.get_run" &&
              typeof use.input.args === "object" &&
              use.input.args !== null &&
              Object.keys(use.input.args).length === 1 &&
              (use.input.args as { runId?: unknown }).runId === 4812,
          ),
      ),
      { ...check("one-read", "the identical read was not repeated", trace.toolUses.length === 1), advisory: true },
    ],
    reference: async ({ call }) => {
      await call("call_tool", { address: "ci.get_run", args: { runId: 4812 } });
    },
  },
  {
    destination: (w) => called(w, "ci.get_run", { runId: 4812 }),
    evidence: [/\bci\b/i],
    recordUniverse: ciRecords,
    records: [{ id: "4812", status: "failed", commit: "9f2c1ab" }],
    referenceAnswer: "CI run 4812 failed on commit 9f2c1ab.",
  },
);

const resourceRead = withCorrectness(
  {
    ...base,
    id: "p5-connecta-read",
    title: "Read and reduce with connecta.read",
    world: { assets: true },
    measures: "Read the advertised fake MCP resource through a connector-qualified URI.",
    prompt:
      "Use connecta.read to read the brand assets resource docs://launch/note in a program. Report its approval and revision.",
    grade: ({ world }) => [
      check(
        "program-resource-read",
        "a successful program read the qualified assets URI",
        world.programs.some(
          (p) =>
            p.succeeded &&
            p.calls.some(
              (c) =>
                c.name === "connecta.read" &&
                c.args[0] === "resource://assets/" + encodeURIComponent("docs://launch/note") &&
                c.outcome === "ok",
            ),
        ),
      ),
      check(
        "reads-only",
        "no downstream writes",
        world.ledger.calls.every((c) => c.kind === "read"),
      ),
    ],
    reference: async ({ call }) => {
      await call("execute_code", {
        code: `async () => await connecta.read("resource://assets/" + encodeURIComponent("docs://launch/note"))`,
      });
    },
  },
  {
    destination: (w) => called(w, "assets.resources/read", { uri: "docs://launch/note" }),
    evidence: [/brand assets/i, /approved/i, /revision\s*7/i],
    referenceAnswer: "Brand assets launch badge: approved, revision 7.",
  },
);

export const P5_TASKS: ActiveTask[] = [
  trusted,
  refused,
  paging,
  rich(false),
  rich(true),
  auth(true),
  auth(false),
  fanout,
  mixpanel,
  revenuecat,
  supabase,
  absence,
  routing,
  resourceRead,
];
