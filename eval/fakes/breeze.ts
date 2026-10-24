/** Deterministic Breeze GET API; endpoint verdicts, not methods, classify writes. */
import { randomUUID } from "node:crypto";
import { serveFetch, type Served } from "../support/serve.js";
import type { Ledger, CallRecord } from "./service.js";
import { registerFakeRoute, unregisterFakeRoute } from "./rest.js";
type Row = Record<string, any>;
export const STATUS_FIELD = "7001";
export const EMAIL_FIELD = "7002";
export const TARGET = "1001";
export const INSTANCE = "8101";
export const TAG = "601";
export const CAMPAIGN = "9201";
export const NEW_EMAIL = "alice.new@example.com";
export function breezeState() {
  return {
    people: Array.from({ length: 200 }, (_, i) => ({
      id: String(1001 + i),
      first_name: i === 0 ? "Bob" : "Alice",
      last_name: i === 0 ? "Smith" : `Member${i}`,
      details: { [STATUS_FIELD]: i % 3 === 0 ? "901" : "902", [EMAIL_FIELD]: `person${i}@example.com` },
      tags: i % 2 === 0 ? [TAG] : ["602"],
      path: "img/profiles/unused.jpg",
    })) as Row[],
    created: [] as string[],
    updated: [] as string[],
  };
}
export type BreezeState = ReturnType<typeof breezeState>;
const READS = new Set([
  "/people",
  "/profile",
  "/tags/list_tags",
  "/events",
  "/events/calendars/list",
  "/events/attendance/list",
  "/account/summary",
  "/funds/list",
  "/giving/list",
  "/pledges/list_campaigns",
  "/pledges/list_pledges",
]);
export class FakeBreeze {
  private served?: Served;
  readonly vendor = "breeze" as const;
  readonly credential = `eval_breeze_${randomUUID()}`;
  constructor(
    readonly name: string,
    private readonly ledger: Ledger,
    readonly state: BreezeState,
    private readonly fault?: "update-500",
  ) {}
  get url() {
    if (!this.served) throw new Error("Breeze fake not started");
    return this.served.url;
  }
  async start() {
    this.served = await serveFetch((request) => this.handle(request));
    registerFakeRoute(this.credential, this.url, ["church.breezechms.com"]);
  }
  async stop() {
    unregisterFakeRoute(this.credential);
    await this.served?.close();
  }
  private async handle(request: Request) {
    const url = new URL(request.url),
      path = url.pathname.replace(/^\/api/, ""),
      query = Object.fromEntries(url.searchParams);
    const authorized = request.headers.get("api-key") === this.credential;
    const kind = READS.has(path) || /^\/people\/\d+$/.test(path) ? "read" : "write";
    const record: CallRecord = {
      seq: this.ledger.next(),
      at: Date.now(),
      service: this.name,
      tool: `GET ${path}`,
      kind,
      args: { method: request.method, path, query },
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
    const reply =
      authorized && request.method === "GET" ? this.dispatch(path, query) : { status: 401, value: "Invalid key" };
    if (reply.status >= 400) {
      record.outcome = "tool_error";
      record.error = `HTTP ${reply.status}`;
    }
    const text = JSON.stringify(reply.value);
    record.resultBytes = Buffer.byteLength(text);
    return new Response(text, { status: reply.status, headers: { "content-type": "text/html; charset=UTF-8" } });
  }
  private dispatch(path: string, q: Row): { status: number; value: unknown } {
    const ok = (value: unknown) => ({ status: 200, value });
    if (path === "/people") {
      const filter = JSON.parse(q.filter_json ?? "{}");
      const rows = this.state.people.filter((p) =>
        Object.entries(filter).every(([key, value]) =>
          key === "tag_contains"
            ? p.tags.includes(String(value).replace(/^y_/, ""))
            : String(value).split("-").includes(p.details[key]),
        ),
      );
      return ok(
        rows
          .slice(Number(q.offset ?? 0), Number(q.offset ?? 0) + Number(q.limit ?? 500))
          .map((p) => (q.details === "1" ? p : { id: p.id, first_name: p.first_name, last_name: p.last_name })),
      );
    }
    if (/^\/people\/\d+$/.test(path)) return ok(this.state.people.find((p) => p.id === path.split("/").at(-1)) ?? []);
    if (path === "/profile")
      return ok([
        {
          name: "Main",
          fields: [
            {
              field_id: STATUS_FIELD,
              field_type: "multiple_choice",
              name: "Status",
              options: [
                { option_id: "901", name: "Member" },
                { option_id: "902", name: "Visitor" },
              ],
            },
            { field_id: EMAIL_FIELD, field_type: "email", name: "Email", options: [] },
          ],
        },
      ]);
    if (path === "/tags/list_tags")
      return ok([
        { id: TAG, name: "Choir", folder_id: "60" },
        { id: "602", name: "Ushers", folder_id: "60" },
      ]);
    if (path === "/events")
      return ok([
        {
          id: INSTANCE,
          event_id: "8100",
          name: "Sunday Gathering",
          start_datetime: "2026-10-18 10:00:00",
          end_datetime: "0000-00-00 00:00:00",
        },
        { id: "8201", event_id: "8100", name: "Sunday Gathering", start_datetime: "2026-10-25 10:00:00" },
      ]);
    if (path === "/events/calendars/list")
      return ok([
        { id: "1", name: "Main", address: "https://church.breezechms.com/events/feed/secret", embed_key: "private" },
      ]);
    if (path === "/events/attendance/list")
      return ok(
        q.instance_id === INSTANCE
          ? [
              {
                person_id: TARGET,
                created_on: "2026-10-18 09:55:00",
                check_out: "0000-00-00 00:00:00",
                details: { first_name: "Bob", last_name: "Smith" },
              },
            ]
          : [],
      );
    if (path === "/account/summary")
      return ok({
        id: "1",
        name: "Example Church",
        subdomain: "church",
        details: { timezone: "America/New_York", country: { name: "United States", currency: "USD" } },
      });
    if (path === "/funds/list")
      return ok([
        { id: "51", name: "General", tax_deductible: "1" },
        { id: "52", name: "Missions", tax_deductible: "1" },
      ]);
    if (path === "/giving/list") {
      const rows = [
        {
          id: "1",
          paid_on: "2026-10-01 00:00:00",
          amount: "0.10",
          person_id: TARGET,
          funds: [{ fund_id: "51", fund_name: "General", amount: "0.10" }],
        },
        {
          id: "2",
          paid_on: "2026-10-02 00:00:00",
          amount: "0.20",
          person_id: TARGET,
          funds: [{ fund_id: "51", fund_name: "General", amount: "0.20" }],
        },
        {
          id: "3",
          paid_on: "2026-10-05 00:00:00",
          amount: "12.34",
          person_id: "1002",
          funds: [{ fund_id: "52", fund_name: "Missions", amount: "12.34" }],
        },
        { id: "4", paid_on: "2026-09-30 00:00:00", amount: "99.00", funds: [{ fund_id: "51", amount: "99.00" }] },
      ];
      return ok(
        rows.filter(
          (r) =>
            r.paid_on.slice(0, 10) >= q.start &&
            r.paid_on.slice(0, 10) <= q.end &&
            (!q.fund_ids || r.funds.some((f) => String(q.fund_ids).split("-").includes(f.fund_id))),
        ),
      );
    }
    if (path === "/pledges/list_campaigns")
      return ok([
        { id: CAMPAIGN, name: "Roof Renewal", amount: "25000.00" },
        { id: "9202", name: "Youth", amount: "5000.00" },
      ]);
    if (path === "/pledges/list_pledges")
      return ok(q.campaign_id === CAMPAIGN ? [{ id: "9301", person_id: TARGET, amount: "125.50" }] : []);
    if (path === "/people/add" || path === "/people/update") {
      let person: Row | undefined;
      if (path.endsWith("add")) {
        person = {
          id: String(5000 + this.state.created.length),
          first_name: q.first,
          last_name: q.last,
          details: {},
          tags: [],
        };
        this.state.people.push(person);
        this.state.created.push(person.id);
      } else {
        person = this.state.people.find((p) => p.id === q.person_id);
        if (!person) return ok({ success: false, errors: "Unknown person" });
        this.state.updated.push(person.id);
      }
      for (const f of JSON.parse(q.fields_json ?? "[]"))
        person!.details[f.field_id] = f.field_type === "email" ? f.details.address : f.response;
      if (this.fault && path.endsWith("update") && this.state.updated.length === 1)
        return { status: 500, value: "Upstream failure" };
      return ok(person);
    }
    return { status: 404, value: "Unknown endpoint" };
  }
}
