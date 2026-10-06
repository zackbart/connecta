// Google Workspace domain-wide delegation, the layer every Workspace product
// provider shares (src/providers/google/). Driven through gmail() because the
// layer has no export of its own; the Gmail suite owns the tool surface.
//
// What this pins: the RS256 JWT-bearer assertion (header, claims, and a
// signature that verifies against the key's public half, signed with Web
// Crypto in whichever runtime runs this suite), the in-memory token cache and
// its refresh and dedupe, and the one rule the ethos row exists for — the
// subject comes from deployment config applied to the admitted identity, and
// from nothing a call, a header, or a program sends (#678).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachCaller } from "../src/connector-caller.js";
import { ConnectorCallError } from "../src/errors.js";
import { GMAIL_API_BASE_URL, GMAIL_SCOPES, gmail } from "../src/providers/gmail.js";
import { memoryStorage } from "../src/storage/memory.js";
import type {
  AuthenticatedIdentity,
  Connector,
  ConnectorContext,
  InboundAuth,
} from "../src/types.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const keys = (await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;

function pem(der: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(der)) binary += String.fromCharCode(byte);
  const body = btoa(binary).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

const PRIVATE_KEY = pem(
  (await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer,
);

/** Each test gets its own service account, so the module-level cache is fresh. */
let accounts = 0;
function account(): { clientEmail: string; privateKey: string; clientId: string } {
  accounts += 1;
  return {
    clientEmail: `delegate-${accounts}@project.iam.gserviceaccount.com`,
    privateKey: PRIVATE_KEY,
    clientId: `10000000000000000${accounts}`,
  };
}

function identity(id: string): AuthenticatedIdentity {
  return {
    actor: { kind: "test-users", id, namespace: "https://identity.test" },
    subject: { namespace: "https://identity.test", id },
    principal: { namespace: "https://identity.test", id },
    interactive: true,
  };
}

function context(caller?: AuthenticatedIdentity, signal?: AbortSignal): ConnectorContext {
  const ctx: ConnectorContext = {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    ...(signal ? { signal } : {}),
  };
  return caller ? attachCaller(ctx, { identity: caller }) : ctx;
}

const DIRECTORY: Readonly<Record<string, string>> = {
  alice: "alice@org.example",
  bob: "bob@org.example",
};

function mailbox(
  overrides: Record<string, unknown> = {},
  serviceAccount: unknown = account(),
): Connector {
  return gmail("mail", {
    purpose: "Staff email",
    serviceAccount,
    subject: (who: AuthenticatedIdentity) => DIRECTORY[who.principal?.id ?? ""],
    ...overrides,
  } as Parameters<typeof gmail>[1]);
}

// --- Network stub -----------------------------------------------------------------

interface TokenCall {
  grant: string | null;
  assertion: string;
}

interface ApiCall {
  url: string;
  method: string;
  authorization: string | null;
}

type Reply = () => Response | Promise<Response>;

const tokenCalls: TokenCall[] = [];
const apiCalls: ApiCall[] = [];
let tokenReplies: Reply[] = [];
let apiReplies: Reply[] = [];
const realFetch = globalThis.fetch;

function tokenResponse(token: string, expiresIn = 3599): Response {
  return Response.json({ access_token: token, expires_in: expiresIn, token_type: "Bearer" });
}

/** A response held until the test releases it, honoring the request's signal. */
function deferred(): { reply: Reply; release: (response: Response) => void } {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { reply: () => pending, release };
}

beforeEach(() => {
  tokenCalls.length = 0;
  apiCalls.length = 0;
  tokenReplies = [];
  apiReplies = [];
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const signal = init.signal ?? undefined;
    const answer = async (reply: Reply): Promise<Response> => {
      if (!signal) return await reply();
      if (signal.aborted) throw signal.reason;
      return await new Promise<Response>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        Promise.resolve(reply()).then(resolve, reject);
      });
    };
    if (url === TOKEN_URL) {
      const form = new URLSearchParams(String(init.body));
      tokenCalls.push({ grant: form.get("grant_type"), assertion: form.get("assertion") ?? "" });
      const count = tokenCalls.length;
      return await answer(tokenReplies.shift() ?? (() => tokenResponse(`token-${count}`)));
    }
    apiCalls.push({
      url,
      method: init.method ?? "GET",
      authorization: new Headers(init.headers).get("authorization"),
    });
    return await answer(apiReplies.shift() ?? (() => Response.json({ labels: [] })));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function decodeSegment(segment: string): any {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)));
}

function bytesOf(segment: string): Uint8Array {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

const labels = (connector: Connector, ctx: ConnectorContext, args: Record<string, unknown> = {}) =>
  connector.callTool("list_labels", args, ctx) as Promise<any>;

// --- The assertion ----------------------------------------------------------------

describe("the JWT-bearer assertion", () => {
  it("is RS256 with the delegation claims, and verifies against the key", async () => {
    const owner = account();
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    await labels(mailbox({}, owner), context(identity("alice")));

    expect(tokenCalls).toHaveLength(1);
    const call = tokenCalls[0]!;
    expect(call.grant).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = call.assertion.split(".");
    expect(decodeSegment(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeSegment(claims!)).toEqual({
      iss: owner.clientEmail,
      sub: "alice@org.example",
      scope: GMAIL_SCOPES.join(" "),
      aud: TOKEN_URL,
      iat: 1_800_000_000,
      exp: 1_800_000_000 + 3600,
    });
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      keys.publicKey,
      bytesOf(signature!),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(verified).toBe(true);
    expect(apiCalls[0]!.authorization).toBe("Bearer token-1");
  });

  it("accepts the downloaded JSON key text, escaped newlines included", async () => {
    const owner = account();
    const file = JSON.stringify({
      type: "service_account",
      project_id: "project",
      private_key_id: "abc",
      // An environment variable that kept the JSON's escapes literally.
      private_key: owner.privateKey.replace(/\n/g, "\\n"),
      client_email: owner.clientEmail,
      client_id: owner.clientId,
      token_uri: TOKEN_URL,
    });
    await labels(mailbox({}, file), context(identity("bob")));
    expect(decodeSegment(tokenCalls[0]!.assertion.split(".")[1]!)).toMatchObject({
      iss: owner.clientEmail,
      sub: "bob@org.example",
    });
  });
});

// --- Construction ---------------------------------------------------------------------

describe("construction refuses a structural mistake", () => {
  const build = (overrides: Record<string, unknown>) => () =>
    gmail("mail", {
      purpose: "Staff email",
      serviceAccount: account(),
      subject: () => undefined,
      ...overrides,
    } as Parameters<typeof gmail>[1]);

  it.each([
    ["no purpose", { purpose: " " }, /purpose/],
    ["no service account", { serviceAccount: undefined }, /serviceAccount/],
    ["a non-JSON string", { serviceAccount: "not json" }, /not JSON/],
    ["a user credential file", { serviceAccount: JSON.stringify({ type: "authorized_user" }) }, /not a service_account/],
    ["no client email", { serviceAccount: { privateKey: PRIVATE_KEY } }, /clientEmail/],
    ["no private key", { serviceAccount: { clientEmail: "a@b.iam.gserviceaccount.com" } }, /privateKey/],
    [
      "a PKCS#1 key",
      { serviceAccount: { clientEmail: "a@b.c", privateKey: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----" } },
      /PKCS#1/,
    ],
    [
      "a key that is not PKCS#8",
      { serviceAccount: { clientEmail: "a@b.c", privateKey: `-----BEGIN PRIVATE KEY-----\n${btoa("x".repeat(100))}\n-----END PRIVATE KEY-----` } },
      /PKCS#8/,
    ],
    ["no subject", { subject: undefined }, /subject/],
    ["a fixed subject that is not an address", { subject: "alice" }, /email address/],
  ])("%s", (_name, overrides, message) => {
    expect(build(overrides)).toThrow(message);
  });

  it("never puts the key in a construction error", () => {
    const secret = `-----BEGIN PRIVATE KEY-----\n${btoa("x".repeat(100))}\n-----END PRIVATE KEY-----`;
    try {
      build({ serviceAccount: { clientEmail: "a@b.c", privateKey: secret } })();
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(btoa("x".repeat(100)).slice(0, 20));
    }
  });
});

// --- Subject ------------------------------------------------------------------------

describe("whose account a call acts as", () => {
  it("comes from the config function applied to the admitted identity", async () => {
    const connector = mailbox();
    await labels(connector, context(identity("alice")));
    await labels(connector, context(identity("bob")));
    const subjects = tokenCalls.map((call) => decodeSegment(call.assertion.split(".")[1]!).sub);
    expect(subjects).toEqual(["alice@org.example", "bob@org.example"]);
    // Each caller rides on their own token.
    expect(apiCalls.map((call) => call.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("may be resolved asynchronously, from a directory lookup", async () => {
    const connector = mailbox({
      subject: async (who: AuthenticatedIdentity) => `${who.principal?.id}@lookup.example`,
    });
    await labels(connector, context(identity("carol")));
    expect(decodeSegment(tokenCalls[0]!.assertion.split(".")[1]!).sub).toBe("carol@lookup.example");
  });

  it("may be one fixed account, which needs no caller", async () => {
    const connector = mailbox({ subject: "shared-inbox@org.example" });
    await labels(connector, context());
    expect(decodeSegment(tokenCalls[0]!.assertion.split(".")[1]!).sub).toBe("shared-inbox@org.example");
  });

  it("fails closed with no admitted caller, before any network call", async () => {
    await expect(labels(mailbox(), context())).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("no admitted caller"),
    });
    expect(tokenCalls).toEqual([]);
    expect(apiCalls).toEqual([]);
  });

  it("fails closed when the mapping has no account for this caller", async () => {
    await expect(labels(mailbox(), context(identity("mallory")))).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("no Google Workspace account mapped"),
    });
    expect(tokenCalls).toEqual([]);
    expect(apiCalls).toEqual([]);
  });

  it("refuses a mapping that throws or answers something that is not an address", async () => {
    const thrower = mailbox({
      subject: () => {
        throw new Error("directory down: secret-detail");
      },
    });
    const failure = await labels(thrower, context(identity("alice"))).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed" });
    expect(failure.message).not.toContain("secret-detail");
    await expect(
      labels(mailbox({ subject: () => "not an address" }), context(identity("alice"))),
    ).rejects.toMatchObject({ code: "connector_call_failed" });
    expect(tokenCalls).toEqual([]);
  });

  it("cannot be chosen by an argument", async () => {
    // Every schema is closed, so a subject- or user-shaped argument is refused
    // locally rather than reaching anything that might read it.
    for (const args of [{ subject: "ceo@org.example" }, { userId: "ceo@org.example" }]) {
      await expect(labels(mailbox(), context(identity("alice")), args)).rejects.toMatchObject({
        code: "invalid_args",
      });
    }
    // An id cannot climb out of users/me either.
    await expect(
      mailbox().callTool("get_thread", { threadId: "../../ceo@org.example/threads/1" }, context(identity("alice"))),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(tokenCalls).toEqual([]);
    expect(apiCalls).toEqual([]);
  });

  it("reaches only the token's own mailbox", async () => {
    await labels(mailbox(), context(identity("alice")));
    expect(apiCalls[0]!.url).toBe(`${GMAIL_API_BASE_URL}/labels`);
  });
});

describe("over MCP, the subject is the authorization's and nothing else's", () => {
  function users(): InboundAuth {
    return {
      kind: "test-users",
      interactiveOperator: true,
      activityActorNamespace: "https://identity.test",
      authorize(request) {
        const user = /^Bearer (alice|bob)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
        return user
          ? { ok: true, userId: user, subjectId: user }
          : { ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
      },
    };
  }

  it("maps each admitted user to their own mailbox, whatever the request says", async () => {
    const connecta = createTestConnecta({
      connectors: [mailbox()],
      auth: users(),
      logger: silentLogger,
    });
    const call = async (user: "alice" | "bob", args: Record<string, unknown>) => {
      const request = mcpRpc("tools/call", {
        name: "call_tool",
        arguments: { address: "mail.list_labels", args },
      }, { token: user });
      // A header naming someone else's mailbox is just a header.
      request.headers.set("X-Goog-Subject", "ceo@org.example");
      request.headers.set("X-Connecta-Subject", "ceo@org.example");
      return await readJsonRpc(await connecta.fetch(request));
    };

    const alice = await call("alice", {});
    expect(alice.result.isError).toBeFalsy();
    const bob = await call("bob", {});
    expect(bob.result.isError).toBeFalsy();
    const forged = await call("alice", { subject: "ceo@org.example" });
    expect(forged.result.isError).toBe(true);
    expect(JSON.stringify(forged.result)).toContain("invalid_args");

    const subjects = tokenCalls.map((entry) => decodeSegment(entry.assertion.split(".")[1]!).sub);
    expect(subjects).toEqual(["alice@org.example", "bob@org.example"]);
    expect(JSON.stringify(subjects)).not.toContain("ceo");
  });
});

// --- Token cache --------------------------------------------------------------------

describe("the in-memory token cache", () => {
  it("reuses a token until a minute before it expires, then mints anew", async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const connector = mailbox();
    const ctx = () => context(identity("alice"));

    await labels(connector, ctx());
    now += 30 * 60_000;
    await labels(connector, ctx());
    expect(tokenCalls).toHaveLength(1);

    // 3,599 s granted: at 3,538 s it still has more than the minute's margin.
    now = 1_800_000_000_000 + 3_538_000;
    await labels(connector, ctx());
    expect(tokenCalls).toHaveLength(1);

    now = 1_800_000_000_000 + 3_540_000;
    await labels(connector, ctx());
    expect(tokenCalls).toHaveLength(2);
    expect(apiCalls.map((call) => call.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-1",
      "Bearer token-1",
      "Bearer token-2",
    ]);
  });

  it("keys by subject and scope set, and shares across connectors on one account", async () => {
    const owner = account();
    const first = mailbox({}, owner);
    const second = mailbox({}, owner);
    await labels(first, context(identity("alice")));
    await labels(second, context(identity("alice")));
    expect(tokenCalls).toHaveLength(1);
    await labels(second, context(identity("bob")));
    expect(tokenCalls).toHaveLength(2);
  });

  it("sends concurrent callers through one mint", async () => {
    const held = deferred();
    tokenReplies.push(held.reply);
    const connector = mailbox();
    const pending = [1, 2, 3].map(() => labels(connector, context(identity("alice"))));
    await vi.waitFor(() => expect(tokenCalls).toHaveLength(1));
    held.release(tokenResponse("shared"));
    await Promise.all(pending);
    expect(tokenCalls).toHaveLength(1);
    expect(apiCalls.map((call) => call.authorization)).toEqual([
      "Bearer shared",
      "Bearer shared",
      "Bearer shared",
    ]);
  });

  it("does not hand an owner's cancellation to a caller still waiting", async () => {
    const first = deferred();
    tokenReplies.push(first.reply);
    const connector = mailbox();
    const owner = new AbortController();
    const owning = labels(connector, context(identity("alice"), owner.signal));
    await vi.waitFor(() => expect(tokenCalls).toHaveLength(1));
    const joining = labels(connector, context(identity("alice")));
    owner.abort(new Error("owner left"));
    await expect(owning).rejects.toBeDefined();
    await joining;
    // The joiner asked Google itself rather than inheriting the abort.
    expect(tokenCalls).toHaveLength(2);
    expect(apiCalls.map((call) => call.authorization)).toEqual(["Bearer token-2"]);
  });

  it("shares a refusal from Google with everyone waiting on it", async () => {
    const held = deferred();
    tokenReplies.push(held.reply);
    const connector = mailbox();
    const pending = [1, 2].map(() =>
      labels(connector, context(identity("alice"))).catch((error) => error),
    );
    await vi.waitFor(() => expect(tokenCalls).toHaveLength(1));
    held.release(Response.json({ error: "unauthorized_client" }, { status: 401 }));
    const failures = await Promise.all(pending);
    expect(failures.map((error) => error.code)).toEqual(["auth_required", "auth_required"]);
    expect(tokenCalls).toHaveLength(1);
  });

  it("stays bounded, dropping the oldest token first", async () => {
    const connector = mailbox({ subject: (who: AuthenticatedIdentity) => `${who.principal?.id}@org.example` });
    await labels(connector, context(identity("first")));
    for (let index = 0; index < 512; index += 1) {
      await labels(connector, context(identity(`user${index}`)));
    }
    expect(tokenCalls).toHaveLength(513);
    await labels(connector, context(identity("user511")));
    expect(tokenCalls).toHaveLength(513);
    await labels(connector, context(identity("first")));
    expect(tokenCalls).toHaveLength(514);
  });

  it("forgets a token the API rejects and replays once with a fresh one", async () => {
    apiReplies.push(() => Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 }));
    const connector = mailbox();
    await labels(connector, context(identity("alice")));
    expect(tokenCalls).toHaveLength(2);
    expect(apiCalls.map((call) => call.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("answers auth_required when the fresh token is rejected too", async () => {
    const rejected = () => Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 });
    apiReplies.push(rejected, rejected);
    await expect(labels(mailbox(), context(identity("alice")))).rejects.toMatchObject({
      code: "auth_required",
    });
    expect(apiCalls).toHaveLength(2);
  });
});

// --- Failures -----------------------------------------------------------------------

describe("token refusals map to what fixes them, and never carry a secret", () => {
  async function refusedWith(status: number, body: unknown, headers: Record<string, string> = {}) {
    tokenReplies.push(() => Response.json(body, { status, headers }));
    const owner = account();
    const failure = await labels(mailbox({}, owner), context(identity("alice"))).catch((error) => error);
    expect(failure).toBeInstanceOf(ConnectorCallError);
    expect(failure.message).not.toContain("PRIVATE KEY");
    expect(failure.message).not.toContain(tokenCalls[0]!.assertion.split(".")[2]!.slice(0, 16));
    expect(apiCalls).toEqual([]);
    return { failure, owner };
  }

  it("names the client ID and exact scopes when delegation is not granted", async () => {
    const { failure, owner } = await refusedWith(401, {
      error: "unauthorized_client",
      error_description: "Client is unauthorized to retrieve access tokens using this method.",
    });
    expect(failure.code).toBe("auth_required");
    expect(failure.message).toContain(owner.clientId);
    expect(failure.message).toContain(GMAIL_SCOPES.join(","));
    expect(failure.message).toContain("Manage Domain Wide Delegation");
    expect(failure.message).toContain("24 hours");
  });

  it("explains invalid_grant: unknown or suspended user, deleted key, or clock skew", async () => {
    const { failure } = await refusedWith(400, {
      error: "invalid_grant",
      error_description: "Invalid email or User ID",
    });
    expect(failure.code).toBe("auth_required");
    expect(failure.message).toContain("Invalid email or User ID");
    expect(failure.message).toMatch(/suspended/);
    expect(failure.message).toMatch(/clock/);
  });

  it("reports a disabled service account", async () => {
    const { failure } = await refusedWith(401, { error: "invalid_client" });
    expect(failure.code).toBe("auth_required");
  });

  it("passes on Google's wait and its outages as retryable", async () => {
    const limited = await refusedWith(429, { error: "rate_limit_exceeded" }, { "Retry-After": "7" });
    expect(limited.failure).toMatchObject({ code: "rate_limited", retryAfterMs: 7000 });
    const down = await refusedWith(503, {});
    expect(down.failure).toMatchObject({ code: "unavailable", retryable: true });
  });

  it("refuses a success that carries no token", async () => {
    const { failure } = await refusedWith(200, { token_type: "Bearer" });
    expect(failure.code).toBe("connector_call_failed");
  });
});

describe("API refusals map by Google's reason codes", () => {
  async function apiFailure(status: number, error: Record<string, unknown>) {
    apiReplies.push(() => Response.json({ error: { code: status, ...error } }, { status }));
    return await labels(mailbox(), context(identity("alice"))).catch((failure) => failure);
  }

  it("names the exact scopes when the token lacks one", async () => {
    const failure = await apiFailure(403, {
      message: "Request had insufficient authentication scopes.",
      status: "PERMISSION_DENIED",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
    });
    expect(failure.code).toBe("auth_required");
    expect(failure.message).toContain(GMAIL_SCOPES.join(","));
  });

  it("says to enable the API when the project has not", async () => {
    const failure = await apiFailure(403, {
      message: "Gmail API has not been used in project 1 before or it is disabled.",
      errors: [{ reason: "accessNotConfigured" }],
    });
    expect(failure.code).toBe("connector_call_failed");
    expect(failure.message).toContain("Gmail API is not enabled");
  });

  it("maps quota exhaustion to rate_limited", async () => {
    const failure = await apiFailure(403, {
      message: "User-rate limit exceeded.",
      errors: [{ reason: "userRateLimitExceeded" }],
    });
    expect(failure.code).toBe("rate_limited");
  });

  it("maps a user without Gmail to a failed precondition", async () => {
    const failure = await apiFailure(400, {
      message: "Mail service not enabled",
      errors: [{ reason: "failedPrecondition" }],
    });
    expect(failure.code).toBe("connector_call_failed");
  });

  it("maps a bad argument to invalid_args and an outage to unavailable", async () => {
    expect((await apiFailure(400, { message: "Invalid query" })).code).toBe("invalid_args");
    expect((await apiFailure(500, { message: "Backend Error" })).code).toBe("unavailable");
  });
});
