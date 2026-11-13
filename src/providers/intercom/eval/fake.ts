import { randomBytes } from "node:crypto";
import { serveFetch, type Served } from "../../../../eval/support/serve.js";
import type { CallRecord, Ledger } from "../../../../eval/fakes/service.js";
import { routeFakeVendor } from "../../../../eval/fakes/transport.js";
import type { ProviderFake } from "../../../../eval/support/provider-eval.js";

type Row = Record<string, any>;

export const INTERCOM_TOKEN = "dG9rOmV2YWwtaW50ZXJjb20";
export const ACTING_ADMIN = "1001";
export const CONVERSATION_ID = "215467";
export const BILLING_TEAM = "4002";
export const REFUND_TAG = "7003";
export const ATTACHMENT_URL = "https://downloads.intercomcdn.com/i/o/9/receipt.pdf?expires=1&signature=eval-capability";

function intercomState() {
  const token = `${INTERCOM_TOKEN}${randomBytes(8).toString("hex")}`;
  return {
    token,
    admins: [
      { type: "admin", id: ACTING_ADMIN, name: "Assistant", email: "assistant@example.com" },
      { type: "admin", id: "1002", name: "Alice", email: "alice@example.com" },
    ],
    teams: [
      { type: "team", id: "4001", name: "Onboarding", admin_ids: ["1002"] },
      { type: "team", id: BILLING_TEAM, name: "Billing", admin_ids: ["1002"] },
    ],
    tags: [
      { type: "tag", id: "7001", name: "bug" },
      { type: "tag", id: REFUND_TAG, name: "refund" },
    ],
    conversations: [
      {
        type: "conversation",
        id: CONVERSATION_ID,
        title: null,
        state: "open",
        open: true,
        created_at: 1_794_000_000,
        admin_assignee_id: null,
        team_assignee_id: null,
        contacts: { type: "contact.list", contacts: [{ type: "contact", id: "c-bob", external_id: "bob" }] },
        source: {
          type: "conversation",
          id: "5001",
          delivered_as: "customer_initiated",
          subject: "Refund for order 4471",
          body: "<p>I was charged twice for order 4471. Please refund the duplicate.</p>",
          author: { type: "user", id: "c-bob", name: "Bob", email: "bob@example.com" },
          attachments: [{ type: "upload", name: "receipt.pdf", url: ATTACHMENT_URL, content_type: "application/pdf" }],
        },
        tags: { type: "tag.list", tags: [] as Row[] },
        conversation_parts: {
          type: "conversation_part.list",
          conversation_parts: [
            {
              type: "conversation_part",
              id: "5002",
              part_type: "comment",
              body: "<p>The duplicate charge was on 2026-11-02.</p>",
              author: { type: "user", id: "c-bob", name: "Bob" },
              attachments: [],
            },
          ] as Row[],
          total_count: 1,
        },
      },
      {
        type: "conversation",
        id: "215468",
        state: "open",
        source: { type: "conversation", id: "6001", subject: "Login trouble", body: "<p>Cannot log in.</p>" },
        tags: { type: "tag.list", tags: [] },
        conversation_parts: { type: "conversation_part.list", conversation_parts: [], total_count: 0 },
      },
    ] as Row[],
  };
}

export class FakeIntercom {
  readonly state = intercomState();
  private server?: Served;
  private release: (() => void) | undefined;
  private part = 9000;
  constructor(private readonly ledger: Ledger) {}
  get url() {
    if (!this.server) throw new Error("Intercom fake is not started");
    return this.server.url;
  }
  get token() {
    return this.state.token;
  }
  async start() {
    this.server = await serveFetch(async (request) => this.fetch(request));
    this.release = routeFakeVendor({
      hosts: ["api.intercom.io"],
      owns: (credential) => credential === this.token,
      target: this.url,
    });
  }
  async stop() {
    this.release?.();
    this.release = undefined;
    await this.server?.close();
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    let body: Row = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    const authorized =
      request.headers.get("authorization") === `Bearer ${this.token}` &&
      request.headers.get("intercom-version") === "2.18";
    const write = request.method !== "GET" && !url.pathname.endsWith("/search");
    const record: CallRecord = {
      seq: this.ledger.next(),
      at: Date.now(),
      service: "intercom",
      tool: `${request.method} ${url.pathname}`,
      args: { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body },
      kind: write ? "write" : "read",
      outcome: "ok",
      resultBytes: 0,
    };
    this.ledger.calls.push(record);
    this.ledger.requests.push({
      seq: record.seq,
      at: record.at,
      service: "intercom",
      methods: [request.method],
      authorized,
    });
    const send = (value: unknown, status = 200) => {
      if (status >= 400) record.outcome = "tool_error";
      const out = JSON.stringify(value);
      record.resultBytes = out.length;
      return new Response(out, { status, headers: { "Content-Type": "application/json" } });
    };
    const error = (status: number, code: string) =>
      send({ type: "error.list", request_id: "eval", errors: [{ code, message: code }] }, status);
    if (!authorized) return error(401, "unauthorized");
    const s = this.state;
    const conversation = (id: string | undefined) => s.conversations.find((row) => row.id === id);
    const summary = (row: Row) => {
      const { conversation_parts: _parts, ...rest } = row;
      return rest;
    };
    if (request.method === "GET" && url.pathname === "/admins") return send({ type: "admin.list", admins: s.admins });
    if (request.method === "GET" && url.pathname === "/teams") return send({ type: "team.list", teams: s.teams });
    if (request.method === "GET" && url.pathname === "/tags") return send({ type: "list", data: s.tags });
    if (request.method === "POST" && url.pathname === "/conversations/search") {
      const wanted = JSON.stringify(body.query ?? {}).toLowerCase();
      const rows = s.conversations.filter(
        (row) => row.state === "open" && (!wanted.includes("refund") || /refund/i.test(row.source.subject)),
      );
      return send({
        type: "conversation.list",
        conversations: rows.map(summary),
        total_count: rows.length,
        pages: { type: "pages", page: 1, per_page: 20, total_pages: 1 },
      });
    }
    const match = /^\/conversations\/(\d+)(\/reply|\/parts|\/tags(?:\/(\d+))?)?$/.exec(url.pathname);
    const target = conversation(match?.[1]);
    if (!match || !target) return error(404, "not_found");
    if (request.method === "GET" && !match[2]) return send(target);
    if ("admin_id" in body && !s.admins.some((admin) => admin.id === body.admin_id))
      return error(400, "admin_not_found");
    if (body.admin_id === undefined) return error(400, "parameter_not_found");
    const append = (part: Row) => {
      target.conversation_parts.conversation_parts.push({
        type: "conversation_part",
        id: String(++this.part),
        author: { type: "admin", id: body.admin_id },
        ...part,
      });
      target.conversation_parts.total_count += 1;
    };
    if (request.method === "POST" && match[2] === "/reply") {
      if (body.type !== "admin" || !["comment", "note"].includes(body.message_type) || !body.body)
        return error(400, "parameter_invalid");
      append({ part_type: body.message_type, body: body.body });
      return send(target);
    }
    if (request.method === "POST" && match[2] === "/parts") {
      if (body.message_type === "assignment") {
        if (body.assignee_id === "0") {
          target.admin_assignee_id = null;
          target.team_assignee_id = null;
        } else if (body.type === "team") target.team_assignee_id = body.assignee_id;
        else target.admin_assignee_id = body.assignee_id;
        append({ part_type: "assignment", assigned_to: { type: body.type, id: body.assignee_id } });
        return send(target);
      }
      if (body.message_type === "close" || body.message_type === "open") {
        target.state = body.message_type === "close" ? "closed" : "open";
        append({ part_type: body.message_type });
        return send(target);
      }
      return error(400, "parameter_invalid");
    }
    if (request.method === "POST" && match[2] === "/tags") {
      const tag = s.tags.find((row) => row.id === body.id);
      if (!tag) return error(404, "tag_not_found");
      if (!target.tags.tags.some((row: Row) => row.id === tag.id))
        target.tags.tags.push({ ...tag, applied_by: { type: "admin", id: body.admin_id } });
      return send(tag);
    }
    if (request.method === "DELETE" && match[3]) {
      const tag = s.tags.find((row) => row.id === match[3]);
      if (!tag) return error(404, "tag_not_found");
      target.tags.tags = target.tags.tags.filter((row: Row) => row.id !== tag.id);
      return send(tag);
    }
    return error(404, "not_found");
  }
}

export const evalFake: ProviderFake<FakeIntercom> = {
  create: (ledger) => new FakeIntercom(ledger),
  specs: (fake) => [
    {
      id: "intercom",
      title: "Intercom",
      description: "Customer support inbox",
      url: fake.url,
      credential: { label: "Intercom access token", value: fake.token },
    },
  ],
  saved: (state) =>
    Array.isArray(state.conversations) && Array.isArray(state.teams) && Array.isArray(state.tags) && !!state.token,
};
