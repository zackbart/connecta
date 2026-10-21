import { tithely } from "../../../src/providers/tithely/index.js";
import { defineGoldenSpec } from "../harness.js";

const ORGANIZATION = {
  organization_id: "org_1",
  widget_id: "999",
  account_id: "user_owner",
  created_date: "1493928837",
  name: "Grace Church",
  phone_number: "5551231234",
  website: "https://grace.example",
  address: { street_address: "1 Main St", city: "Nashville", state: "TN", postal: "37209", country: "US" },
  giving_types: ["Tithe", "Missions", "Building"],
  giving_types_full: [
    { id: "10", name: "Tithe", status: "1" },
    { id: "11", name: "Missions", status: "2" },
    { id: "12", name: "Building", status: "0" },
  ],
  bank: { account_number_last4: "6789", name: "TEST BANK", country: "US", currency: "USD" },
  legal: { entity_type: "organization", first_name: "Mike", last_name: "Rogers", date_of_birth: "5/23/1985" },
};

const DONOR = {
  account_id: "user_jane",
  created_date: "1487792831",
  email: "jane@example.com",
  first_name: "Jane",
  last_name: "Doe",
  phone_number: "5555551234",
  address: { street_address: "2 Elm", city: "Nashville", state: "TN", postal: "37209", country: "US" },
};

const PAYMENT_METHOD = {
  pm_id: "pm_9",
  last_4_digits: "4242",
  brand: "Visa",
  pm_type: "card",
  account_id: "user_jane",
};

const CHARGE = {
  charge_status: "charged",
  amount: "2500",
  net_amount: "2397",
  fees: "103",
  currency: "USD",
  giving_type: "Tithe",
  charge_date: "1497638090",
  deposit_date: "pending",
  recurring_transaction: false,
  fees_covered: true,
  organization: ORGANIZATION,
  donor_account: DONOR,
  payment_method: PAYMENT_METHOD,
};

const RECURRING = {
  amount: "1000",
  currency: "USD",
  giving_type: "Missions",
  start_date: "1497632472",
  term: "monthly",
  organization: ORGANIZATION,
  donor_account: DONOR,
};

const list = (data: unknown[]) => [{ body: { status: "success", type: "List", data } }];

export default defineGoldenSpec({
  provider: "tithely",
  create: () => tithely("giving", { purpose: "Weekly giving reports for Grace Church", environment: "live" }),
  credential: { publicKey: "pub_golden_public_key/+=", privateKey: "pri_golden_private_key/+=" },
  basic: [["publicKey", "privateKey"]],
  failureReply: (status, message) => ({ status, body: { status: "fail", reason: message } }),
  calls: [
    {
      tool: "tithely_api_get",
      args: { path: "/payment-methods/pm_9", query: [{ name: "account_id", value: "user_jane" }] },
      replies: [{ body: { status: "success", pm_id: "pm_9", type: "Payment Method", object: PAYMENT_METHOD } }],
    },
    {
      tool: "tithely_api_mutate",
      args: {
        method: "POST",
        path: "/charges",
        form: [
          { name: "account_id", value: "user_jane" },
          { name: "pm_id", value: "pm_9" },
          { name: "organization_id", value: "org_1" },
          { name: "amount", value: 2555 },
          { name: "giving_type", value: "Tithe" },
        ],
      },
      replies: [{ body: { status: "success", charge_id: "ch_new", type: "Charge", object: CHARGE } }],
    },
    {
      label: "tithely_api_mutate DELETE",
      tool: "tithely_api_mutate",
      args: { method: "DELETE", path: "/payment-methods/pm_9", query: [{ name: "account_id", value: "user_jane" }] },
      replies: [{ body: { status: "success", note: "Payment method removed." } }],
    },
    { tool: "list_organizations", args: { limit: 5 }, replies: list([ORGANIZATION]) },
    {
      tool: "get_organization",
      args: { organizationId: "org_1" },
      replies: [{ body: { status: "success", organization_id: "org_1", type: "Organization", object: ORGANIZATION } }],
    },
    { tool: "list_accounts", replies: list([DONOR]) },
    {
      tool: "get_account",
      args: { accountId: "user_jane" },
      replies: [{ body: { status: "success", account_id: "user_jane", type: "Account", object: DONOR } }],
    },
    {
      tool: "list_charges",
      args: { organizationId: "org_1", limit: 1, createdAfter: "2026-01-01" },
      replies: list([
        { ...CHARGE, charge_id: "ch_1" },
        { ...CHARGE, charge_id: "ch_2" },
      ]),
    },
    {
      tool: "get_charge",
      args: { chargeId: "ch_1" },
      replies: [{ body: { status: "success", charge_id: "ch_1", type: "Charge", object: CHARGE } }],
    },
    {
      tool: "list_recurring_charges",
      args: { organizationId: "org_1" },
      replies: list([{ ...RECURRING, recurring_id: "rc_1" }]),
    },
    {
      tool: "get_recurring_charge",
      args: { recurringId: "rc_1" },
      replies: [{ body: { status: "success", recurring_id: "rc_1", type: "Recurring", object: RECURRING } }],
    },
    { tool: "list_payment_methods", args: { accountId: "user_jane" }, replies: list([PAYMENT_METHOD]) },
  ],
  echo: {
    tool: "tithely_api_get",
    args: { path: "/payment-methods/pm_9", query: [{ name: "account_id", value: "user_jane" }] },
    replies: (text) => [
      {
        body: { status: "success", pm_id: "pm_9", type: "Payment Method", object: { ...PAYMENT_METHOD, brand: text } },
      },
    ],
  },
  failures: {
    read: { tool: "get_charge", args: { chargeId: "ch_1" } },
    write: {
      tool: "tithely_api_mutate",
      args: { method: "POST", path: "/charges", form: [{ name: "account_id", value: "user_jane" }] },
    },
  },
});
