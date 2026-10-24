import { ccb } from "../../../src/providers/ccb/index.js";
import { defineGoldenSpec, type StubResponse } from "../harness.js";

const API = "https://api.ccbchurch.com";
const CLIENT_SECRET = "golden-ccb-client-secret/123+456=";
const ACCESS_TOKEN = "golden-ccb-access-token/123+456=";
const REFRESH_TOKEN = "golden-ccb-refresh-token/123+456=";

const json = (body: unknown, headers: Record<string, string> = {}): StubResponse[] => [{ body, headers }];

const PERSON = {
  id: 42,
  family_id: 9,
  campus_id: 1,
  name: "Grace Hopper",
  first_name: "Grace",
  last_name: "Hopper",
  email: "grace@example.org",
  phone: { mobile: "555-0100", home: "", work: "" },
  birthday: "1906-12-09",
  family_position: "PRIMARY_CONTACT",
  membership_type_id: 3,
  active: true,
  deceased: "",
  images: { thumbnail: "https://cdn.example/t.png" },
  actions: { can_view_profile: { allowed: true } },
};

const INDIVIDUAL = {
  ...PERSON,
  gender: "F",
  marital_status: "MARRIED",
  campus_name: "Main Campus",
  membership_type_name: "Member",
  membership_date: "2010-05-02",
  baptized: true,
  last_attended_date: "2026-09-27",
  listed: true,
  allergies: "peanuts",
  giving_number: "G-17",
  envelope_user_id: 3,
  last_giving_date: "2026-09-01",
  addresses: {
    home: { street: "1 Main", city: "Springfield", state: "IL", zip: "62701", country_iso: "US", latitude: "1" },
    mailing: { street: "", city: "", state: "", zip: "" },
  },
  custom_fields: [{ id: 5, value: "Usher" }],
};

const GROUP = {
  id: 5,
  name: "Tuesday Small Group",
  campus_id: 1,
  inactive: false,
  group_type: { id: 2, name: "Small Group" },
  interaction_type: "MEMBERS_INTERACT",
  membership_type: "MODERATED",
  main_leader: { id: 42, name: "Grace Hopper", images: {} },
  department: { id: 4, name: "Connect" },
  actions: { can_edit: { allowed: true } },
};

const MEMBERSHIP = {
  group_id: 5,
  individual_id: 42,
  status: "LEADER",
  date_added: "2024-01-14",
  individual: { id: 42, name: "Grace Hopper", email: "grace@example.org", phone: { mobile: "555-0100" } },
  group: { id: 5, name: "Tuesday Small Group", group_type: { name: "Small Group" }, inactive: false },
};

const PAGE_HEADERS = { "x-page": "1", "x-total-pages": "1", "x-total": "1", "x-next-page": "" };

export default defineGoldenSpec({
  provider: "ccb",
  create: () =>
    ccb("church", {
      purpose: "Pastoral care and group shepherding",
      environment: "production",
      mode: "system",
      access: "read-write",
      clientId: "golden-ccb-client",
      clientSecret: CLIENT_SECRET,
    }),
  // CCB's grant is an authorization-code OAuth flow whose tokens live in the
  // registry's storage, so each scenario completes consent first through the
  // connector's own hooks, as the provider's tests do.
  async setup(connector, ctx) {
    const started = await connector.startAuth!(ctx);
    const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
    if (!(await connector.verifyState!(state, ctx))) throw new Error("ccb golden: consent state rejected");
    await connector.finishAuth!("golden-code", ctx, new URLSearchParams({ code: "golden-code", state }));
  },
  secrets: { clientSecret: CLIENT_SECRET, accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN },
  auxiliary: [
    {
      name: "token",
      match: (request) => request.url.href === `${API}/oauth/token`,
      reply: {
        body: {
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          token_type: "bearer",
          expires_in: 7200,
          scope: "read:individuals",
        },
      },
    },
  ],
  failureReply: (status, message) => ({ status, body: { message } }),
  calls: [
    { tool: "ccb_api_search", args: { query: "campus" }, replies: [] },
    { tool: "ccb_api_details", args: { method: "GET", path: "/individuals/{id}" }, replies: [] },
    {
      tool: "get_me",
      replies: json({
        id: 7,
        name: "Ada Pastor",
        email: "ada@example.org",
        username: "ada",
        family_id: 3,
        campus_id: 1,
        user_types: ["ADMIN"],
        images: {},
      }),
    },
    {
      tool: "list_individuals",
      args: { query: "hop", includeInactive: true, limit: 50 },
      replies: json([PERSON], { "x-page": "1", "x-total-pages": "4", "x-total": "77", "x-next-page": "2" }),
    },
    { tool: "get_individual", args: { individualId: 42 }, replies: json(INDIVIDUAL) },
    {
      label: "get_individual fields",
      tool: "get_individual",
      args: { individualId: 42, fields: ["id", "name"] },
      replies: json({ id: 42, name: "Grace Hopper", allergies: "peanuts", giving_number: "G-17" }),
    },
    {
      tool: "list_families",
      args: { lastName: "Hop" },
      replies: json(
        [
          {
            id: 9,
            last_name: "Hopper",
            address: { street: "1 Main", city: "Springfield", state: "IL", zip: "62701", country_iso: "US" },
          },
        ],
        PAGE_HEADERS,
      ),
    },
    {
      tool: "get_family",
      args: { familyId: 9, includeInactive: true },
      replies: json({
        id: 9,
        last_name: "Hopper",
        address: { street: "1 Main", city: "Springfield", state: "IL", zip: "62701", country_iso: "US" },
        members: [PERSON, { id: 43, name: "Walter Hopper", family_position: "SPOUSE", active: true }],
      }),
    },
    {
      tool: "list_groups",
      args: { name: "Tuesday", campusId: 1 },
      replies: json([GROUP], { "x-next-page": "", "x-total": "1" }),
    },
    {
      label: "list_groups short page",
      tool: "list_groups",
      replies: json([{ id: 1, name: "Alpha" }]),
    },
    {
      tool: "get_group",
      args: { groupId: 5 },
      replies: json({
        ...GROUP,
        description: "Bible study on Tuesday nights",
        member_count: 12,
        childcare: false,
        listed: true,
        full: false,
        meet_day: { id: 3, name: "Tuesday" },
        meet_time: { id: 19, name: "7:00 PM" },
        area: { id: 2, name: "North" },
        address: { street: "9 Oak", city: "Springfield", state: "IL", zip: "62702" },
      }),
    },
    {
      tool: "list_group_members",
      args: { groupId: 5, status: "leader" },
      replies: json([MEMBERSHIP], PAGE_HEADERS),
    },
    {
      tool: "list_individual_groups",
      args: { individualId: 42, includeInactive: false },
      replies: json([MEMBERSHIP], PAGE_HEADERS),
    },
    {
      tool: "list_events",
      args: { name: "Small Group", range: "PAST" },
      replies: json(
        [
          {
            event_id: 12,
            occurrence: "20260927",
            start: "2026-09-27T19:00:00-05:00",
            end: "2026-09-27T21:00:00-05:00",
            event: {
              id: 12,
              name: "Tuesday Small Group",
              campus_id: 1,
              recurs: true,
              group: { id: "5", name: "Tuesday Small Group" },
            },
          },
        ],
        PAGE_HEADERS,
      ),
    },
    {
      tool: "get_event",
      args: { eventId: 12, occurrence: "2026-09-27", withAttendance: true },
      replies: json({
        id: 12,
        name: "Tuesday Small Group",
        description: "Weekly meeting",
        campus_id: 1,
        start: "2026-09-27T19:00:00-05:00",
        end: "2026-09-27T21:00:00-05:00",
        recurs: true,
        recur_end_date: "",
        approval_status: "APPROVED",
        address: { street: "9 Oak", city: "Springfield", state: "IL", zip: "62702" },
        guest_counts: { attending: 3, invited: 10 },
        group: { id: 5, name: "Tuesday Small Group" },
        attendance: { status: "MET", total_attendance: 14, visitors: 2, notes: "leader notes" },
      }),
    },
    {
      tool: "get_event_attendance",
      args: { eventId: 12, occurrence: "2026-09-27" },
      replies: json({
        event_id: 12,
        occurrence: "20260927",
        status: "MET",
        total_attendance: 14,
        visitors: 2,
        topic: "Romans 8",
        prayer_requests: "private",
        notes: "leader notes",
      }),
    },
    {
      tool: "list_event_attendees",
      args: { eventId: 12, occurrence: "20260927" },
      replies: json(
        [
          {
            individual_id: 42,
            occurrence_date: "2026-09-27",
            individual: { id: 42, name: "Grace Hopper", family_id: 9 },
          },
        ],
        PAGE_HEADERS,
      ),
    },
    {
      label: "list_forms through hatch",
      tool: "ccb_api_read",
      args: { path: "/forms", query: { "status": "ACTIVE" } },
      replies: json(
        [
          {
            id: 31,
            title: "Visitor Card",
            status: "ACTIVE",
            campus_id: 1,
            start: "2026-01-01",
            end: "",
            public: true,
            url: "https://gracechurch.ccbchurch.com/goto/forms/31",
          },
        ],
        PAGE_HEADERS,
      ),
    },
    {
      label: "list_form_responses through hatch",
      tool: "ccb_api_read",
      args: { path: "/forms/31/responses" },
      replies: json(
        [
          {
            id: 501,
            form_id: 31,
            individual_id: 42,
            created: "2026-09-01T10:00:00Z",
            payment_status: "NONE",
            payment: { card_last4: "4242" },
            answers: [{ question_id: 1, answer: "A friend invited me" }],
          },
        ],
        PAGE_HEADERS,
      ),
    },
    {
      label: "list_processes through hatch",
      tool: "ccb_api_read",
      args: { path: "/processes", query: { "statuses": "ACTIVE", "managed_by_me": true } },
      replies: json(
        [
          {
            id: 8,
            name: "New Visitor Follow-up",
            campus_id: 1,
            owner_id: 7,
            hidden: false,
            archived: false,
            process_managers: [{ id: 7, name: "Ada Pastor" }],
          },
        ],
        PAGE_HEADERS,
      ),
    },
    {
      label: "list_queues through hatch",
      tool: "ccb_api_read",
      args: { path: "/queues", query: { "process_ids": [8] } },
      replies: json(
        [
          {
            id: 81,
            name: "First Contact",
            process_id: 8,
            process: { id: 8, name: "New Visitor Follow-up" },
            description: "",
            assigned_count: 2,
            unassigned_count: 1,
          },
        ],
        PAGE_HEADERS,
      ),
    },
    {
      label: "list_queue_individuals through hatch",
      tool: "ccb_api_read",
      args: { path: "/queues_individuals", query: { "statuses": ["IN_PROCESS"], "assignment": "ASSIGNED_TO_ME" } },
      replies: json(
        [
          {
            queue_individual_id: 9001,
            queue_id: 81,
            queue: { name: "First Contact", process_id: 8, process_name: "New Visitor Follow-up" },
            individual_id: 42,
            individual: { id: 42, name: "Grace Hopper" },
            status: "IN_PROCESS",
            due: "2026-10-01",
            created: "2026-09-20",
            completed: null,
          },
        ],
        PAGE_HEADERS,
      ),
    },
    {
      label: "list_scheduling_categories through hatch",
      tool: "ccb_api_read",
      args: { path: "/scheduling/categories" },
      replies: json([
        {
          id: 3,
          name: "Worship Team",
          campus: { id: 1, name: "Main Campus" },
          organizer: { id: 7, name: "Ada Pastor" },
          archived: false,
          teams: [{ id: 31, name: "Vocals" }],
        },
      ]),
    },
    {
      label: "list_schedules through hatch",
      tool: "ccb_api_read",
      args: { path: "/scheduling/categories/3/schedules", query: { "after": "2026-09-01" } },
      replies: json(
        [
          {
            id: 300,
            category_id: 3,
            name: "October",
            start: "2026-10-01",
            end: "2026-10-31",
            needed: 6,
            events: [{ id: 12, name: "Sunday Service", start: "2026-10-04T09:00:00", end: "2026-10-04T10:30:00" }],
            metrics: { accepted: 4, declined: 1 },
          },
        ],
        PAGE_HEADERS,
      ),
    },
    {
      label: "list_individual_assignments through hatch",
      tool: "ccb_api_read",
      args: { path: "/individuals/42/assignments" },
      replies: json(
        [
          {
            id: 7001,
            category_id: 3,
            schedule_id: 300,
            event_id: 12,
            event_position_id: 55,
            status: "ACCEPTED",
            status_reason: "",
            date_notified: "2026-09-20",
            volunteer: { individual: { id: 42, name: "Grace Hopper" } },
          },
        ],
        PAGE_HEADERS,
      ),
    },
    {
      tool: "list_individual_notes",
      args: { individualId: 42, context: "GENERAL" },
      replies: json(
        [
          {
            id: 61,
            individual_id: 42,
            note: "Visited after surgery",
            date: "2026-09-15",
            sharing_level: "LEADERS",
            context: "GENERAL",
            context_id: 0,
            creator: { id: 7, name: "Ada Pastor" },
          },
        ],
        PAGE_HEADERS,
      ),
    },
    {
      tool: "get_giving_metrics",
      args: { familyId: 9, start: "2026-01-01", end: "2026-09-30" },
      replies: json([
        { family_id: 9, date: "2026-08-01", count: 3, members: [{ id: 42, count: 2, start: "2026-08-01" }] },
      ]),
    },
    {
      label: "get_giving_metrics individual",
      tool: "get_giving_metrics",
      args: { individualId: 42, start: "2026-01-01", end: "2026-09-30" },
      replies: json([{ start: "2026-08-01", count: 2 }]),
    },
    {
      label: "list_individual_pledges through hatch",
      tool: "ccb_api_read",
      args: { path: "/individuals/42/pledges" },
      replies: json(
        [
          {
            id: 77,
            campus_id: 1,
            coa: { id: 2, name: "Building Fund" },
            pledged: 1200,
            paid: 300,
            expected: 400,
            total: 1200,
            start: "2026-01-01",
            recurrence: { frequency: "MONTHLY", end: "2026-12-31" },
          },
        ],
        PAGE_HEADERS,
      ),
    },
    {
      tool: "ccb_api_read",
      args: { path: "/church/membership_types" },
      replies: json([{ id: 1, name: "Member" }], { "x-next-page": "" }),
    },
    {
      tool: "search_records",
      args: {
        domain: "individuals",
        body: { configuration: { filter_profile_type: ["active"] }, filters: {} },
        limit: 100,
      },
      replies: json([{ id: 7, name: "Ada Pastor" }], { "x-next-page": "2" }),
    },
    {
      tool: "ccb_api_write",
      args: { method: "POST", path: "/individuals/42/notes", body: { note: "Visited" } },
      replies: json({ id: 3, note: "Visited" }),
    },
    {
      label: "ccb_api_write DELETE",
      tool: "ccb_api_write",
      args: { method: "DELETE", path: "/groups/5/members", body: { ids: [42] } },
      replies: [{ status: 204 }],
    },
  ],
  unsent: ["clientSecret", "refreshToken"],
  echo: { tool: "get_me", replies: (text) => json({ id: 7, name: text }) },
  failures: {
    read: { tool: "get_group", args: { groupId: 5 } },
    write: {
      tool: "ccb_api_write",
      args: { method: "POST", path: "/individuals/42/notes", body: { note: "Visited" } },
    },
  },
});
