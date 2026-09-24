/**
 * A fake issue tracker: three projects, ~40 issues, cursor paging, and properly
 * annotated reads and writes. Dates are relative to the world's clock so
 * "stale" means the same thing on every run.
 *
 * The issues nearest the 30-day line sit two days either side of it (WEB-107
 * at 32, WEB-108 at 28), never one. An agent reasons in calendar days, and a
 * cutoff built from a date rather than an instant can land up to a day past
 * the world's clock whichever way it rounds. At 31 days, WEB-107 fell on the
 * wrong side whenever the agent's local date trailed the clock's UTC date. Two
 * days keeps the task about the 30-day boundary, not about the time of day.
 */
import { z } from "zod";
import type { FakeTool } from "./service.js";

interface Issue {
  id: string;
  project: "web" | "api" | "mobile";
  title: string;
  status: "open" | "closed";
  labels: string[];
  customer?: string;
  assignee?: string;
  createdAt: string;
  updatedAt: string;
  comments: { author: string; body: string; at: string }[];
  closedBy?: "seed" | "agent";
}

type Seed = [
  id: string,
  status: Issue["status"],
  label: string,
  ageDays: number,
  title: string,
  customer?: string,
];

const SEED: Seed[] = [
  ["WEB-101", "open", "bug", 3, "Checkout button unresponsive on Safari", "initech.com"],
  ["WEB-102", "open", "feature", 5, "Bulk export for dashboards", "hooli.com"],
  ["WEB-103", "open", "bug", 45, "Chart tooltips overlap the legend", "globex.com"],
  ["WEB-104", "closed", "bug", 10, "SSO redirect loop after password reset", "umbrella.com"],
  ["WEB-105", "open", "chore", 62, "Upgrade the analytics SDK"],
  ["WEB-106", "open", "bug", 12, "Invoice PDF is missing the VAT line", "soylent.com"],
  ["WEB-107", "open", "feature", 32, "Dark mode for the settings pages"],
  ["WEB-108", "open", "bug", 28, "Search debounce is too aggressive"],
  ["WEB-109", "closed", "chore", 90, "Remove the legacy router"],
  ["WEB-110", "open", "bug", 40, "Session expires during checkout", "initech.com"],
  ["WEB-111", "open", "feature", 2, "Keyboard shortcuts for the editor"],
  ["WEB-112", "open", "bug", 8, "Avatar upload fails for HEIC images"],
  ["WEB-113", "closed", "bug", 35, "Broken link in the onboarding email"],
  ["WEB-114", "open", "chore", 15, "Consolidate the button components"],
  ["WEB-115", "open", "question", 20, "Does the embed support SSO?", "tyrell.com"],
  ["WEB-116", "open", "bug", 1, "Footer overlaps content on small screens"],
  ["API-201", "open", "feature", 4, "Webhook retries with backoff"],
  ["API-202", "closed", "bug", 50, "Rate limiter counts OPTIONS requests"],
  ["API-203", "open", "chore", 70, "Drop the v1 pagination shim"],
  ["API-204", "open", "feature", 6, "Idempotency keys on POST /orders"],
  ["API-205", "closed", "bug", 14, "Orders endpoint returns 500 on empty cart", "cyberdyne.com"],
  ["API-206", "open", "chore", 9, "Rotate the staging signing key"],
  ["API-207", "open", "bug", 6, "Bulk import times out above 10k rows", "stark.com"],
  ["API-208", "open", "feature", 33, "GraphQL persisted queries"],
  ["API-209", "open", "bug", 2, "Timezone offset wrong in usage reports"],
  ["API-210", "closed", "chore", 3, "Bump the Postgres driver"],
  ["API-211", "open", "feature", 18, "Scoped API tokens"],
  ["API-212", "open", "bug", 11, "Refund endpoint ignores partial amounts", "acme.com"],
  ["MOB-301", "open", "feature", 5, "Offline mode for saved reports"],
  ["MOB-302", "closed", "bug", 40, "Crash on launch on Android 12"],
  ["MOB-303", "open", "chore", 7, "Migrate to the new push provider"],
  ["MOB-304", "open", "feature", 13, "Biometric unlock"],
  ["MOB-305", "open", "bug", 50, "Pull-to-refresh spinner never stops"],
  ["MOB-306", "closed", "bug", 1, "Settings toggle does not persist"],
  ["MOB-307", "open", "chore", 21, "Remove unused image assets"],
  ["MOB-308", "open", "feature", 16, "Share sheet for dashboards"],
  ["MOB-309", "open", "chore", 3, "Update the privacy manifest"],
  ["MOB-310", "open", "bug", 4, "Push notifications arrive twice", "wayne.com"],
];

const PROJECTS = {
  web: { key: "WEB", name: "Web" },
  api: { key: "API", name: "API" },
  mobile: { key: "MOB", name: "Mobile" },
} as const;

const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;
const DAY_MS = 86_400_000;

export interface TrackerState {
  issues: Issue[];
}

export function trackerState(now: number): TrackerState {
  const people = ["ana", "ben", "chioma", "dev", "eli"];
  return {
    issues: SEED.map(([id, status, label, ageDays, title, customer], index) => {
      const project = id.startsWith("WEB")
        ? "web"
        : id.startsWith("API")
          ? "api"
          : "mobile";
      return {
        id,
        project,
        title,
        status,
        labels: [label],
        ...(customer ? { customer } : {}),
        assignee: people[index % people.length]!,
        createdAt: new Date(now - (ageDays + 20) * DAY_MS).toISOString(),
        updatedAt: new Date(now - ageDays * DAY_MS).toISOString(),
        comments: [],
        ...(status === "closed" ? { closedBy: "seed" as const } : {}),
      };
    }),
  };
}

function summary(issue: Issue) {
  return {
    id: issue.id,
    project: issue.project,
    title: issue.title,
    status: issue.status,
    labels: issue.labels,
    ...(issue.customer ? { customer: issue.customer } : {}),
    assignee: issue.assignee,
    updatedAt: issue.updatedAt,
  };
}

function cursorOffset(cursor: unknown): number {
  if (typeof cursor !== "string" || !/^c\d+$/.test(cursor)) return 0;
  return Number(cursor.slice(1));
}

export function trackerTools(state: TrackerState, now: () => number): FakeTool[] {
  const find = (id: unknown) =>
    state.issues.find((issue) => issue.id === String(id).toUpperCase());
  return [
    {
      name: "list_projects",
      description: "List tracker projects with their keys and open issue counts.",
      input: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: () => ({
        json: {
          projects: Object.entries(PROJECTS).map(([id, project]) => ({
            id,
            ...project,
            openIssues: state.issues.filter(
              (issue) => issue.project === id && issue.status === "open",
            ).length,
          })),
        },
      }),
    },
    {
      name: "search_issues",
      description:
        "Search issues. Filters combine with AND. Results are sorted by id and paged with an opaque cursor.",
      input: z.object({
        project: z.enum(["web", "api", "mobile"]).optional().describe("Project id"),
        status: z.enum(["open", "closed"]).optional(),
        label: z.string().optional().describe("One label, e.g. bug, feature, chore"),
        customer: z.string().optional().describe("Customer domain, e.g. acme.com"),
        updatedBefore: z.string().optional().describe("ISO 8601 timestamp; only issues last updated before it"),
        text: z.string().optional().describe("Case-insensitive substring of the title"),
        limit: z.number().int().min(1).max(PAGE_MAX).optional().describe(`Page size, default ${PAGE_DEFAULT}, max ${PAGE_MAX}`),
        cursor: z.string().optional().describe("nextCursor from the previous page"),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: (args) => {
        const before =
          typeof args.updatedBefore === "string"
            ? Date.parse(args.updatedBefore)
            : undefined;
        if (before !== undefined && Number.isNaN(before)) {
          return { error: "updatedBefore must be an ISO 8601 timestamp" };
        }
        const text =
          typeof args.text === "string" ? args.text.toLowerCase() : undefined;
        const matches = state.issues.filter(
          (issue) =>
            (args.project === undefined || issue.project === args.project) &&
            (args.status === undefined || issue.status === args.status) &&
            (args.label === undefined || issue.labels.includes(String(args.label))) &&
            (args.customer === undefined || issue.customer === args.customer) &&
            (before === undefined || Date.parse(issue.updatedAt) < before) &&
            (text === undefined || issue.title.toLowerCase().includes(text)),
        );
        const offset = cursorOffset(args.cursor);
        const limit = typeof args.limit === "number" ? args.limit : PAGE_DEFAULT;
        const page = matches.slice(offset, offset + limit);
        const next = offset + limit < matches.length ? `c${offset + limit}` : undefined;
        return {
          json: {
            issues: page.map(summary),
            total: matches.length,
            ...(next ? { nextCursor: next } : {}),
          },
        };
      },
    },
    {
      name: "get_issue",
      description: "Get one issue with its comments.",
      input: z.object({ id: z.string().describe("Issue key, e.g. WEB-101") }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: (args) => {
        const issue = find(args.id);
        return issue
          ? { json: { ...summary(issue), createdAt: issue.createdAt, comments: issue.comments } }
          : { error: `issue ${String(args.id)} not found` };
      },
    },
    {
      name: "close_issue",
      description: "Close an issue, optionally leaving a closing comment.",
      input: z.object({
        id: z.string().describe("Issue key"),
        comment: z.string().optional().describe("Closing comment"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      run: (args) => {
        const issue = find(args.id);
        if (!issue) return { error: `issue ${String(args.id)} not found` };
        if (issue.status === "closed") {
          return { json: { id: issue.id, status: "closed", alreadyClosed: true } };
        }
        issue.status = "closed";
        issue.closedBy = "agent";
        issue.updatedAt = new Date(now()).toISOString();
        if (typeof args.comment === "string" && args.comment.trim()) {
          issue.comments.push({ author: "agent", body: args.comment, at: issue.updatedAt });
        }
        return { json: { id: issue.id, status: "closed" } };
      },
    },
    {
      name: "add_comment",
      description: "Add a comment to an issue.",
      input: z.object({ id: z.string(), body: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      run: (args) => {
        const issue = find(args.id);
        if (!issue) return { error: `issue ${String(args.id)} not found` };
        const at = new Date(now()).toISOString();
        issue.comments.push({ author: "agent", body: String(args.body), at });
        issue.updatedAt = at;
        return { json: { id: issue.id, comments: issue.comments.length } };
      },
    },
    {
      name: "create_issue",
      description: "Create an issue in a project.",
      input: z.object({
        project: z.enum(["web", "api", "mobile"]),
        title: z.string(),
        label: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      run: (args) => {
        const project = args.project as Issue["project"];
        const key = PROJECTS[project].key;
        const count = state.issues.filter((issue) => issue.project === project).length;
        const at = new Date(now()).toISOString();
        const issue: Issue = {
          id: `${key}-${(project === "web" ? 100 : project === "api" ? 200 : 300) + count + 1}`,
          project,
          title: String(args.title),
          status: "open",
          labels: args.label ? [String(args.label)] : [],
          createdAt: at,
          updatedAt: at,
          comments: [],
        };
        state.issues.push(issue);
        return { json: summary(issue) };
      },
    },
    {
      name: "delete_issue",
      description: "Permanently delete an issue.",
      input: z.object({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      run: (args) => {
        const index = state.issues.findIndex((issue) => issue.id === String(args.id).toUpperCase());
        if (index < 0) return { error: `issue ${String(args.id)} not found` };
        state.issues.splice(index, 1);
        return { json: { deleted: String(args.id) } };
      },
    },
  ];
}
