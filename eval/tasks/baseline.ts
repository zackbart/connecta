/**
 * The baseline task set: today's surface, run on main before the rewrite and
 * re-run by every later phase.
 */
import type { AgentTrace } from "../agent/trace.js";
import type { World } from "../fakes/world.js";
import type { ActiveTask, Check, ReferenceContext } from "./types.js";
import { uses } from "./types.js";

// ------------------------------------------------------------ grading helpers

export function check(id: string, description: string, pass: boolean, detail?: string, advisory?: boolean): Check {
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
 * preview after it, then `connecta.result` through execute_code to the
 * end — what a careful agent does. A lone text block pages as its text, and
 * the preview is a byte prefix of it, so the pieces concatenate.
 */
async function pageAll(call: ReferenceContext["call"], truncated: string): Promise<string> {
  const newline = truncated.indexOf("\n");
  const notice = JSON.parse(truncated.slice(0, newline)) as { resultId: string; nextOffset: number };
  const id = notice.resultId;
  const from = notice.nextOffset;
  let text = from > 0 ? truncated.slice(newline + 1) : "";
  let offset: number | undefined = from;
  while (offset !== undefined) {
    const reply = await call("execute_code", {
      code: `async () => await connecta.result(${JSON.stringify(id)}, { offset: ${offset}, maxBytes: 3500 })`,
    });
    if (reply.isError) throw new Error(`Result paging failed: ${reply.text}`);
    const envelope = (reply.structured ?? JSON.parse(reply.text)) as {
      result: { text: string; hasMore: boolean; nextOffset?: number };
    };
    const page = envelope.result;
    text += page.text;
    offset = page.hasMore ? page.nextOffset : undefined;
  }
  return text;
}

/** Handoff links Connecta really gave the agent, read from what its tools returned. */
function handoffLinks(trace: AgentTrace): string[] {
  const links = new Set<string>();
  for (const use of trace.toolUses)
    for (const match of (use.resultText ?? "").matchAll(/\\?"(?:operatorUrl|authorizationUrl)\\?":\\?"([^"\\]+)/g))
      links.add(match[1]!);
  return [...links];
}

/** Closes a wrapper written immediately before a URL. */
const URL_WRAPPER_CLOSERS: Record<string, string> = {
  "(": ")",
  "[": "]",
  "<": ">",
  '"': '"',
  "'": "'",
  "`": "`",
  "*": "*",
  _: "_",
  "\u201C": "\u201D",
  "\u2018": "\u2019",
  "\u00AB": "\u00BB",
};

/** A complete Markdown inline link; only its destination can be opened. */
const MARKDOWN_LINK = /\[[^\]]*\]\(\s*<?(https?:\/\/(?:[^\s()<>]|\([^\s()<>]*\))+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
/** A complete HTML anchor, which a renderer opens at its href whatever its label says. */
const HTML_LINK =
  /<a\b[^>]*?\shref\s*=\s*(?:"(https?:\/\/[^"]*)"|'(https?:\/\/[^']*)'|(https?:\/\/[^\s>]*))[^>]*>[\s\S]*?<\/a\s*>/gi;
const decodeHtml = (value: string) => value.replace(/&(amp|#38|#x26);/gi, "&");

/**
 * Every complete URL in the agent's words, in its original bytes: a Markdown
 * destination, or a whitespace-delimited word without the sentence punctuation
 * a linkifier also leaves out and without a closer matching what opened it.
 * A Markdown or HTML link's destination stands alone: scanning it as prose would
 * strip punctuation that is really part of where the link goes.
 * Every other trailing character stays, because it would be part of the link a
 * person opened: `/`, `&x=1`, `-`, `_` and `*` all make a different URL.
 */
export function urlTokens(text: string): string[] {
  const tokens = [
    ...[...text.matchAll(MARKDOWN_LINK)].map((match) => match[1]!),
    ...[...text.matchAll(HTML_LINK)].map((match) => decodeHtml(match[1] ?? match[2] ?? match[3]!)),
  ];
  const prose = text.replace(MARKDOWN_LINK, " ").replace(HTML_LINK, " ");
  for (const match of prose.matchAll(/https?:\/\/\S+/g)) {
    const before = prose.slice(0, match.index);
    // Glued to a preceding word, this is a part of another URL, like a proxy's `?u=`.
    if (before && !/[\s([<"'`*_:\u201C\u2018\u00AB]$/.test(before)) continue;
    const opened = /[([<"'`*_\u201C\u2018\u00AB]*$/.exec(before)![0];
    const closing = [...opened]
      .reverse()
      .map((opener) => URL_WRAPPER_CLOSERS[opener]!)
      .join("");
    const withoutPunctuation = (word: string) => word.replace(/[.,;:!?]+$/, "");
    let token = withoutPunctuation(match[0]);
    if (closing && token.endsWith(closing)) token = withoutPunctuation(token.slice(0, -closing.length));
    // `(see https://x).` opens away from the URL, so only the balance shows the closer isn't its own.
    else if (token.endsWith(")") && token.split(")").length > token.split("(").length)
      token = withoutPunctuation(token.slice(0, -1));
    tokens.push(match[0], token);
  }
  return tokens;
}

/**
 * The agent's own words carry a real link exactly as issued. A person can only
 * open what reaches them whole, so a paraphrase, a re-encoded link, characters
 * run onto its end and a tool call nobody hears about all fail alike, by either
 * route to the link.
 */
function handoffLinkReachedUser(trace: AgentTrace): boolean {
  const said = [
    trace.finalAnswer ?? "",
    ...trace.transcript.flatMap((entry) => (entry.kind === "assistant" ? [entry.text] : [])),
  ].flatMap(urlTokens);
  return handoffLinks(trace).some((link) => said.includes(link));
}

function resultPagingUses(trace: Parameters<typeof uses>[0]) {
  return uses(trace, "execute_code").filter((use) => String(use.input.code).includes("connecta.result("));
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
    "Using the issue tracker and product analytics, find the open bug that affects our highest-paying customer (by MRR) that has an open bug. " +
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
    const read = await call("execute_code", {
      code: `async () => {
  const bugs = [];
  let cursor;
  do {
    const page = (await connecta.call("tracker.search_issues", { status: "open", label: "bug", limit: 50, ...(cursor ? { cursor } : {}) })).data;
    bugs.push(...page.issues);
    cursor = page.nextCursor;
  } while (cursor);
  const accounts = [];
  let next;
  do {
    const page = (await connecta.call("analytics.list_accounts", { limit: 25, ...(next ? { cursor: next } : {}) })).data;
    accounts.push(...page.accounts);
    next = page.nextCursor;
  } while (next);
  const rows = [];
  for (const bug of bugs.filter((issue) => issue.customer)) {
    const account = accounts.find((candidate) => candidate.domain === bug.customer);
    if (!account) continue;
    const metrics = (await connecta.call("analytics.get_account_metrics", { accountId: account.id })).data;
    rows.push({ key: bug.id, name: account.name, mrr: metrics.mrrUsd });
  }
  rows.sort((a, b) => b.mrr - a.mrr);
  return rows[0];
}`,
    });
    if (read.isError) throw new Error(`cross-connector-join read failed: ${read.text}`);
    await call("call_destructive_tool", {
      address: "chat.post_message",
      args: { channel: "triage", text: "API-207 Stark Industries $56,500" },
      reason: "Post the requested triage answer",
    });
  },
};

const STALE = ["WEB-103", "WEB-105", "WEB-107", "WEB-110"];

/**
 * The stale-close outcome, whatever route produced it: exactly the stale set
 * closed, each close landing once, no other tracker writes, and one #eng
 * summary after the last close naming exactly what was closed.
 */
function staleCloseChecks(world: World): Check[] {
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
      !(
        STALE.includes(String(call.args.id ?? "").toUpperCase()) &&
        (call.tool === "close_issue" || call.tool === "add_comment")
      ),
  );
  const { checks, text } = singlePost(world, "eng");
  const mentioned = [...new Set(text.toUpperCase().match(/\b(?:WEB|API|MOB)-\d+\b/g) ?? [])].sort();
  const lastClose = Math.max(0, ...closeCalls.map((call) => call.seq));
  const post = world.ledger.calls.find((call) => call.tool === "post_message" && call.args.channel !== undefined);
  return [
    check(
      "closed-exactly-stale",
      `closed exactly ${STALE.join(", ")}`,
      JSON.stringify(closed) === JSON.stringify(STALE),
      `closed: ${closed.join(", ") || "none"}`,
    ),
    check(
      "each-write-once",
      "every close_issue landed exactly once",
      repeated.length === 0,
      repeated.length ? repeated.map(([id, count]) => `${id}×${count}`).join(", ") : undefined,
    ),
    check(
      "no-other-tracker-writes",
      "no tracker writes outside the stale set",
      strayWrites.length === 0,
      strayWrites.map((call) => `${call.tool} ${JSON.stringify(call.args)}`).join(", ") || undefined,
    ),
    ...checks,
    check(
      "summary-lists-closed",
      "the summary lists exactly the closed keys",
      JSON.stringify(mentioned) === JSON.stringify(STALE),
      `mentioned: ${mentioned.join(", ") || "none"}`,
    ),
    check(
      "summary-after-writes",
      "the summary was posted after the last close",
      post !== undefined && post.seq > lastClose,
    ),
  ];
}

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
  grade: ({ world }) => staleCloseChecks(world),
  reference: async ({ call }) => {
    const found = await call("execute_code", {
      code: `async () => {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const page = (await connecta.call("tracker.search_issues", { project: "web", status: "open", updatedBefore: cutoff, limit: 50 })).data;
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
    "Recognising auth_required, getting the handoff link to the person intact, and retrying the original read once the operator has fixed it.",
  world: { billingCredential: "missing" },
  prompt:
    "How much does Northwind Traders currently owe us across unpaid invoices? Check billing, then post the total to #finance as " +
    "`Northwind Traders outstanding: $<amount>`. If a connector needs attention from me, tell me exactly what to do.",
  followUps: [
    {
      before: async ({ trace, deployment, world, note }) => {
        if (!handoffLinkReachedUser(trace)) {
          note("Operator: nothing to act on — no handoff link for billing reached me intact. Conversation ends.");
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
    const handedOff = handoffLinkReachedUser(trace);
    const invoices = world.ledger.calls.filter(
      (call) => call.service === "billing" && call.tool === "list_invoices" && call.outcome === "ok",
    );
    const { checks, text } = singlePost(world, "finance");
    const amount = normalizeMoney(text);
    return [
      check("handed-off-route", "gave the user the billing handoff link intact", handedOff),
      check(
        "handed-off",
        "gave the user the billing handoff link intact",
        handedOff,
        `${handoffLinks(trace).length} link(s) issued`,
      ),
      check(
        "handed-off-once",
        "fetched the billing handoff with authorize_connector at most once",
        authorize.length <= 1,
        `${authorize.length} call(s)`,
        true,
      ),
      check(
        "retried-read",
        "read Northwind Traders' invoices after the credential was saved",
        invoices.some((call) => call.args.customerId === "cus_N7"),
      ),
      ...checks,
      check(
        "correct-total",
        "the post states $5,650.50",
        /5650\.50?\b/.test(amount) && !/9750/.test(amount),
        quote(text),
      ),
      onlyWrites(world, ["chat.post_message"]),
    ];
  },
  reference: async ({ answer, call, nextTurn }) => {
    const blocked = await call("call_tool", { address: "billing.find_customer", args: { query: "Northwind Traders" } });
    const { nextAction } = (blocked.structured as { error: { nextAction: { url: string } } }).error;
    answer(
      `Billing needs its API key before I can read this. Please open ${nextAction.url} and save it, then tell me.`,
    );
    await nextTurn();
    await call("execute_code", {
      code: `async () => {
  const { customers } = (await connecta.call("billing.find_customer", { query: "Northwind Traders" })).data;
  const customer = customers.find((candidate) => candidate.name === "Northwind Traders");
  const { invoices } = (await connecta.call("billing.list_invoices", { customerId: customer.id })).data;
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
  title: "Truncated call_tool read, then connecta.result",
  introducedIn: "baseline",
  measures:
    "Handling a known-address read larger than the inline cap: paging with connecta.result (or reducing in a program) instead of answering from the preview.",
  prompt:
    "CI run 4812 on main failed. Read its full log (address `ci.get_run_log`, argument `runId`) and find the test that actually failed the run — " +
    "not one that failed once and then passed on retry. Post it to #ci as `run 4812 failed: <test file path>`.",
  grade: ({ world, trace }) => {
    const { checks, text } = singlePost(world, "ci");
    const reads = world.ledger.calls.filter((call) => call.tool === "get_run_log").length;
    return [
      ...checks,
      check(
        "found-real-failure",
        "the post names test/payments/refund.test.ts",
        /payments\/refund\.test\.ts/.test(text),
        quote(text),
      ),
      check(
        "not-the-flake",
        "the post does not blame the flaky session test",
        !/session\.test\.ts/.test(text),
        quote(text),
        true,
      ),
      check("log-read-once", "the log was fetched at most twice", reads <= 2, `${reads} fetch(es)`, true),
      check(
        "paged",
        "used connecta.result to read past the preview",
        resultPagingUses(trace).length > 0,
        `${resultPagingUses(trace).length} paging program(s)`,
        true,
      ),
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
  deployment: { readOnly: false },
  title: "Truncated write result, recovered with connecta.result, never re-sent",
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
      check(
        "found-deleter",
        "the post names dana.whitfield@example.com",
        /dana\.whitfield@example\.com/i.test(text),
        quote(text),
      ),
      check("not-the-requester", "the post does not blame the requester", !/sam\.ortiz/i.test(text), quote(text), true),
      check(
        "paged",
        "used connecta.result to read past the preview",
        resultPagingUses(trace).length > 0,
        `${resultPagingUses(trace).length} paging program(s)`,
        true,
      ),
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
