import { planningCenter } from "../../../src/providers/planning-center/index.js";
import { defineGoldenSpec, type StubResponse } from "../harness.js";

type Relationships = Record<string, { data: unknown }>;

const ref = (type: string, id: string) => ({ data: { type, id } });
const refs = (type: string, ...ids: string[]) => ({ data: ids.map((id) => ({ type, id })) });

function resource(type: string, id: string, attributes: Record<string, unknown>, relationships?: Relationships) {
  return { type, id, attributes, ...(relationships ? { relationships } : {}) };
}

/** One JSON:API list page; `next` sets Planning Center's offset cursor. */
function page(data: unknown[], options: { included?: unknown[]; total?: number; next?: number } = {}): StubResponse[] {
  return [
    {
      body: {
        data,
        ...(options.included ? { included: options.included } : {}),
        meta: {
          total_count: options.total ?? data.length,
          count: data.length,
          ...(options.next !== undefined ? { next: { offset: options.next } } : {}),
        },
      },
    },
  ];
}

const one = (data: unknown, status = 200, included?: unknown[]): StubResponse[] => [
  { status, body: { data, ...(included ? { included } : {}) } },
];

const ALICE = resource(
  "Person",
  "7",
  {
    name: "Alice Smith",
    first_name: "Alice",
    last_name: "Smith",
    nickname: null,
    status: "active",
    membership: "Member",
    child: false,
    birthdate: "1985-05-23",
    gender: "Female",
    medical_notes: "private",
    created_at: "2020-03-01T15:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    emails: refs("Email", "101", "102"),
    phone_numbers: refs("PhoneNumber", "201"),
    addresses: refs("Address", "301"),
    households: refs("Household", "401"),
    primary_campus: ref("Campus", "501"),
  },
);

const ALICE_INCLUDED = [
  resource("Email", "101", { address: "old@example.com", location: "Work", primary: false }),
  resource("Email", "102", { address: "alice@example.com", location: "Home", primary: true }),
  resource("PhoneNumber", "201", { number: "(555) 010-0100", location: "Mobile", primary: true }),
  resource("Address", "301", {
    street_line_1: "1 Main St",
    city: "Nashville",
    state: "TN",
    zip: "37209",
    country_code: "US",
    location: "Home",
    primary: true,
  }),
  resource("Household", "401", { name: "Smith household", primary_contact_id: "7", member_count: 3 }),
  resource("Campus", "501", { name: "Downtown" }),
];

const BOB = resource(
  "Person",
  "9",
  {
    name: "Bob Jones",
    first_name: "Bob",
    last_name: "Jones",
    nickname: null,
    status: "active",
    membership: "Visitor",
    child: false,
    updated_at: "2026-01-02T03:04:05Z",
  },
  { emails: refs("Email", "103"), phone_numbers: refs("PhoneNumber") },
);

const designated = (id: string, fundId: string, cents: number) =>
  resource("Designation", id, { amount_cents: cents }, { fund: ref("Fund", fundId) });

const FUNDS = [resource("Fund", "61", { name: "General" }), resource("Fund", "62", { name: "Missions" })];

export default defineGoldenSpec({
  provider: "planning-center",
  create: () =>
    planningCenter("church", {
      purpose: "Grace Church staff operations",
    }),
  credential: { applicationId: "golden-application-id-123456", secret: "golden-pat-secret-654321" },
  failureReply: (status) => ({
    status,
    body: {
      errors: [
        {
          status: String(status),
          title: `Golden ${status}`,
          detail: `Golden ${status} failure`,
          source: { pointer: "/data/attributes/first_name" },
        },
      ],
    },
  }),
  calls: [
    // --- Hatches ---
    {
      tool: "pco_api_get",
      args: {
        path: "/publishing/v2/episodes",
        query: [
          { name: "where[title]", value: "Easter" },
          { name: "per_page", value: 5 },
        ],
      },
      replies: page([resource("Episode", "71", { title: "Easter Sunday", published_to_library_at: null })]),
    },
    {
      label: "pco_api_get version override",
      tool: "pco_api_get",
      args: { path: "/people/v2/campuses", version: "2025-11-10" },
      replies: page([resource("Campus", "501", { name: "Downtown" })]),
    },
    {
      tool: "pco_api_mutate",
      args: {
        method: "POST",
        path: "/giving/v2/batches",
        body: { data: { type: "Batch", attributes: { description: "Sunday offering" } } },
      },
      replies: one(resource("Batch", "81", { description: "Sunday offering", status: "in_progress" }), 201),
    },
    {
      label: "pco_api_mutate DELETE",
      tool: "pco_api_mutate",
      args: { method: "DELETE", path: "/people/v2/emails/101" },
      replies: [{ status: 204 }],
    },

    // --- People ---
    {
      tool: "get_me",
      replies: one(
        resource("Person", "1", {
          name: "Alice Admin",
          first_name: "Alice",
          last_name: "Admin",
          status: "active",
        }),
        200,
        [resource("Organization", "100", { name: "Grace Church", time_zone: "America/Chicago" })],
      ),
    },
    {
      tool: "search_people",
      args: { search: "alice", status: "active", updatedSince: "2026-01-01", order: "-updated_at", perPage: 1 },
      replies: page([ALICE], { included: ALICE_INCLUDED.slice(0, 3), total: 2, next: 1 }),
    },
    {
      tool: "get_person",
      args: { personId: "7" },
      replies: one(ALICE, 200, ALICE_INCLUDED),
    },
    {
      tool: "create_person",
      args: { firstName: "Bob", lastName: "Jones", birthdate: "1990-04-12", membership: "Visitor", child: false },
      replies: one(BOB, 201),
    },
    {
      tool: "update_person",
      args: { personId: "9", status: "inactive", nickname: null },
      replies: one({ ...BOB, attributes: { ...BOB.attributes, status: "inactive" } }),
    },
    {
      tool: "add_person_email",
      args: { personId: "9", address: "bob@example.com", primary: true },
      replies: one(
        resource(
          "Email",
          "103",
          { address: "bob@example.com", location: "Home", primary: true },
          { person: ref("Person", "9") },
        ),
        201,
      ),
    },
    {
      tool: "add_person_phone_number",
      args: { personId: "9", number: "555-0199" },
      replies: one(
        resource(
          "PhoneNumber",
          "203",
          { number: "(555) 019-9000", location: "Mobile", primary: false },
          { person: ref("Person", "9") },
        ),
        201,
      ),
    },
    {
      tool: "list_lists",
      args: { name: "Volunteers%", order: "name" },
      replies: page([
        resource("List", "3", {
          name: "Volunteers",
          description: "Everyone serving this quarter",
          total_people: 42,
          status: "complete",
          refreshed_at: "2026-01-01T12:00:00Z",
          auto_refresh: true,
          automations_active: false,
        }),
      ]),
    },
    {
      tool: "list_list_people",
      args: { listId: "3" },
      replies: page([ALICE], { included: ALICE_INCLUDED.slice(0, 3) }),
    },
    { tool: "run_list", args: { listId: "3" }, replies: [{ status: 201, body: {} }] },
    {
      tool: "list_workflows",
      replies: page(
        [
          resource(
            "Workflow",
            "5",
            {
              name: "First-time guests",
              total_cards_count: 12,
              total_ready_card_count: 4,
              total_overdue_card_count: 1,
              total_unassigned_card_count: 2,
              my_ready_card_count: 1,
              archived_at: null,
            },
            { steps: refs("WorkflowStep", "52", "51") },
          ),
        ],
        {
          included: [
            resource("WorkflowStep", "52", { name: "Send welcome gift", sequence: 2 }),
            resource("WorkflowStep", "51", { name: "Call", sequence: 1 }),
          ],
        },
      ),
    },
    {
      tool: "list_workflow_cards",
      args: { workflowId: "5", stage: "ready", overdue: true },
      replies: page(
        [
          resource(
            "WorkflowCard",
            "88",
            {
              stage: "ready",
              overdue: true,
              moved_to_step_at: "2025-12-20T00:00:00Z",
              snooze_until: null,
              completed_at: null,
              removed_at: null,
            },
            {
              person: ref("Person", "7"),
              assignee: { data: null },
              current_step: ref("WorkflowStep", "51"),
            },
          ),
        ],
        { included: [ALICE, resource("WorkflowStep", "51", { name: "Call", sequence: 1 })] },
      ),
    },
    {
      tool: "add_workflow_card",
      args: { workflowId: "5", personId: "9", assigneeId: "1" },
      replies: one(
        resource(
          "WorkflowCard",
          "89",
          { stage: "ready", overdue: false, moved_to_step_at: "2026-01-02T03:04:05Z" },
          {
            person: ref("Person", "9"),
            assignee: ref("Person", "1"),
            current_step: ref("WorkflowStep", "51"),
          },
        ),
        201,
      ),
    },
    {
      tool: "apply_workflow_card_action",
      args: { personId: "7", cardId: "88", action: "snooze", snoozeDays: 15 },
      replies: one(resource("WorkflowCard", "88", { stage: "snoozed", snooze_until: "2026-01-17T03:04:05Z" })),
    },
    {
      label: "apply_workflow_card_action promote",
      tool: "apply_workflow_card_action",
      args: { personId: "7", cardId: "88", action: "promote" },
      replies: one(resource("WorkflowCard", "88", { stage: "ready" })),
    },
    {
      tool: "add_workflow_card_note",
      args: { personId: "7", cardId: "88", note: "Left a voicemail." },
      replies: one(
        resource("WorkflowCardNote", "91", { note: "Left a voicemail.", created_at: "2026-01-02T03:04:05Z" }),
        201,
      ),
    },
    {
      tool: "list_person_notes",
      args: { personId: "7" },
      replies: page(
        [
          resource(
            "Note",
            "601",
            {
              note: "Visited after surgery.",
              note_category_id: "41",
              person_id: "7",
              display_date: "2025-12-15T00:00:00Z",
              created_at: "2025-12-15T18:00:00Z",
              created_by_id: "1",
            },
            { category: ref("NoteCategory", "41") },
          ),
        ],
        { included: [resource("NoteCategory", "41", { name: "Pastoral" })] },
      ),
    },
    {
      tool: "add_person_note",
      args: { personId: "7", note: "Called to check in.", noteCategoryId: "41" },
      replies: one(
        resource("Note", "602", {
          note: "Called to check in.",
          note_category_id: "41",
          person_id: "7",
          display_date: "2026-01-02T03:04:05Z",
          created_at: "2026-01-02T03:04:05Z",
          created_by_id: "1",
        }),
        201,
      ),
    },
    {
      tool: "list_person_field_data",
      args: { personId: "7" },
      replies: page(
        [
          resource(
            "FieldDatum",
            "701",
            { value: "Blue", file_name: null },
            {
              field_definition: ref("FieldDefinition", "711"),
            },
          ),
        ],
        { included: [resource("FieldDefinition", "711", { name: "Favorite color", data_type: "string" })] },
      ),
    },
    {
      tool: "list_forms",
      replies: page([
        resource("Form", "4", {
          name: "Connection card",
          description: "Tell us about yourself",
          active: true,
          submission_count: 17,
          public_url: "https://grace.example/people/forms/4",
          archived_at: null,
        }),
      ]),
    },
    {
      tool: "list_form_submissions",
      args: { formId: "4", submittedAfter: "2026-01-01" },
      replies: page(
        [
          resource(
            "FormSubmission",
            "801",
            { created_at: "2026-01-01T16:00:00Z" },
            { person: ref("Person", "7"), form_submission_values: refs("FormSubmissionValue", "811", "812") },
          ),
        ],
        {
          included: [
            ALICE,
            resource(
              "FormSubmissionValue",
              "811",
              { value: "m", display_value: "Medium" },
              { form_field: ref("FormField", "821") },
            ),
            resource("FormSubmissionValue", "812", { value: "Yes" }, { form_field: ref("FormField", "822") }),
            resource("FormField", "821", { label: "T-shirt size" }),
            resource("FormField", "822", { label: "Interested in serving?" }),
          ],
        },
      ),
    },

    // --- Services ---
    {
      tool: "list_service_types",
      replies: page([
        resource(
          "ServiceType",
          "10",
          { name: "Sunday Morning", frequency: "Weekly", sequence: 0 },
          {
            parent: ref("Folder", "11"),
          },
        ),
      ]),
    },
    {
      tool: "list_plans",
      args: { serviceTypeId: "10" },
      replies: page([
        resource("Plan", "20", {
          title: "Easter",
          series_title: "Resurrection",
          dates: "April 5, 2026",
          sort_date: "2026-04-05T14:00:00Z",
          items_count: 2,
          plan_people_count: 6,
          needed_positions_count: 1,
          planning_center_url: "https://services.planningcenteronline.com/plans/20",
        }),
      ]),
    },
    {
      tool: "get_plan",
      args: { serviceTypeId: "10", planId: "20" },
      // Three requests run in parallel; answer each by path.
      replies: (request) => {
        const path = request.url.pathname;
        if (path.endsWith("/items")) {
          return {
            body: {
              data: [
                resource(
                  "Item",
                  "902",
                  { sequence: 2, item_type: "song", title: "Amazing Grace", length: 240, key_name: "G" },
                  { song: ref("Song", "30"), arrangement: ref("Arrangement", "31") },
                ),
                resource("Item", "901", {
                  sequence: 1,
                  item_type: "header",
                  title: "Welcome",
                  service_position: "during",
                }),
              ],
              meta: { total_count: 101, next: { offset: 100 } },
            },
          };
        }
        if (path.endsWith("/team_members")) {
          return {
            body: {
              data: [
                resource(
                  "PlanPerson",
                  "1001",
                  { name: "Alice Smith", status: "C", team_position_name: "Vocals" },
                  { team: ref("Team", "40"), person: ref("Person", "7") },
                ),
              ],
              included: [resource("Team", "40", { name: "Band" })],
              meta: { total_count: 1 },
            },
          };
        }
        return {
          body: {
            data: resource(
              "Plan",
              "20",
              {
                title: "Easter",
                series_title: "Resurrection",
                dates: "April 5, 2026",
                sort_date: "2026-04-05T14:00:00Z",
                total_length: 4500,
                needed_positions_count: 1,
                planning_center_url: "https://services.planningcenteronline.com/plans/20",
                permissions: "Editor",
              },
              { plan_times: refs("PlanTime", "1101") },
            ),
            included: [
              resource("PlanTime", "1101", {
                name: "9am",
                time_type: "service",
                starts_at: "2026-04-05T14:00:00Z",
                ends_at: "2026-04-05T15:15:00Z",
              }),
            ],
          },
        };
      },
    },
    {
      tool: "list_teams",
      args: { serviceTypeId: "10" },
      replies: page(
        [
          resource(
            "Team",
            "40",
            { name: "Band", archived_at: null },
            { team_positions: refs("TeamPosition", "41", "42") },
          ),
        ],
        {
          included: [
            resource("TeamPosition", "41", { name: "Vocals" }),
            resource("TeamPosition", "42", { name: "Bass" }),
          ],
        },
      ),
    },
    {
      tool: "list_person_schedules",
      args: { personId: "7" },
      replies: page([
        resource(
          "Schedule",
          "1201",
          {
            dates: "April 5, 2026",
            sort_date: "2026-04-05T14:00:00Z",
            service_type_name: "Sunday Morning",
            team_name: "Band",
            team_position_name: "Vocals",
            status: "C",
            decline_reason: null,
          },
          { plan: ref("Plan", "20") },
        ),
      ]),
    },
    {
      tool: "schedule_plan_person",
      args: { serviceTypeId: "10", planId: "20", personId: "9", teamId: "40", teamPositionName: "Bass" },
      replies: one(
        resource(
          "PlanPerson",
          "1002",
          { name: "Bob Jones", status: "U", team_position_name: "Bass", decline_reason: null },
          { team: ref("Team", "40"), person: ref("Person", "9") },
        ),
        201,
      ),
    },
    {
      tool: "add_plan_item",
      args: {
        serviceTypeId: "10",
        planId: "20",
        title: "Amazing Grace",
        songId: "30",
        arrangementId: "31",
        length: 240,
      },
      replies: one(
        resource(
          "Item",
          "903",
          {
            sequence: 3,
            item_type: "song",
            title: "Amazing Grace",
            length: 240,
            key_name: null,
            service_position: "during",
          },
          { song: ref("Song", "30"), arrangement: ref("Arrangement", "31") },
        ),
        201,
      ),
    },
    {
      tool: "list_songs",
      args: { title: "Amazing%", order: "title" },
      replies: page([
        resource("Song", "30", {
          title: "Amazing Grace",
          author: "John Newton",
          ccli_number: 22025,
          themes: "Grace, Salvation",
          hidden: false,
          last_scheduled_at: "2025-12-21T15:00:00Z",
        }),
      ]),
    },
    {
      tool: "list_song_arrangements",
      args: { songId: "30" },
      replies: page(
        [
          resource(
            "Arrangement",
            "31",
            {
              name: "Default",
              bpm: 72,
              meter: "3/4",
              length: 240,
              chord_chart_key: "G",
              sequence_short: ["V1", "V2", "C"],
              lyrics: "Amazing grace…",
            },
            { keys: refs("Key", "32") },
          ),
        ],
        { included: [resource("Key", "32", { name: "Default", starting_key: "G", ending_key: "G" })] },
      ),
    },

    // --- Groups ---
    {
      tool: "list_groups",
      args: { name: "Young%", archived: "include" },
      replies: page([
        resource(
          "Group",
          "8",
          {
            name: "Young Adults",
            memberships_count: 14,
            schedule: "Tuesdays at 7pm",
            contact_email: "youngadults@example.com",
            archived_at: null,
            public_church_center_web_url: "https://grace.example/groups/young-adults",
          },
          { group_type: ref("GroupType", "81") },
        ),
      ]),
    },
    {
      tool: "list_group_memberships",
      args: { groupId: "8", role: "leader" },
      replies: page(
        [
          resource(
            "Membership",
            "1301",
            { role: "leader", joined_at: "2025-01-01T00:00:00Z" },
            {
              person: ref("Person", "7"),
            },
          ),
        ],
        { included: [ALICE] },
      ),
    },
    {
      tool: "add_group_member",
      args: { groupId: "8", personId: "9" },
      replies: one(
        resource(
          "Membership",
          "1302",
          { role: "member", joined_at: "2026-01-02T03:04:05Z" },
          {
            person: ref("Person", "9"),
          },
        ),
        201,
        [BOB],
      ),
    },
    {
      tool: "list_group_events",
      args: { groupId: "8", startsAfter: "2026-01-01", startsBefore: "2026-02-01" },
      replies: page([
        resource(
          "Event",
          "1401",
          {
            name: "Weekly meeting",
            starts_at: "2026-01-06T01:00:00Z",
            ends_at: "2026-01-06T02:30:00Z",
            canceled: false,
            visitors_count: 2,
            virtual_location_url: null,
          },
          { group: ref("Group", "8") },
        ),
      ]),
    },

    // --- Check-Ins ---
    {
      tool: "list_check_in_events",
      replies: page([resource("Event", "2", { name: "Sunday Kids", frequency: "Weekly", archived_at: null })]),
    },
    {
      tool: "list_check_in_event_periods",
      args: { eventId: "2", startsAfter: "2025-12-01" },
      replies: page([
        resource("EventPeriod", "1501", {
          starts_at: "2025-12-28T15:00:00Z",
          ends_at: "2025-12-28T17:00:00Z",
          regular_count: 48,
          guest_count: 5,
          volunteer_count: 12,
          unique_total_count: 65,
          note: null,
        }),
      ]),
    },
    {
      tool: "list_check_ins",
      args: { eventId: "2", serviceAfter: "2025-12-28", serviceBefore: "2025-12-29", kind: "guest" },
      replies: page([
        resource(
          "CheckIn",
          "1601",
          {
            first_name: "Carol",
            last_name: "Smith",
            kind: "Guest",
            number: 14,
            security_code: "X7K",
            created_at: "2025-12-28T14:55:00Z",
            checked_out_at: "2025-12-28T16:40:00Z",
            one_time_guest: true,
          },
          { person: { data: null }, event_period: ref("EventPeriod", "1501") },
        ),
      ]),
    },

    // --- Calendar ---
    {
      tool: "list_calendar_event_instances",
      args: { startsAfter: "2026-01-01", startsBefore: "2026-01-08" },
      replies: page([
        resource(
          "EventInstance",
          "1701",
          {
            name: "Staff meeting",
            starts_at: "2026-01-05T15:00:00Z",
            ends_at: "2026-01-05T16:00:00Z",
            all_day_event: false,
            location: "Room 101",
            kind: "Standard",
            recurrence_description: "Weekly on Monday",
            church_center_url: "https://grace.example/calendar/1701",
          },
          { event: ref("Event", "1702") },
        ),
      ]),
    },

    // --- Registrations ---
    {
      tool: "list_signups",
      replies: page([
        resource("Signup", "1801", {
          name: "Winter retreat",
          open: true,
          closed: false,
          open_at: "2025-11-01T00:00:00Z",
          close_at: "2026-01-31T00:00:00Z",
          maximum_capacity: 80,
          at_maximum_capacity: false,
          archived: false,
          new_registration_url: "https://grace.example/registrations/1801",
        }),
      ]),
    },
    {
      tool: "list_signup_attendees",
      args: { signupId: "1801", status: "active" },
      replies: page(
        [
          resource(
            "Attendee",
            "1811",
            {
              name: "Alice Smith",
              active: true,
              waitlisted: false,
              canceled: false,
              complete: true,
              created_at: "2025-11-03T12:00:00Z",
            },
            { person: ref("Person", "7") },
          ),
        ],
        { included: [ALICE] },
      ),
    },

    // --- Giving ---
    {
      tool: "list_donations",
      args: { receivedAfter: "2025-12-01", fundId: "61", succeededOnly: true },
      replies: page(
        [
          resource(
            "Donation",
            "1901",
            {
              amount_cents: 7500,
              amount_currency: "USD",
              fee_cents: -248,
              received_at: "2025-12-28T15:30:00Z",
              payment_method: "card",
              payment_status: "succeeded",
              payment_last4: "4242",
              refunded: false,
            },
            {
              person: ref("Person", "7"),
              batch: { data: null },
              campus: ref("Campus", "501"),
              designations: refs("Designation", "1911", "1912"),
            },
          ),
        ],
        { included: [designated("1911", "61", 5000), designated("1912", "62", 2500), ...FUNDS] },
      ),
    },
    {
      label: "list_donations by donor",
      tool: "list_donations",
      args: { personId: "7", perPage: 1, offset: 1 },
      replies: page(
        [
          resource(
            "Donation",
            "1902",
            {
              amount_cents: 2000,
              amount_currency: "USD",
              fee_cents: 0,
              received_at: "2025-12-21T15:30:00Z",
              payment_method: "cash",
              payment_status: "succeeded",
              refunded: false,
            },
            {
              person: ref("Person", "7"),
              batch: ref("Batch", "81"),
              designations: refs("Designation", "1913"),
            },
          ),
        ],
        { included: [designated("1913", "61", 2000), FUNDS[0]], total: 3, next: 2 },
      ),
    },
    {
      tool: "list_funds",
      replies: page([
        resource("Fund", "61", {
          name: "General",
          ledger_code: "4000",
          visibility: "everywhere",
          default: true,
          description: null,
        }),
      ]),
    },
    {
      tool: "list_batches",
      args: { status: "committed" },
      replies: page([
        resource(
          "Batch",
          "81",
          {
            description: "Sunday offering",
            status: "committed",
            donations_count: 32,
            total_cents: 412500,
            total_currency: "USD",
            committed_at: "2025-12-22T10:00:00Z",
            created_at: "2025-12-21T18:00:00Z",
          },
          { batch_group: { data: null } },
        ),
      ]),
    },
    {
      tool: "list_pledge_campaigns",
      replies: page([
        resource(
          "PledgeCampaign",
          "2001",
          {
            name: "Building fund",
            starts_at: "2025-09-01T00:00:00Z",
            ends_at: "2026-08-31T00:00:00Z",
            goal_cents: 50000000,
            received_total_from_pledges_cents: 12000000,
            received_total_outside_of_pledges_cents: 800000,
          },
          { fund: ref("Fund", "63") },
        ),
      ]),
    },
    {
      tool: "list_pledges",
      args: { pledgeCampaignId: "2001" },
      replies: page([
        resource(
          "Pledge",
          "2011",
          {
            amount_cents: 120000,
            donated_total_cents: 40000,
            joint_giver_amount_cents: null,
            created_at: "2025-09-07T16:00:00Z",
          },
          { person: ref("Person", "7") },
        ),
      ]),
    },
    {
      tool: "list_recurring_donations",
      args: { status: "active" },
      replies: page(
        [
          resource(
            "RecurringDonation",
            "2101",
            {
              amount_cents: 10000,
              amount_currency: "USD",
              schedule: "Monthly on the 1st",
              status: "active",
              next_occurrence: "2026-02-01",
              last_donation_received_at: "2026-01-01T12:00:00Z",
            },
            { person: ref("Person", "7"), designations: refs("Designation", "2111") },
          ),
        ],
        { included: [designated("2111", "62", 10000), FUNDS[1]] },
      ),
    },

    // --- Webhooks ---
    {
      tool: "list_webhook_subscriptions",
      replies: page([
        resource("WebhookSubscription", "2201", {
          name: "people.v2.events.person.created",
          url: "https://hooks.example.com/people",
          active: true,
          application_id: "2202",
          authenticity_secret: "golden-webhook-signing-secret",
          created_at: "2025-06-01T00:00:00Z",
        }),
      ]),
    },
  ],
  failures: {
    read: { tool: "get_person", args: { personId: "7" } },
    write: { tool: "create_person", args: { firstName: "Bob", lastName: "Jones" } },
  },
});
