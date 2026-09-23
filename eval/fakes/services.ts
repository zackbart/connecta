/**
 * The other fakes: messaging, product analytics, billing, CI, and an audit
 * log. Each is small, deterministic, and annotated the way a careful provider
 * would annotate it — reads say `readOnlyHint: true`, everything else does not.
 */
import { z } from "zod";
import type { FakeTool } from "./service.js";

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- chat

interface ChatMessage {
  channel: string;
  text: string;
  author: string;
  ts: string;
  byAgent: boolean;
}

export interface ChatState {
  channels: { id: string; name: string; topic: string }[];
  messages: ChatMessage[];
}

export function chatState(now: number): ChatState {
  const channels = [
    ["C01", "general", "Company-wide announcements"],
    ["C02", "eng", "Engineering"],
    ["C03", "triage", "Customer-impacting bugs"],
    ["C04", "finance", "Billing and revenue"],
    ["C05", "ci", "Build and test failures"],
    ["C06", "security", "Security and audit"],
    ["C07", "random", "Anything else"],
  ].map(([id, name, topic]) => ({ id: id!, name: name!, topic: topic! }));
  const seeded: [string, string, string, number][] = [
    ["eng", "ben", "Reminder: stale issues get closed on Fridays.", 2],
    ["triage", "ana", "Morning! Anything customer-facing on fire?", 1],
    ["finance", "dev", "Q3 invoicing run is done.", 3],
    ["ci", "eli", "Main is green again after the flaky auth test.", 4],
  ];
  return {
    channels,
    messages: seeded.map(([channel, author, text, ageDays]) => ({
      channel,
      author,
      text,
      ts: new Date(now - ageDays * DAY_MS).toISOString(),
      byAgent: false,
    })),
  };
}

export function chatTools(state: ChatState, now: () => number): FakeTool[] {
  const channelOf = (value: unknown) => {
    const key = String(value ?? "").replace(/^#/, "").toLowerCase();
    return state.channels.find(
      (channel) => channel.name === key || channel.id.toLowerCase() === key,
    );
  };
  return [
    {
      name: "list_channels",
      description: "List chat channels.",
      input: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: () => ({ json: { channels: state.channels } }),
    },
    {
      name: "read_messages",
      description: "Read the most recent messages in a channel, newest last.",
      input: z.object({
        channel: z.string().describe("Channel name (with or without #) or id"),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: (args) => {
        const channel = channelOf(args.channel);
        if (!channel) return { error: `channel ${String(args.channel)} not found` };
        const limit = typeof args.limit === "number" ? args.limit : 20;
        return {
          json: {
            channel: channel.name,
            messages: state.messages
              .filter((message) => message.channel === channel.name)
              .slice(-limit)
              .map(({ author, text, ts }) => ({ author, text, ts })),
          },
        };
      },
    },
    {
      name: "post_message",
      description: "Post a message to a channel as the workspace bot.",
      input: z.object({
        channel: z.string().describe("Channel name (with or without #) or id"),
        text: z.string().min(1),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      run: (args) => {
        const channel = channelOf(args.channel);
        if (!channel) return { error: `channel ${String(args.channel)} not found` };
        const ts = new Date(now()).toISOString();
        state.messages.push({
          channel: channel.name,
          text: String(args.text),
          author: "bot",
          ts,
          byAgent: true,
        });
        return { json: { ok: true, channel: channel.name, ts } };
      },
    },
  ];
}

// ---------------------------------------------------------------- analytics

interface Account {
  id: string;
  name: string;
  domain: string;
  plan: "starter" | "growth" | "enterprise";
  mrr: number;
  activeUsers: number;
}

const ACCOUNTS: Account[] = [
  { id: "acc_01", name: "Initech", domain: "initech.com", plan: "enterprise", mrr: 48_000, activeUsers: 812 },
  { id: "acc_02", name: "Globex", domain: "globex.com", plan: "growth", mrr: 31_500, activeUsers: 404 },
  { id: "acc_03", name: "Hooli", domain: "hooli.com", plan: "enterprise", mrr: 120_000, activeUsers: 2_210 },
  { id: "acc_04", name: "Umbrella Corp", domain: "umbrella.com", plan: "enterprise", mrr: 95_000, activeUsers: 1_530 },
  { id: "acc_05", name: "Soylent", domain: "soylent.com", plan: "growth", mrr: 22_000, activeUsers: 260 },
  { id: "acc_06", name: "Stark Industries", domain: "stark.com", plan: "enterprise", mrr: 56_500, activeUsers: 990 },
  { id: "acc_07", name: "Wayne Enterprises", domain: "wayne.com", plan: "enterprise", mrr: 51_000, activeUsers: 870 },
  { id: "acc_08", name: "Acme", domain: "acme.com", plan: "starter", mrr: 9_000, activeUsers: 75 },
  { id: "acc_09", name: "Northwind Traders", domain: "northwind.com", plan: "growth", mrr: 14_200, activeUsers: 140 },
  { id: "acc_10", name: "Tyrell", domain: "tyrell.com", plan: "enterprise", mrr: 77_000, activeUsers: 1_120 },
  { id: "acc_11", name: "Cyberdyne", domain: "cyberdyne.com", plan: "enterprise", mrr: 64_000, activeUsers: 1_004 },
  { id: "acc_12", name: "Oscorp", domain: "oscorp.com", plan: "starter", mrr: 5_000, activeUsers: 41 },
];

export function analyticsTools(): FakeTool[] {
  return [
    {
      name: "list_accounts",
      description: "List customer accounts (id, name, domain, plan). Paged; revenue lives in get_account_metrics.",
      input: z.object({
        plan: z.enum(["starter", "growth", "enterprise"]).optional(),
        limit: z.number().int().min(1).max(25).optional().describe("Page size, default 10, max 25"),
        cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: (args) => {
        const rows = ACCOUNTS.filter(
          (account) => args.plan === undefined || account.plan === args.plan,
        );
        const offset =
          typeof args.cursor === "string" && /^p\d+$/.test(args.cursor)
            ? Number(args.cursor.slice(1))
            : 0;
        const limit = typeof args.limit === "number" ? args.limit : 10;
        const page = rows.slice(offset, offset + limit);
        return {
          json: {
            accounts: page.map(({ id, name, domain, plan }) => ({ id, name, domain, plan })),
            ...(offset + limit < rows.length ? { nextCursor: `p${offset + limit}` } : {}),
          },
        };
      },
    },
    {
      name: "get_account_metrics",
      description: "Current revenue and usage metrics for one account.",
      input: z.object({ accountId: z.string().describe("Account id, e.g. acc_01") }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: (args) => {
        const account = ACCOUNTS.find((candidate) => candidate.id === args.accountId);
        return account
          ? {
              json: {
                accountId: account.id,
                mrrUsd: account.mrr,
                activeUsers30d: account.activeUsers,
              },
            }
          : { error: `account ${String(args.accountId)} not found` };
      },
    },
  ];
}

// ---------------------------------------------------------------- billing

interface Invoice {
  id: string;
  customerId: string;
  status: "paid" | "open" | "past_due" | "void";
  amountDue: number;
  currency: "USD";
  dueDate: string;
}

export function billingTools(now: number): FakeTool[] {
  const customers = [
    { id: "cus_A1", name: "Acme" },
    { id: "cus_N7", name: "Northwind Traders" },
    { id: "cus_N8", name: "Northwind Logistics" },
    { id: "cus_S3", name: "Soylent" },
  ];
  const day = (offset: number) => new Date(now + offset * DAY_MS).toISOString().slice(0, 10);
  const invoices: Invoice[] = [
    { id: "in_1001", customerId: "cus_N7", status: "paid", amountDue: 2_400, currency: "USD", dueDate: day(-60) },
    { id: "in_1002", customerId: "cus_N7", status: "open", amountDue: 1_250, currency: "USD", dueDate: day(10) },
    { id: "in_1003", customerId: "cus_N7", status: "past_due", amountDue: 3_480.5, currency: "USD", dueDate: day(-12) },
    { id: "in_1004", customerId: "cus_N7", status: "void", amountDue: 700, currency: "USD", dueDate: day(-30) },
    { id: "in_1005", customerId: "cus_N7", status: "open", amountDue: 920, currency: "USD", dueDate: day(20) },
    { id: "in_2001", customerId: "cus_N8", status: "open", amountDue: 4_100, currency: "USD", dueDate: day(5) },
    { id: "in_3001", customerId: "cus_A1", status: "open", amountDue: 310, currency: "USD", dueDate: day(8) },
    { id: "in_4001", customerId: "cus_S3", status: "past_due", amountDue: 1_875, currency: "USD", dueDate: day(-3) },
  ];
  return [
    {
      name: "find_customer",
      description: "Find billing customers whose name contains the query.",
      input: z.object({ query: z.string().min(1) }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: (args) => ({
        json: {
          customers: customers.filter((customer) =>
            customer.name.toLowerCase().includes(String(args.query).toLowerCase()),
          ),
        },
      }),
    },
    {
      name: "list_invoices",
      description: "List a customer's invoices. Status is one of paid, open, past_due, void.",
      input: z.object({
        customerId: z.string(),
        status: z.enum(["paid", "open", "past_due", "void"]).optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: (args) => ({
        json: {
          invoices: invoices.filter(
            (invoice) =>
              invoice.customerId === args.customerId &&
              (args.status === undefined || invoice.status === args.status),
          ),
        },
      }),
    },
    {
      name: "void_invoice",
      description: "Void an open invoice.",
      input: z.object({ invoiceId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      run: (args) => {
        const invoice = invoices.find((candidate) => candidate.id === args.invoiceId);
        if (!invoice) return { error: `invoice ${String(args.invoiceId)} not found` };
        invoice.status = "void";
        return { json: { id: invoice.id, status: invoice.status } };
      },
    },
  ];
}

// ---------------------------------------------------------------- ci

/**
 * One long run log. A flaky failure (retried, then passed) sits inside the
 * first 50 KB — the default inline cap — and the real failure well past it,
 * so answering from the truncated preview gives the wrong test.
 */
function ciRunLog(runId: number, now: number): string {
  const lines: string[] = [];
  const areas = ["auth", "billing", "catalog", "orders", "search", "ui", "reports", "sync"];
  let clock = now - 40 * 60_000;
  const stamp = () => {
    clock += 731;
    return new Date(clock).toISOString();
  };
  lines.push(`${stamp()} run ${runId} started on main (8 shards)`);
  for (let index = 0; index < 2_300; index += 1) {
    const area = areas[index % areas.length]!;
    const shard = (index % 8) + 1;
    if (index === 310) {
      lines.push(
        `${stamp()} [shard ${shard}/8] FAIL test/auth/session.test.ts > refreshes idle sessions (attempt 1/2)`,
        `${stamp()} [shard ${shard}/8]   TimeoutError: waited 5000ms for token refresh`,
        `${stamp()} [shard ${shard}/8] PASS test/auth/session.test.ts > refreshes idle sessions (attempt 2/2, marked flaky)`,
      );
      continue;
    }
    if (index === 1_980) {
      lines.push(
        `${stamp()} [shard ${shard}/8] FAIL test/payments/refund.test.ts > refunds partial captures`,
        `${stamp()} [shard ${shard}/8]   AssertionError: expected status 200, received 409 (capture already settled)`,
        `${stamp()} [shard ${shard}/8]     at test/payments/refund.test.ts:88:17`,
      );
      continue;
    }
    lines.push(
      `${stamp()} [shard ${shard}/8] PASS test/${area}/case-${String(index).padStart(4, "0")}.test.ts (${(index * 37) % 400 + 12} ms)`,
    );
  }
  lines.push(
    `${stamp()} Test Files  1 failed | 1 flaky | 2298 passed (2300)`,
    `${stamp()} run ${runId} finished: FAILED`,
  );
  return lines.join("\n");
}

export function ciTools(now: number): FakeTool[] {
  const runs = [
    { runId: 4812, branch: "main", status: "failed", commit: "9f2c1ab", startedAt: new Date(now - 40 * 60_000).toISOString() },
    { runId: 4811, branch: "main", status: "passed", commit: "71d0e3c", startedAt: new Date(now - 3 * 3_600_000).toISOString() },
    { runId: 4810, branch: "feature/export", status: "passed", commit: "c0ffee1", startedAt: new Date(now - 5 * 3_600_000).toISOString() },
  ];
  return [
    {
      name: "list_runs",
      description: "List recent CI runs.",
      input: z.object({ branch: z.string().optional() }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: (args) => ({
        json: { runs: runs.filter((run) => args.branch === undefined || run.branch === args.branch) },
      }),
    },
    {
      name: "get_run",
      description: "Get a CI run's status and counts. Failure details are only in the run log.",
      input: z.object({ runId: z.number().int() }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: (args) => {
        const run = runs.find((candidate) => candidate.runId === args.runId);
        if (!run) return { error: `run ${String(args.runId)} not found` };
        return {
          json: {
            ...run,
            ...(run.status === "failed" ? { failedTests: 1, flakyTests: 1 } : { failedTests: 0 }),
            logBytes: Buffer.byteLength(ciRunLog(run.runId, now)),
          },
        };
      },
    },
    {
      name: "get_run_log",
      description: "Return the complete plain-text log of a CI run.",
      input: z.object({ runId: z.number().int() }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: (args) =>
        runs.some((run) => run.runId === args.runId)
          ? { text: ciRunLog(Number(args.runId), now) }
          : { error: `run ${String(args.runId)} not found` },
    },
    {
      name: "rerun_job",
      description: "Re-run a CI run.",
      input: z.object({ runId: z.number().int() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      run: (args) => ({ json: { queued: true, runId: Number(args.runId) + 1000 } }),
    },
  ];
}

// ---------------------------------------------------------------- audit

export interface AuditState {
  exports: { exportId: string; since: string; events: number; createdAt: string }[];
}

/**
 * ~130 KB of JSON lines. The deletion *request* is near the top; the actual
 * deletion, by someone else, is far past the default inline cap.
 */
function auditEvents(now: number): string {
  const actors = ["sam.ortiz@example.com", "lee.park@example.com", "noor.haddad@example.com", "ivan.petrov@example.com"];
  const actions = ["login", "token.created", "member.invited", "setting.changed", "project.viewed", "export.downloaded"];
  const lines: string[] = [];
  const start = now - 7 * DAY_MS;
  for (let index = 0; index < 1_150; index += 1) {
    const ts = new Date(start + index * 520_000).toISOString();
    if (index === 120) {
      lines.push(JSON.stringify({ ts, actor: "sam.ortiz@example.com", action: "project.delete_requested", target: "prod-db", note: "requested deletion; awaiting second approver" }));
      continue;
    }
    if (index === 600) {
      lines.push(JSON.stringify({ ts, actor: "lee.park@example.com", action: "project.deleted", target: "staging-db" }));
      continue;
    }
    if (index === 1_050) {
      lines.push(JSON.stringify({ ts, actor: "dana.whitfield@example.com", action: "project.deleted", target: "prod-db", note: "approved and executed deletion" }));
      continue;
    }
    lines.push(
      JSON.stringify({
        ts,
        actor: actors[index % actors.length],
        action: actions[index % actions.length],
        target: `resource-${(index * 7919) % 997}`,
        ip: `10.0.${index % 255}.${(index * 13) % 255}`,
      }),
    );
  }
  return lines.join("\n");
}

export function auditTools(state: AuditState, now: () => number): FakeTool[] {
  return [
    {
      name: "export_events",
      description:
        "Start an audit export job for a time window and return the exported events as JSON lines. Each call creates a new billable export job.",
      input: z.object({
        since: z.string().describe("ISO 8601 start of the window"),
        until: z.string().optional().describe("ISO 8601 end of the window; defaults to now"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      run: (args) => {
        const at = now();
        const text = auditEvents(at);
        state.exports.push({
          exportId: `exp_${state.exports.length + 1}`,
          since: String(args.since),
          events: text.split("\n").length,
          createdAt: new Date(at).toISOString(),
        });
        return { text };
      },
    },
    {
      name: "list_exports",
      description: "List audit export jobs created so far (metadata only).",
      input: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: () => ({ json: { exports: state.exports } }),
    },
  ];
}
