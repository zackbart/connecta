import { PRIVATE_KEY } from "../../../test/fixtures/rsa.js";
// The Google People connection. Delegation, subjects, tokens and OAuth mode
// live in test/google-workspace-delegation.test.ts. This suite covers the
// People-specific behavior: the search warm-up, projections, the
// sensitive-field choice, permanent withholding, cursors, etag conflicts and
// directory refusals.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { people } from "./index.js";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
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
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === TOKEN_URL) return Response.json({ access_token: "token", expires_in: 3599 });
    const call: ApiCall = {
      url: new URL(url),
      method: init.method ?? (input instanceof Request ? input.method : "GET"),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
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
  return people("contacts", {
    purpose: "Resolve people",
    serviceAccount: { clientEmail: `people-${accounts}@project.iam.gserviceaccount.com`, privateKey: PRIVATE_KEY },
    subject: "alice@example.com",
    ...overrides,
  } as Parameters<typeof people>[1]);
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

/** A contact as Google returns it, with the fields the review withholds or drops. */
const PERSON = {
  resourceName: "people/c1",
  etag: "%EgUBAgMEBQ==",
  names: [{ metadata: { primary: true, source: { type: "CONTACT", id: "1" } }, displayName: "Bob Example" }],
  emailAddresses: [
    { metadata: { primary: true }, value: "bob@example.com", type: "work" },
    { metadata: { source: { type: "CONTACT" } }, value: "bob@example.org" },
  ],
  photos: [{ metadata: { primary: true }, url: "https://lh3.googleusercontent.com/private-photo" }],
  birthdays: [{ date: { year: 1990, month: 1, day: 2 } }],
  biographies: [{ value: "Private note", contentType: "TEXT_PLAIN" }],
  clientData: [{ key: "crm-id", value: "app-private-value" }],
};

describe("searching contacts", () => {
  it("sends Google's empty-query warm-up before the search and projects each match", async () => {
    route = (call) => (call.url.searchParams.get("query") ? { body: { results: [{ person: PERSON }] } } : { body: {} });
    const connector = connection();
    const result = await call(connector, "search_contacts", { query: "bob" });
    expect(calls.map((c) => [c.url.pathname, c.url.searchParams.get("query")])).toEqual([
      ["/v1/people:searchContacts", ""],
      ["/v1/people:searchContacts", "bob"],
    ]);
    expect(calls[1]!.url.searchParams.get("readMask")).toBe("names,emailAddresses,phoneNumbers,organizations");
    expect(calls[1]!.url.searchParams.get("pageSize")).toBe("10");
    expect(result.page).toEqual({ hasMore: false });
    expect(result.items[0]).toEqual({
      resourceName: "people/c1",
      etag: "%EgUBAgMEBQ==",
      names: [{ displayName: "Bob Example", primary: true }],
      emailAddresses: [{ value: "bob@example.com", type: "work", primary: true }, { value: "bob@example.org" }],
      photos: [{ url: "[redacted]", primary: true }],
    });
    const narrowed = await call(connector, "search_contacts", { query: "bob", fields: ["emailAddresses"] });
    expect(narrowed.items).toEqual([{ emailAddresses: result.items[0].emailAddresses }]);
  });

  it("refuses withheld or unknown person fields before any request, naming every problem", async () => {
    const connector = connection();
    const failure = await call(connector, "search_contacts", {
      query: "bob",
      personFields: ["names", "birthdays", "nonsense"],
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "invalid_args" });
    expect(String((failure as Error).message)).toContain("/personFields/1");
    expect(String((failure as Error).message)).toContain("/personFields/2");
    expect(String((failure as Error).message)).not.toContain("nonsense");
    expect(calls).toHaveLength(0);
    await expect(call(connector, "list_contacts", { personFields: ["addresses"] })).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("the sensitive-field choice", () => {
  it("drops sensitive fields everywhere by default, and returns them only when the deployment chooses", async () => {
    route = () => ({ body: PERSON });
    const dropping = connection();
    const named = await call(dropping, "get_person", { resourceName: "people/c1" });
    expect(named).not.toHaveProperty("birthdays");
    const hatch = await call(dropping, "people_api_read", {
      path: "/people/c1",
      query: { personFields: "names,birthdays,biographies,clientData,photos" },
    });
    expect(hatch.data).not.toHaveProperty("birthdays");
    expect(hatch.data).not.toHaveProperty("biographies");
    // Permanently withheld whatever the choice.
    expect(hatch.data.clientData).toEqual([{ key: "crm-id", value: "[redacted]" }]);
    expect(hatch.data.photos[0].url).toBe("[redacted]");
    expect(JSON.stringify(dropping.usageGuide)).toContain("withholds addresses, birthdays");

    const returning = connection({ sensitiveFields: "return" });
    const full = await call(returning, "get_person", {
      resourceName: "people/c1",
      personFields: ["names", "birthdays", "biographies"],
    });
    expect(calls.at(-1)!.url.searchParams.get("personFields")).toBe("names,birthdays,biographies");
    expect(full.birthdays).toEqual([{ date: { year: 1990, month: 1, day: 2 } }]);
    expect(full.biographies).toEqual([{ value: "Private note", contentType: "TEXT_PLAIN" }]);
    const hatchFull = await call(returning, "people_api_read", {
      path: "/people/c1",
      query: { personFields: "names" },
    });
    expect(hatchFull.data.clientData).toEqual([{ key: "crm-id", value: "[redacted]" }]);
    expect(() => connection({ sensitiveFields: "all" })).toThrow(/sensitiveFields/);
  });

  it("reads people/me and cuts long text with a truncated path", async () => {
    route = () => ({
      body: { resourceName: "people/123", organizations: [{ name: "x".repeat(25_000) }] },
    });
    const connector = connection();
    const me = await call(connector, "get_person", { resourceName: "people/me", personFields: ["organizations"] });
    expect(calls[0]!.url.pathname).toBe("/v1/people/me");
    expect(me.organizations[0].name).toMatch(/more characters truncated/);
    expect(me.truncated).toEqual(["organizations[].name"]);
  });
});

describe("paging", () => {
  it("carries Google's token and the first page size in a cursor bound to the call", async () => {
    route = (call) =>
      call.url.searchParams.get("pageToken")
        ? { body: { connections: [{ ...PERSON, resourceName: "people/c2" }] } }
        : { body: { connections: [PERSON], nextPageToken: "page-2" } };
    const connector = connection();
    const first = await call(connector, "list_contacts", { limit: 1, sortOrder: "FIRST_NAME_ASCENDING" });
    expect(calls[0]!.url.pathname).toBe("/v1/people/me/connections");
    expect(first.page.hasMore).toBe(true);
    const second = await call(connector, "list_contacts", {
      limit: 50,
      sortOrder: "FIRST_NAME_ASCENDING",
      cursor: first.page.nextCursor,
    });
    expect(calls[1]!.url.searchParams.get("pageToken")).toBe("page-2");
    expect(calls[1]!.url.searchParams.get("pageSize")).toBe("1");
    expect(second).toMatchObject({ items: [{ resourceName: "people/c2" }], page: { hasMore: false } });
    await expect(
      call(connector, "list_contacts", { sortOrder: "LAST_NAME_ASCENDING", cursor: first.page.nextCursor }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(2);
  });
});

describe("writing contacts", () => {
  beforeEach(() => {
    installOwnedTransport();
  });

  it("replaces only the fields given, at the read etag, and reports a stale etag as conflict", async () => {
    route = () => ({ body: { ...PERSON, phoneNumbers: [{ value: "+1 555 0100" }] } });
    const connector = connection();
    const updated = await call(connector, "update_contact", {
      resourceName: "people/c1",
      etag: "%EgUBAgMEBQ==",
      phoneNumbers: [{ value: "+1 555 0100", type: "mobile" }],
    });
    const sent = calls[0]!;
    expect(sent.method).toBe("PATCH");
    expect(sent.url.pathname).toBe("/v1/people/c1:updateContact");
    expect(sent.url.searchParams.get("updatePersonFields")).toBe("phoneNumbers");
    expect(sent.body).toEqual({ phoneNumbers: [{ value: "+1 555 0100", type: "mobile" }], etag: "%EgUBAgMEBQ==" });
    expect(updated.phoneNumbers).toEqual([{ value: "+1 555 0100" }]);

    route = () => ({
      status: 400,
      body: {
        error: {
          code: 400,
          message: "Request person.etag is different than the current person.etag.",
          status: "FAILED_PRECONDITION",
        },
      },
    });
    await expect(
      call(connector, "update_contact", { resourceName: "people/c1", etag: "stale", name: { givenName: "Bob" } }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(calls).toHaveLength(2);
    await expect(call(connector, "update_contact", { resourceName: "people/c1", etag: "e" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(calls).toHaveLength(2);
  });

  it("checks a hatch photo's decoded bytes before upload", async () => {
    route = () => ({ body: { person: PERSON } });
    const connector = connection();
    await expect(
      call(connector, "people_api_write", {
        method: "PATCH",
        path: "/people/c1:updateContactPhoto",
        body: { photoBytes: btoa("image https://files.example.com/photo?sig=[redacted] bytes") },
      }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(0);
    const photo = await call(connector, "people_api_write", {
      method: "PATCH",
      path: "/people/c1:updateContactPhoto",
      body: { photoBytes: btoa("\u0089PNG image bytes") },
    });
    expect(calls).toHaveLength(1);
    expect(photo.data.person.photos[0].url).toBe("[redacted]");
  });
});

describe("the Workspace directory", () => {
  it("says a refused directory read needs a Google Workspace account", async () => {
    route = () => ({
      status: 400,
      body: { error: { code: 400, message: "Must be a G Suite domain user.", status: "FAILED_PRECONDITION" } },
    });
    const connector = connection();
    const failure = await call(connector, "search_directory", { query: "ali" }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed" });
    expect(String((failure as Error).message)).toContain("only for Google Workspace accounts");
    expect(calls[0]!.url.searchParams.getAll("sources")).toEqual([
      "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
      "DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT",
    ]);
  });
});
