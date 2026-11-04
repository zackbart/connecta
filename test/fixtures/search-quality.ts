/**
 * Labelled lexical-search queries over every maintained provider's offline
 * catalog plus a deliberately lookalike-heavy fake deployment.
 *
 * Method: every query and label was written from the tool list alone, before
 * any ranking change and before any query's results were seen. Each query's
 * half is the FNV-1a hash of its text, except the four audit reproductions,
 * which are pinned to `tune` because their failures were already known. Tuning
 * inspected `tune` per query; `heldOut` was scored in aggregate only, once.
 *
 * `expect` lists every address that would genuinely answer the query. A hatch
 * belongs there only when no named tool performs the operation.
 */
import type { Connector, ToolDef } from "../../src/types.js";
import { connectorWith } from "./connectors.js";

const read = { readOnlyHint: true };
const write = { readOnlyHint: false, destructiveHint: true };
const fake = (id: string, tools: ToolDef[]): Connector => connectorWith({ id, kind: "api", tools });
const tool = (name: string, description: string, annotations: ToolDef["annotations"] = read, title?: string): ToolDef => ({
  name,
  description,
  annotations,
  inputSchema: { type: "object" },
  ...(title ? { title } : {}),
});

/** Near-identical names, tails that mention each other's words, one stuffed console and opaque titled tools. */
export const lookalikeConnectors = (): Connector[] => [
  fake("billing", [
    tool("list_subscriptions", "List a customer's subscriptions with plan, status and renewal date. Canceled subscriptions are excluded unless asked for."),
    tool("get_subscription", "Get one subscription by id with its plan, quantity and next invoice. Use update_subscription to change it."),
    tool("update_subscription", "Update a subscription's plan, quantity or renewal setting. Set cancelAtPeriodEnd to cancel it, or pauseCollection to pause billing.", write),
    tool("list_invoices", "List invoices for a customer, newest first. Each row carries the subscription it billed and any refund."),
    tool("get_invoice", "Get one invoice with its line items and payment status. Send it again with payments.send_invoice."),
    tool("create_credit_note", "Create a credit note against one paid invoice. Reduces what the customer owes without moving money.", write),
  ]),
  fake("payments", [
    tool("send_money", "Send money to a vendor's bank account. The customer or vendor receives an email with the receipt, and the customer record is updated with the transfer.", write),
    tool("send_invoice", "Send a finished invoice to its payer for payment. Delivery is by email or post; customer contact details come from the invoice.", write),
    tool("list_transfers", "List outgoing bank transfers with vendor, amount and status. Filter by date; email receipts are not included."),
    tool("get_transfer", "Get one bank transfer by id with its vendor and settlement date."),
  ]),
  fake("mailer", [
    tool("send_customer_email", "Send a one-off email to a customer from a template or plain text.", write),
    tool("send_campaign", "Send a marketing campaign to a segment. Each customer in it receives one email unless they unsubscribed.", write),
    tool("list_templates", "List reusable message templates with their subject lines. Use one when you send a customer email."),
    tool("get_delivery_status", "Get the delivery status of one sent message: queued, delivered, bounced or opened."),
  ]),
  fake("support", [
    tool("search", "Search the whole workspace. Covers conversations, contacts, users, companies and articles, so one query can find a conversation with a user, a contact, or a company."),
    tool("search_conversations", "Search support conversations by status, assignee or participant."),
    tool("get_conversation", "Get one conversation with its messages and who started it."),
    tool("reply_to_conversation", "Post a reply to one open conversation as the signed-in teammate. The customer is notified by email.", write),
    tool("search_contacts", "Search contacts by name or email address."),
    tool("get_contact", "Get one contact's profile, including their email address, company and tags."),
    tool("create_contact", "Create a new contact with a name and optional email address.", write),
    tool("list_articles", "List published knowledge base articles with their titles and collections."),
  ]),
  fake("tickets", [
    tool("get_ticket", "Get one ticket with its subject, status and assignee."),
    tool("get_ticket_status", "Get only a ticket's current status. Use get_ticket for its comments, assignee and history."),
    tool("get_ticket_history", "Get a ticket's change log: every status change, assignment and comment event."),
    tool("list_tickets", "List tickets in a queue, newest first. Closed tickets are hidden unless asked for; assign and comment with other tools."),
    tool("search_tickets", "Search tickets by text, requester or tag."),
    tool("list_ticket_comments", "List the comments on one ticket, oldest first."),
    tool("add_ticket_comment", "Add a comment to one ticket, public or internal. The requester is emailed when it is public.", write),
    tool("update_ticket", "Update a ticket's subject, priority or tags. To close it or assign it, use the dedicated tools; agents see the change at once.", write),
    tool("close_ticket", "Close one ticket with a resolution note.", write),
    tool("assign_ticket", "Assign one ticket to an agent or a group.", write),
    tool("merge_tickets", "Merge duplicate tickets into one, keeping every comment.", write),
  ]),
  fake("calendar", [
    tool("list_calendars", "List the calendars this user can see, with their ids and colors."),
    tool("list_events", "List events on one calendar between two dates. Free time is not included; recurring events are expanded."),
    tool("get_event", "Get one calendar event with its attendees and video link."),
    tool("create_event", "Create an event on a calendar and invite attendees.", write),
    tool("update_event", "Change an event's time, title or attendees. Attendees are notified.", write),
    tool("delete_event", "Delete one event and tell its attendees.", write),
    tool("find_free_time", "Find when a set of people are all free in a date range."),
  ]),
  fake("admin", [
    tool(
      "admin_console",
      "Administer the workspace. Manage users, passwords, invoices, tickets, calendars, emails, conversations, audit logs, backups, repositories, organization settings, articles, refunds, subscriptions, deployments, spreadsheets, documents, donors, events, groups, and teams from one place. Reports, exports and configuration are all reachable here, as is anything else an administrator might want to find, create, update, delete, send or list.",
      write,
    ),
    tool("reset_password", "Send a password reset link to one user.", write),
    tool("list_users", "List workspace users with their roles and last sign-in."),
    tool("get_org_config", "Read the organization's settings: name, domain, sign-in policy and retention."),
  ]),
  fake("audit", [
    tool("op_1042", "Runs the requested operation.", read, "Export audit log"),
    tool("op_1043", "Runs the requested operation.", write, "Rotate signing key"),
    tool("op_1044", "Runs the requested operation.", read, "Count failed sign-ins"),
  ]),
  fake("code", [
    tool("list_repo_branches", "List a repo's branches with their head commits and protection state."),
    tool("get_repo", "Get one repo's description, default branch and visibility."),
    tool("list_repo_collaborators", "List who can push to a repo, with their permission level."),
  ]),
  fake("infra", [
    tool("create_db_backup", "Start a backup of one db instance. Storage is billed by size.", write),
    tool("list_db_instances", "List db instances with their engine, size and region."),
    tool("get_env_config", "Get the settings of one deploy target by name."),
  ]),
];

export interface LabelledQuery {
  query: string;
  /** Addresses that genuinely answer the query. */
  expect: readonly string[];
  /** Pinned to `tune` because the audit already published its failure. */
  audit?: true;
}

export const LABELLED_QUERIES: readonly LabelledQuery[] = [
  // Audit reproductions, known before this fixture existed.
  { query: "cancel a subscription", expect: ["billing.update_subscription", "stripe.stripe_api_search"], audit: true },
  { query: "send a customer email", expect: ["mailer.send_customer_email"], audit: true },
  { query: "find a conversation with a user", expect: ["support.search_conversations"], audit: true },
  { query: "vercel environment variables", expect: ["vercel.list_project_env_vars"], audit: true },
  // Maintained providers: named tools.
  { query: "list upcoming service plans", expect: ["planning-center.list_plans"] },
  { query: "who attended a church event", expect: ["ccb.list_event_attendees", "breeze.list_attendance"] },
  { query: "replace text in a google doc", expect: ["docs.replace_all_text"] },
  { query: "add a row to a spreadsheet", expect: ["sheets.append_values"] },
  { query: "read cell values from a sheet", expect: ["sheets.get_values"] },
  { query: "share a drive file with someone", expect: ["drive.share_file"] },
  { query: "restore a deleted file from trash", expect: ["drive.restore_file"] },
  { query: "download email attachment", expect: ["gmail.get_attachment"] },
  { query: "search email threads", expect: ["gmail.search_threads"] },
  { query: "draft a reply to an email", expect: ["gmail.create_draft"] },
  { query: "profit and loss report", expect: ["quickbooks.get_report"] },
  { query: "create a customer invoice", expect: ["quickbooks.create_invoice"] },
  { query: "recurring donations for a donor", expect: ["tithely.list_recurring_charges", "overflow.list_subscriptions"] },
  { query: "list refunds", expect: ["overflow.list_refunds"] },
  { query: "card chargebacks and disputes", expect: ["overflow.list_chargebacks"] },
  { query: "stripe account balance", expect: ["stripe.get_balance_summary"] },
  { query: "deployment build logs", expect: ["vercel.get_deployment_build_logs"] },
  { query: "runtime logs for a deployment", expect: ["vercel.get_runtime_logs"] },
  { query: "merge a pull request", expect: ["github.merge_pull_request"] },
  { query: "search github code", expect: ["github.search_scoped"] },
  { query: "list cloudflare zones", expect: ["cloudflare.list_zones"] },
  { query: "add a comment to a slide", expect: ["slides.create_comment"] },
  { query: "slide thumbnail image", expect: ["slides.get_slide_thumbnail"] },
  { query: "submitted form responses", expect: ["forms.list_responses"] },
  { query: "add a question to a form", expect: ["forms.batch_update_form"] },
  { query: "schedule a volunteer on a team", expect: ["planning-center.schedule_plan_person"] },
  { query: "add a person to a group", expect: ["planning-center.add_group_member"] },
  { query: "notes on a person's profile", expect: ["planning-center.list_person_notes", "ccb.list_individual_notes"] },
  { query: "find a family by last name", expect: ["ccb.list_families"] },
  { query: "giving funds list", expect: ["breeze.list_funds", "planning-center.list_funds"] },
  { query: "who has access to this drive file", expect: ["drive.list_permissions"] },
  { query: "create a new folder", expect: ["drive.create_folder"] },
  { query: "move a file to another folder", expect: ["drive.move_file"] },
  { query: "append text to document", expect: ["docs.append_text"] },
  { query: "list bank deposits", expect: ["overflow.list_deposits"] },
  { query: "verify api token is valid", expect: ["cloudflare.verify_credential"] },
  { query: "analytics graphql query", expect: ["cloudflare.graphql_query"] },
  { query: "list gmail labels", expect: ["gmail.list_labels"] },
  { query: "workflow cards for a person", expect: ["planning-center.list_workflow_cards"] },
  { query: "donor giving history", expect: ["tithely.list_charges", "overflow.list_contributions", "ccb.get_giving_metrics"] },
  { query: "upload a worker script", expect: ["cloudflare.cloudflare_api_upload"] },
  { query: "list teams", expect: ["vercel.list_teams", "planning-center.list_teams"] },
  { query: "add a new tab to a spreadsheet", expect: ["sheets.add_sheet"] },
  // Maintained providers: no named tool, so the hatch is the answer.
  { query: "dns records for a domain", expect: ["cloudflare.cloudflare_api_search"] },
  { query: "create a stripe refund", expect: ["stripe.stripe_api_search"] },
  { query: "open a github issue", expect: ["github.github_api_search"] },
  { query: "granola meeting notes", expect: ["granola.granola_api_search"] },
  // Lookalike-heavy fake deployment.
  { query: "close a support ticket", expect: ["tickets.close_ticket"] },
  { query: "ticket comments", expect: ["tickets.list_ticket_comments"] },
  { query: "assign ticket to an agent", expect: ["tickets.assign_ticket"] },
  { query: "what status is this ticket in", expect: ["tickets.get_ticket_status"] },
  { query: "export audit log", expect: ["audit.op_1042"] },
  { query: "rotate the signing key", expect: ["audit.op_1043"] },
  { query: "create calendar event", expect: ["calendar.create_event"] },
  { query: "when is everyone free", expect: ["calendar.find_free_time"] },
  { query: "send money to a vendor", expect: ["payments.send_money"] },
  { query: "send an invoice", expect: ["payments.send_invoice"] },
  { query: "pause a subscription", expect: ["billing.update_subscription"] },
  { query: "contact email address", expect: ["support.get_contact", "support.search_contacts"] },
  { query: "knowledge base articles", expect: ["support.list_articles"] },
  { query: "reset user password", expect: ["admin.reset_password"] },
  { query: "organization settings", expect: ["admin.get_org_config"] },
  { query: "list repository branches", expect: ["code.list_repo_branches"] },
  { query: "database backup", expect: ["infra.create_db_backup"] },
  { query: "merge duplicate tickets", expect: ["tickets.merge_tickets"] },
  { query: "credit note for an invoice", expect: ["billing.create_credit_note"] },
  { query: "has my email been delivered", expect: ["mailer.get_delivery_status"] },
];

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export const queryHalf = (entry: LabelledQuery): "tune" | "heldOut" =>
  entry.audit || fnv1a(entry.query) % 2 === 0 ? "tune" : "heldOut";

/** Mean reciprocal rank and top-3 count of labelled answers across ranked address pages. */
export function rankingScore(
  entries: readonly LabelledQuery[],
  pages: ReadonlyMap<string, readonly string[]>,
): { queries: number; mrr: number; top3: number; top8: number } {
  let reciprocal = 0;
  let top3 = 0;
  let top8 = 0;
  for (const entry of entries) {
    const page = pages.get(entry.query) ?? [];
    const position = page.findIndex((address) => entry.expect.includes(address));
    if (position < 0) continue;
    reciprocal += 1 / (position + 1);
    if (position < 3) top3 += 1;
    if (position < 8) top8 += 1;
  }
  return { queries: entries.length, mrr: entries.length ? reciprocal / entries.length : 0, top3, top8 };
}
