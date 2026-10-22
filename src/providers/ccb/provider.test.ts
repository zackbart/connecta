// The CCB (Pushpay ChMS) connection is hand-written fetch over `api()`'s
// downstream OAuth grant. A fake CCB stands in for both the token endpoint and
// the API. Request shapes, projections, and status mapping live in the
// characterization goldens; these tests pin the consent URL, the code exchange
// with CCB's own Accept header, rotating single-use refresh tokens, the 401
// replay, paging edges, the sensitive-field boundary, and grant isolation.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CCB_MEDIA_TYPE, CCB_READ_SCOPES, CCB_WRITE_SCOPES, ccb, type CcbOptions } from "./index.js";
import { classifyCallError } from "../../errors.js";
import { identityStorageKey } from "../../identity.js";
import { requestSentSecrets } from "../../sent-secrets.js";
import type { Connector, ConnectorContext } from "../../types.js";
import { makeRegistry } from "../../../test/helpers.js";

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
  return (request) => (request.method === method && request.url.pathname === path ? respond(request) : undefined);
}

/** Start, consent, and finish one grant through the connector's own hooks. */
async function authorize(connector: Connector, ctx: () => ConnectorContext, fake: Fake): Promise<URL> {
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

describe("ccb() construction", () => {
  it.each([
    ["no environment", { environment: undefined }, /requires environment/],
    ["a malformed scope", { scopes: ["individuals"] }, /not a CCB scope/],
    ["an empty client secret from an unset variable", { clientSecret: "" }, /clientSecret to be a non-empty string/],
  ])("refuses %s", (_label, overrides, message) => {
    expect(() => connection(overrides as Partial<CcbOptions>)).toThrow(message);
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 599 })),
    );
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
});

describe("ccb() OAuth end to end", () => {
  it("exchanges the code with CCB's Accept header and calls the sandbox API as a bearer", async () => {
    const { fake, call } = await connected({ environment: "sandbox" });
    const exchange = fake.tokenRequests.at(-1)!;
    expect(exchange.params.get("grant_type")).toBe("authorization_code");
    expect(exchange.params.get("redirect_uri")).toBe(`${BASE}/oauth/callback/church`);
    expect(exchange.headers.get("accept")).toBe(CCB_MEDIA_TYPE);
    expect(exchange.headers.get("authorization")).toBe(BASIC);

    fake.route(on("GET", "/me", () => json({ id: 7, name: "Ada Pastor" })));
    await call("get_me");
    const request = fake.requests.at(-1)!;
    expect(request.url.origin).toBe(SANDBOX_API);
    expect(request.headers.get("authorization")).toBe("Bearer access-1");
    expect(request.headers.get("accept")).toBe(CCB_MEDIA_TYPE);
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

  it("INV-4: raw rows, hatches, and search drop sensitive fields unless deployment code returns them", async () => {
    const individual = {
      ...PERSON,
      allergies: "peanuts",
      confirmed_no_allergies: false,
      giving_number: "G-17",
      envelope_user_id: 3,
      last_giving_date: "2026-09-01",
      date_anyone_run_giving_statement: "2026-01-02",
      family: { members: [{ id: 43, allergies: "shellfish" }] },
    };
    const attendance = { event_id: 12, occurrence: "20260927", prayer_requests: "private", notes: "leader notes" };
    const response = { id: 5, form_id: 2, payment: { method: "CREDIT_CARD", total: 2500 }, payment_status: "PAID" };
    const routes = [
      on("GET", "/individuals/42", () => json(individual)),
      on("GET", "/events/12/attendance/20260927", () => json(attendance)),
      on("GET", "/forms/2/responses", () => json([response], { "x-next-page": "" })),
      on("POST", "/search/individuals/results", () => json([individual], { "x-next-page": "" })),
      on("PUT", "/individuals/42", () => json(individual)),
    ];
    const reads: Array<[string, Record<string, unknown>]> = [
      ["get_individual", { individualId: 42, raw: true }],
      ["get_event_attendance", { eventId: 12, occurrence: "2026-09-27", raw: true }],
      ["list_form_responses", { formId: 2, raw: true }],
      ["ccb_api_get", { path: "/individuals/42" }],
      ["ccb_api_get", { path: "/events/12/attendance/20260927" }],
      ["ccb_api_search", { domain: "individuals", body: { filters: {} } }],
      ["ccb_api_mutate", { method: "PUT", path: "/individuals/42", body: { first_name: "Ada" } }],
    ];
    const secrets = ["peanuts", "shellfish", "G-17", "envelope", "giving", "statement", "private", "leader notes"];
    const dropped = await connected({ access: "read-write" });
    dropped.fake.route(...routes);
    for (const [tool, args] of reads) {
      const text = JSON.stringify(await dropped.call(tool, args));
      for (const secret of [...secrets, "allerg", "CREDIT_CARD"])
        expect(text, `${tool} ${secret}`).not.toContain(secret);
    }
    expect(JSON.stringify(await dropped.call("ccb_api_get", { path: "/individuals/42" }))).toContain(
      '"name":"Grace Hopper"',
    );

    // An argument cannot widen it; only the deployment's option can.
    const returned = await connected({ access: "read-write", sensitiveFields: "return" });
    returned.fake.route(...routes);
    expect(await returned.call("get_individual", { individualId: 42, raw: true })).toMatchObject({
      allergies: "peanuts",
      giving_number: "G-17",
    });
    expect(JSON.stringify(await returned.call("ccb_api_get", { path: "/events/12/attendance/20260927" }))).toContain(
      "leader notes",
    );
    expect(() => connection({ sensitiveFields: "raw" as never })).toThrow(/sensitiveFields/);
  });
});

describe("ccb() typed failures (H11)", () => {
  async function failing(response: Response) {
    const { fake, call } = await connected();
    fake.route(on("GET", "/groups/5", () => response));
    return failure(call("get_group", { groupId: 5 }));
  }

  it("INV-5: error normalization cannot trim a private value before redaction", async () => {
    const value = `   ${"private-error-with-whitespace/".repeat(30)}`;
    const { fake, connector, ctx } = await connected();
    const context = ctx();
    context.requestScope = {};
    requestSentSecrets(context).arguments(
      { private: value },
      {
        type: "object",
        properties: { private: { type: "string", writeOnly: true } },
      },
    );
    fake.route(on("GET", "/groups/5", () => json({ message: value }, {}, 400)));
    const failed = await failure(Promise.resolve(connector.callTool("get_group", { groupId: 5 }, context)));
    expect(failed.message).toContain("[redacted]");
    expect(failed.message).not.toContain("private-error-with-whitespace");
  });

  it("reads CCB's stated wait from a 429 body without a Retry-After header", async () => {
    expect(await failing(json({ error: "Rate limit exceeded", retry_after: 3 }, {}, 429))).toMatchObject({
      code: "rate_limited",
      retryAfterMs: 3000,
    });
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
    const before = fake.requests.length;
    for (const path of [
      "https://evil.example/steal",
      "/../../oauth/token",
      "/groups/../oauth/token",
      "/%6Fauth/token",
      "/oauth/token",
      "/individuals?x=1",
    ]) {
      expect(await failure(call("ccb_api_get", { path })), path).toMatchObject({ code: "invalid_args" });
    }
    expect(await failure(call("ccb_api_search", { domain: "permission_individuals", body: {} }))).toMatchObject({
      code: "invalid_args",
    });
    expect(fake.requests.length).toBe(before);
    expect(fake.tokenRequests.filter((r) => r.params.get("grant_type") === "refresh_token")).toHaveLength(0);
  });

  it("INV-9: after a 401 the grant refreshes, a search (a POST read) replays once, and a mutation is never resent", async () => {
    const { fake, call } = await connected({ access: "read-write" });
    fake.route(
      on("POST", "/search/individuals/results", () => json([{ id: 1 }], { "x-next-page": "" })),
      on("POST", "/individuals/42/notes", () => json({ id: 3 })),
    );
    fake.expireAccess();
    expect((await call("ccb_api_search", { domain: "individuals", body: {} })).result).toEqual([{ id: 1 }]);
    expect(fake.requests.filter((request) => request.url.pathname === "/search/individuals/results")).toHaveLength(2);

    fake.expireAccess();
    expect(
      await failure(
        call("ccb_api_mutate", { method: "POST", path: "/individuals/42/notes", body: { note: "Visited" } }),
      ),
    ).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(fake.requests.filter((request) => request.url.pathname === "/individuals/42/notes")).toHaveLength(1);
    // The renewed grant serves the deliberate repeat.
    expect(
      await call("ccb_api_mutate", { method: "POST", path: "/individuals/42/notes", body: { note: "Visited" } }),
    ).toEqual({ result: { id: 3 } });
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
