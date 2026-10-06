// The CCB (Pushpay ChMS) connection is hand-written fetch over `api()`'s
// downstream OAuth grant. A fake CCB stands in for both the token endpoint and
// the API, so these tests pin the whole path end to end: the consent URL each
// mode and environment builds, the code exchange with CCB's own Accept header,
// rotating single-use refresh tokens, the 401 replay, and then the requests,
// projections, pagination, and typed failures the connector owns.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CCB_MEDIA_TYPE,
  CCB_READ_SCOPES,
  CCB_WRITE_SCOPES,
  ccb,
  type CcbOptions,
} from "../src/providers/ccb.js";
import { classifyCallError } from "../src/errors.js";
import { identityStorageKey } from "../src/identity.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, ConnectorContext, ConnectorUsageGuide, ToolDef } from "../src/types.js";
import { makeRegistry } from "./helpers.js";

const BASE = "https://connecta.test";
const PROD_API = "https://api.ccbchurch.com";
const SANDBOX_API = "https://api-beta.ccbchurch.com";
const BASIC = `Basic ${btoa("church-client:church-secret")}`;

const OPTIONS: CcbOptions = {
  purpose: "Pastoral care and group shepherding",
  environment: "production",
  mode: "system",
  clientId: "church-client",
  clientSecret: "church-secret",
};

function connection(overrides: Partial<CcbOptions> = {}, id = "church"): Connector {
  return ccb(id, { ...OPTIONS, ...overrides } as CcbOptions);
}

interface ApiRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
}

type Route = (request: ApiRequest) => Response | undefined;

/**
 * A CCB in miniature. Codes, access tokens, and refresh tokens are minted and
 * checked the way CCB documents them: a refresh returns a new pair and
 * revokes both old tokens at once, a spent refresh token answers 401
 * `invalid_grant` (CCB's status for every token error), and both the code
 * exchange and the refresh must carry the v2 Accept header.
 */
function fakeCcb(apiOrigin = PROD_API) {
  let minted = 0;
  const codes = new Set<string>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  const tokenRequests: Array<{ params: URLSearchParams; headers: Headers }> = [];
  const requests: ApiRequest[] = [];
  let routes: Route[] = [];
  const issue = () => {
    minted += 1;
    const pair = { access_token: `access-${minted}`, refresh_token: `refresh-${minted}` };
    access.add(pair.access_token);
    refresh.add(pair.refresh_token);
    return Response.json({ ...pair, token_type: "bearer", expires_in: 7200, scope: "read:individuals" });
  };
  const stub = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init.headers);
    if (url.href === `${apiOrigin}/oauth/token`) {
      const params = new URLSearchParams(String(init.body));
      tokenRequests.push({ params, headers });
      if (headers.get("accept") !== CCB_MEDIA_TYPE) {
        return Response.json({ error: "invalid_request" }, { status: 406 });
      }
      if (headers.get("authorization") !== BASIC) {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      if (params.get("grant_type") === "authorization_code") {
        const code = params.get("code") ?? "";
        if (!codes.delete(code)) return Response.json({ error: "invalid_request" }, { status: 401 });
        return issue();
      }
      if (params.get("grant_type") === "refresh_token") {
        const token = params.get("refresh_token") ?? "";
        if (!refresh.delete(token)) {
          return Response.json({ error: "invalid_grant" }, { status: 401 });
        }
        // Rotation revokes the previous access token with the refresh token.
        access.delete(`access-${token.split("-")[1]}`);
        return issue();
      }
      return Response.json({ error: "unsupported_grant_type" }, { status: 401 });
    }
    if (url.origin === apiOrigin) {
      const request: ApiRequest = {
        url,
        method: init.method ?? "GET",
        headers,
        body: typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined,
      };
      requests.push(request);
      if (!access.has((headers.get("authorization") ?? "").replace(/^Bearer /, ""))) {
        return new Response(null, { status: 401 });
      }
      for (const route of routes) {
        const response = route(request);
        if (response) return response;
      }
      return Response.json({ error: `no route for ${request.method} ${url.pathname}` }, { status: 599 });
    }
    throw new Error(`unexpected request to ${url.href}`);
  };
  return {
    stub,
    tokenRequests,
    requests,
    refresh,
    consent(authorizationUrl: string) {
      const code = `code-${codes.size + minted + 1}`;
      codes.add(code);
      return { code, state: new URL(authorizationUrl).searchParams.get("state")! };
    },
    route(...next: Route[]) {
      routes = next;
    },
    expireAccess() {
      access.clear();
    },
  };
}

type Fake = ReturnType<typeof fakeCcb>;

function install(fake: Fake): void {
  vi.stubGlobal("fetch", vi.fn(fake.stub));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Answer one path (exact, template-free) with one response. */
function on(method: string, path: string, respond: (request: ApiRequest) => Response): Route {
  return (request) =>
    request.method === method && request.url.pathname === path ? respond(request) : undefined;
}

/** Start, consent, and finish one grant through the connector's own hooks. */
async function authorize(
  connector: Connector,
  ctx: () => ConnectorContext,
  fake: Fake,
): Promise<URL> {
  const started = await connector.startAuth!(ctx());
  expect(started.state).toBe("auth_required");
  const authorizationUrl = new URL(started.authorizationUrl!);
  const { code, state } = fake.consent(authorizationUrl.href);
  const callback = ctx();
  expect(await connector.verifyState!(state, callback)).toBe(true);
  await connector.finishAuth!(code, callback, new URLSearchParams({ code, state }));
  return authorizationUrl;
}

/** A connected connector with a fake CCB behind it. */
async function connected(overrides: Partial<CcbOptions> = {}) {
  const fake = fakeCcb(overrides.environment === "sandbox" ? SANDBOX_API : PROD_API);
  install(fake);
  const connector = connection(overrides);
  const registry = makeRegistry([connector]);
  const ctx = () => registry.contextFor("church", BASE);
  await authorize(connector, ctx, fake);
  const call = (name: string, args: Record<string, unknown> = {}) =>
    connector.callTool(name, args, ctx()) as Promise<any>;
  return { fake, connector, registry, ctx, call };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return classifyCallError(error);
  }
  throw new Error("expected the call to fail");
}

async function toolsOf(connector: Connector): Promise<ToolDef[]> {
  return connector.listTools(makeRegistry([connector]).contextFor(connector.id, BASE));
}

function guide(connector: Connector): ConnectorUsageGuide {
  return connector.usageGuide as ConnectorUsageGuide;
}

describe("ccb() construction", () => {
  it.each([
    ["a blank purpose", { purpose: "  " }, /non-empty church purpose/],
    ["no environment", { environment: undefined }, /requires environment/],
    ["an unknown environment", { environment: "staging" }, /requires environment/],
    ["no mode", { mode: undefined }, /requires mode/],
    ["access beside scopes", { access: "read", scopes: ["read:groups"] }, /access or scopes, not both/],
    ["an empty scope list", { scopes: [] }, /non-empty list/],
    ["a malformed scope", { scopes: ["individuals"] }, /not a CCB scope/],
    ["a repeated scope", { scopes: ["read:groups", "read:groups"] }, /listed twice/],
    ["a subdomain URL", { subdomain: "https://mychurch.ccbchurch.com" }, /bare CCB subdomain/],
    ["a page size CCB refuses", { defaultPerPage: 30 }, /25, 50, 75, or 100/],
    ["an empty client secret from an unset variable", { clientSecret: "" }, /clientSecret must be a non-empty string/],
  ])("refuses %s", (_label, overrides, message) => {
    expect(() => connection(overrides as Partial<CcbOptions>)).toThrow(message);
  });

  it("declares an OAuth grant and no operator credential slot", () => {
    const connector = connection();
    expect(connector.credential).toBeUndefined();
    for (const hook of ["status", "startAuth", "disconnectAuth", "verifyState", "finishAuth"] as const) {
      expect(connector[hook]).toBeTypeOf("function");
    }
  });

  it("derives grant ownership from the mode", () => {
    expect(connection({ mode: "system" }).authScope).toBe("shared");
    expect(connection({ mode: "identity" }).authScope).toBe("personal");
  });
});

describe("ccb() consent URL", () => {
  it("asks System Auth for the read scopes at production, with no network request", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 599 }));
    vi.stubGlobal("fetch", fetchSpy);
    const connector = connection({ subdomain: "gracechurch" });
    const started = await connector.startAuth!(makeRegistry([connector]).contextFor("church", BASE));
    const url = new URL(started.authorizationUrl!);
    expect(`${url.origin}${url.pathname}`).toBe("https://oauth.ccbchurch.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "church-client",
      redirect_uri: `${BASE}/oauth/callback/church`,
      scope: CCB_READ_SCOPES.join(" "),
      subdomain: "gracechurch",
    });
    expect(url.searchParams.has("resource_owner_auth")).toBe(false);
    expect(url.href).not.toContain("church-secret");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks Identity Auth with resource_owner_auth at the sandbox host, per person", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 599 })));
    const connector = connection({ mode: "identity", environment: "sandbox", access: "read-write" });
    const registry = makeRegistry([connector]);
    const key = await identityStorageKey({ namespace: "synthetic", id: "pastor" });
    const started = await connector.startAuth!(
      registry.scoped({ connectorIds: "all", principalKey: key }).contextFor("church", BASE),
    );
    const url = new URL(started.authorizationUrl!);
    expect(`${url.origin}${url.pathname}`).toBe("https://beta-oauth.ccbchurch.com/oauth/authorize");
    expect(url.searchParams.get("resource_owner_auth")).toBe("true");
    expect(url.searchParams.get("scope")).toBe([...CCB_READ_SCOPES, ...CCB_WRITE_SCOPES].join(" "));
  });

  it("requests an explicit scope list exactly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 599 })));
    const connector = connection({ scopes: ["read:individuals", "read:background_checks"] });
    const started = await connector.startAuth!(makeRegistry([connector]).contextFor("church", BASE));
    expect(new URL(started.authorizationUrl!).searchParams.get("scope")).toBe(
      "read:individuals read:background_checks",
    );
  });
});

describe("ccb() OAuth end to end", () => {
  it("exchanges the code with CCB's Accept header and calls the sandbox API as a bearer", async () => {
    const { fake, call } = await connected({ environment: "sandbox" });
    const exchange = fake.tokenRequests.at(-1)!;
    expect(exchange.params.get("grant_type")).toBe("authorization_code");
    expect(exchange.params.get("redirect_uri")).toBe(`${BASE}/oauth/callback/church`);
    expect(exchange.headers.get("accept")).toBe(CCB_MEDIA_TYPE);
    expect(exchange.headers.get("authorization")).toBe(BASIC);

    fake.route(on("GET", "/me", () => json({ id: 7, name: "Ada Pastor", username: "ada", user_types: ["ADMIN"], images: {} })));
    expect(await call("get_me")).toEqual({ id: 7, name: "Ada Pastor", username: "ada", userTypes: ["ADMIN"] });
    const request = fake.requests.at(-1)!;
    expect(request.url.origin).toBe(SANDBOX_API);
    expect(request.headers.get("authorization")).toBe("Bearer access-1");
    expect(request.headers.get("accept")).toBe(CCB_MEDIA_TYPE);
  });

  it("refreshes on a 401, rotates the single-use refresh token, and replays once", async () => {
    const { fake, call } = await connected();
    fake.route(on("GET", "/me", () => json({ id: 7, name: "Ada Pastor" })));

    // Two hours pass: the access token is dead, the refresh token is not.
    fake.expireAccess();
    expect(await call("get_me")).toMatchObject({ id: 7 });
    const refreshes = () =>
      fake.tokenRequests.filter((r) => r.params.get("grant_type") === "refresh_token");
    expect(refreshes().map((r) => r.params.get("refresh_token"))).toEqual(["refresh-1"]);
    expect(refreshes()[0]!.headers.get("accept")).toBe(CCB_MEDIA_TYPE);
    // CCB refuses a scope on refresh; the grant never sends one.
    expect(refreshes()[0]!.params.has("scope")).toBe(false);
    expect(fake.requests.map((r) => r.headers.get("authorization"))).toEqual([
      "Bearer access-1",
      "Bearer access-2",
    ]);
    expect(fake.refresh.has("refresh-1")).toBe(false);

    // The next expiry redeems the rotated token, never the spent one.
    fake.expireAccess();
    await call("get_me");
    expect(refreshes().map((r) => r.params.get("refresh_token"))).toEqual(["refresh-1", "refresh-2"]);
  });

  it("answers auth_required when CCB refuses the refresh token, and drops the grant", async () => {
    const { fake, connector, ctx, call } = await connected();
    fake.route(on("GET", "/me", () => json({ id: 7 })));
    // Another worker spent the refresh token, or the church removed its approval.
    fake.refresh.clear();
    fake.expireAccess();
    const failed = await failure(call("get_me"));
    expect(failed).toMatchObject({ code: "auth_required" });
    expect(failed.message).toContain('authorize_connector({ connector: "church" })');
    expect((await connector.status!(ctx())).state).toBe("auth_required");
  });
});

describe("ccb() tool surface", () => {
  it("ships reads and the read-only hatches, and no write tool, by default", async () => {
    const connector = connection();
    const tools = await toolsOf(connector);
    expect(tools.map((tool) => tool.name)).not.toContain("ccb_api_mutate");
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["ccb_api_get", "ccb_api_search"]));
    expect(connector.title).toBe("Pushpay ChMS (CCB) — read-only");
  });

  it("adds the always-destructive mutate hatch exactly when a write scope is granted", async () => {
    for (const overrides of [{ access: "read-write" }, { scopes: ["read:groups", "write:notes"] }] as const) {
      const tools = await toolsOf(connection(overrides as Partial<CcbOptions>));
      const mutate = tools.find((tool) => tool.name === "ccb_api_mutate");
      expect(mutate?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
      expect(tools.filter((tool) => tool.annotations?.readOnlyHint !== true)).toHaveLength(1);
    }
    expect(connection({ access: "read-write", environment: "sandbox", mode: "identity" }).title).toBe(
      "Pushpay ChMS (CCB) — sandbox, per-person",
    );
  });

  it("puts the routing fact first in the guide and appends church instructions", () => {
    const connector = connection({ environment: "sandbox", mode: "identity", instructions: "Small groups live under the Connect department." });
    const content = guide(connector).content;
    const firstLine = content.split("\n").find((line) => line.trim() && !line.startsWith("#"));
    expect(firstLine).toContain("Sandbox church data, acting as each signed-in person");
    expect(firstLine).toContain("read-only");
    expect(content.trim().endsWith("Small groups live under the Connect department.")).toBe(true);
    expect(content).toContain("legacy v1 XML API");
    expect(guide(connector).summary!.length).toBeLessThanOrEqual(120);
    expect(guide(connector).required).toBe(true);
  });
});

describe("ccb() reads", () => {
  const PERSON = {
    id: 42,
    family_id: 9,
    campus_id: 1,
    name: "Grace Hopper",
    first_name: "Grace",
    last_name: "Hopper",
    email: "grace@example.org",
    phone: { mobile: "555-0100", home: "", work: "" },
    active: true,
    images: { thumbnail: "https://cdn.example/t.png" },
    actions: { can_view_profile: { allowed: true } },
  };

  it("lists individuals with CCB's paging, projecting and reporting the next page", async () => {
    const { fake, call } = await connected();
    fake.route(on("GET", "/individuals", () =>
      json([PERSON], { "x-page": "2", "x-total-pages": "4", "x-total": "77", "x-next-page": "3" }),
    ));
    const result = await call("list_individuals", { query: "hop", includeInactive: true, page: 2, perPage: 50 });
    expect(result).toEqual({
      individuals: [{
        id: 42, name: "Grace Hopper", firstName: "Grace", lastName: "Hopper", email: "grace@example.org",
        phones: { mobile: "555-0100" }, familyId: 9, campusId: 1, active: true,
      }],
      page: { hasMore: true, nextPage: 3, total: 77 },
    });
    expect(Object.fromEntries(fake.requests.at(-1)!.url.searchParams)).toEqual({
      name: "hop", include_inactive: "true", page: "2", per_page: "50",
    });
  });

  it("reads the last page from an empty x-next-page, then from x-total-pages, then from a short page", async () => {
    const { fake, call } = await connected();
    fake.route(on("GET", "/groups", () => json([{ id: 1, name: "Alpha" }], { "x-next-page": "", "x-total": "1" })));
    expect((await call("list_groups")).page).toEqual({ hasMore: false, nextPage: null, total: 1 });
    fake.route(on("GET", "/groups", () => json([{ id: 1 }], { "x-page": "1", "x-total-pages": "2" })));
    expect((await call("list_groups")).page).toEqual({ hasMore: true, nextPage: 2, total: null });
    fake.route(on("GET", "/groups", () => json([{ id: 1 }])));
    expect((await call("list_groups")).page).toEqual({ hasMore: false, nextPage: null, total: null });
    expect(fake.requests.at(-1)!.url.searchParams.get("per_page")).toBe("25");
  });

  it("drops sensitive individual fields unless raw is asked for", async () => {
    const { fake, call } = await connected();
    const row = {
      ...PERSON,
      allergies: "peanuts",
      giving_number: "G-17",
      envelope_user_id: 3,
      last_giving_date: "2026-09-01",
      addresses: { home: { street: "1 Main", city: "Springfield", state: "IL", zip: "62701", latitude: "1" } },
      custom_fields: [{ id: 5, value: "Usher" }],
    };
    fake.route(on("GET", "/individuals/42", () => json(row)));
    const projected = await call("get_individual", { individualId: 42 });
    expect(projected).toMatchObject({
      id: 42,
      homeAddress: { street: "1 Main", city: "Springfield", state: "IL", zip: "62701" },
      customFields: { "5": "Usher" },
    });
    const text = JSON.stringify(projected);
    for (const secret of ["peanuts", "G-17", "envelope", "last_giving_date", "actions", "thumbnail"]) {
      expect(text).not.toContain(secret);
    }
    expect(await call("get_individual", { individualId: 42, raw: true })).toMatchObject({ allergies: "peanuts", giving_number: "G-17" });
  });

  it("addresses an event occurrence and drops prayer requests from attendance", async () => {
    const { fake, call } = await connected();
    fake.route(on("GET", "/events/12/attendance/20260927", () =>
      json({ event_id: 12, occurrence: "20260927", status: "MET", total_attendance: 14, visitors: 2, topic: "Romans 8", prayer_requests: "private", notes: "leader notes" }),
    ));
    const summary = await call("get_event_attendance", { eventId: 12, occurrence: "2026-09-27" });
    expect(summary).toEqual({ eventId: 12, occurrence: "20260927", status: "MET", totalAttendance: 14, visitors: 2, topic: "Romans 8" });
  });

  it("chooses the individual or family giving endpoint and refuses a range CCB would reject", async () => {
    const { fake, call } = await connected();
    fake.route(
      on("GET", "/families/9/metrics/giving", () => json([{ family_id: 9, date: "2026-08-01", count: 3, members: [{ id: 42, count: 2, start: "2026-08-01" }] }])),
    );
    expect(await call("get_giving_metrics", { familyId: 9, start: "2026-01-01", end: "2026-09-30" })).toEqual({
      periods: [{ start: "2026-08-01", count: 3, members: [{ individualId: 42, count: 2 }] }],
    });
    const before = fake.requests.length;
    expect(await failure(call("get_giving_metrics", { individualId: 42, familyId: 9 }))).toMatchObject({ code: "invalid_args" });
    expect(await failure(call("get_giving_metrics", { individualId: 42, start: "2024-01-01", end: "2026-01-01" }))).toMatchObject({ code: "invalid_args" });
    expect(fake.requests.length).toBe(before);
  });
});

describe("ccb() typed failures (H11)", () => {
  async function failing(response: Response) {
    const { fake, call } = await connected();
    fake.route(on("GET", "/groups/5", () => response));
    return failure(call("get_group", { groupId: 5 }));
  }

  it("maps a 403 to a non-retryable gap that re-authorizing cannot fix", async () => {
    const failed = await failing(json({ message: "Insufficient scope" }, {}, 403));
    expect(failed).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failed.message).toContain("Insufficient scope");
    expect(failed.message).toContain("Re-authorizing alone will not fix it");
  });

  it("maps a 404 to not_found, because CCB reports permission gaps as 403", async () => {
    expect(await failing(new Response(null, { status: 404 }))).toMatchObject({ code: "not_found", retryable: false });
  });

  it("maps a 429 to rate_limited with CCB's stated wait", async () => {
    expect(await failing(json({ error: "Rate limit exceeded", retry_after: 5 }, { "retry-after": "5" }, 429))).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 5000,
    });
    expect(await failing(json({ error: "Rate limit exceeded", retry_after: 3 }, {}, 429))).toMatchObject({
      code: "rate_limited",
      retryAfterMs: 3000,
    });
  });

  it.each([
    [400, "invalid_args", false],
    [412, "invalid_args", false],
    [422, "invalid_args", false],
    [409, "conflict", false],
    [503, "unavailable", true],
    [418, "connector_call_failed", false],
  ])("maps HTTP %i to %s", async (status, code, retryable) => {
    expect(await failing(json({ errors: [{ message: "nope" }] }, {}, status))).toMatchObject({ code, retryable });
  });

  it("carries an upstream retry-after on a 5xx", async () => {
    expect(await failing(json({}, { "retry-after": "9" }, 503))).toMatchObject({ code: "unavailable", retryAfterMs: 9000 });
  });

  it("refuses a successful response that is not JSON", async () => {
    expect(await failing(new Response("<html>maintenance</html>", { status: 200 }))).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
  });
});

describe("ccb() escape hatches (H14)", () => {
  it("sends ccb_api_get only beneath the API origin, never to /oauth", async () => {
    const { fake, call } = await connected();
    fake.route(on("GET", "/church/membership_types", () => json([{ id: 1, name: "Member" }], { "x-next-page": "" })));
    expect(await call("ccb_api_get", { path: "/church/membership_types", query: { per_page: 50 } })).toEqual({
      result: [{ id: 1, name: "Member" }],
      page: { hasMore: false, nextPage: null, total: null },
    });
    expect(fake.requests.at(-1)!.url.search).toBe("?per_page=50");
    const before = fake.requests.length;
    for (const path of ["https://evil.example/steal", "/../../oauth/token", "/groups/../oauth/token", "/%6Fauth/token", "/oauth/token", "/individuals?x=1"]) {
      expect(await failure(call("ccb_api_get", { path })), path).toMatchObject({ code: "invalid_args" });
    }
    expect(fake.requests.length).toBe(before);
    expect(fake.tokenRequests.filter((r) => r.params.get("grant_type") === "refresh_token")).toHaveLength(0);
  });

  it("runs advanced searches as a read against one domain's results endpoint", async () => {
    const { fake, call } = await connected();
    fake.route(on("POST", "/search/individuals/results", (request) => json([{ id: 1, echo: request.body }], { "x-next-page": "2" })));
    const body = { configuration: { columns: ["name"] }, filters: { name: "Ada" } };
    const result = await call("ccb_api_search", { domain: "individuals", body, perPage: 100 });
    expect(result).toEqual({ result: [{ id: 1, echo: body }], page: { hasMore: true, nextPage: 2, total: null } });
    expect(fake.requests.at(-1)!.url.search).toBe("?page=1&per_page=100");
    expect(await failure(call("ccb_api_search", { domain: "permission_individuals", body: {} }))).toMatchObject({ code: "invalid_args" });
  });

  it("sends a JSON mutation through the approval-gated hatch", async () => {
    const { fake, call } = await connected({ access: "read-write" });
    fake.route(on("POST", "/individuals/42/notes", (request) => json({ id: 3, note: (request.body as any).note })));
    expect(await call("ccb_api_mutate", { method: "POST", path: "/individuals/42/notes", body: { note: "Visited" } })).toEqual({
      result: { id: 3, note: "Visited" },
    });
    expect(fake.requests.at(-1)!.headers.get("content-type")).toBe("application/json");
  });
});

describe("ccb() call admission", () => {
  it("meters each endpoint separately with CCB's documented 60-call burst", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network touched"); }));
    const connector = connection();
    const rule = connector.callAdmission!.rules[0]!;
    expect(rule.budget).toEqual({ kind: "rolling-window", maxCalls: 60, windowMs: 60_000 });
    const key = (toolName: string, args: unknown) => rule.partitionKey!({ toolName, args });
    expect(key("get_individual", { individualId: 1 })).toBe("GET /individuals/{id}");
    expect(key("get_individual", { individualId: 2 })).toBe(key("ccb_api_get", { path: "/individuals/77" }));
    expect(key("get_giving_metrics", { familyId: 1 })).toBe("GET /families/{id}/metrics/giving");
    expect(key("ccb_api_search", { domain: "individuals" })).toBe("POST /search/individuals/results");
    expect(key("ccb_api_mutate", { method: "PUT", path: "/groups/9" })).toBe("PUT /groups/{id}");
    expect(key("ccb_api_get", null)).toBe("GET ");
    expect(key("ccb_api_get", { path: `/${"x".repeat(500)}` }).length).toBeLessThanOrEqual(120);

    const registry = makeRegistry([connector], { storage: memoryStorage() });
    for (let index = 0; index < 60; index += 1) {
      (await registry.admitCall("church", { toolName: "get_individual", args: { individualId: index + 1 } })).release();
    }
    await expect(
      registry.admitCall("church", { toolName: "get_individual", args: { individualId: 99 } }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    // Another endpoint still has its own budget.
    (await registry.admitCall("church", { toolName: "list_groups", args: {} })).release();
  });
});

describe("ccb() instance isolation", () => {
  it("keeps two connections' grants and hosts apart", async () => {
    const fake = fakeCcb(PROD_API);
    install(fake);
    const church = ccb("ccb_church", OPTIONS);
    const sandbox = ccb("ccb_sandbox", { ...OPTIONS, environment: "sandbox" });
    const registry = makeRegistry([church, sandbox]);
    await authorize(church, () => registry.contextFor("ccb_church", BASE), fake);
    expect((await church.status!(registry.contextFor("ccb_church", BASE))).state).toBe("ok");
    expect((await sandbox.status!(registry.contextFor("ccb_sandbox", BASE))).state).toBe("auth_required");
    const started = await sandbox.startAuth!(registry.contextFor("ccb_sandbox", BASE));
    expect(new URL(started.authorizationUrl!).origin).toBe("https://beta-oauth.ccbchurch.com");
  });

  it("keeps Identity Auth grants personal to each signed-in person", async () => {
    const fake = fakeCcb(PROD_API);
    install(fake);
    const connector = connection({ mode: "identity" });
    const registry = makeRegistry([connector]);
    const [pastor, deacon] = await Promise.all(
      ["pastor", "deacon"].map((id) => identityStorageKey({ namespace: "synthetic", id })),
    );
    const as = (principalKey: string) => () =>
      registry.scoped({ connectorIds: "all", principalKey }).contextFor("church", BASE);
    await authorize(connector, as(pastor!), fake);
    expect((await connector.status!(as(pastor!)())).state).toBe("ok");
    expect((await connector.status!(as(deacon!)())).state).toBe("auth_required");
  });
});
