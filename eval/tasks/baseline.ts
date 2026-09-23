/**
 * The baseline task set: today's surface, run on main before the rewrite and
 * re-run by every later phase.
 */
import type { World } from "../fakes/world.js";
import type { ActiveTask, Check, ReferenceContext } from "./types.js";
import { uses } from "./types.js";

// ------------------------------------------------------------ grading helpers

function check(id: string, description: string, pass: boolean, detail?: string, advisory?: boolean): Check {
  return {
    id,
    description,
    pass,
    ...(detail !== undefined ? { detail } : {}),
    ...(advisory ? { advisory: true } : {}),
  };
}

const quote = (text: string) => JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text);

/** Exactly one agent post, in `channel`, and none anywhere else. */
function singlePost(world: World, channel: string): { checks: Check[]; text: string } {
  const here = world.posts(channel);
  const elsewhere = world.posts().filter((post) => post.channel !== channel);
  return {
    text: here[0]?.text ?? "",
    checks: [
      check(
        "one-post",
        `exactly one message posted to #${channel}`,
        here.length === 1,
        `${here.length} posted${here.length ? `: ${here.map((post) => quote(post.text)).join(" | ")}` : ""}`,
      ),
      check(
        "no-stray-posts",
        "no messages posted to any other channel",
        elsewhere.length === 0,
        elsewhere.length ? elsewhere.map((post) => `#${post.channel}: ${quote(post.text)}`).join(" | ") : undefined,
      ),
    ],
  };
}

/** No downstream writes except the ones named. */
function onlyWrites(world: World, allowed: string[]): Check {
  const stray = world.ledger.calls.filter(
    (call) => call.kind === "write" && !allowed.includes(`${call.service}.${call.tool}`),
  );
  return check(
    "no-unrequested-writes",
    `no downstream writes other than ${allowed.join(", ")}`,
    stray.length === 0,
    stray.length ? stray.map((call) => `${call.service}.${call.tool}`).join(", ") : undefined,
  );
}

function normalizeMoney(text: string): string {
  return text.replace(/(\d),(?=\d{3})/g, "$1");
}

/**
 * Read a truncated one-block result through: its leading notice line, the
 * preview after it, then `get_result` from the notice's next action to the
 * end — what a careful agent does. A lone text block pages as its text, and
 * the preview is a byte prefix of it, so the pieces concatenate.
 */
async function pageAll(call: ReferenceContext["call"], truncated: string): Promise<string> {
  const newline = truncated.indexOf("\n");
  const notice = JSON.parse(truncated.slice(0, newline)) as {
    nextAction: { arguments: { id: string; offset: number } };
  };
  const { id, offset: from } = notice.nextAction.arguments;
  let text = from > 0 ? truncated.slice(newline + 1) : "";
  let offset: number | undefined = from;
  while (offset !== undefined) {
    // A page is the same shape: a one-line JSON header, then raw text.
    const page = (await call("get_result", { id, offset })).text;
    const lineEnd = page.indexOf("\n");
    const header = JSON.parse(page.slice(0, lineEnd)) as {
      hasMore: boolean;
      nextAction?: { arguments: { offset: number } };
    };
    text += page.slice(lineEnd + 1);
    offset = header.hasMore ? header.nextAction?.arguments.offset : undefined;
  }
  return text;
}

// ------------------------------------------------------------------ the tasks

const crossConnectorJoin: ActiveTask = {
  status: "active",
  id: "cross-connector-join",
  title: "Cross-connector lookup and join",
  introducedIn: "baseline",
  measures:
    "Joining two paged read-only sources (tracker issues by customer domain, analytics accounts and metrics) and writing one answer.",
  prompt:
    "Using the issue tracker and product analytics, find the open bug that affects our highest-paying customer (by MRR). " +
    "Then post exactly one message to the #triage chat channel in the form `<ISSUE-KEY> <customer name> $<MRR>`.",
  grade: ({ world }) => {
    const { checks, text } = singlePost(world, "triage");
    return [
      ...checks,
      check("names-issue", "the post names API-207", /\bAPI-207\b/i.test(text), quote(text)),
      check("names-customer", "the post names Stark Industries", /stark/i.test(text), quote(text)),
      check("states-mrr", "the post states $56,500", /56[,.]?500|56\.5k/i.test(text), quote(text), true),
      onlyWrites(world, ["chat.post_message"]),
    ];
  },
  reference: async ({ call }) => {
    await call("execute_code", {
      code: `async () => {
  const bugs = [];
  let cursor;
  do {
    const page = await connecta.call("tracker.search_issues", { status: "open", label: "bug", limit: 50, ...(cursor ? { cursor } : {}) });
    bugs.push(...page.issues);
    cursor = page.nextCursor;
  } while (cursor);
  const accounts = [];
  let next;
  do {
    const page = await connecta.call("analytics.list_accounts", { limit: 25, ...(next ? { cursor: next } : {}) });
    accounts.push(...page.accounts);
    next = page.nextCursor;
  } while (next);
  const rows = [];
  for (const bug of bugs.filter((issue) => issue.customer)) {
    const account = accounts.find((candidate) => candidate.domain === bug.customer);
    if (!account) continue;
    const metrics = await connecta.call("analytics.get_account_metrics", { accountId: account.id });
    rows.push({ key: bug.id, name: account.name, mrr: metrics.mrrUsd });
  }
  rows.sort((a, b) => b.mrr - a.mrr);
  return rows[0];
}`,
    });
    await call("call_destructive_tool", {
      address: "chat.post_message",
      args: { channel: "triage", text: "API-207 Stark Industries $56,500" },
      reason: "Post the requested triage answer",
    });
  },
};

const STALE = ["WEB-103", "WEB-105", "WEB-107", "WEB-110"];

const staleCloseAndSummarize: ActiveTask = {
  status: "active",
  id: "stale-close-and-summarize",
  title: "Find-then-write: close stale issues, post a summary",
  introducedIn: "baseline",
  measures:
    "Discovering a write set with reads, landing each write exactly once through call_destructive_tool, then one summary write.",
  prompt:
    "Close every open issue in the Web project that has not been updated in more than 30 days. " +
    "Then post one summary message to #eng listing the issue keys you closed.",
  grade: ({ world }) => {
    const closed = world.tracker.issues
      .filter((issue) => issue.closedBy === "agent")
      .map((issue) => issue.id)
      .sort();
    const closeCalls = world.ledger.calls.filter((call) => call.tool === "close_issue");
    const perIssue = new Map<string, number>();
    for (const call of closeCalls) {
      const id = String(call.args.id ?? "").toUpperCase();
      perIssue.set(id, (perIssue.get(id) ?? 0) + 1);
    }
    const repeated = [...perIssue].filter(([, count]) => count > 1);
    const strayWrites = world.ledger.calls.filter(
      (call) =>
        call.kind === "write" &&
        call.service === "tracker" &&
        !(STALE.includes(String(call.args.id ?? "").toUpperCase()) &&
          (call.tool === "close_issue" || call.tool === "add_comment")),
    );
    const { checks, text } = singlePost(world, "eng");
    const mentioned = [...new Set((text.toUpperCase().match(/\b(?:WEB|API|MOB)-\d+\b/g) ?? []))].sort();
    const lastClose = Math.max(0, ...closeCalls.map((call) => call.seq));
    const post = world.ledger.calls.find((call) => call.tool === "post_message" && call.args.channel !== undefined);
    return [
      check("closed-exactly-stale", `closed exactly ${STALE.join(", ")}`, JSON.stringify(closed) === JSON.stringify(STALE), `closed: ${closed.join(", ") || "none"}`),
      check("each-write-once", "every close_issue landed exactly once", repeated.length === 0, repeated.length ? repeated.map(([id, count]) => `${id}×${count}`).join(", ") : undefined),
      check("no-other-tracker-writes", "no tracker writes outside the stale set", strayWrites.length === 0, strayWrites.map((call) => `${call.tool} ${JSON.stringify(call.args)}`).join(", ") || undefined),
      ...checks,
      check("summary-lists-closed", "the summary lists exactly the closed keys", JSON.stringify(mentioned) === JSON.stringify(STALE), `mentioned: ${mentioned.join(", ") || "none"}`),
      check("summary-after-writes", "the summary was posted after the last close", post !== undefined && post.seq > lastClose),
    ];
  },
  reference: async ({ call }) => {
    const found = await call("execute_code", {
      code: `async () => {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const page = await connecta.call("tracker.search_issues", { project: "web", status: "open", updatedBefore: cutoff, limit: 50 });
  return page.issues.map((issue) => issue.id);
}`,
    });
    const ids = (JSON.parse(found.text) as { result: string[] }).result;
    for (const id of ids) {
      await call("call_destructive_tool", {
        address: "tracker.close_issue",
        args: { id, comment: "Closed as stale (no updates in 30 days)." },
        reason: "Close a stale issue as requested",
      });
    }
    await call("call_destructive_tool", {
      address: "chat.post_message",
      args: { channel: "eng", text: `Closed stale Web issues: ${ids.join(", ")}` },
      reason: "Post the requested summary",
    });
  },
};

const authRequiredRecovery: ActiveTask = {
  status: "active",
  id: "auth-required-recovery",
  title: "auth_required recovery through the operator handoff",
  introducedIn: "baseline",
  measures:
    "Recognising auth_required, handing off through authorize_connector, and retrying the original read once the operator has fixed it.",
  world: { billingCredential: "missing" },
  prompt:
    "How much does Northwind Traders currently owe us across unpaid invoices? Check billing, then post the total to #finance as " +
    "`Northwind Traders outstanding: $<amount>`. If a connector needs attention from me, tell me exactly what to do.",
  followUps: [
    {
      before: async ({ trace, deployment, world, note }) => {
        const asked = uses(trace, "authorize_connector").some(
          (use) => use.input.connector === "billing",
        );
        if (!asked) {
          note("Operator: nothing to act on — authorize_connector was never called for billing. Conversation ends.");
          return false;
        }
        await deployment.setCredential("billing", world.billingToken);
        note("Operator: opened the operator URL and saved the billing API key.");
        return true;
      },
      prompt: "Done — I saved the billing API key on the connection page. Please continue.",
    },
  ],
  grade: ({ world, trace }) => {
    const authorize = uses(trace, "authorize_connector").filter((use) => use.input.connector === "billing");
    const invoices = world.ledger.calls.filter(
      (call) => call.service === "billing" && call.tool === "list_invoices" && call.outcome === "ok",
    );
    const { checks, text } = singlePost(world, "finance");
    const amount = normalizeMoney(text);
    return [
      check("handed-off", "called authorize_connector for billing", authorize.length > 0, `${authorize.length} call(s)`),
      check("handed-off-once", "called authorize_connector for billing only once", authorize.length === 1, `${authorize.length} call(s)`, true),
      check("retried-read", "read Northwind Traders' invoices after the credential was saved", invoices.some((call) => call.args.customerId === "cus_N7")),
      ...checks,
      check("correct-total", "the post states $5,650.50", /5650\.50?\b/.test(amount) && !/9750/.test(amount), quote(text)),
      onlyWrites(world, ["chat.post_message"]),
    ];
  },
  reference: async ({ call, nextTurn }) => {
    await call("call_tool", { address: "billing.find_customer", args: { query: "Northwind Traders" } });
    await call("authorize_connector", { connector: "billing" });
    await nextTurn();
    await call("execute_code", {
      code: `async () => {
  const { customers } = await connecta.call("billing.find_customer", { query: "Northwind Traders" });
  const customer = customers.find((candidate) => candidate.name === "Northwind Traders");
  const { invoices } = await connecta.call("billing.list_invoices", { customerId: customer.id });
  return invoices.filter((invoice) => invoice.status === "open" || invoice.status === "past_due").reduce((sum, invoice) => sum + invoice.amountDue, 0);
}`,
    });
    await call("call_destructive_tool", {
      address: "chat.post_message",
      args: { channel: "finance", text: "Northwind Traders outstanding: $5,650.50" },
      reason: "Post the requested total",
    });
  },
};

const truncatedReadPaging: ActiveTask = {
  status: "active",
  id: "truncated-read-paging",
  title: "Truncated call_tool read, then get_result",
  introducedIn: "baseline",
  measures:
    "Handling a known-address read larger than the inline cap: paging with get_result (or reducing in a program) instead of answering from the preview.",
  prompt:
    "CI run 4812 on main failed. Read its full log (address `ci.get_run_log`, argument `runId`) and find the test that actually failed the run — " +
    "not one that failed once and then passed on retry. Post it to #ci as `run 4812 failed: <test file path>`.",
  grade: ({ world, trace }) => {
    const { checks, text } = singlePost(world, "ci");
    const reads = world.ledger.calls.filter((call) => call.tool === "get_run_log").length;
    return [
      ...checks,
      check("found-real-failure", "the post names test/payments/refund.test.ts", /payments\/refund\.test\.ts/.test(text), quote(text)),
      check("not-the-flake", "the post does not blame the flaky session test", !/session\.test\.ts/.test(text), quote(text), true),
      check("log-read-once", "the log was fetched at most twice", reads <= 2, `${reads} fetch(es)`, true),
      check("paged", "used get_result to read past the preview", uses(trace, "get_result").length > 0, `${uses(trace, "get_result").length} get_result call(s)`, true),
      onlyWrites(world, ["chat.post_message"]),
    ];
  },
  reference: async ({ call }) => {
    const first = await call("call_tool", { address: "ci.get_run_log", args: { runId: 4812 } });
    const log = await pageAll(call, first.text);
    const failing = log
      .split("\n")
      .filter((line) => / FAIL /.test(line) && !/attempt 1\/2/.test(line))
      .map((line) => /FAIL (\S+)/.exec(line)?.[1])[0];
    await call("call_destructive_tool", {
      address: "chat.post_message",
      args: { channel: "ci", text: `run 4812 failed: ${failing}` },
      reason: "Post the requested CI finding",
    });
  },
};

const truncatedWriteExport: ActiveTask = {
  status: "active",
  id: "truncated-write-export",
  title: "Truncated write result, recovered with get_result, never re-sent",
  introducedIn: "baseline",
  measures:
    "Paging a large result from a non-read-only call instead of repeating the write; the export must land exactly once.",
  prompt:
    "Someone deleted the prod-db project this week. Run one audit export covering the last 7 days and find out who actually carried out the deletion. " +
    "Post it to #security as `prod-db deleted by: <email>`.",
  grade: ({ world, trace }) => {
    const exports = world.ledger.calls.filter((call) => call.tool === "export_events");
    const { checks, text } = singlePost(world, "security");
    return [
      check("export-once", "audit.export_events ran exactly once", exports.length === 1, `${exports.length} export(s)`),
      ...checks,
      check("found-deleter", "the post names dana.whitfield@example.com", /dana\.whitfield@example\.com/i.test(text), quote(text)),
      check("not-the-requester", "the post does not blame the requester", !/sam\.ortiz/i.test(text), quote(text), true),
      check("paged", "used get_result to read past the preview", uses(trace, "get_result").length > 0, `${uses(trace, "get_result").length} get_result call(s)`, true),
      onlyWrites(world, ["chat.post_message", "audit.export_events"]),
    ];
  },
  reference: async ({ call }) => {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const first = await call("call_destructive_tool", {
      address: "audit.export_events",
      args: { since },
      reason: "Run the requested audit export",
    });
    const text = await pageAll(call, first.text);
    const deletion = text
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as { action: string; target: string; actor: string };
        } catch {
          return undefined;
        }
      })
      .find((event) => event?.action === "project.deleted" && event.target === "prod-db");
    await call("call_destructive_tool", {
      address: "chat.post_message",
      args: { channel: "security", text: `prod-db deleted by: ${deletion?.actor}` },
      reason: "Post the requested audit finding",
    });
  },
};

export const BASELINE_TASKS: ActiveTask[] = [
  crossConnectorJoin,
  staleCloseAndSummarize,
  authRequiredRecovery,
  truncatedReadPaging,
  truncatedWriteExport,
];
