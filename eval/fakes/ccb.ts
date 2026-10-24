/** Fake-only CCB v2 JSON/OAuth state; requests retain their production origin guards. */
import { randomUUID } from "node:crypto";
import { serveFetch, type Served } from "../support/serve.js";
import { registerFakeRoute, unregisterFakeRoute } from "./rest.js";
import type { CallRecord, Ledger } from "./service.js";

export const CCB_TARGET = 1002;
export const CCB_NEW_EMAIL = "alice.updated@example.com";
export function ccbState() {
  return {
    people: Array.from({ length: 137 }, (_, i) => ({
      id: 1001 + i,
      family_id: i === 1 || i === 2 ? 9 : 10,
      name: i === 1 ? "Alice Rowan" : `Member ${i}`,
      first_name: i === 1 ? "Alice" : "Member",
      last_name: i === 1 ? "Rowan" : String(i),
      email: `person${i}@example.com`,
      active: i % 5 !== 0,
      campus_id: i % 2 === 0 ? 1 : 2,
      membership_type_id: 3,
    })),
    updated: [] as number[],
  };
}
export type CcbState = ReturnType<typeof ccbState>;
export class FakeCcb {
  private served?: Served;
  readonly vendor = "ccb" as const;
  readonly clientId = randomUUID();
  readonly clientSecret = randomUUID();
  readonly accessToken = randomUUID();
  readonly refreshToken = randomUUID();
  get credential() {
    return JSON.stringify({ clientId: this.clientId, clientSecret: this.clientSecret });
  }
  constructor(
    readonly name: string,
    private readonly ledger: Ledger,
    readonly state: CcbState,
    private readonly fault?: "update-500",
  ) {}
  get url() {
    if (!this.served) throw new Error("CCB fake has not started.");
    return this.served.url;
  }
  async start() {
    this.served = await serveFetch((request) => this.handle(request));
    for (const value of [this.clientId, this.accessToken]) registerFakeRoute(value, this.url, ["api.ccbchurch.com"]);
  }
  async stop() {
    for (const value of [this.clientId, this.accessToken]) unregisterFakeRoute(value);
    await this.served?.close();
  }
  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname;
    if (path === "/oauth/token") {
      const form = new URLSearchParams(await request.text());
      const basic = request.headers.get("authorization")?.startsWith("Basic ")
        ? Buffer.from(request.headers.get("authorization")!.slice(6), "base64").toString().split(":")
        : [];
      if (
        (basic[0] ?? form.get("client_id")) !== this.clientId ||
        (basic[1] ?? form.get("client_secret")) !== this.clientSecret
      )
        return Response.json({ error: "invalid_client" }, { status: 401 });
      return Response.json({
        access_token: this.accessToken,
        refresh_token: this.refreshToken,
        token_type: "bearer",
        expires_in: 7200,
        scope: "read:individuals read:advanced_searches write:individuals",
      });
    }
    const query = Object.fromEntries(url.searchParams);
    const body = request.method === "GET" || request.method === "DELETE" ? undefined : await request.json();
    const kind = request.method === "GET" || /^\/search\/[^/]+\/results$/.test(path) ? "read" : "write";
    const authorized = request.headers.get("authorization") === `Bearer ${this.accessToken}`;
    const record: CallRecord = {
      seq: this.ledger.next(),
      at: Date.now(),
      service: this.name,
      tool: `${request.method} ${path}`,
      kind,
      args: { method: request.method, path, query, body },
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
    const respond = (value: unknown, status = 200, headers: Record<string, string> = {}) => {
      if (status >= 400) {
        record.outcome = "tool_error";
        record.error = `HTTP ${status}`;
      }
      record.resultBytes = Buffer.byteLength(JSON.stringify(value));
      return Response.json(value, { status, headers });
    };
    if (!authorized) return respond({ message: "The access token was refused." }, 401);
    const page = (rows: unknown[]) => {
      const size = Number(query.per_page ?? 25),
        current = Number(query.page ?? 1);
      if (![25, 50, 75, 100].includes(size) || !Number.isSafeInteger(current) || current < 1)
        return respond({ message: "Invalid page arguments." }, 412);
      const pages = Math.max(1, Math.ceil(rows.length / size));
      return respond(rows.slice((current - 1) * size, current * size), 200, {
        "x-page": String(current),
        "x-total-pages": String(pages),
        "x-total": String(rows.length),
        "x-next-page": current < pages ? String(current + 1) : "",
      });
    };
    if (path === "/individuals" && request.method === "GET") {
      const name = (query.name ?? "").toLowerCase();
      return page(
        this.state.people.filter(
          (p) => (query.include_inactive === "true" || p.active) && `${p.name} ${p.email}`.toLowerCase().includes(name),
        ),
      );
    }
    if (/^\/individuals\/\d+$/.test(path)) {
      const person = this.state.people.find((p) => p.id === Number(path.split("/").at(-1)));
      if (!person) return respond({ message: "Record not found." }, 404);
      if (request.method === "GET") return respond(person);
      if (request.method === "PUT") {
        const values = body as Record<string, unknown>;
        if (Object.keys(values).length !== 1 || typeof values.email !== "string") return respond({}, 412);
        person.email = values.email;
        this.state.updated.push(person.id);
        if (this.fault === "update-500") return respond({ message: "The update response was lost." }, 500);
        return respond(person);
      }
    }
    if (path === "/search/individuals/results" && request.method === "POST") {
      const config = (body as { configuration?: { filter_profile_type?: string[] } }).configuration;
      const types = config?.filter_profile_type ?? ["active"];
      return page(this.state.people.filter((p) => types.includes(p.active ? "active" : "inactive")));
    }
    if (path === "/families") return page([{ id: 9, last_name: "Rowan" }]);
    if (path === "/families/9")
      return respond({ id: 9, last_name: "Rowan", members: this.state.people.filter((p) => p.family_id === 9) });
    if (path === "/groups") return page([{ id: 5, name: "Choir", campus_id: 1 }]);
    if (path === "/groups/5")
      return respond({ id: 5, name: "Choir", main_leader: { id: CCB_TARGET, name: "Alice Rowan" } });
    if (path === "/groups/5/members")
      return page(
        [1002, 1003, 1004].map((id) => ({
          group_id: 5,
          individual_id: id,
          status: id === CCB_TARGET ? "LEADER" : "MEMBER",
          individual: this.state.people.find((p) => p.id === id),
        })),
      );
    if (path === "/campuses")
      return respond([{ id: 1, name: "North", timezone: "America/Chicago", public_gift_message: "Thank you, North." }]);
    if (path === "/me") return respond({ id: 1002, name: "Alice Rowan", family_id: 9, campus_id: 2 });
    return respond({ message: `No fake route for ${request.method} ${path}.` }, 404);
  }
}
