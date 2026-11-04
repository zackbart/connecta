/**
 * Fake catalogs for the presentation arms. Graders read only the shared ledger,
 * so a saved trial regrades without restoring any state from these services.
 *
 * - `payments` and `crm` are look-alike connector pairs: identical tool lists,
 *   overlapping records and ids that do not say which is which. An agent can
 *   always find out from `get_account_info` or `get_workspace_info`.
 * - `clones` is four regional tenants with 43 exactly identical tools each, 172
 *   rows, the shape of a real pool's clones. Records differ by tenant.
 */
import { z } from "zod";
import { FakeService, type FakeTool, type Ledger } from "./service.js";

export type PresentationFake = "payments" | "crm" | "clones";

export interface PresentationService {
  service: FakeService;
  title: string;
  description: string;
  purpose: string;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };

interface Charge {
  id: string;
  amountCents: number;
  createdAt: string;
  status: "succeeded";
}

function paymentTools(environment: "sandbox" | "production", customerId: string, charges: Charge[]): FakeTool[] {
  const refunds: { id: string; chargeId: string; amountCents: number; reason: string }[] = [];
  return [
    {
      name: "get_account_info",
      description: "Describe this payments account and the environment it runs in.",
      input: z.object({}),
      annotations: READ,
      run: () => ({ json: { environment, currency: "usd", realMoney: environment === "production" } }),
    },
    {
      name: "search_customers",
      description: "Find customers by exact email address.",
      input: z.object({ email: z.string(), limit: z.number().int().min(1).max(50).optional() }),
      annotations: READ,
      run: ({ email }) => ({
        json: {
          customers: email === "dana@example.com" ? [{ id: customerId, name: "Dana Reyes", email }] : [],
        },
      }),
    },
    {
      name: "list_charges",
      description: "List a customer's charges, newest first.",
      input: z.object({
        customerId: z.string(),
        status: z.enum(["succeeded", "failed", "refunded"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: READ,
      run: ({ customerId: id, status }) => ({
        json: { charges: id === customerId && (!status || status === "succeeded") ? charges : [] },
      }),
    },
    {
      name: "create_refund",
      description: "Refund a charge. Each successful call moves money once.",
      input: z.object({
        chargeId: z.string(),
        amountCents: z.number().int().min(1),
        reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]),
      }),
      annotations: WRITE,
      run: ({ chargeId, amountCents, reason }) => {
        if (!charges.some((charge) => charge.id === chargeId)) return { error: `No such charge ${String(chargeId)}` };
        const refund = {
          id: `re_${String(chargeId).slice(3)}`,
          chargeId: String(chargeId),
          amountCents: Number(amountCents),
          reason: String(reason),
        };
        refunds.push(refund);
        return { json: refund };
      },
    },
    {
      name: "list_refunds",
      description: "List refunds issued against a charge.",
      input: z.object({ chargeId: z.string() }),
      annotations: READ,
      run: ({ chargeId }) => ({ json: { refunds: refunds.filter((refund) => refund.chargeId === chargeId) } }),
    },
  ];
}

interface CrmAccount {
  id: string;
  name: string;
  seats: number;
  plan: string;
  renewalDate: string;
}

function crmTools(segment: "small-business" | "enterprise", accounts: CrmAccount[]): FakeTool[] {
  const notes: { id: string; accountId: string; body: string }[] = [];
  return [
    {
      name: "get_workspace_info",
      description: "Describe this CRM workspace and the accounts it holds.",
      input: z.object({}),
      annotations: READ,
      run: () => ({ json: { segment, accountCount: accounts.length } }),
    },
    {
      name: "search_accounts",
      description: "Find accounts by a name fragment.",
      input: z.object({ name: z.string(), limit: z.number().int().min(1).max(50).optional() }),
      annotations: READ,
      run: ({ name }) => ({
        json: {
          accounts: accounts
            .filter((account) => account.name.toLowerCase().includes(String(name).toLowerCase()))
            .map(({ id, name: accountName }) => ({ id, name: accountName })),
        },
      }),
    },
    {
      name: "get_account",
      description: "Read one account's plan, seat count and contract renewal date.",
      input: z.object({ accountId: z.string() }),
      annotations: READ,
      run: ({ accountId }) => {
        const account = accounts.find((candidate) => candidate.id === accountId);
        return account ? { json: account } : { error: `No such account ${String(accountId)}` };
      },
    },
    {
      name: "add_account_note",
      description: "Add one note to an account.",
      input: z.object({ accountId: z.string(), body: z.string(), pinned: z.boolean().optional() }),
      annotations: WRITE,
      run: ({ accountId, body }) => {
        if (!accounts.some((account) => account.id === accountId))
          return { error: `No such account ${String(accountId)}` };
        const note = {
          id: `note_${String(accountId).slice(4)}_${notes.length + 1}`,
          accountId: String(accountId),
          body: String(body),
        };
        notes.push(note);
        return { json: note };
      },
    },
    {
      name: "list_account_notes",
      description: "List the notes on an account.",
      input: z.object({ accountId: z.string() }),
      annotations: READ,
      run: ({ accountId }) => ({ json: { notes: notes.filter((note) => note.accountId === accountId) } }),
    },
  ];
}

const OBJECTS = ["contact", "account", "invoice", "ticket", "deal", "note"];
const VERBS = ["list", "get", "search", "create", "update", "archive", "export"];
const LIFECYCLE = z.enum(["open", "pending", "closed"]);

interface Tenant {
  region: string;
  contacts: { id: string; name: string; email: string }[];
  invoices: { invoiceNumber: string; status: string; balanceCents: number; contactId: string }[];
  /** Open high-priority tickets; a matching number of low-priority and closed ones are decoys. */
  highOpen: number;
}

const TENANTS: Tenant[] = [
  {
    region: "north",
    contacts: [
      { id: "con_n1", name: "Dana Reyes", email: "dana@example.com" },
      { id: "con_n7", name: "Omar Haddad", email: "omar@example.com" },
    ],
    invoices: [{ invoiceNumber: "INV-2044", status: "open", balanceCents: 94100, contactId: "con_n7" }],
    highOpen: 3,
  },
  {
    region: "south",
    contacts: [
      { id: "con_s1", name: "Dana Reyes", email: "dana@example.com" },
      { id: "con_s7", name: "Mei Tanaka", email: "mei@example.com" },
    ],
    invoices: [{ invoiceNumber: "INV-2044", status: "paid", balanceCents: 0, contactId: "con_s7" }],
    highOpen: 5,
  },
  {
    region: "east",
    contacts: [
      { id: "con_e1", name: "Dana Reyes", email: "dana@example.com" },
      { id: "con_e7", name: "Lars Berg", email: "lars@example.com" },
    ],
    invoices: [{ invoiceNumber: "INV-2044", status: "open", balanceCents: 30075, contactId: "con_e7" }],
    highOpen: 2,
  },
  {
    region: "west",
    contacts: [
      { id: "con_w1", name: "Dana Reyes", email: "dana@example.com" },
      { id: "con_w7", name: "Priya Nair", email: "priya@example.com" },
    ],
    invoices: [{ invoiceNumber: "INV-2044", status: "open", balanceCents: 18250, contactId: "con_w7" }],
    highOpen: 4,
  },
];

function tickets(tenant: Tenant) {
  const row = (index: number, priority: string, status: string) => ({
    id: `TCK-${tenant.region.slice(0, 1).toUpperCase()}${index}`,
    priority,
    status,
  });
  return [
    ...Array.from({ length: tenant.highOpen }, (_, index) => row(index + 1, "high", "open")),
    row(20, "low", "open"),
    row(21, "high", "closed"),
  ];
}

/** The same 43 definitions for every tenant; only the closures' records differ. */
function cloneTools(tenant: Tenant): FakeTool[] {
  const created: { id: string; contactId: string; body: string }[] = [];
  const empty = () => ({ json: { records: [], revision: 1 } });
  const special: Record<string, Pick<FakeTool, "description" | "input" | "run">> = {
    search_contacts: {
      description: "Find contacts by email address or name fragment.",
      input: z.object({ email: z.string().optional(), name: z.string().optional() }),
      run: ({ email, name }) => ({
        json: {
          contacts: tenant.contacts.filter(
            (contact) =>
              (email === undefined || contact.email === email) &&
              (name === undefined || contact.name.toLowerCase().includes(String(name).toLowerCase())),
          ),
        },
      }),
    },
    get_contact: {
      description: "Read one contact by id.",
      input: z.object({ contactId: z.string() }),
      run: ({ contactId }) => {
        const contact = tenant.contacts.find((candidate) => candidate.id === contactId);
        return contact ? { json: contact } : { error: `No such contact ${String(contactId)}` };
      },
    },
    get_invoice: {
      description: "Read one invoice by its number, including its status, balance and billing contact id.",
      input: z.object({ invoiceNumber: z.string() }),
      run: ({ invoiceNumber }) => {
        const invoice = tenant.invoices.find((candidate) => candidate.invoiceNumber === invoiceNumber);
        return invoice ? { json: invoice } : { error: `No such invoice ${String(invoiceNumber)}` };
      },
    },
    list_tickets: {
      description: "List support tickets, optionally filtered by status and priority.",
      input: z.object({
        status: LIFECYCLE.optional(),
        priority: z.enum(["low", "normal", "high"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      run: ({ status, priority }) => ({
        json: {
          tickets: tickets(tenant).filter(
            (ticket) =>
              (status === undefined || ticket.status === status) &&
              (priority === undefined || ticket.priority === priority),
          ),
        },
      }),
    },
    create_note: {
      description: "Add one note to a contact.",
      input: z.object({ contactId: z.string(), body: z.string(), pinned: z.boolean().optional() }),
      run: ({ contactId, body }) => {
        if (!tenant.contacts.some((contact) => contact.id === contactId))
          return { error: `No such contact ${String(contactId)}` };
        const note = {
          id: `note_${String(contactId).slice(4)}_${created.length + 1}`,
          contactId: String(contactId),
          body: String(body),
        };
        created.push(note);
        return { json: note };
      },
    },
  };
  const named = OBJECTS.flatMap((object) =>
    VERBS.map((verb) => {
      const plural = verb === "list" || verb === "search" || verb === "export";
      const name = `${verb}_${object}${plural ? "s" : ""}`;
      const read = verb === "list" || verb === "get" || verb === "search" || verb === "export";
      return {
        name,
        annotations: read ? READ : WRITE,
        ...(special[name] ?? {
          description: `${verb} ${object} records in this CRM workspace.`,
          input: z.object(
            read
              ? { cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }
              : { id: z.string().optional(), fields: z.record(z.string(), z.string()).optional() },
          ),
          run: empty,
        }),
      } satisfies FakeTool;
    }),
  );
  return [
    {
      name: "get_workspace_info",
      description: "Describe this CRM workspace.",
      input: z.object({}),
      annotations: READ,
      run: () => ({ json: { region: tenant.region } }),
    },
    ...named,
  ];
}

export function presentationServices(fake: PresentationFake, ledger: Ledger): PresentationService[] {
  const entry = (id: string, tools: FakeTool[], title: string, description: string, purpose: string) => ({
    service: new FakeService(id, description, tools, ledger),
    title,
    description,
    purpose,
  });
  if (fake === "payments")
    return [
      entry(
        "payments_a",
        paymentTools("sandbox", "cus_8101", [
          { id: "ch_8201", amountCents: 4800, createdAt: "2026-10-14T09:02:11Z", status: "succeeded" },
          { id: "ch_8202", amountCents: 4800, createdAt: "2026-10-14T09:02:43Z", status: "succeeded" },
        ]),
        "payments_a",
        "Payments account",
        "Sandbox test data; never use for real customers",
      ),
      entry(
        "payments_b",
        paymentTools("production", "cus_4401", [
          { id: "ch_4431", amountCents: 4800, createdAt: "2026-10-14T09:02:11Z", status: "succeeded" },
          { id: "ch_4432", amountCents: 4800, createdAt: "2026-10-14T09:02:43Z", status: "succeeded" },
        ]),
        "payments_b",
        "Payments account",
        "Production: real customers and real money",
      ),
    ];
  if (fake === "crm")
    return [
      entry(
        "crm_a",
        crmTools("small-business", [
          { id: "acc_311", name: "Northwind Traders", seats: 14, plan: "team", renewalDate: "2026-12-01" },
        ]),
        "crm_a",
        "Customer records",
        "Self-serve small-business accounts under 100 seats",
      ),
      entry(
        "crm_b",
        crmTools("enterprise", [
          { id: "acc_907", name: "Northwind Traders", seats: 450, plan: "enterprise", renewalDate: "2027-03-15" },
        ]),
        "crm_b",
        "Customer records",
        "Enterprise accounts with contracts of 100+ seats",
      ),
    ];
  return TENANTS.map((tenant) =>
    entry(
      `crm_${tenant.region}`,
      cloneTools(tenant),
      `CRM ${tenant.region} region`,
      "Regional customer records",
      `Customer records for the ${tenant.region} region`,
    ),
  );
}
