import { breeze } from "../../../src/providers/breeze/index.js";
import { defineGoldenSpec, type StubResponse } from "../harness.js";

// Breeze labels its JSON text/html; the provider parses text whatever the type.
const HTML = { "content-type": "text/html; charset=UTF-8" };
const reply = (body: unknown): StubResponse[] => [{ body, headers: HTML }];

const PERSON = {
  id: "157857",
  first_name: "Thomas",
  force_first_name: "Tom",
  last_name: "Anderson",
  nick_name: "",
  middle_name: "J",
  thumb_path: "",
  path: "img/profiles/generic/blue.jpg",
  details: { "1508481877": [{ address: "thomas@example.com" }] },
  family: [
    {
      person_id: "157858",
      family_id: "9",
      role_name: "Spouse",
      details: { id: "157858", first_name: "Trinity", last_name: "Anderson", path: "x" },
    },
  ],
};

const CONTRIBUTION = {
  id: "378477",
  paid_on: "2022-03-05 00:00:00",
  num: "144",
  method: "check",
  method_id: "41",
  amount: "0.10",
  note: "",
  person_id: "157857",
  first_name: "Thomas",
  last_name: "Anderson",
  envelope_number: "105",
  meta: null,
  funds: [{ fund_id: "28", amount: "0.10", fund_name: "General Fund", tax_deductible: "1", oid: "2749" }],
};

export default defineGoldenSpec({
  provider: "breeze",
  create: () => breeze("church", { subdomain: "gracechurch", purpose: "Pastoral care and giving reports" }),
  credential: "golden-breeze-api-key/123+4567=",
  // Breeze's failures are short plain text (or an HTML page), labelled text/html.
  failureReply: (status, message) => ({ status, text: message, headers: HTML }),
  calls: [
    { tool: "breeze_api_search", args: { query: "people" } },
    { tool: "breeze_api_details", args: { method: "GET", path: "/people" } },
    {
      tool: "breeze_api_read",
      args: { "path": "/people/157857", "query": { "details": 1 } },
      replies: reply({ id: "157857", first_name: "Thomas", last_name: "Anderson" }),
    },
    {
      label: "breeze_api_read filter_json",
      tool: "breeze_api_read",
      args: { "path": "/people/", "query": { "filter_json": '{"tag_contains":"y_9"}' } },
      replies: reply([{ id: "1", first_name: "Thomas", last_name: "Anderson" }]),
    },
    {
      tool: "breeze_api_write",
      args: { "path": "/giving/delete", "query": { "payment_id": "56789123" }, "method": "GET" },
      replies: reply({ success: true, errors: null, payment_id: 56789123 }),
    },
    {
      tool: "get_account_summary",
      args: {},
      replies: reply({
        id: "1234",
        name: "Grace Church",
        subdomain: "gracechurch",
        status: "1",
        created_on: "2014-09-10 09:19:35",
        details: {
          timezone: "America/New_York",
          country: { id: "2", name: "United States of America", currency: "USD", currency_symbol: "$" },
        },
      }),
    },
    {
      tool: "list_people",
      args: { "tagId": "16681", "filter": { "2000138015": "226-227" }, "limit": 2 },
      replies: reply([
        {
          id: "1",
          first_name: "Thomas",
          force_first_name: "Tom",
          last_name: "Anderson",
          path: "img/profiles/generic/blue.jpg",
        },
        { id: "2", first_name: "Kate", force_first_name: "Kate", last_name: "Austen", path: "img/x.jpg" },
      ]),
    },
    {
      label: "list_people fields",
      tool: "list_people",
      args: { "includeDetails": true, "fields": ["id"] },
      replies: reply([{ id: "1", first_name: "Thomas", last_name: "Anderson", path: "img/x.jpg" }]),
    },
    { tool: "get_person", args: { "personId": "157857" }, replies: reply(PERSON) },
    {
      tool: "list_profile_fields",
      args: {},
      replies: reply([
        {
          id: "10098",
          name: "Main",
          fields: [
            {
              id: "31028",
              oid: "2749",
              field_id: "2000138015",
              field_type: "multiple_choice",
              name: "Status",
              options: [{ id: "9690", option_id: "225", name: "Member", position: "6" }],
            },
            { field_id: "656342607", field_type: "birthdate", name: "Age", options: [] },
          ],
        },
      ]),
    },
    {
      tool: "list_tags",
      args: { "folderId": "77" },
      replies: reply([{ id: "16681", name: "Choir", created_on: "2025-01-01 10:00:00", folder_id: "77" }]),
    },
    {
      tool: "list_events",
      args: { "start": "2025-03-01", "end": "2025-03-31", "calendarId": "1553", "limit": 1 },
      replies: reply([
        {
          id: "40984",
          oid: "2749",
          event_id: "736",
          name: "Youth Group",
          category_id: "1553",
          start_datetime: "2025-03-05 18:00:00",
          end_datetime: "0000-00-00 00:00:00",
        },
      ]),
    },
    {
      label: "list_calendars via hatch",
      tool: "breeze_api_read",
      args: { "path": "/events/calendars/list" },
      replies: reply([
        {
          id: 0,
          name: "Main",
          color: "b2cd92",
          address: "https://gracechurch.breezechms.com/events/feed/feedtoken",
          embed_key: "AbC",
        },
      ]),
    },
    {
      tool: "list_attendance",
      args: { "instanceId": "3778451", "includeNames": true },
      replies: reply([
        {
          instance_id: "3778451",
          person_id: "824512",
          check_out: "0000-00-00 00:00:00",
          created_on: "2025-12-09 11:01:33",
          details: { first_name: "Carol", last_name: "Adams", details: { mobile: "123-123-1234" } },
        },
      ]),
    },
    {
      label: "list_forms via hatch",
      tool: "breeze_api_read",
      args: { "path": "/forms/list_forms" },
      replies: reply([
        { id: "15326", name: "Visitor Card", url_slug: "visitor-card", is_archived: "0", created_on: "2025-02-01" },
      ]),
    },
    {
      label: "list_form_fields via hatch",
      tool: "breeze_api_read",
      args: { "path": "/forms/list_form_fields", "query": { "form_id": "15326" } },
      replies: reply([
        {
          field_id: "46",
          field_type: "email",
          name: "Email",
          options: [],
        },
        {
          field_id: "47",
          field_type: "multiple_choice",
          name: "How did you hear about us?",
          options: [{ option_id: "3", name: "Friend" }],
        },
      ]),
    },
    {
      label: "list_form_entries via hatch",
      tool: "breeze_api_read",
      args: { "path": "/forms/list_form_entries", "query": { "form_id": "15326", "details": 1 } },
      replies: reply([
        { id: "11", form_id: "15326", created_on: "2025-03-09", person_id: "5", response: { "46": "z@example.com" } },
      ]),
    },
    {
      label: "list_volunteers via hatch",
      tool: "breeze_api_read",
      args: { "path": "/volunteers/list", "query": { "instance_id": "123456" } },
      replies: reply([
        { person_id: "3008467", response: "0", comment: "", rsvped_on: "0000-00-00 00:00:00", role_ids: null },
        {
          person_id: "3349681",
          response: "1",
          comment: "Glad to",
          rsvped_on: "2025-03-02 09:00:00",
          role_ids: ["9627"],
        },
      ]),
    },
    {
      label: "list_volunteer_roles via hatch",
      tool: "breeze_api_read",
      args: { "path": "/volunteers/list_roles", "query": { "instance_id": "123456", "show_quantity": 1 } },
      replies: reply([{ id: "9627", name: "Teacher", quantity: "2" }]),
    },
    {
      label: "list_account_log via hatch",
      tool: "breeze_api_read",
      args: {
        "path": "/account/list_log",
        "query": { "action": "person_updated", "start": "2025-08-01", "details": 1, "limit": 1 },
      },
      replies: reply([
        {
          id: "112",
          user_id: "261",
          action: "person_updated",
          object_json: '"5023943"',
          created_on: "2025-08-15 04:41:10",
          details: "Updated Status",
        },
      ]),
    },
    {
      tool: "list_contributions",
      args: { "start": "2022-01-01", "end": "2022-06-30", "fundIds": ["28", "29"], "batchNumbers": ["144"] },
      replies: reply([CONTRIBUTION, { id: "376786", paid_on: "2022-05-06 00:00:00", amount: "0.20", funds: [] }]),
    },
    {
      tool: "list_funds",
      args: {},
      replies: reply([{ id: "12346", name: "General Fund", tax_deductible: "1", is_default: "1", created_on: "x" }]),
    },
    {
      tool: "add_person",
      args: {
        "firstName": "Jiminy",
        "lastName": "Cricket",
        "fields": [{ "fieldId": "1508481877", "type": "email", "details": { "address": "jiminy@example.com" } }],
      },
      replies: reply([
        { id: "12345678", first_name: "Jiminy", force_first_name: "Jiminy", last_name: "Cricket", path: "x" },
      ]),
    },
    {
      tool: "update_person",
      args: { "personId": "12345678", "fields": [{ "fieldId": "2000138811", "type": "radio", "response": "459" }] },
      replies: reply({ id: "12345678", first_name: "Jiminy", last_name: "Cricket" }),
    },
    {
      label: "assign_tag via hatch",
      tool: "breeze_api_write",
      args: { "method": "GET", "path": "/tags/assign", "query": { "person_id": "157857", "tag_id": "16681" } },
      replies: reply(true),
    },
    {
      label: "unassign_tag via hatch",
      tool: "breeze_api_write",
      args: { "method": "GET", "path": "/tags/unassign", "query": { "person_id": "157857", "tag_id": "16681" } },
      replies: reply(true),
    },
    {
      label: "record_check_in via hatch",
      tool: "breeze_api_write",
      args: {
        "method": "GET",
        "path": "/events/attendance/add",
        "query": { "person_id": "157857", "instance_id": "40984", "direction": "in" },
      },
      replies: reply(true),
    },
  ],
  echo: {
    tool: "breeze_api_read",
    args: { path: "/people/157857" },
    replies: (text) => reply({ id: "157857", first_name: text }),
  },
  failures: {
    read: { tool: "get_person", args: { personId: "157857" } },
    write: { tool: "add_person", args: { firstName: "Jiminy", lastName: "Cricket" } },
  },
});
