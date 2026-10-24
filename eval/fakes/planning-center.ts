/** Fake-only Planning Center JSON:API world; pinned versions and real provider paths. */
import { randomUUID } from "node:crypto";
import { serveFetch, type Served } from "../support/serve.js";
import { registerFakeRoute, unregisterFakeRoute } from "./rest.js";
import type { CallRecord, Ledger } from "./service.js";

type Row = Record<string, any>;
export const PERSON = "1001";
export const GROUP = "2001";
export const SERVICE = "3001";
export const PLAN = "4001";
export const CATEGORY = "6001";
export const REMOVED = "2999";
export const NOTE = "Called about volunteering.";
const ref = (type: string, id: string) => ({ data: { type, id } });
const resource = (type: string, id: string, attributes: Row, relationships: Row = {}) => ({
  type,
  id,
  attributes,
  relationships,
});
export function planningCenterState() {
  return {
    people: Array.from({ length: 137 }, (_, i) =>
      resource(
        "Person",
        String(1001 + i),
        {
          name: i === 0 ? "Alice Brooks" : i === 2 ? "Bob Green" : `Member ${i}`,
          first_name: i === 0 ? "Alice" : i === 2 ? "Bob" : "Member",
          last_name: i === 0 ? "Brooks" : i === 2 ? "Green" : String(i),
          status: i % 5 === 0 ? "inactive" : "active",
          membership: i % 3 === 0 ? "Visitor" : "Member",
          child: false,
          nickname: null,
          updated_at: "2026-10-01T12:00:00Z",
          created_at: "2025-01-01T12:00:00Z",
        },
        { emails: { data: [{ type: "Email", id: String(5001 + i) }] } },
      ),
    ),
    notes: [] as Row[],
    updated: [] as string[],
  };
}
export type PlanningCenterState = ReturnType<typeof planningCenterState>;
const VERSIONS: Record<string, string> = {
  people: "2026-06-04",
  services: "2018-11-01",
  groups: "2023-07-10",
  "check-ins": "2025-05-28",
  calendar: "2026-06-22",
  registrations: "2025-05-01",
  giving: "2019-10-18",
  publishing: "2024-03-25",
  webhooks: "2022-10-20",
  api: "2026-09-24",
};
export class FakePlanningCenter {
  private served?: Served;
  readonly vendor = "planning-center" as const;
  private readonly key = `eval_pco_${randomUUID()}`;
  readonly credential = JSON.stringify({ applicationId: "eval-pco", secret: this.key });
  constructor(
    readonly name: string,
    private readonly ledger: Ledger,
    readonly state: PlanningCenterState,
    private readonly fault?: "update-500",
  ) {}
  get url() {
    if (!this.served) throw new Error("Planning Center fake not started");
    return this.served.url;
  }
  async start() {
    this.served = await serveFetch((request) => this.handle(request));
    // Own the shared fake transport's lifecycle; this provider uses loopback baseUrl directly.
    registerFakeRoute(this.key, this.url, []);
  }
  async stop() {
    unregisterFakeRoute(this.key);
    await this.served?.close();
  }
  private async handle(request: Request) {
    const url = new URL(request.url),
      path = url.pathname,
      query = Object.fromEntries(url.searchParams);
    const body = request.body ? ((await request.json()) as Row) : undefined;
    const authorized = request.headers.get("authorization") === `Basic ${btoa(`eval-pco:${this.key}`)}`;
    const version = request.headers.get("x-pco-api-version");
    const record: CallRecord = {
      seq: this.ledger.next(),
      at: Date.now(),
      service: this.name,
      tool: `${request.method} ${path}`,
      kind: request.method === "GET" ? "read" : "write",
      args: { method: request.method, path, query, ...(body === undefined ? {} : { body }), version },
      outcome: "ok",
      resultBytes: 0,
    };
    this.ledger.calls.push(record);
    this.ledger.requests.push({
      seq: record.seq,
      at: record.at,
      service: this.name,
      methods: [record.tool],
      authorized,
    });
    const error = (status: number, detail: string) => ({
      status,
      value: { errors: [{ status: String(status), detail }] },
    });
    const reply = !authorized
      ? error(401, "Invalid fake credential")
      : version !== VERSIONS[path.split("/")[1]!]
        ? error(400, "Pinned product version required")
        : this.dispatch(request.method, path, query, body);
    if (reply.status >= 400) {
      record.outcome = "tool_error";
      record.error = `HTTP ${reply.status}`;
    }
    const text = JSON.stringify(reply.value);
    record.resultBytes = Buffer.byteLength(text);
    return new Response(text, { status: reply.status, headers: { "content-type": "application/json" } });
  }
  private dispatch(method: string, path: string, q: Row, body: Row | undefined): { status: number; value: unknown } {
    const one = (data: Row, included: Row[] = [], status = 200) => ({ status, value: { data, included } });
    const error = (status: number, detail: string) => ({
      status,
      value: { errors: [{ status: String(status), detail }] },
    });
    const page = (all: Row[], included: Row[] = []) => {
      const offset = Number(q.offset ?? 0),
        size = Number(q.per_page ?? 25);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 1 || size > 100)
        return error(400, "Invalid page");
      const data = all.slice(offset, offset + size),
        next = offset + data.length;
      return {
        status: 200,
        value: {
          data,
          included,
          meta: {
            total_count: all.length,
            count: data.length,
            ...(next < all.length ? { next: { offset: next } } : {}),
            can_query_by: ["name", "status", "membership"],
            can_include: ["emails", "person"],
          },
        },
      };
    };
    const emails = (people: Row[]) =>
      people.map((p) =>
        resource("Email", String(5001 + Number(p.id) - 1001), {
          address:
            p.id === PERSON ? "alice@example.com" : p.id === "1003" ? "bob@example.com" : `person${p.id}@example.org`,
          primary: true,
          location: "Home",
        }),
      );
    const people = () =>
      this.state.people.filter((p) =>
        Object.entries(q).every(([key, value]) => {
          const attribute = /^where\[(\w+)\]$/.exec(key)?.[1];
          if (!attribute) return true;
          if (attribute.startsWith("search_"))
            return `${p.attributes.name} ${emails([p])[0]!.attributes.address}`
              .toLowerCase()
              .includes(String(value).toLowerCase());
          if (!(attribute in p.attributes)) return true;
          return String(value).endsWith("%")
            ? String(p.attributes[attribute]).startsWith(String(value).slice(0, -1))
            : String(p.attributes[attribute]) === String(value);
        }),
      );
    if (method === "GET") {
      if (path === "/people/v2/me")
        return one(this.state.people[0]!, [
          resource("Organization", "1", { name: "Example Church", time_zone: "America/Chicago" }),
        ]);
      if (path === "/people/v2/people") {
        const rows = people();
        return page(rows, q.include ? emails(rows) : []);
      }
      const person = /^\/people\/v2\/people\/(\d+)$/.exec(path)?.[1];
      if (person) {
        const p = this.state.people.find((p) => p.id === person);
        return p ? one(p, q.include ? emails([p]) : []) : error(404, "The resource you requested could not be found");
      }
      if (/^\/people\/v2\/people\/\d+\/emails$/.test(path))
        return page(emails(this.state.people.filter((p) => p.id === path.split("/")[4])));
      if (path === "/people/v2/note_categories")
        return page([
          resource("NoteCategory", CATEGORY, { name: "Follow-up" }),
          resource("NoteCategory", "6002", { name: "Private" }),
        ]);
      if (/^\/people\/v2\/people\/\d+\/notes$/.test(path))
        return page(this.state.notes.filter((n) => n.attributes.person_id === path.split("/")[4]));
      if (path === "/people/v2/person_mergers")
        return page(
          [
            resource("PersonMerger", "7001", {
              person_to_remove_id: REMOVED,
              person_to_keep_id: PERSON,
              created_at: "2026-09-01T12:00:00Z",
            }),
            resource("PersonMerger", "7002", {
              person_to_remove_id: "2998",
              person_to_keep_id: "1003",
              created_at: "2026-09-02T12:00:00Z",
            }),
          ].filter(
            (r) =>
              !q["where[person_to_remove_id]"] || r.attributes.person_to_remove_id === q["where[person_to_remove_id]"],
          ),
        );
      if (path === "/groups/v2/groups")
        return page(
          [
            resource("Group", GROUP, { name: "Welcome Team", memberships_count: 3 }),
            resource("Group", "2002", { name: "Welcome Team Alumni", memberships_count: 1 }),
          ].filter((r) => !q["where[name]"] || r.attributes.name === q["where[name]"]),
        );
      if (path === `/groups/v2/groups/${GROUP}/memberships`)
        return page(
          [
            resource(
              "Membership",
              "2101",
              { role: "leader", joined_at: "2025-01-01" },
              { person: ref("Person", PERSON) },
            ),
            resource(
              "Membership",
              "2102",
              { role: "member", joined_at: "2025-01-01" },
              { person: ref("Person", "1002") },
            ),
            resource(
              "Membership",
              "2103",
              { role: "leader", joined_at: "2025-01-01" },
              { person: ref("Person", "1003") },
            ),
          ].filter((r) => !q["where[role]"] || r.attributes.role === q["where[role]"]),
          q.include ? this.state.people.slice(0, 3) : [],
        );
      if (path === "/services/v2/service_types")
        return page([
          resource("ServiceType", SERVICE, { name: "Sunday Morning", sequence: 1 }),
          resource("ServiceType", "3002", { name: "Youth", sequence: 2 }),
        ]);
      if (path === `/services/v2/service_types/${SERVICE}/plans`)
        return page(
          [
            resource("Plan", PLAN, {
              title: "October Gathering",
              dates: "October 25, 2026",
              sort_date: "2026-10-25T15:00:00Z",
              items_count: 2,
              plan_people_count: 1,
            }),
            resource("Plan", "4002", {
              title: "September Gathering",
              sort_date: "2026-09-27T15:00:00Z",
              dates: "September 27, 2026",
            }),
          ].filter((r) => q.filter !== "future" || r.id === PLAN),
        );
      if (path === `/services/v2/service_types/${SERVICE}/plans/${PLAN}`)
        return one(
          resource(
            "Plan",
            PLAN,
            {
              title: "October Gathering",
              dates: "October 25, 2026",
              sort_date: "2026-10-25T15:00:00Z",
              total_length: 2400,
            },
            { plan_times: { data: [{ type: "PlanTime", id: "4101" }] } },
          ),
          [
            resource("PlanTime", "4101", {
              starts_at: "2026-10-25T15:00:00Z",
              ends_at: "2026-10-25T16:00:00Z",
              time_type: "service",
            }),
          ],
        );
      if (path === `/services/v2/service_types/${SERVICE}/plans/${PLAN}/items`)
        return page([
          resource("Item", "4201", { title: "Welcome", sequence: 1, item_type: "item", length: 300 }),
          resource("Item", "4202", { title: "Sermon", sequence: 2, item_type: "item", length: 1500 }),
        ]);
      if (path === `/services/v2/service_types/${SERVICE}/plans/${PLAN}/team_members`)
        return page(
          [
            resource(
              "PlanPerson",
              "4301",
              { name: "Alice Brooks", status: "C", team_position_name: "Host" },
              { person: ref("Person", PERSON), team: ref("Team", "4401") },
            ),
          ],
          [resource("Team", "4401", { name: "Welcome" })],
        );
      const scheduled = /^\/services\/v2\/people\/(\d+)\/schedules$/.exec(path)?.[1];
      if (scheduled)
        return page(
          scheduled === PERSON || scheduled === "1003"
            ? [
                resource(
                  "Schedule",
                  `45${scheduled}`,
                  {
                    dates: q.filter === "past" ? "September 27, 2026" : "October 25, 2026",
                    sort_date: "2026-10-25T15:00:00Z",
                    service_type_name: "Sunday Morning",
                    team_name: "Welcome",
                    status: "C",
                  },
                  { plan: ref("Plan", q.filter === "past" ? "4002" : PLAN) },
                ),
              ]
            : [],
        );
      return error(404, "Unsupported fake read");
    }
    if (method === "POST" && path === `/people/v2/people/${PERSON}/notes`) {
      const attrs = body?.data?.attributes;
      if (body?.data?.type !== "Note" || attrs?.note_category_id !== CATEGORY || typeof attrs?.note !== "string")
        return error(422, "Note and category required");
      const note = resource("Note", String(8001 + this.state.notes.length), {
        ...attrs,
        person_id: PERSON,
        created_at: "2026-10-24T12:00:00Z",
      });
      this.state.notes.push(note);
      return one(note, [], 201);
    }
    if (method === "PATCH" && path === `/people/v2/people/${PERSON}`) {
      if (body?.data?.type !== "Person" || !body?.data?.attributes) return error(422, "Person attributes required");
      Object.assign(this.state.people[0]!.attributes, body.data.attributes);
      this.state.updated.push(PERSON);
      if (this.fault === "update-500" && this.state.updated.length === 1) return error(500, "Answer lost after commit");
      return one(this.state.people[0]!);
    }
    return error(422, "Unsupported fake write");
  }
}
