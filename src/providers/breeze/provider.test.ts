// The Breeze connection is hand-written fetch against one church's own host.
// Tests stub the network and pin the requests, the endpoint-split hatches,
// projections, and typed failures we own. Every Breeze call is a GET, writes
// included, so the read hatch's allowlist is the safety boundary under test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../../errors.js";
import { breeze } from "./index.js";
import { memoryStorage } from "../../storage/memory.js";
import { classifyTool } from "../../tool-safety.js";
import { silentLogger } from "../../../test/helpers.js";
import type { Connector, ConnectorContext, ConnectorUsageGuide } from "../../types.js";

const isRead = (tool: import("../../types.js").ToolDef) => classifyTool(tool) === "read";

interface StubResponse {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
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
    const text = next.text ?? JSON.stringify(next.body ?? []);
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    });
    // Breeze labels JSON responses text/html; the stub does the same.
    return new Response(text, {
      status: next.status ?? 200,
      headers: { "content-type": "text/html; charset=UTF-8", ...next.headers },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function context(key: string | null = "breeze-key"): ConnectorContext {
  return {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    credential: {
      get: async () => key,
      getAll: async () => (key ? { value: key } : null),
    },
  };
}

function connection(overrides: Record<string, unknown> = {}): Connector {
  return breeze("church", {
    subdomain: "gracechurch",
    purpose: "Pastoral care and giving reports",
    ...overrides,
  } as Parameters<typeof breeze>[1]);
}

function call(
  connector: Connector,
  name: string,
  args: Record<string, unknown> = {},
  ctx: ConnectorContext = context(),
): Promise<any> {
  return connector.callTool(name, args, ctx) as Promise<any>;
}

function url(index = 0): URL {
  return new URL(calls[index]!.url);
}

function guide(connector: Connector): ConnectorUsageGuide {
  if (typeof connector.usageGuide !== "object" || !connector.usageGuide) {
    throw new Error("expected a structured guide");
  }
  return connector.usageGuide;
}

async function failure(promise: Promise<unknown>): Promise<ConnectorCallError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConnectorCallError) return error;
    throw error;
  }
  throw new Error("expected a ConnectorCallError");
}

describe("breeze() construction", () => {
  it("requires a purpose and a single-label subdomain", () => {
    expect(() => breeze("church", { subdomain: "gracechurch", purpose: "  " })).toThrow("non-empty church purpose");
    for (const subdomain of [
      "",
      "https://gracechurch.breezechms.com",
      "gracechurch.breezechms.com",
      "evil.example.com",
      "grace/church",
      "grace_church",
      "-grace",
      "a".repeat(64),
    ]) {
      expect(() => breeze("church", { subdomain, purpose: "Care" })).toThrow("one hostname label");
    }
    expect(() =>
      breeze("church", {
        subdomain: "grace",
        purpose: "Care",
        defaultPageSize: 1_001,
      }),
    ).toThrow("between 1 and 1000");
  });

  it("normalizes the subdomain and names the church in title and description", async () => {
    const connector = connection({ subdomain: "  GraceChurch " });
    expect(connector.kind).toBe("api");
    expect(connector.title).toBe("Breeze ChMS (gracechurch)");
    expect(connector.description).toContain("gracechurch.breezechms.com");
    expect(connector.callAdmission).toBeUndefined();
    queue({ body: { id: "1", name: "Grace" } });
    await call(connector, "get_account_summary");
    expect(url().origin).toBe("https://gracechurch.breezechms.com");
    expect(url().pathname).toBe("/api/account/summary");
    expect(calls[0]!.headers["api-key"]).toBe("breeze-key");
  });

  it("passes an operator admission policy through without inventing one", () => {
    const callAdmission = {
      rules: [{ maxConcurrency: 2, budget: { kind: "rolling-window" as const, maxCalls: 20, windowMs: 60_000 } }],
    };
    expect(connection({ callAdmission }).callAdmission).toEqual(callAdmission);
  });

  it("classifies every tool explicitly and splits the hatches by safety", async () => {
    const tools = await connection().listTools(context());
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(tools).toHaveLength(23);
    expect(isRead(byName.get("breeze_api_get")!)).toBe(true);
    expect(byName.get("breeze_api_mutate")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
    for (const name of ["list_contributions", "list_funds", "list_people", "get_person"]) {
      expect(isRead(byName.get(name)!), name).toBe(true);
    }
    for (const name of ["add_person", "assign_tag", "record_check_in"]) {
      expect(byName.get(name)?.annotations, name).toEqual({ readOnlyHint: false });
    }
    for (const name of ["update_person", "unassign_tag"]) {
      expect(byName.get(name)?.annotations, name).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    }
  });

  it("carries the church, sensitivity, giving caveat, and instructions in its guide", () => {
    const usage = guide(connection({ instructions: "Never tag minors." }));
    expect(usage.required).toBe(true);
    expect(usage.content.split("\n").find((line) => line.startsWith("Church database"))).toContain(
      "gracechurch.breezechms.com",
    );
    expect(usage.content).toContain("Pastoral care and giving reports");
    expect(usage.content).toContain("religious affiliation by proxy");
    expect(usage.content).toContain("removed from\nits public reference");
    expect(usage.content).toContain("third party reports");
    expect(usage.content).toContain("Never tag minors.");
  });

  it("INV-2: points write routing to usage without retired approval config", async () => {
    const connector = connection();
    const tools = await connector.listTools(context());
    for (const name of ["add_person", "assign_tag", "record_check_in"]) {
      expect(tools.find((tool) => tool.name === name)!.annotations?.readOnlyHint).toBe(false);
    }
    const content = guide(connector).content.replace(/\s+/g, " ");
    expect(content).not.toContain("execute.approval");
    expect(content).toContain("follows the routing in the `usage` skill");
    expect(content).toContain('skills({ name: "usage" })');
  });

  it("declares a single-field credential and constructs without the network", () => {
    const connector = connection();
    expect(connector.credential?.label).toBe("Breeze API key");
    expect(connector.credential?.fields).toBeUndefined();
    expect(connector.credential?.description).toContain("https://gracechurch.breezechms.com/extensions/api");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("Breeze people and profile reads", () => {
  it("pages people by an opaque offset cursor and turns tagId into Breeze's filter", async () => {
    queue({
      body: [
        {
          id: "1",
          first_name: "Thomas",
          force_first_name: "Tom",
          last_name: "Anderson",
          path: "img/profiles/generic/blue.jpg",
        },
        { id: "2", first_name: "Kate", force_first_name: "Kate", last_name: "Austen", path: "img/x.jpg" },
      ],
    });
    const result = await call(connection(), "list_people", {
      tagId: "16681",
      filter: { "2000138015": "226-227" },
      limit: 2,
      cursor: "40",
    });
    expect(url().pathname).toBe("/api/people");
    expect(url().searchParams.get("limit")).toBe("2");
    expect(url().searchParams.get("offset")).toBe("40");
    expect(url().searchParams.get("details")).toBe("0");
    expect(JSON.parse(url().searchParams.get("filter_json")!)).toEqual({
      "2000138015": "226-227",
      tag_contains: "y_16681",
    });
    expect(result).toEqual({
      people: [
        { id: "1", firstName: "Thomas", forceFirstName: "Tom", lastName: "Anderson" },
        { id: "2", firstName: "Kate", forceFirstName: "Kate", lastName: "Austen" },
      ],
      page: { hasMore: true, nextCursor: "42" },
    });
  });

  it("ends paging on a short page and uses the configured default page size", async () => {
    queue({ body: [{ id: "1", first_name: "A", last_name: "B" }] });
    const result = await call(connection({ defaultPageSize: 25 }), "list_people");
    expect(url().searchParams.get("limit")).toBe("25");
    expect(url().searchParams.get("filter_json")).toBeNull();
    expect(result.page).toEqual({ hasMore: false, nextCursor: null });
  });

  it("refuses a tag passed both ways before any request", async () => {
    const error = await failure(
      call(connection(), "list_people", {
        tagId: "1",
        filter: { tag_contains: "y_2" },
      }),
    );
    expect(error.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });

  it("gets one person with details and family, dropping photo paths", async () => {
    queue({
      body: {
        id: "157857",
        first_name: "Thomas",
        force_first_name: "Thomas",
        last_name: "Anderson",
        nick_name: "",
        thumb_path: "",
        path: "img/profiles/generic/blue.jpg",
        details: { "1508481877": [{ address: "t@example.com" }] },
        family: [
          {
            person_id: "157858",
            family_id: "9",
            role_name: "Spouse",
            details: { id: "157858", first_name: "Trinity", last_name: "Anderson", path: "x" },
          },
        ],
      },
    });
    const person = await call(connection(), "get_person", { personId: "157857" });
    expect(url().pathname).toBe("/api/people/157857");
    expect(url().searchParams.get("details")).toBe("1");
    expect(person).toEqual({
      id: "157857",
      firstName: "Thomas",
      forceFirstName: "Thomas",
      lastName: "Anderson",
      details: { "1508481877": [{ address: "t@example.com" }] },
      family: [{ personId: "157858", familyId: "9", role: "Spouse", firstName: "Trinity", lastName: "Anderson" }],
    });
  });

  it("maps an empty person answer to not_found, since a Breeze key has no scopes", async () => {
    queue({ body: [] });
    const error = await failure(call(connection(), "get_person", { personId: "999" }));
    expect(error.code).toBe("not_found");
  });

  it("refuses a non-numeric person id locally, so no path can be spelled through it", async () => {
    const error = await failure(call(connection(), "get_person", { personId: "delete" }));
    expect(error.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });

  it("flattens profile sections into fields with option ids", async () => {
    queue({
      body: [
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
      ],
    });
    const result = await call(connection(), "list_profile_fields");
    expect(result.fields).toEqual([
      {
        fieldId: "2000138015",
        name: "Status",
        type: "multiple_choice",
        section: "Main",
        options: [{ optionId: "225", name: "Member" }],
      },
      { fieldId: "656342607", name: "Age", type: "birthdate", section: "Main" },
    ]);
  });
});

describe("Breeze events, attendance, forms, volunteers, and the log", () => {
  it("lists event instances with zero dates as null and flags a full result", async () => {
    queue({
      body: [
        {
          id: "40984",
          oid: "2749",
          event_id: "736",
          name: "Youth Group",
          category_id: "0",
          start_datetime: "2025-03-05 18:00:00",
          end_datetime: "0000-00-00 00:00:00",
        },
      ],
    });
    const result = await call(connection(), "list_events", {
      start: "2025-03-01",
      end: "2025-03-31",
      calendarId: "1553",
      limit: 1,
    });
    expect(url().pathname).toBe("/api/events");
    expect(url().searchParams.get("category_id")).toBe("1553");
    expect(result).toEqual({
      events: [
        {
          id: "40984",
          eventId: "736",
          name: "Youth Group",
          calendarId: "0",
          startsAt: "2025-03-05 18:00:00",
          endsAt: null,
        },
      ],
      truncated: true,
    });
  });

  it("refuses a non-ISO date before the request", async () => {
    const error = await failure(call(connection(), "list_events", { start: "5-3-2025" }));
    expect(error.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });

  it("omits each calendar's private feed address", async () => {
    queue({
      body: [
        {
          id: 0,
          name: "Main",
          color: "b2cd92",
          address: "https://gracechurch.breezechms.com/events/feed/SECRET",
          embed_key: "AbC",
        },
      ],
    });
    const result = await call(connection(), "list_calendars");
    expect(result).toEqual({ calendars: [{ id: "0", name: "Main", color: "b2cd92" }] });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("projects attendance to names and times, leaving contact details to raw", async () => {
    queue({
      body: [
        {
          instance_id: "3778451",
          person_id: "824512",
          check_out: "0000-00-00 00:00:00",
          created_on: "2025-12-09 11:01:33",
          details: { first_name: "Carol", last_name: "Adams", details: { mobile: "123-123-1234" } },
        },
      ],
    });
    const result = await call(connection(), "list_attendance", {
      instanceId: "3778451",
      includeNames: true,
    });
    expect(url().searchParams.get("type")).toBe("person");
    expect(url().searchParams.get("details")).toBe("true");
    expect(result.attendance).toEqual([
      {
        personId: "824512",
        firstName: "Carol",
        lastName: "Adams",
        checkedInAt: "2025-12-09 11:01:33",
        checkedOutAt: null,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("123-123-1234");
  });

  it("lists form entries with responses only on request", async () => {
    queue(
      {
        body: [
          { id: "11", form_id: "15326", created_on: "2025-03-09", person_id: null, response: { "46": "z@test.com" } },
        ],
      },
      {
        body: [
          { id: "11", form_id: "15326", created_on: "2025-03-09", person_id: "5", response: { "46": "z@test.com" } },
        ],
      },
    );
    const lean = await call(connection(), "list_form_entries", { formId: "15326" });
    const full = await call(connection(), "list_form_entries", { formId: "15326", includeResponses: true });
    expect(url(0).searchParams.get("details")).toBe("0");
    expect(lean.entries).toEqual([{ id: "11", personId: null, createdAt: "2025-03-09" }]);
    expect(full.entries[0]).toEqual({
      id: "11",
      personId: "5",
      createdAt: "2025-03-09",
      responses: { "46": "z@test.com" },
    });
  });

  it("lists volunteers and roles for one instance", async () => {
    queue(
      {
        body: [
          { person_id: "3008467", response: "0", comment: "", rsvped_on: "0000-00-00 00:00:00", role_ids: null },
          { person_id: "3349681", role_ids: ["9627"] },
        ],
      },
      { body: [{ id: "9627", name: "Teacher", quantity: "2" }] },
    );
    const volunteers = await call(connection(), "list_volunteers", { instanceId: "123456" });
    const roles = await call(connection(), "list_volunteer_roles", { instanceId: "123456" });
    expect(volunteers.volunteers).toEqual([
      { personId: "3008467", roleIds: [], response: "0", rsvpedAt: null },
      { personId: "3349681", roleIds: ["9627"] },
    ]);
    expect(url(1).searchParams.get("show_quantity")).toBe("1");
    expect(roles.roles).toEqual([{ id: "9627", name: "Teacher", quantity: 2 }]);
  });

  it("parses the log's object_json and flags a full page", async () => {
    queue({
      body: [
        {
          id: "112",
          user_id: "261",
          action: "person_updated",
          object_json: '"5023943"',
          created_on: "2025-08-15 04:41:10",
        },
      ],
    });
    const result = await call(connection(), "list_account_log", {
      action: "person_updated",
      start: "2025-08-01",
      limit: 1,
    });
    expect(url().searchParams.get("action")).toBe("person_updated");
    expect(result).toEqual({
      entries: [
        { id: "112", action: "person_updated", userId: "261", object: "5023943", createdAt: "2025-08-15 04:41:10" },
      ],
      truncated: true,
    });
  });
});

describe("Breeze giving reads (undocumented endpoints)", () => {
  it("lists contributions with joined id filters, fund splits, and an exact total", async () => {
    queue({
      body: [
        {
          id: "378477",
          paid_on: "2022-03-05 00:00:00",
          num: "144",
          method: "check",
          method_id: "41",
          amount: "0.10",
          note: "",
          person_id: "157823",
          first_name: "Frodo",
          last_name: "Baggins",
          envelope_number: "105",
          meta: null,
          funds: [{ fund_id: "28", amount: "0.10", fund_name: "General Fund", tax_deductible: "1", oid: "2749" }],
        },
        { id: "376786", paid_on: "2022-05-06 00:00:00", amount: "0.20", funds: [] },
      ],
    });
    const result = await call(connection(), "list_contributions", {
      start: "2022-01-01",
      end: "2022-06-30",
      fundIds: ["28", "29"],
      batchNumbers: ["144"],
    });
    expect(url().pathname).toBe("/api/giving/list");
    expect(url().searchParams.get("start")).toBe("2022-01-01");
    expect(url().searchParams.get("fund_ids")).toBe("28-29");
    expect(url().searchParams.get("batches")).toBe("144");
    expect(result.count).toBe(2);
    // 0.1 + 0.2 is the float trap; summed in cents, the total is exact.
    expect(result.totalAmount).toBe("0.30");
    expect(result.contributions[0]).toEqual({
      id: "378477",
      paidOn: "2022-03-05",
      amount: "0.10",
      method: "check",
      methodId: "41",
      personId: "157823",
      firstName: "Frodo",
      lastName: "Baggins",
      envelopeNumber: "105",
      batchNumber: "144",
      funds: [{ fundId: "28", name: "General Fund", amount: "0.10", taxDeductible: true }],
    });
  });

  it("refuses includeFamily without a donor before the request", async () => {
    const error = await failure(
      call(connection(), "list_contributions", {
        start: "2022-01-01",
        end: "2022-06-30",
        includeFamily: true,
      }),
    );
    expect(error.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });

  it("lists funds with boolean flags", async () => {
    queue({ body: [{ id: "12346", name: "General Fund", tax_deductible: "1", is_default: "1", created_on: "x" }] });
    const result = await call(connection(), "list_funds");
    expect(url().pathname).toBe("/api/funds/list");
    expect(result.funds).toEqual([{ id: "12346", name: "General Fund", taxDeductible: true, isDefault: true }]);
  });
});

describe("Breeze named writes", () => {
  it("adds a person with JSON-encoded profile values", async () => {
    queue({
      body: [{ id: "12345678", first_name: "Jiminy", force_first_name: "Jiminy", last_name: "Cricket", path: "x" }],
    });
    const person = await call(connection(), "add_person", {
      firstName: "Jiminy",
      lastName: "Cricket",
      fields: [{ fieldId: "1508481877", type: "email", details: { address: "j@example.com" } }],
    });
    expect(url().pathname).toBe("/api/people/add");
    expect(url().searchParams.get("first")).toBe("Jiminy");
    expect(JSON.parse(url().searchParams.get("fields_json")!)).toEqual([
      { field_id: "1508481877", field_type: "email", response: true, details: { address: "j@example.com" } },
    ]);
    expect(person).toEqual({ id: "12345678", firstName: "Jiminy", forceFirstName: "Jiminy", lastName: "Cricket" });
  });

  it("updates a person and refuses a detail-type field without details", async () => {
    const missing = await failure(
      call(connection(), "update_person", {
        personId: "12345678",
        fields: [{ fieldId: "1148898687", type: "phone" }],
      }),
    );
    expect(missing.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);

    queue({ body: { id: "12345678", first_name: "Jiminy", last_name: "Cricket" } });
    await call(connection(), "update_person", {
      personId: "12345678",
      fields: [{ fieldId: "2000138811", type: "radio", response: "459" }],
    });
    expect(url().pathname).toBe("/api/people/update");
    expect(url().searchParams.get("person_id")).toBe("12345678");
    expect(JSON.parse(url().searchParams.get("fields_json")!)).toEqual([
      { field_id: "2000138811", field_type: "radio", response: "459" },
    ]);
  });

  it("assigns, unassigns, and checks in, and treats a false answer as a failure", async () => {
    queue({ body: true }, { body: true }, { body: true }, { body: false });
    const connector = connection();
    expect(await call(connector, "assign_tag", { personId: "1", tagId: "2" })).toEqual({ assigned: true });
    expect(await call(connector, "unassign_tag", { personId: "1", tagId: "2" })).toEqual({ unassigned: true });
    expect(await call(connector, "record_check_in", { personId: "1", instanceId: "3" })).toEqual({ checkedIn: true });
    expect(url(0).pathname).toBe("/api/tags/assign");
    expect(url(1).pathname).toBe("/api/tags/unassign");
    expect(url(2).pathname).toBe("/api/events/attendance/add");
    expect(url(2).searchParams.get("direction")).toBe("in");
    const error = await failure(call(connector, "assign_tag", { personId: "1", tagId: "2" }));
    expect(error.code).toBe("connector_call_failed");
    expect(error.retryable).toBe(false);
  });
});

describe("Breeze hatches split by endpoint, not by method", () => {
  it("lets the read hatch reach reviewed reads with their documented parameters", async () => {
    queue({ body: [{ id: "1" }] }, { body: { id: "5" } }, { body: [] }, { body: [] });
    const connector = connection();
    const folders = await call(connector, "breeze_api_get", { path: "/tags/list_folders" });
    expect(folders).toEqual({ result: [{ id: "1" }] });
    await call(connector, "breeze_api_get", {
      path: "/people/5",
      query: [{ name: "details", value: 1 }],
    });
    await call(connector, "breeze_api_get", {
      path: "/people/",
      query: [{ name: "filter_json", value: { tag_contains: "y_9" } }],
    });
    await call(connector, "breeze_api_get", {
      path: "/giving/view",
      query: [{ name: "payment_id", value: "56789123" }],
    });
    expect(url(1).pathname).toBe("/api/people/5");
    expect(url(2).pathname).toBe("/api/people");
    expect(url(2).searchParams.get("filter_json")).toBe('{"tag_contains":"y_9"}');
    expect(url(3).pathname).toBe("/api/giving/view");
    expect(calls.every((request) => request.method === "GET")).toBe(true);
  });

  it("refuses every write endpoint through the read hatch, fail-closed", async () => {
    for (const path of [
      "/people/add",
      "/people/update",
      "/people/delete",
      "/people/123/delete",
      "/tags/assign",
      "/tags/delete_tag",
      "/events/add",
      "/events/attendance/add",
      "/families/destroy",
      "/volunteers/update",
      "/forms/remove_form_entry",
      "/giving/add",
      "/giving/edit",
      "/giving/delete",
      "/giving/brand_new_read",
    ]) {
      const error = await failure(call(connection(), "breeze_api_get", { path }));
      expect(error.code, path).toBe("invalid_args");
      expect(error.message, path).toContain("breeze_api_mutate");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses paths that are not plain lowercase segments", async () => {
    for (const path of [
      "people",
      "/People",
      "/people/../people/add",
      "/people/%61dd",
      "/people?x=1",
      "//evil.example.com/api",
      "/people/1#x",
      "https://evil.example.com/api/people",
    ]) {
      const error = await failure(call(connection(), "breeze_api_get", { path }));
      expect(error.code, path).toBe("invalid_args");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses unreviewed parameters on a reviewed read path", async () => {
    for (const query of [
      [
        { name: "c", value: "people" },
        { name: "m", value: "delete" },
      ],
      [{ name: "fields_json", value: "[]" }],
      [{ name: "_method", value: "DELETE" }],
      [{ name: "__proto__", value: "x" }],
    ]) {
      const error = await failure(call(connection(), "breeze_api_get", { path: "/people", query }));
      expect(error.code).toBe("invalid_args");
    }
    const duplicate = await failure(
      call(connection(), "breeze_api_get", {
        path: "/people",
        query: [
          { name: "limit", value: 1 },
          { name: "limit", value: 2 },
        ],
      }),
    );
    expect(duplicate.message).toContain("more than once");
    expect(calls).toHaveLength(0);
  });

  it("lets the destructive hatch reach writes and undocumented routes as GETs", async () => {
    queue({ body: true }, { text: "not json" });
    const connector = connection();
    const removed = await call(connector, "breeze_api_mutate", {
      path: "/families/destroy",
      query: [{ name: "people_ids_json", value: [5555555, 6666666] }],
    });
    expect(removed).toEqual({ result: true });
    expect(calls[0]!.method).toBe("GET");
    expect(url(0).pathname).toBe("/api/families/destroy");
    expect(url(0).searchParams.get("people_ids_json")).toBe("[5555555,6666666]");
    const text = await call(connector, "breeze_api_mutate", {
      path: "/giving/delete",
      query: [{ name: "payment_id", value: "1" }],
    });
    expect(text).toEqual({ result: "not json" });
  });

  it("keeps the mutate hatch confined to the church's /api", async () => {
    const error = await failure(call(connection(), "breeze_api_mutate", { path: "/../extensions/api" }));
    expect(error.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });
});

describe("Breeze typed failures and credential test", () => {
  it("fails locally without a key", async () => {
    const error = await failure(call(connection(), "list_funds", {}, context(null)));
    expect(error.code).toBe("auth_required");
    expect(calls).toHaveLength(0);
  });

  it("maps HTTP statuses by the caller's next move", async () => {
    queue(
      { status: 403, text: "Invalid API Key" },
      { status: 404, text: "<!DOCTYPE html><html>…</html>" },
      { status: 429, text: "", headers: { "retry-after": "7" } },
      { status: 503, text: "" },
      { status: 400, text: "Bad request" },
    );
    const connector = connection();
    const auth = await failure(call(connector, "list_funds"));
    expect(auth.code).toBe("auth_required");
    expect(auth.message).toContain("Invalid API Key");
    const missing = await failure(call(connector, "breeze_api_mutate", { path: "/nope/route" }));
    expect(missing.code).toBe("not_found");
    expect(missing.message).not.toContain("DOCTYPE");
    const throttled = await failure(call(connector, "list_funds"));
    expect(throttled.code).toBe("rate_limited");
    expect(throttled.retryAfterMs).toBe(7_000);
    const down = await failure(call(connector, "list_funds"));
    expect(down.code).toBe("unavailable");
    const bad = await failure(call(connector, "list_funds"));
    expect(bad.code).toBe("invalid_args");
  });

  it("reads a failure Breeze reports inside a 200, and not a null errors field", async () => {
    queue(
      { body: { success: false, errors: "Payment not found" } },
      { body: { errorCode: 12, errorMessage: "Bad person" } },
      { body: { success: true, errors: null, payment_id: 1320278 } },
    );
    const connector = connection();
    const reported = await failure(
      call(connector, "breeze_api_get", { path: "/giving/view", query: [{ name: "payment_id", value: "1" }] }),
    );
    expect(reported.code).toBe("connector_call_failed");
    expect(reported.message).toContain("Payment not found");
    const coded = await failure(call(connector, "breeze_api_mutate", { path: "/people/update" }));
    expect(coded.message).toContain("Bad person");
    const ok = await call(connector, "breeze_api_mutate", { path: "/giving/add" });
    expect(ok.result.payment_id).toBe(1320278);
  });

  it("refuses a non-JSON success on a named read instead of inventing rows", async () => {
    queue({ text: "<html>maintenance</html>" });
    const error = await failure(call(connection(), "list_funds"));
    expect(error.code).toBe("connector_call_failed");
  });

  it("tests the key against the account summary and names the church", async () => {
    queue({ body: { id: "1234", name: "Grace Church", subdomain: "gracechurch" } });
    const connector = connection();
    const ok = await connector.testCredential!("candidate-key", context(null));
    expect(ok).toEqual({ ok: true, message: "Authenticated to Grace Church (gracechurch.breezechms.com)." });
    expect(url().pathname).toBe("/api/account/summary");
    expect(calls[0]!.headers["api-key"]).toBe("candidate-key");

    queue({ body: { id: "9", name: "Other", subdomain: "otherchurch" } });
    const mismatch = await connector.testCredential!("candidate-key", context(null));
    expect(mismatch.ok).toBe(false);
    expect(mismatch.message).toContain("otherchurch");

    queue({ status: 403, text: "Invalid API Key" });
    const rejected = await connector.testCredential!("bad", context(null));
    expect(rejected.ok).toBe(false);
  });
});
