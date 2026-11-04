/**
 * Search metadata for the eval's fake catalogs. An isolated writer produced this
 * from tool names and descriptions alone, without any task prompt, so a hint
 * arm cannot be tuned to the tasks it is measured on. Claude Code has no
 * stemming, so inflected forms are spelled out.
 */
const TOOLS: Record<string, string> = {
  "tracker.list_projects": "boards, teams, workspaces, codebases overview with keys and open ticket bug totals",
  "tracker.search_issues": "find, finding, lookup, query tickets, bugs, tasks, filter, filtered, browse by criteria",
  "tracker.get_issue": "view, read, open single ticket, bug or task details with discussion thread",
  "tracker.close_issue": "resolve, resolved, finish, complete, mark done a ticket, bug or task",
  "tracker.add_comment": "reply, note, remark, annotate, respond, discuss, write on ticket, bug or task",
  "tracker.create_issue": "file, open, report, log, new ticket, bug or task, raise a problem",
  "tracker.delete_issue": "remove, erase, destroy, purge, wipe a ticket, bug or task forever, irreversible",
  "chat.list_channels": "rooms, groups, conversations, team spaces, show, browse available places to talk",
  "chat.read_messages": "latest chat history, recent posts, conversation, discussion, see what people said",
  "chat.post_message": "send, sending, say, announce, notify, share, write text into a room",
  "analytics.list_accounts":
    "customers, clients, companies, organizations, tenants with domains and pricing plans, paged browse",
  "analytics.get_account_metrics":
    "revenue, income, mrr, arr, usage, consumption, stats, numbers for one customer, client",
  "billing.find_customer": "lookup, search, locate payer, client, company by partial name match in billing",
  "billing.list_invoices": "bills, charges, statements, overdue, unpaid, paid, open, past due, voided status",
  "billing.void_invoice": "cancel, cancelling, cancelled, annul, nullify, invalidate, reverse an open bill, charge",
  "ci.list_runs": "builds, pipelines, workflows, recent build history, continuous integration test activity",
  "ci.get_run": "build, pipeline, workflow status, result, passed, failed, counts, summary of one",
  "ci.get_run_log": "build output, console, failure, failed, failing, errors, stack trace, full plain text",
  "ci.rerun_job": "retry, retrying, retrigger, restart, rebuild, run again, kick off failed build, pipeline",
  "audit.export_events": "download, dump, activity history, security trail, who did what, time range, billable",
  "audit.list_exports": "previous, past, prior download dump jobs, already created, metadata, activity trail history",
  "revenuecat.list-projects": "apps, workspaces, production subscription accounts, ids, browse available environments",
  "revenuecat.list-subscriptions":
    "subscribers, entitlement, entitlements, paying users, active access, membership, plain text report",
  "supabase.list_projects":
    "database references, refs, instances, production databases, postgres, available environments",
  "supabase.execute_sql": "run query, select, postgres, database tables, orders, rows, read only production data",
  "assets.get_badge": "launch logo, icon, picture, png file data, caption, json for scripts",
  "assets.get_badge_image": "launch logo, icon, picture, png, show, view, display inline visual with text",
};
const PADDING_VERBS: Record<string, string> = {
  "list": "show, browse, enumerate, all",
  "get": "fetch, retrieve, read, view, lookup",
  "search": "find, lookup, query, filter",
  "create": "add, new, make, file",
  "update": "edit, change, modify, set",
  "archive": "hide, retire, shelve, remove",
  "export": "download, dump, extract, save",
  "reconcile": "match, balance, compare, sync",
};
const PADDING_OBJECTS: Record<string, string> = {
  "issues": "tickets, bugs, tasks, problems",
  "invoices": "bills, charges, payments, statements",
  "messages": "posts, chats, notes, texts",
  "customers": "clients, accounts, buyers, companies",
  "logs": "output, traces, history, errors",
  "subscriptions": "plans, memberships, subscribers, renewals",
  "records": "entries, rows, documents, data",
  "campaigns": "promotions, ads, outreach, blasts",
};

/** A hint for a catalog address; padded tools combine their verb and object synonyms. */
export function searchHintFor(address: string): string | undefined {
  const exact = TOOLS[address];
  if (exact) return exact;
  const padded = /^[a-z_]+\.([a-z]+)_([a-z]+)_\d+$/.exec(address);
  if (!padded) return undefined;
  const verb = PADDING_VERBS[padded[1]!];
  const object = PADDING_OBJECTS[padded[2]!];
  return verb && object ? `${verb}, ${object}` : undefined;
}
