import { PRIVATE_KEY } from "../../../test/fixtures/rsa.js";
// The Google Meet connection. Delegation, subjects, tokens and OAuth mode live
// in test/google-workspace-delegation.test.ts. This suite covers Meet's own
// behavior: resource-name requests, filters, cursors, settings masks, cuts and
// hatch admission.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meet } from "./index.js";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { jsonBytes, RESULT_BUDGET_BYTES } from "../_shared/google/result-size.js";
import { memoryStorage } from "../../storage/memory.js";
import { silentLogger } from "../../../test/helpers.js";
import type { Connector, ConnectorContext } from "../../types.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

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
  installOwnedTransport();
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (request.url === TOKEN_URL) return Response.json({ access_token: "token", expires_in: 3599 });
    const text = await request.text();
    const call: ApiCall = {
      url: new URL(request.url),
      method: request.method,
      body: text ? JSON.parse(text) : undefined,
    };
    calls.push(call);
    const reply = route(call) ?? {};
    return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

let accounts = 0;
function connection(overrides: Record<string, unknown> = {}): Connector {
  accounts += 1;
  return meet("meet", {
    purpose: "Team meetings",
    serviceAccount: { clientEmail: `meet-${accounts}@project.iam.gserviceaccount.com`, privateKey: PRIVATE_KEY },
    subject: "office@example.com",
    ...overrides,
  } as Parameters<typeof meet>[1]);
}

const storage = memoryStorage();
function context(): ConnectorContext {
  return { storage, logger: silentLogger, baseUrl: "https://connecta.example" };
}

function call(connector: Connector, name: string, args: Record<string, unknown> = {}): Promise<any> {
  return connector.callTool(name, args, context()) as Promise<any>;
}

describe("spaces", () => {
  it("resolves a meeting code or link with get, and projects only declared fields", async () => {
    route = () => ({
      body: {
        name: "spaces/abcDEF123",
        meetingCode: "abc-mnop-xyz",
        meetingUri: "https://meet.google.com/abc-mnop-xyz",
        config: { accessType: "TRUSTED" },
        activeConference: { conferenceRecord: "conferenceRecords/c1" },
        futureField: "dropped",
      },
    });
    const connector = connection();
    for (const space of ["abc-mnop-xyz", "https://meet.google.com/abc-mnop-xyz", "spaces/abc-mnop-xyz"]) {
      const result = await call(connector, "get_space", { space });
      expect(result).toEqual({
        name: "spaces/abcDEF123",
        meetingCode: "abc-mnop-xyz",
        meetingUri: "https://meet.google.com/abc-mnop-xyz",
        config: { accessType: "TRUSTED" },
        activeConference: { conferenceRecord: "conferenceRecords/c1" },
      });
    }
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(Array(3).fill("GET /v2/spaces/abc-mnop-xyz"));
    expect(await call(connector, "get_space", { space: "abc-mnop-xyz", fields: ["name"] })).toEqual({
      name: "spaces/abcDEF123",
    });
  });

  it("sends exactly the named settings as nested config with a matching update mask", async () => {
    route = (c) => ({ body: { name: "spaces/s1", config: c.body.config } });
    const connector = connection();
    const result = await call(connector, "update_space", {
      space: "spaces/s1",
      accessType: "RESTRICTED",
      moderation: true,
      chatRestriction: "HOSTS_ONLY",
      autoTranscription: false,
      attendanceReport: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url.pathname).toBe("/v2/spaces/s1");
    expect(calls[0]!.url.searchParams.get("updateMask")!.split(",").sort()).toEqual(
      [
        "config.accessType",
        "config.moderation",
        "config.moderationRestrictions.chatRestriction",
        "config.attendanceReportGenerationType",
        "config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration",
      ].sort(),
    );
    expect(calls[0]!.body).toEqual({
      config: {
        accessType: "RESTRICTED",
        moderation: "ON",
        moderationRestrictions: { chatRestriction: "HOSTS_ONLY" },
        attendanceReportGenerationType: "GENERATE_REPORT",
        artifactConfig: { transcriptionConfig: { autoTranscriptionGeneration: "OFF" } },
      },
    });
    expect(result.config.moderation).toBe("ON");
  });

  it("refuses a settings change that names no setting, or a meeting code, before any request", async () => {
    const connector = connection();
    await expect(call(connector, "update_space", { space: "spaces/s1" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(call(connector, "update_space", { space: "abc-mnop-xyz", accessType: "OPEN" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(call(connector, "end_active_conference", { space: "abc-mnop-xyz" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(calls).toHaveLength(0);
  });

  it("ends a conference once, and reports an uncertain create without sending it again", async () => {
    const connector = connection();
    expect(await call(connector, "end_active_conference", { space: "spaces/s1" })).toEqual({
      space: "spaces/s1",
      ended: true,
    });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["POST /v2/spaces/s1:endActiveConference"]);

    route = () => ({ status: 500, body: { error: { code: 500, status: "INTERNAL", message: "Backend failed" } } });
    const failure = await call(connector, "create_space", { accessType: "TRUSTED" }).catch((error) => error);
    // A dispatched create's outcome is unknown: never retryable, never resent.
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("create_space makes a new meeting link on every call");
    expect(calls.filter((c) => c.url.pathname === "/v2/spaces")).toHaveLength(1);
    expect(calls.at(-1)!.body).toEqual({ config: { accessType: "TRUSTED" } });
  });
});

describe("conference records and artifacts", () => {
  it("filters conference records from structured arguments and pages with a bound cursor", async () => {
    route = (c) =>
      c.url.searchParams.get("pageToken")
        ? { body: { conferenceRecords: [{ name: "conferenceRecords/c2", space: "spaces/s1" }] } }
        : {
            body: {
              conferenceRecords: [
                { name: "conferenceRecords/c1", space: "spaces/s1", startTime: "2026-10-02T10:00:00Z" },
              ],
              nextPageToken: "next-1",
            },
          };
    const connector = connection();
    const args = { space: "abc-mnop-xyz", startedAfter: "2026-10-01T00:00:00Z", activeOnly: true };
    const first = await call(connector, "list_conference_records", { ...args, limit: 1 });
    expect(calls[0]!.url.searchParams.get("filter")).toBe(
      'space.meeting_code = "abc-mnop-xyz" AND start_time >= "2026-10-01T00:00:00Z" AND end_time IS NULL',
    );
    expect(calls[0]!.url.searchParams.get("pageSize")).toBe("1");
    expect(first.items).toEqual([
      { name: "conferenceRecords/c1", space: "spaces/s1", startTime: "2026-10-02T10:00:00Z" },
    ]);
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).not.toContain("next-1");
    const second = await call(connector, "list_conference_records", { ...args, cursor: first.page.nextCursor });
    expect(calls[1]!.url.searchParams.get("pageToken")).toBe("next-1");
    expect(second).toEqual({ items: [{ name: "conferenceRecords/c2", space: "spaces/s1" }], page: { hasMore: false } });
    // A cursor carried to other arguments would page through another listing.
    await expect(
      call(connector, "list_conference_records", { space: "spaces/other", cursor: first.page.nextCursor }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(2);

    await call(connector, "list_conference_records", { space: "spaces/s1" });
    expect(calls.at(-1)!.url.searchParams.get("filter")).toBe('space.name = "spaces/s1"');
  });

  it("reads nested resource names segment by segment", async () => {
    route = () => ({ body: { name: "x", latestEndTime: "2026-10-02T11:00:00Z" } });
    const connector = connection();
    await call(connector, "get_participant", { participant: "conferenceRecords/c1/participants/p1" });
    await call(connector, "list_participant_sessions", {
      participant: "conferenceRecords/c1/participants/p1",
      activeOnly: true,
    });
    await call(connector, "get_recording", { name: "conferenceRecords/c1/recordings/r1" });
    await call(connector, "list_smart_notes", { conferenceRecord: "conferenceRecords/c1" });
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/v2/conferenceRecords/c1/participants/p1",
      "/v2/conferenceRecords/c1/participants/p1/participantSessions",
      "/v2/conferenceRecords/c1/recordings/r1",
      "/v2/conferenceRecords/c1/smartNotes",
    ]);
    expect(calls[1]!.url.searchParams.get("filter")).toBe("end_time IS NULL");
    await expect(
      call(connector, "get_participant", { participant: "conferenceRecords/c1/../spaces/s1" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(4);
  });

  it("cuts long transcript entries in a list, says so, and keeps the page inside one result", async () => {
    const long = "word ".repeat(12_000);
    route = (c) => ({
      body: c.url.pathname.endsWith("/entries/e1")
        ? { name: "e1", text: long }
        : {
            transcriptEntries: Array.from({ length: 50 }, (_, i) => ({
              name: `conferenceRecords/c1/transcripts/t1/entries/e${i}`,
              participant: "conferenceRecords/c1/participants/p1",
              text: i === 0 ? "Short." : long,
            })),
          },
    });
    const connector = connection();
    const page = await call(connector, "list_transcript_entries", {
      transcript: "conferenceRecords/c1/transcripts/t1",
      limit: 50,
    });
    expect(jsonBytes(page)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(page.truncated).toEqual(["items[].text"]);
    expect(page.items[0].text).toBe("Short.");
    expect(page.items[1].text).toContain("get_transcript_entry reads it whole");
    const whole = await call(connector, "get_transcript_entry", {
      entry: "conferenceRecords/c1/transcripts/t1/entries/e1",
    });
    expect(whole.text).toBe(long);
  });

  it("fails closed on malformed paging metadata", async () => {
    route = () => ({ body: { recordings: [], nextPageToken: "https://elsewhere.example/next" } });
    await expect(
      call(connection(), "list_recordings", { conferenceRecord: "conferenceRecords/c1" }),
    ).rejects.toMatchObject({ code: "connector_call_failed" });
  });
});

describe("the hatch", () => {
  it("reaches space members by resource path and bounds pageSize before sending", async () => {
    route = () => ({
      body: { members: [{ name: "spaces/s1/members/m1", email: "alice@example.com", role: "COHOST" }] },
    });
    const connector = connection();
    const read = await call(connector, "meet_api_read", { path: "/spaces/s1/members", query: { pageSize: 10 } });
    expect(read.data.members[0]).toMatchObject({ email: "alice@example.com", role: "COHOST" });
    await expect(
      call(connector, "meet_api_read", { path: "/spaces/s1/members", query: { pageSize: 501 } }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v2/spaces/s1/members"]);
  });
});
