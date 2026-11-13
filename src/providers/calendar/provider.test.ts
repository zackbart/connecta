import { PRIVATE_KEY } from "../../../test/fixtures/rsa.js";
// The Google Calendar connection. Delegation, subjects, and tokens live in
// test/google-workspace-delegation.test.ts; whole workflows in the provider's
// outcome journeys. This suite covers request shapes, guest-list
// preservation, argument refusals, withheld join secrets and hatch refusals.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendar } from "./index.js";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { memoryStorage } from "../../storage/memory.js";
import { silentLogger } from "../../../test/helpers.js";
import type { Connector, ConnectorContext } from "../../types.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const BASE = "/calendar/v3";

interface ApiCall {
  url: URL;
  method: string;
  body: any;
}

type Route = (call: ApiCall) => { status?: number; body?: unknown } | undefined;

const calls: ApiCall[] = [];
let route: Route = () => undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  route = () => undefined;
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url === TOKEN_URL) return Response.json({ access_token: "token", expires_in: 3599 });
    const call: ApiCall = {
      url: new URL(url),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = route(call) ?? {};
    return reply.status === 204
      ? new Response(null, { status: 204 })
      : Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  installOwnedTransport();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

let accounts = 0;
function connection(overrides: Record<string, unknown> = {}): Connector {
  accounts += 1;
  return calendar("calendar", {
    purpose: "Team scheduling",
    serviceAccount: { clientEmail: `calendar-${accounts}@project.iam.gserviceaccount.com`, privateKey: PRIVATE_KEY },
    subject: "alice@example.com",
    ...overrides,
  } as Parameters<typeof calendar>[1]);
}

let storage = memoryStorage();
beforeEach(() => {
  storage = memoryStorage();
});
function context(): ConnectorContext {
  return { storage, logger: silentLogger, baseUrl: "https://connecta.example" };
}

function call(connector: Connector, name: string, args: Record<string, unknown> = {}): Promise<any> {
  return connector.callTool(name, args, context()) as Promise<any>;
}

const INVITE = {
  id: "evt1",
  status: "confirmed",
  summary: "Planning",
  start: { dateTime: "2026-11-20T09:00:00-05:00", timeZone: "America/New_York" },
  end: { dateTime: "2026-11-20T09:30:00-05:00", timeZone: "America/New_York" },
  organizer: { email: "bob@example.com" },
  attendees: [
    { email: "bob@example.com", organizer: true, responseStatus: "accepted" },
    { email: "alice@example.com", self: true, responseStatus: "needsAction" },
    { email: "carol@example.com", responseStatus: "tentative", comment: "Maybe late" },
  ],
  conferenceData: {
    conferenceId: "abc-defg-hij",
    entryPoints: [
      { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij", meetingCode: "abc-defg-hij" },
      { entryPointType: "phone", uri: "tel:+1-555-0100", pin: "918273645", passcode: "secret-pass" },
    ],
  },
};

describe("events", () => {
  it("creates an event with a Meet request, and sends invitations only as asked", async () => {
    route = (c) =>
      c.method === "POST" ? { body: { ...INVITE, id: "new1", hangoutLink: "https://meet.google.com/x" } } : undefined;
    const connector = connection();
    const result = await call(connector, "create_event", {
      summary: "Planning",
      start: { dateTime: "2026-11-20T09:00:00-05:00" },
      end: { dateTime: "2026-11-20T09:30:00-05:00" },
      attendees: [{ email: "bob@example.com" }],
      addGoogleMeet: true,
      sendUpdates: "none",
    });
    expect(calls).toHaveLength(1);
    const [sent] = calls;
    expect(sent!.url.pathname).toBe(`${BASE}/calendars/primary/events`);
    expect(sent!.url.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(sent!.url.searchParams.get("sendUpdates")).toBe("none");
    expect(sent!.body.conferenceData.createRequest).toMatchObject({ conferenceSolutionKey: { type: "hangoutsMeet" } });
    expect(sent!.body.conferenceData.createRequest.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent!.body.attendees).toEqual([{ email: "bob@example.com" }]);
    expect(result).toMatchObject({ id: "new1", calendarId: "primary", meetLink: "https://meet.google.com/x" });

    calls.length = 0;
    await call(connector, "quick_add_event", { text: "Lunch tomorrow at noon" });
    expect(calls[0]!.url.pathname).toBe(`${BASE}/calendars/primary/events/quickAdd`);
    expect(calls[0]!.url.searchParams.get("text")).toBe("Lunch tomorrow at noon");
    // Omitted, Google's own default applies: nothing is sent.
    expect(calls[0]!.url.searchParams.has("sendUpdates")).toBe(false);
  });

  it("refuses malformed or contradictory times in one refusal, before any request", async () => {
    const connector = connection();
    const refusal = await call(connector, "create_event", {
      summary: "Bad",
      start: { dateTime: "2026-11-20 09:00" },
      end: { date: "2026-11-21" },
      recurrence: ["RRULE:FREQ=WEEKLY"],
    }).catch((error) => error);
    expect(refusal).toMatchObject({ code: "invalid_args" });
    expect(refusal.message).toContain("start.dateTime");
    await expect(
      call(connector, "create_event", {
        summary: "Backwards",
        start: { date: "2026-11-21" },
        end: { date: "2026-11-20" },
      }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      call(connector, "update_event", { eventId: "evt1", start: { dateTime: "2026-11-20T09:00:00Z" } }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(call(connector, "update_event", { eventId: "evt1" })).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(0);
  });

  it("answers an invitation by changing only the user's own response", async () => {
    route = (c) => (c.method === "GET" ? { body: INVITE } : { body: { ...INVITE, attendees: c.body.attendees } });
    const result = await call(connection(), "respond_to_event", {
      eventId: "evt1",
      response: "accepted",
      sendUpdates: "all",
    });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1]!.url.searchParams.get("sendUpdates")).toBe("all");
    expect(calls[1]!.body).toEqual({
      attendees: [
        INVITE.attendees[0],
        { email: "alice@example.com", self: true, responseStatus: "accepted" },
        INVITE.attendees[2],
      ],
    });
    expect(result.myResponseStatus).toBe("accepted");
  });

  it("refuses to answer an event the user is not invited to, or whose guest list Google cut", async () => {
    const connector = connection();
    route = () => ({ body: { ...INVITE, attendees: [INVITE.attendees[0]] } });
    await expect(call(connector, "respond_to_event", { eventId: "evt1", response: "declined" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    route = () => ({ body: { ...INVITE, attendeesOmitted: true } });
    await expect(call(connector, "respond_to_event", { eventId: "evt1", response: "declined" })).rejects.toMatchObject({
      code: "connector_call_failed",
    });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });

  it("adds and removes guests without replacing the others' responses", async () => {
    route = (c) => (c.method === "GET" ? { body: INVITE } : { body: { ...INVITE, attendees: c.body.attendees } });
    await call(connection(), "update_event", {
      calendarId: "team@example.com",
      eventId: "evt1",
      summary: "Planning v2",
      addAttendees: [{ email: "dave@example.com", optional: true }, { email: "BOB@example.com" }],
      removeAttendees: ["Carol@example.com"],
    });
    expect(calls[1]!.url.pathname).toBe(`${BASE}/calendars/team%40example.com/events/evt1`);
    expect(calls[1]!.body).toEqual({
      summary: "Planning v2",
      attendees: [INVITE.attendees[0], INVITE.attendees[1], { email: "dave@example.com", optional: true }],
    });
  });

  it("withholds conference join secrets and keeps the join link", async () => {
    route = () => ({ body: INVITE });
    const connector = connection();
    const event = await call(connector, "get_event", { eventId: "evt1" });
    expect(event).toMatchObject({ meetLink: "https://meet.google.com/abc-defg-hij", organizer: "bob@example.com" });
    const raw = await call(connector, "calendar_api_read", { path: "/calendars/primary/events/evt1" });
    const entry = raw.data.conferenceData.entryPoints[1];
    expect(entry.pin).toBe("[redacted]");
    expect(entry.passcode).toBe("[redacted]");
    expect(raw.data.conferenceData.entryPoints[0].meetingCode).toBe("abc-defg-hij");
    expect(JSON.stringify([event, raw])).not.toMatch(/918273645|secret-pass/);
  });

  it("lists occurrences by default and pages with a bound cursor", async () => {
    route = (c) =>
      c.url.searchParams.get("pageToken") === "page-2"
        ? { body: { items: [{ id: "evt2", summary: "Two", start: { date: "2026-11-21" } }] } }
        : { body: { items: [INVITE], nextPageToken: "page-2" } };
    const connector = connection();
    const first = await call(connector, "list_events", {
      timeMin: "2026-11-20T00:00:00Z",
      timeMax: "2026-11-22T00:00:00Z",
      orderBy: "startTime",
    });
    expect(calls[0]!.url.searchParams.get("singleEvents")).toBe("true");
    expect(first.items[0]).toMatchObject({ id: "evt1", attendeeCount: 3, myResponseStatus: "needsAction" });
    expect(first.items[0]).not.toHaveProperty("description");
    expect(first.page.hasMore).toBe(true);
    const second = await call(connector, "list_events", {
      timeMin: "2026-11-20T00:00:00Z",
      timeMax: "2026-11-22T00:00:00Z",
      orderBy: "startTime",
      cursor: first.page.nextCursor,
    });
    expect(calls[1]!.url.searchParams.get("pageToken")).toBe("page-2");
    expect(second).toEqual({
      items: [{ id: "evt2", summary: "Two", start: { date: "2026-11-21" } }],
      page: { hasMore: false },
    });
    await expect(
      call(connector, "list_events", { calendarId: "other", cursor: first.page.nextCursor }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(call(connector, "list_events", { singleEvents: false, orderBy: "startTime" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(calls).toHaveLength(2);
  });

  it("reads free/busy as a reviewed read-only POST and keeps per-calendar errors", async () => {
    route = () => ({
      body: {
        timeMin: "2026-11-20T14:00:00.000Z",
        timeMax: "2026-11-20T17:00:00.000Z",
        calendars: {
          "alice@example.com": { busy: [{ start: "2026-11-20T14:00:00Z", end: "2026-11-20T15:00:00Z" }] },
          "ext@example.org": { errors: [{ domain: "global", reason: "notFound" }], busy: [] },
        },
      },
    });
    const result = await call(connection({ readOnly: true }), "query_free_busy", {
      timeMin: "2026-11-20T14:00:00Z",
      timeMax: "2026-11-20T17:00:00Z",
      calendars: ["alice@example.com", "ext@example.org"],
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: { items: [{ id: "alice@example.com" }, { id: "ext@example.org" }] },
    });
    expect(result.calendars).toEqual([
      { id: "alice@example.com", busy: [{ start: "2026-11-20T14:00:00Z", end: "2026-11-20T15:00:00Z" }], errors: [] },
      { id: "ext@example.org", busy: [], errors: ["notFound"] },
    ]);
  });
});

describe("the hatch", () => {
  it("refuses push notification channels before any request, and admits sharing rules", async () => {
    const connector = connection();
    for (const path of [
      "/calendars/primary/events/watch",
      "/calendars/primary/acl/watch",
      "/users/me/calendarList/watch",
      "/users/me/settings/watch",
      "/channels/stop",
    ])
      await expect(
        call(connector, "calendar_api_write", { method: "POST", path, body: { id: "c", type: "web_hook" } }),
      ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(0);
    route = () => ({ body: { id: "user:bob@example.com", role: "reader" } });
    const shared = await call(connector, "calendar_api_write", {
      method: "POST",
      path: "/calendars/primary/acl",
      body: { role: "reader", scope: { type: "user", value: "bob@example.com" } },
    });
    expect(shared.data).toMatchObject({ role: "reader" });
    expect(calls[0]!.url.pathname).toBe(`${BASE}/calendars/primary/acl`);
  });

  it("builds in OAuth mode with exactly the Calendar scope", () => {
    const connector = calendar("calendar", {
      purpose: "Team scheduling",
      oauth: { clientId: "client-id", clientSecret: "client-secret" },
      authScope: "personal",
    } as unknown as Parameters<typeof calendar>[1]);
    expect(connector.description).toContain("each person's own connected Google account");
  });
});
