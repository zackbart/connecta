// The Planning Center connection is hand-written fetch over JSON:API. Tests
// stub the network and pin what this provider owns: the pinned version per
// product, the credential framing, request shapes, projections, the hatch
// confinement, and the typed failures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../src/errors.js";
import {
  PLANNING_CENTER_API_BASE_URL,
  PLANNING_CENTER_API_VERSIONS,
  PLANNING_CENTER_APPS,
  planningCenter,
} from "../src/providers/planning-center.js";
import { memoryStorage } from "../src/storage/memory.js";
import { isExplicitlyReadOnly } from "../src/tool-safety.js";
import { silentLogger } from "./helpers.js";
import type { Connector, ConnectorContext, ConnectorUsageGuide } from "../src/types.js";

interface StubResponse {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

interface StubCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let responses: StubResponse[] = [];
const calls: StubCall[] = [];
const realFetch = globalThis.fetch;

function queue(...items: StubResponse[]): void {
  responses.push(...items);
}

beforeEach(() => {
  responses = [];
  calls.length = 0;
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const next = responses.shift() ?? {};
    const headers = new Headers(init.headers);
    calls.push({
      url: new URL(String(input)),
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body: typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined,
    });
    const status = next.status ?? 200;
    return new Response(
      [204, 205, 304].includes(status) ? null : (next.text ?? JSON.stringify(next.body ?? { data: [] })),
      { status, ...(next.headers ? { headers: next.headers } : {}) },
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function context(
  values: Record<string, string> | null = { applicationId: "app123", secret: "shh456" },
): ConnectorContext {
  return {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    credential: {
      get: async (field?: string) => (field && values ? values[field] ?? null : null),
      getAll: async () => values,
    },
  };
}

function connection(overrides: Record<string, unknown> = {}): Connector {
  return planningCenter("church", {
    purpose: "Downtown campus staff operations",
    ...overrides,
  } as Parameters<typeof planningCenter>[1]);
}

function call(
  name: string,
  args: Record<string, unknown> = {},
  connector: Connector = connection(),
  ctx: ConnectorContext = context(),
): Promise<any> {
  return connector.callTool(name, args, ctx) as Promise<any>;
}

function guide(connector: Connector): ConnectorUsageGuide {
  if (typeof connector.usageGuide !== "object" || !connector.usageGuide) {
    throw new Error("expected a structured guide");
  }
  return connector.usageGuide;
}

function person(id: string, attributes: Record<string, unknown>, relationships: Record<string, unknown> = {}) {
  return { type: "Person", id, attributes, relationships };
}

describe("planningCenter() construction", () => {
  it("refuses a blank purpose, an out-of-range page size, and a multi-line user agent", () => {
    expect(() => planningCenter("church", { purpose: "  " })).toThrow("non-empty organization purpose");
    expect(() => connection({ defaultPageSize: 101 })).toThrow("between 1 and 100");
    expect(() => connection({ defaultPageSize: 0 })).toThrow("between 1 and 100");
    expect(() => connection({ userAgent: "connecta\r\nX-Evil: 1" })).toThrow("single line");
  });

  it("ships a static surface with explicit safety on every tool and hatches split by class", async () => {
    const connector = connection();
    expect(connector.kind).toBe("api");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const tools = await connector.listTools(context());
    expect(tools.length).toBeGreaterThan(40);
    for (const tool of tools) {
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(isExplicitlyReadOnly(byName.get("pco_api_get")!)).toBe(true);
    expect(isExplicitlyReadOnly(byName.get("pco_api_mutate")!)).toBe(false);
    expect(byName.get("pco_api_mutate")!.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(byName.has("pco_api_upload")).toBe(false);
    // Additive writes are write-routed without claiming destruction; anything
    // that moves or fires existing state is destructive.
    for (const name of ["create_person", "add_person_email", "schedule_plan_person", "add_group_member", "add_workflow_card"]) {
      expect(byName.get(name)!.annotations, name).toEqual({ readOnlyHint: false, destructiveHint: false });
    }
    for (const name of ["update_person", "run_list", "apply_workflow_card_action"]) {
      expect(byName.get(name)!.annotations, name).toEqual({ readOnlyHint: false, destructiveHint: true });
    }
    // Giving is read-only on the named surface: money moves only through the hatch.
    const givingWrites = tools.filter(
      (tool) => /donation|fund|batch|pledge/.test(tool.name) && tool.annotations?.readOnlyHint !== true,
    );
    expect(givingWrites.map((tool) => tool.name)).toEqual([]);
  });

  it("declares a two-field personal access token slot and the documented admission budget", () => {
    const connector = connection();
    expect(connector.credential?.fields?.map((field) => [field.name, field.inputType])).toEqual([
      ["applicationId", "text"],
      ["secret", "password"],
    ]);
    expect(connector.testCredentials).toBeInstanceOf(Function);
    expect(connector.callAdmission?.rules[0]).toMatchObject({
      maxConcurrency: 5,
      budget: { kind: "rolling-window", maxCalls: 100, windowMs: 20_000 },
    });
    const custom = { rules: [{ budget: { kind: "rolling-window" as const, maxCalls: 50, windowMs: 20_000 } }] };
    expect(connection({ callAdmission: custom }).callAdmission).toBe(custom);
  });

  it("routes by purpose, appends instructions, and states the pins and write limits", () => {
    const connector = connection({ instructions: "Use the Downtown campus id 42." });
    expect(connector.title).toBe("Planning Center");
    expect(connector.description).toContain("Downtown campus staff operations");
    const content = guide(connector).content;
    expect(content.split("\n").find((line) => line.trim() && !line.startsWith("#"))).toContain(
      "Downtown campus staff operations",
    );
    expect(content).toContain("## Organization instructions\n\nUse the Downtown campus id 42.");
    for (const app of PLANNING_CENTER_APPS) {
      expect(content).toContain(`${app} ${PLANNING_CENTER_API_VERSIONS[app]}`);
    }
    expect(content).toContain("Check-Ins and Registrations: read-only");
    expect(content).toContain("groups cannot be created");
    expect(guide(connector).summary!.length).toBeLessThanOrEqual(120);
    expect(guide(connector).required).toBeUndefined();
  });
});

describe("Planning Center transport", () => {
  it("sends HTTP Basic, the user agent, and the pinned version for the path's product", async () => {
    queue({ body: { data: [] } }, { body: { data: [] } }, { body: { data: [] } });
    await call("search_people");
    await call("list_service_types");
    await call("list_donations");
    expect(calls.map((entry) => entry.url.origin)).toEqual(Array(3).fill(PLANNING_CENTER_API_BASE_URL));
    expect(calls[0]!.headers["authorization"]).toBe(`Basic ${btoa("app123:shh456")}`);
    expect(calls[0]!.headers["user-agent"]).toMatch(/^connecta\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/zackbart\/connecta\)$/);
    expect(calls.map((entry) => entry.headers["x-pco-api-version"])).toEqual([
      PLANNING_CENTER_API_VERSIONS.people,
      PLANNING_CENTER_API_VERSIONS.services,
      PLANNING_CENTER_API_VERSIONS.giving,
    ]);
  });

  it("sends a configured user agent", async () => {
    queue({ body: { data: [] } });
    await call("list_funds", {}, connection({ userAgent: "Grace Church staff bot (ops@grace.example)" }));
    expect(calls[0]!.headers["user-agent"]).toBe("Grace Church staff bot (ops@grace.example)");
  });

  it("fails locally without both credential fields, and on a pasted id that cannot be a token", async () => {
    await expect(call("search_people", {}, connection(), context({ applicationId: "app123" }))).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringMatching(/Application ID and the Secret.*authorize_connector/),
    });
    await expect(call("search_people", {}, connection(), context(null))).rejects.toMatchObject({ code: "auth_required" });
    await expect(
      call("search_people", {}, connection(), context({ applicationId: "app:123", secret: "shh" })),
    ).rejects.toMatchObject({ code: "auth_required", message: expect.stringContaining("re-paste") });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, "auth_required", false],
    [403, "connector_call_failed", false],
    [404, "not_found", false],
    [422, "invalid_args", false],
    [500, "unavailable", true],
  ] as const)("maps HTTP %s to %s", async (status, code, retryable) => {
    queue({
      status,
      body: { errors: [{ status: String(status), title: "Provider title", detail: "provider detail", source: { pointer: "/data/attributes/first_name" } }] },
    });
    const error = (await call("get_person", { personId: "7" }).catch((caught) => caught)) as ConnectorCallError;
    expect(error).toBeInstanceOf(ConnectorCallError);
    expect(error).toMatchObject({ code, retryable });
    expect(error.message).toContain("Provider title: provider detail (/data/attributes/first_name)");
  });

  it("names the merge possibility on a 404 and the user's permissions on a 403", async () => {
    queue({ status: 404, body: { errors: [] } }, { status: 403, text: "<html>forbidden</html>" });
    await expect(call("get_person", { personId: "7" })).rejects.toMatchObject({
      message: expect.stringContaining("person_mergers"),
    });
    await expect(call("get_person", { personId: "7" })).rejects.toMatchObject({
      message: expect.stringMatching(/HTTP 403.*lacks permission/),
    });
  });

  it("carries Planning Center's Retry-After on a 429", async () => {
    queue({ status: 429, body: { errors: [{ title: "Too Many Requests" }] }, headers: { "Retry-After": "7" } });
    await expect(call("list_funds")).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 7_000 });
  });

  it("refuses a successful response that is not JSON", async () => {
    queue({ text: "<html>gateway</html>" });
    await expect(call("list_funds")).rejects.toMatchObject({ code: "connector_call_failed", retryable: false });
  });
});

describe("Planning Center People", () => {
  it("searches people, flattens includes to a primary email and phone, and pages by offset", async () => {
    queue({
      body: {
        data: [
          person(
            "1",
            { name: "Ada Lovelace", first_name: "Ada", last_name: "Lovelace", status: "active", membership: "Member", child: false, medical_notes: "private", updated_at: "2026-01-01T00:00:00Z" },
            {
              emails: { data: [{ type: "Email", id: "e1" }, { type: "Email", id: "e2" }] },
              phone_numbers: { data: [{ type: "PhoneNumber", id: "p1" }] },
            },
          ),
        ],
        included: [
          { type: "Email", id: "e1", attributes: { address: "old@example.com", primary: false } },
          { type: "Email", id: "e2", attributes: { address: "ada@example.com", primary: true } },
          { type: "PhoneNumber", id: "p1", attributes: { number: "555-0100", primary: false } },
        ],
        meta: { total_count: 60, next: { offset: 50 } },
      },
    });
    const result = await call("search_people", {
      search: "ada",
      status: "active",
      updatedSince: "2026-01-01",
      order: "-updated_at",
      offset: 25,
    });
    const query = calls[0]!.url.searchParams;
    expect(calls[0]!.url.pathname).toBe("/people/v2/people");
    expect(query.get("where[search_name_or_email_or_phone_number]")).toBe("ada");
    expect(query.get("where[status]")).toBe("active");
    expect(query.get("where[updated_at][gte]")).toBe("2026-01-01");
    expect(query.get("include")).toBe("emails,phone_numbers");
    expect(query.get("order")).toBe("-updated_at");
    expect(query.get("per_page")).toBe("25");
    expect(query.get("offset")).toBe("25");
    expect(result.people).toEqual([
      {
        id: "1",
        name: "Ada Lovelace",
        first_name: "Ada",
        last_name: "Lovelace",
        status: "active",
        membership: "Member",
        child: false,
        primary_email: "ada@example.com",
        primary_phone: "555-0100",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(result.page).toEqual({ hasMore: true, nextOffset: 50, totalCount: 60 });
  });

  it("returns untouched resources and included records with raw: true", async () => {
    const data = [person("1", { name: "Ada", medical_notes: "private" })];
    const included = [{ type: "Email", id: "e1", attributes: { address: "ada@example.com" } }];
    queue({ body: { data, included, meta: {} } });
    const result = await call("search_people", { raw: true, perPage: 5 });
    expect(calls[0]!.url.searchParams.get("per_page")).toBe("5");
    expect(result).toEqual({ people: data, included, page: { hasMore: false, nextOffset: null, totalCount: null } });
  });

  it("gets a person with every contact record, household, and campus", async () => {
    queue({
      body: {
        data: person(
          "7",
          { name: "Ada Lovelace", first_name: "Ada", last_name: "Lovelace", status: "active", birthdate: "1815-12-10", people_permissions: "Editor" },
          {
            emails: { data: [{ type: "Email", id: "e1" }] },
            phone_numbers: { data: [] },
            addresses: { data: [{ type: "Address", id: "a1" }] },
            households: { data: [{ type: "Household", id: "h1" }] },
            primary_campus: { data: { type: "Campus", id: "c1" } },
          },
        ),
        included: [
          { type: "Email", id: "e1", attributes: { address: "ada@example.com", location: "Home", primary: true } },
          { type: "Address", id: "a1", attributes: { city: "London", primary: true, created_at: "x" } },
          { type: "Household", id: "h1", attributes: { name: "Lovelace household", primary_contact_id: "7", member_count: 3 } },
          { type: "Campus", id: "c1", attributes: { name: "Downtown" } },
        ],
      },
    });
    const result = await call("get_person", { personId: "7" });
    expect(calls[0]!.url.pathname).toBe("/people/v2/people/7");
    expect(calls[0]!.url.searchParams.get("include")).toBe("emails,phone_numbers,addresses,households,primary_campus");
    expect(result).toMatchObject({
      id: "7",
      birthdate: "1815-12-10",
      primary_email: "ada@example.com",
      primary_phone: null,
      primary_campus: { id: "c1", name: "Downtown" },
      emails: [{ id: "e1", address: "ada@example.com", location: "Home", primary: true }],
      phone_numbers: [],
      addresses: [{ id: "a1", city: "London", primary: true }],
      households: [{ id: "h1", name: "Lovelace household", primary_contact_id: "7", member_count: 3 }],
    });
    expect(result).not.toHaveProperty("people_permissions");
  });

  it("refuses an id that is not Planning Center's numeric shape before any request", async () => {
    await expect(call("get_person", { personId: "../../oauth" })).rejects.toMatchObject({ code: "invalid_args" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("creates and updates people with JSON:API documents and refuses an empty update", async () => {
    queue(
      { status: 201, body: { data: person("9", { name: "Grace Hopper", first_name: "Grace", last_name: "Hopper", status: "active" }) } },
      { body: { data: person("9", { name: "Grace Hopper", status: "inactive" }) } },
    );
    const createdPerson = await call("create_person", { firstName: "Grace", lastName: "Hopper", birthdate: "1906-12-09" });
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(calls[0]!.body).toEqual({
      data: { type: "Person", attributes: { first_name: "Grace", last_name: "Hopper", birthdate: "1906-12-09" } },
    });
    expect(createdPerson).toMatchObject({ id: "9", name: "Grace Hopper", primary_email: null });

    await call("update_person", { personId: "9", status: "inactive", nickname: null });
    expect(calls[1]).toMatchObject({ method: "PATCH" });
    expect(calls[1]!.url.pathname).toBe("/people/v2/people/9");
    expect(calls[1]!.body).toEqual({ data: { type: "Person", id: "9", attributes: { status: "inactive", nickname: null } } });

    await expect(call("update_person", { personId: "9" })).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(2);
  });

  it("adds email and phone records with default locations", async () => {
    queue(
      { status: 201, body: { data: { type: "Email", id: "e9", attributes: { address: "g@example.com", location: "Home", primary: true }, relationships: { person: { data: { type: "Person", id: "9" } } } } } },
      { status: 201, body: { data: { type: "PhoneNumber", id: "p9", attributes: { number: "555", location: "Mobile", primary: false } } } },
    );
    expect(await call("add_person_email", { personId: "9", address: "g@example.com", primary: true })).toEqual({
      id: "e9",
      address: "g@example.com",
      location: "Home",
      primary: true,
      person_id: "9",
    });
    expect(calls[0]!.body).toEqual({ data: { type: "Email", attributes: { address: "g@example.com", location: "Home", primary: true } } });
    await call("add_person_phone_number", { personId: "9", number: "555" });
    expect(calls[1]!.url.pathname).toBe("/people/v2/people/9/phone_numbers");
    expect(calls[1]!.body).toEqual({ data: { type: "PhoneNumber", attributes: { number: "555", location: "Mobile" } } });
  });

  it("names each profile note's category and files a new note under one", async () => {
    queue(
      {
        body: {
          data: [{ type: "Note", id: "n1", attributes: { note: "Visited", note_category_id: "c1", person_id: "1", created_at: "2026-09-01" } }],
          included: [{ type: "NoteCategory", id: "c1", attributes: { name: "Pastoral" } }],
        },
      },
      { status: 201, body: { data: { type: "Note", id: "n2", attributes: { note: "Called", note_category_id: "c1" } } } },
    );
    const result = await call("list_person_notes", { personId: "1" });
    expect(calls[0]!.url.searchParams.get("order")).toBe("-created_at");
    expect(result.notes).toEqual([
      { id: "n1", note: "Visited", note_category_id: "c1", person_id: "1", created_at: "2026-09-01", category: "Pastoral" },
    ]);
    await expect(call("add_person_note", { personId: "1", note: "Called" })).rejects.toMatchObject({ code: "invalid_args" });
    await call("add_person_note", { personId: "1", note: "Called", noteCategoryId: "4" });
    expect(calls[1]!.body).toEqual({ data: { type: "Note", attributes: { note: "Called", note_category_id: "4" } } });
  });

  it("runs a list and lists its people", async () => {
    queue({ status: 201, body: {} }, { body: { data: [person("1", { name: "Ada" })] } });
    expect(await call("run_list", { listId: "3" })).toEqual({ listId: "3", queued: true });
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(calls[0]!.url.pathname).toBe("/people/v2/lists/3/run");
    const result = await call("list_list_people", { listId: "3" });
    expect(calls[1]!.url.pathname).toBe("/people/v2/lists/3/people");
    expect(result.people[0]).toMatchObject({ id: "1", name: "Ada" });
  });

  it("lists workflow cards with person and step names, and applies card actions", async () => {
    queue({
      body: {
        data: [
          {
            type: "WorkflowCard",
            id: "c1",
            attributes: { stage: "ready", overdue: true, moved_to_step_at: "2026-09-01T00:00:00Z" },
            relationships: {
              person: { data: { type: "Person", id: "1" } },
              assignee: { data: null },
              current_step: { data: { type: "WorkflowStep", id: "s2" } },
            },
          },
        ],
        included: [
          person("1", { name: "Ada Lovelace" }),
          { type: "WorkflowStep", id: "s2", attributes: { name: "Call", sequence: 1 } },
        ],
      },
    });
    const result = await call("list_workflow_cards", { workflowId: "5", overdue: true, stage: "ready" });
    expect(calls[0]!.url.pathname).toBe("/people/v2/workflows/5/cards");
    expect(calls[0]!.url.searchParams.get("where[overdue]")).toBe("true");
    expect(calls[0]!.url.searchParams.get("include")).toBe("person,current_step");
    expect(result.cards).toEqual([
      {
        id: "c1",
        stage: "ready",
        person_id: "1",
        person_name: "Ada Lovelace",
        assignee_id: null,
        current_step_id: "s2",
        current_step_name: "Call",
        moved_to_step_at: "2026-09-01T00:00:00Z",
        overdue: true,
      },
    ]);

    queue({ status: 201, body: {} }, { status: 201, body: {} });
    await call("apply_workflow_card_action", { personId: "1", cardId: "88", action: "snooze", snoozeDays: 15 });
    expect(calls[1]!.url.pathname).toBe("/people/v2/people/1/workflow_cards/88/snooze");
    expect(calls[1]!.body).toEqual({ data: { attributes: { duration: 15 } } });
    await call("apply_workflow_card_action", { personId: "1", cardId: "88", action: "promote" });
    expect(calls[2]!.url.pathname).toBe("/people/v2/people/1/workflow_cards/88/promote");
    expect(calls[2]!.body).toBeUndefined();

    await expect(call("apply_workflow_card_action", { personId: "1", cardId: "88", action: "snooze" })).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      call("apply_workflow_card_action", { personId: "1", cardId: "88", action: "remove", snoozeDays: 2 }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(call("apply_workflow_card_action", { personId: "1", cardId: "88", action: "send_email" })).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(3);
  });

  it("labels form submission answers with their field and custom field data with its definition", async () => {
    queue(
      {
        body: {
          data: [
            {
              type: "FormSubmission",
              id: "fs1",
              attributes: { created_at: "2026-09-01T00:00:00Z" },
              relationships: {
                person: { data: { type: "Person", id: "1" } },
                form_submission_values: { data: [{ type: "FormSubmissionValue", id: "v1" }] },
              },
            },
          ],
          included: [
            person("1", { name: "Ada" }),
            { type: "FormSubmissionValue", id: "v1", attributes: { value: "raw", display_value: "Shown" }, relationships: { form_field: { data: { type: "FormField", id: "f1" } } } },
            { type: "FormField", id: "f1", attributes: { label: "T-shirt size" } },
          ],
        },
      },
      {
        body: {
          data: [{ type: "FieldDatum", id: "d1", attributes: { value: "Blue" }, relationships: { field_definition: { data: { type: "FieldDefinition", id: "fd1" } } } }],
          included: [{ type: "FieldDefinition", id: "fd1", attributes: { name: "Favorite color", data_type: "string" } }],
        },
      },
    );
    const submissions = await call("list_form_submissions", { formId: "4" });
    expect(calls[0]!.url.searchParams.get("order")).toBe("-created_at");
    expect(submissions.submissions).toEqual([
      { id: "fs1", created_at: "2026-09-01T00:00:00Z", person_id: "1", person_name: "Ada", values: [{ field: "T-shirt size", value: "Shown" }] },
    ]);
    const fields = await call("list_person_field_data", { personId: "1" });
    expect(fields.fields).toEqual([
      { id: "d1", field_definition_id: "fd1", field: "Favorite color", data_type: "string", value: "Blue", file_name: null },
    ]);
  });
});

describe("Planning Center Services, Groups, Check-Ins, and Giving", () => {
  it("gets a plan, its order of service, and its team in one call and flags truncation", async () => {
    queue(
      {
        body: {
          data: {
            type: "Plan",
            id: "p1",
            attributes: { title: "Easter", dates: "April 5, 2026", permissions: "Editor" },
            relationships: { plan_times: { data: [{ type: "PlanTime", id: "t1" }] } },
          },
          included: [{ type: "PlanTime", id: "t1", attributes: { name: "9am", time_type: "service", starts_at: "2026-04-05T14:00:00Z" } }],
        },
      },
      {
        body: {
          data: [
            { type: "Item", id: "i2", attributes: { sequence: 2, item_type: "song", title: "Song", html_details: "<p>noise</p>" }, relationships: { song: { data: { type: "Song", id: "s1" } } } },
            { type: "Item", id: "i1", attributes: { sequence: 1, item_type: "header", title: "Welcome" } },
          ],
          meta: { next: { offset: 100 } },
        },
      },
      {
        body: {
          data: [{ type: "PlanPerson", id: "pp1", attributes: { name: "Ada", status: "C" }, relationships: { team: { data: { type: "Team", id: "tm1" } }, person: { data: { type: "Person", id: "1" } } } }],
          included: [{ type: "Team", id: "tm1", attributes: { name: "Band" } }],
          meta: {},
        },
      },
    );
    const result = await call("get_plan", { serviceTypeId: "10", planId: "20" });
    expect(calls.map((entry) => entry.url.pathname).sort()).toEqual([
      "/services/v2/service_types/10/plans/20",
      "/services/v2/service_types/10/plans/20/items",
      "/services/v2/service_types/10/plans/20/team_members",
    ]);
    expect(result.plan).toEqual({
      id: "p1",
      title: "Easter",
      dates: "April 5, 2026",
      times: [{ id: "t1", name: "9am", time_type: "service", starts_at: "2026-04-05T14:00:00Z" }],
    });
    expect(result.items.map((item: any) => item.id)).toEqual(["i1", "i2"]);
    expect(result.items[1]).toEqual({ id: "i2", sequence: 2, item_type: "song", title: "Song", song_id: "s1", arrangement_id: null });
    expect(result.teamMembers).toEqual([
      { id: "pp1", name: "Ada", status: "C", team_id: "tm1", team_name: "Band", person_id: "1" },
    ]);
    expect(result.itemsTruncated).toBe(true);
    expect(result.teamMembersTruncated).toBe(false);
  });

  it("defaults plans to upcoming and schedules a person unconfirmed", async () => {
    queue(
      { body: { data: [] } },
      { body: { data: [] } },
      { status: 201, body: { data: { type: "PlanPerson", id: "pp2", attributes: { name: "Ada", status: "U" }, relationships: { team: { data: { type: "Team", id: "3" } } } } } },
    );
    await call("list_plans", { serviceTypeId: "10" });
    expect(calls[0]!.url.searchParams.get("filter")).toBe("future");
    expect(calls[0]!.url.searchParams.get("order")).toBe("sort_date");
    await call("list_plans", { serviceTypeId: "10", when: "past" });
    expect(calls[1]!.url.searchParams.get("order")).toBe("-sort_date");
    const scheduled = await call("schedule_plan_person", { serviceTypeId: "10", planId: "20", personId: "1", teamId: "3", teamPositionName: "Bass" });
    expect(calls[2]!.url.pathname).toBe("/services/v2/service_types/10/plans/20/team_members");
    expect(calls[2]!.body).toEqual({
      data: { type: "PlanPerson", attributes: { person_id: "1", team_id: "3", team_position_name: "Bass", status: "U" } },
    });
    expect(scheduled).toMatchObject({ id: "pp2", status: "U", team_id: "3" });
  });

  it("resolves group membership names through the included person", async () => {
    queue({
      body: {
        data: [{ type: "Membership", id: "m1", attributes: { role: "leader", joined_at: "2025-01-01" }, relationships: { person: { data: { type: "Person", id: "1" } } } }],
        included: [person("1", { first_name: "Ada", last_name: "Lovelace" })],
      },
    });
    const result = await call("list_group_memberships", { groupId: "8", role: "leader" });
    expect(calls[0]!.url.searchParams.get("include")).toBe("person");
    expect(calls[0]!.url.searchParams.get("where[role]")).toBe("leader");
    expect(result.memberships).toEqual([
      { id: "m1", role: "leader", joined_at: "2025-01-01", person_id: "1", first_name: "Ada", last_name: "Lovelace" },
    ]);
  });

  it("scopes check-ins by service date through the event period", async () => {
    queue({ body: { data: [] } }, { body: { data: [] } });
    await call("list_check_ins", { eventId: "2", serviceAfter: "2026-09-06", serviceBefore: "2026-09-07", kind: "guest" });
    const query = calls[0]!.url.searchParams;
    expect(calls[0]!.url.pathname).toBe("/check-ins/v2/events/2/check_ins");
    expect(query.get("where[event_period][starts_at][gte]")).toBe("2026-09-06");
    expect(query.get("where[event_period][starts_at][lt]")).toBe("2026-09-07");
    expect(query.get("filter")).toBe("guest");
    await call("list_check_ins");
    expect(calls[1]!.url.pathname).toBe("/check-ins/v2/check_ins");
  });

  it("lists donations with fund-named designations, by donor when asked", async () => {
    queue(
      {
        body: {
          data: [
            {
              type: "Donation",
              id: "d1",
              attributes: { amount_cents: 5000, amount_currency: "USD", received_at: "2026-09-01", payment_last4: "4242", refunded: false },
              relationships: {
                person: { data: { type: "Person", id: "1" } },
                batch: { data: null },
                designations: { data: [{ type: "Designation", id: "g1" }] },
              },
            },
          ],
          included: [
            { type: "Designation", id: "g1", attributes: { amount_cents: 5000 }, relationships: { fund: { data: { type: "Fund", id: "f1" } } } },
            { type: "Fund", id: "f1", attributes: { name: "General" } },
          ],
        },
      },
      { body: { data: [] } },
    );
    const result = await call("list_donations", { receivedAfter: "2026-09-01", fundId: "1", succeededOnly: true });
    const query = calls[0]!.url.searchParams;
    expect(calls[0]!.url.pathname).toBe("/giving/v2/donations");
    expect(query.get("where[received_at][gte]")).toBe("2026-09-01");
    expect(query.get("where[fund_id]")).toBe("1");
    expect(query.get("filter")).toBe("succeeded");
    expect(query.get("order")).toBe("-received_at");
    expect(query.get("include")).toBe("designations,designations.fund");
    expect(result.donations).toEqual([
      {
        id: "d1",
        amount_cents: 5000,
        amount_currency: "USD",
        received_at: "2026-09-01",
        refunded: false,
        person_id: "1",
        batch_id: null,
        campus_id: null,
        designations: [{ fund_id: "f1", fund: "General", amount_cents: 5000 }],
      },
    ]);
    await call("list_donations", { personId: "1" });
    expect(calls[1]!.url.pathname).toBe("/giving/v2/people/1/donations");
  });

  it("never returns a webhook subscription's signing secret", async () => {
    queue({
      body: {
        data: [{ type: "WebhookSubscription", id: "w1", attributes: { name: "people.v2.events.person.created", url: "https://hooks.example", active: true, authenticity_secret: "whsec_live" } }],
      },
    });
    const result = await call("list_webhook_subscriptions");
    expect(JSON.stringify(result)).not.toContain("whsec_live");
    expect(result.subscriptions[0]).toEqual({ id: "w1", name: "people.v2.events.person.created", url: "https://hooks.example", active: true });
  });
});

describe("Planning Center hatches", () => {
  it("sends the path's pinned version, query pairs, and returns the untouched body", async () => {
    const body = { data: [{ type: "Episode", id: "1", attributes: {} }], meta: { total_count: 1 } };
    queue({ body }, { body: {} });
    const result = await call("pco_api_get", {
      path: "/publishing/v2/episodes",
      query: [{ name: "where[title]", value: "Easter" }, { name: "per_page", value: 5 }],
    });
    expect(result).toEqual({ result: body });
    expect(calls[0]!.url.pathname).toBe("/publishing/v2/episodes");
    expect(calls[0]!.url.searchParams.get("where[title]")).toBe("Easter");
    expect(calls[0]!.headers["x-pco-api-version"]).toBe(PLANNING_CENTER_API_VERSIONS.publishing);
    await call("pco_api_get", { path: "/people/v2", version: "2025-11-10" });
    expect(calls[1]!.headers["x-pco-api-version"]).toBe("2025-11-10");
  });

  it("confines paths to a product below /<app>/v2", async () => {
    for (const path of [
      "/oauth/token",
      "/people/v1/people",
      "/people/v2/../../oauth/token",
      "/people/v2/%2e%2e/%2e%2e/oauth/token",
      "//evil.example/people/v2",
      "https://evil.example/people/v2/people",
      "/accounting/v2/ledgers",
      "/people/v2/people?per_page=1",
    ]) {
      await expect(call("pco_api_get", { path }), path).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("allows traversal only when it lands inside another product, and pins that product", async () => {
    queue({ body: {} });
    await call("pco_api_get", { path: "/people/v2/../../giving/v2/funds" });
    expect(calls[0]!.url.pathname).toBe("/giving/v2/funds");
    expect(calls[0]!.headers["x-pco-api-version"]).toBe(PLANNING_CENTER_API_VERSIONS.giving);
  });

  it("sends JSON:API mutations, refuses GET and PUT, and returns null for 204", async () => {
    queue({ status: 201, body: { data: { type: "Batch", id: "b1" } } }, { status: 204 });
    const document = { data: { type: "Batch", attributes: { description: "Sunday" } } };
    expect(await call("pco_api_mutate", { method: "POST", path: "/giving/v2/batches", body: document })).toEqual({
      result: { data: { type: "Batch", id: "b1" } },
    });
    expect(calls[0]).toMatchObject({ method: "POST", body: document });
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(await call("pco_api_mutate", { method: "DELETE", path: "/people/v2/emails/9" })).toEqual({ result: null });
    for (const method of ["GET", "PUT"]) {
      await expect(call("pco_api_mutate", { method, path: "/people/v2/people" })).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(calls).toHaveLength(2);
  });
});

describe("Planning Center credential test", () => {
  it("reports the person and organization the token acts as", async () => {
    queue({
      body: {
        data: person("42", { name: "Ada Lovelace" }),
        included: [{ type: "Organization", id: "1", attributes: { name: "Grace Church" } }],
      },
    });
    const result = await connection().testCredentials!({ applicationId: "candidate", secret: "s3cret" }, context(null));
    expect(calls[0]!.url.pathname).toBe("/people/v2/me");
    expect(calls[0]!.url.searchParams.get("include")).toBe("organization");
    expect(calls[0]!.headers["authorization"]).toBe(`Basic ${btoa("candidate:s3cret")}`);
    expect(result).toEqual({ ok: true, message: "Authenticated as Ada Lovelace (person 42) in Grace Church." });
  });

  it("reports a rejected token without throwing", async () => {
    queue({ status: 401, body: { errors: [{ title: "Unauthorized" }] } });
    const result = await connection().testCredentials!({ applicationId: "bad", secret: "bad" }, context(null));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Unauthorized");
  });
});
