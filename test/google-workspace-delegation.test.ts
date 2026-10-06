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
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bearerToken } from "../src/auth/bearer.js";
import { attachCaller } from "../src/connector-caller.js";
import {
  googleReasonsOf,
  googleWorkspaceClient,
  workspaceConnection,
} from "../src/providers/google/workspace.js";
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
const DER_BASE64 = PRIVATE_KEY.replace(/-----[A-Z ]+-----|\s/g, "");

/** A second, distinct RSA key, for rotation under one client email. */
const ROTATED_KEY = pem(
  (await crypto.subtle.exportKey(
    "pkcs8",
    ((await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair).privateKey,
  )) as ArrayBuffer,
);

const EC_PRIVATE_KEY = pem(
  (await crypto.subtle.exportKey(
    "pkcs8",
    ((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair)
      .privateKey,
  )) as ArrayBuffer,
);

const RSA_OID = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

function indexOf(der: Uint8Array, needle: readonly number[]): number {
  for (let at = 0; at + needle.length <= der.length; at += 1) {
    if (needle.every((byte, offset) => der[at + offset] === byte)) return at;
  }
  throw new Error("pattern not found in the fixture key");
}

/** Where the NULL parameters' tag sits, right after the rsaEncryption OID. */
function afterOid(der: Uint8Array): number {
  return indexOf(der, RSA_OID) + RSA_OID.length;
}

/** The RSAPrivateKey's own version byte: OCTET STRING, SEQUENCE, INTEGER 0. */
function rsaVersionAt(der: Uint8Array): number {
  const nullAt = afterOid(der);
  // 05 00 | 04 82 hh ll | 30 82 hh ll | 02 01 00
  return nullAt + 2 + 4 + 4 + 2;
}

/** The fixture key with its DER changed in place, plus any appended bytes. */
function mutated(change: (der: Uint8Array) => void, append: number[] = []): string {
  const der = Uint8Array.from(atob(DER_BASE64), (character) => character.charCodeAt(0));
  change(der);
  return armor(String.fromCharCode(...der, ...append));
}

/** Arbitrary binary in PEM armor. */
function armor(binary: string): string {
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
}

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

function context(
  caller?: AuthenticatedIdentity,
  signal?: AbortSignal,
  authenticated = true,
): ConnectorContext {
  const ctx: ConnectorContext = {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    ...(signal ? { signal } : {}),
  };
  return caller ? attachCaller(ctx, { identity: caller, authenticated }) : ctx;
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
  accept: string | null;
  body: unknown;
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
      accept: new Headers(init.headers).get("accept"),
      body: init.body instanceof Uint8Array ? [...init.body] : init.body,
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
    [
      "a PEM that only opens like PKCS#8",
      { serviceAccount: { clientEmail: "a@b.c", privateKey: armor(`0${"k".repeat(95)}`) } },
      /PKCS#8 RSA/,
    ],
    [
      "a truncated key",
      { serviceAccount: { clientEmail: "a@b.c", privateKey: armor(atob(DER_BASE64).slice(0, 600)) } },
      /PKCS#8 RSA/,
    ],
    [
      "a well-formed key of another algorithm",
      { serviceAccount: { clientEmail: "a@b.c", privateKey: EC_PRIVATE_KEY } },
      /PKCS#8 RSA/,
    ],
    [
      "rsaEncryption parameters that are not NULL",
      { serviceAccount: { clientEmail: "a@b.c", privateKey: mutated((der) => { der[afterOid(der)] = 0xff; }) } },
      /PKCS#8 RSA/,
    ],
    [
      "bytes after the key that are not attributes",
      {
        serviceAccount: {
          clientEmail: "a@b.c",
          privateKey: mutated((der) => {
            // Grow the outer SEQUENCE by two and put a NULL after the key.
            const length = (der[2]! << 8) + der[3]! + 2;
            der[2] = length >> 8;
            der[3] = length & 0xff;
          }, [0x05, 0x00]),
        },
      },
      /PKCS#8 RSA/,
    ],
    [
      "a multi-prime RSAPrivateKey version with no other primes",
      { serviceAccount: { clientEmail: "a@b.c", privateKey: mutated((der) => { der[rsaVersionAt(der)] = 0x01; }) } },
      /PKCS#8 RSA/,
    ],
    ["no subject", { subject: undefined }, /subject/],
    ["a fixed subject that is not an address", { subject: "alice" }, /email address/],
  ])("%s", (_name, overrides, message) => {
    expect(build(overrides)).toThrow(message);
  });

  it("accepts a real RSA key, whose layout the mutations above target", () => {
    expect(build({})).not.toThrow();
    // The mutations change exactly the byte they mean to, so each refusal is
    // about that byte and not an accident of a misplaced offset.
    const der = Uint8Array.from(atob(DER_BASE64), (character) => character.charCodeAt(0));
    expect([der[afterOid(der)], der[afterOid(der) + 1]]).toEqual([0x05, 0x00]);
    const version = rsaVersionAt(der);
    expect([der[version - 2], der[version - 1], der[version]]).toEqual([0x02, 0x01, 0x00]);
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

  it("never asks the mapping about an unauthenticated caller", async () => {
    // An open deployment admits everyone as the anonymous actor; a mapping
    // that answers for anyone must still never be consulted for them.
    const mapping = vi.fn(() => "alice@org.example");
    const failure = await labels(
      mailbox({ subject: mapping }),
      context({ actor: { kind: "anonymous" }, interactive: false }, undefined, false),
    ).catch((error) => error);
    expect(failure).toMatchObject({ code: "auth_required", message: expect.stringContaining("without authentication") });
    expect(mapping).not.toHaveBeenCalled();
    expect(tokenCalls).toEqual([]);
    // A fixed subject is the deployment's explicit choice and still works.
    await labels(
      mailbox({ subject: "shared-inbox@org.example" }),
      context({ actor: { kind: "anonymous" }, interactive: false }, undefined, false),
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it("hands an async mapping the call's signal, once per call", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const connector = mailbox({
      subject: async (_who: AuthenticatedIdentity, { signal }: { signal?: AbortSignal }) => {
        seen.push(signal);
        return "alice@org.example";
      },
    });
    apiReplies.push(
      () => Response.json({ threads: [{ id: "t1" }, { id: "t2" }] }),
      () => Response.json({ id: "t1", messages: [] }),
      () => Response.json({ id: "t2", messages: [] }),
    );
    await connector.callTool("search_threads", {}, context(identity("alice"), controller.signal));
    expect(apiCalls).toHaveLength(3);
    expect(seen).toEqual([controller.signal]);
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

  const labelsOver = async (connecta: { fetch(request: Request): Promise<Response> }, token?: string) =>
    readJsonRpc(
      await connecta.fetch(
        mcpRpc("tools/call", { name: "call_tool", arguments: { address: "mail.list_labels", args: {} } }, token ? { token } : {}),
      ),
    );

  it("refuses an open deployment's anonymous requests before the mapping runs", async () => {
    const mapping = vi.fn(() => "alice@org.example");
    const connecta = createTestConnecta({ connectors: [mailbox({ subject: mapping })], logger: silentLogger });
    const result = await labelsOver(connecta);
    expect(result.result.isError).toBe(true);
    expect(JSON.stringify(result.result)).toContain("auth_required");
    expect(mapping).not.toHaveBeenCalled();
    expect(tokenCalls).toEqual([]);
    expect(apiCalls).toEqual([]);
  });

  it("counts a bearer without a person behind it as authenticated", async () => {
    const mapping = vi.fn((who: AuthenticatedIdentity) => (who.actor.kind === "bearer" ? "robot@org.example" : undefined));
    const connecta = createTestConnecta({
      connectors: [mailbox({ subject: mapping })],
      auth: bearerToken("service-secret"),
      logger: silentLogger,
    });
    const result = await labelsOver(connecta, "service-secret");
    expect(result.result.isError).toBeFalsy();
    expect(mapping).toHaveBeenCalledTimes(1);
    expect(decodeSegment(tokenCalls[0]!.assertion.split(".")[1]!).sub).toBe("robot@org.example");
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

  it("lets a follower in another request mint again, never reading the owner's signal", async () => {
    // On workerd an AbortSignal belongs to the request that made it, and
    // reading it from another throws. Each "request" here runs in its own
    // async context, and the owner's signal throws the same way when read
    // from anywhere else — so a follower that so much as checks whether the
    // owner was cancelled fails this test.
    const requests = new AsyncLocalStorage<string>();
    const owner = new AbortController();
    const ownersSignal = new Proxy(owner.signal, {
      get(target, key) {
        if ((key === "aborted" || key === "reason") && requests.getStore() !== "owner") {
          throw new Error("Cannot perform I/O on behalf of a different request.");
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    tokenReplies.push(deferred().reply);
    const connector = mailbox();
    const owning = requests.run("owner", () => labels(connector, context(identity("alice"), ownersSignal)));
    await vi.waitFor(() => expect(tokenCalls).toHaveLength(1));
    const following = requests.run("follower", () => labels(connector, context(identity("alice"))));
    requests.run("owner", () => owner.abort(new Error("owner left")));
    // The owner failed for its own reason; reading its own signal was fine.
    const ownerFailure = await owning.catch((error) => error);
    expect(ownerFailure.cause?.message ?? ownerFailure.message).toBe("owner left");
    await following;
    // The follower heard "abandoned" and asked Google itself.
    expect(tokenCalls).toHaveLength(2);
    expect(apiCalls.map((call) => call.authorization)).toEqual(["Bearer token-2"]);
  });

  it("stops waiting on another caller's mint at its deadline", async () => {
    tokenReplies.push(deferred().reply);
    const connector = mailbox();
    const short = context(identity("alice"));
    short.timeoutMs = 50;
    // The owner's request hangs and never settles its flight.
    void labels(connector, short).catch(() => undefined);
    await vi.waitFor(() => expect(tokenCalls).toHaveLength(1));
    await labels(connector, context(identity("alice")));
    expect(tokenCalls).toHaveLength(2);
  });

  it("forgets only the token a late 401 rejected, never a newer one", async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const late = deferred();
    apiReplies.push(late.reply);
    const connector = mailbox();
    const first = labels(connector, context(identity("alice")));
    await vi.waitFor(() => expect(apiCalls).toHaveLength(1));
    // token-1 nears expiry while that request is out; the next call renews.
    now += 3_545_000;
    await labels(connector, context(identity("alice")));
    late.release(Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 }));
    await first;
    // The 401 named token-1, which was already replaced: token-2 survives and
    // carries the replay, and nothing mints a third.
    expect(apiCalls.map((call) => call.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-2",
      "Bearer token-2",
    ]);
    await labels(connector, context(identity("alice")));
    expect(tokenCalls).toHaveLength(2);
  });

  it("keys the cache by the key itself, so a rotated key never reuses a token", async () => {
    const owner = account();
    await labels(mailbox({}, owner), context(identity("alice")));
    await labels(mailbox({}, { ...owner, privateKey: ROTATED_KEY }), context(identity("alice")));
    expect(tokenCalls).toHaveLength(2);
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

  it("reports a refused precondition neutrally, with Google's own words for which", async () => {
    // The same reason means a user without Gmail and a stale write elsewhere,
    // so the classification asserts neither; Google's message says which.
    const failure = await apiFailure(400, {
      message: "Mail service not enabled",
      status: "FAILED_PRECONDITION",
      errors: [{ reason: "failedPrecondition" }],
    });
    expect(failure.code).toBe("connector_call_failed");
    expect(failure.message).toContain("Mail service not enabled");
    expect(failure.message).toContain("Google refused the request's precondition");
    expect(failure.message).not.toMatch(/disabled/);
  });

  it("names a disabled API by Google's reason, whatever status carries it", async () => {
    const failure = await apiFailure(400, {
      message: "Gmail API has not been used in project 1 before or it is disabled.",
      status: "FAILED_PRECONDITION",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }],
    });
    expect(failure.code).toBe("connector_call_failed");
    expect(failure.message).toContain("Gmail API is not enabled");
  });

  it.each([
    ["exportSizeLimitExceeded", "larger than Google will export"],
    ["domainPolicy", "domain policy forbids"],
    ["insufficientFilePermissions", "does not have the permission on this item"],
    ["forbidden", "does not have the permission on this item"],
  ])("names a 403 %s precisely", async (reason, words) => {
    const failure = await apiFailure(403, {
      message: "The caller does not have permission",
      status: "PERMISSION_DENIED",
      errors: [{ reason, domain: "global" }],
    });
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain(words);
    expect(googleReasonsOf(failure)).toEqual([reason, "PERMISSION_DENIED"]);
  });

  it("maps either rate-limit reason to rate_limited, whatever the status", async () => {
    for (const reason of ["rateLimitExceeded", "userRateLimitExceeded"]) {
      const failure = await apiFailure(403, { message: "Rate Limit Exceeded", errors: [{ reason }] });
      expect(failure.code).toBe("rate_limited");
      expect(googleReasonsOf(failure)).toEqual([reason]);
    }
  });

  it("exposes Google's reasons sanitized and bounded, never its words", async () => {
    const failure = await apiFailure(403, {
      message: "secret-bearing prose about file Q3-payroll.xlsx",
      status: "PERMISSION_DENIED",
      errors: [
        { reason: "cannotDownloadAbusiveFile", message: "prose" },
        { reason: "has spaces; and punctuation" },
        { reason: "x".repeat(65) },
        { reason: 42 },
        ...Array.from({ length: 10 }, (_, index) => ({ reason: `extra${index}` })),
      ],
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "cannotDownloadAbusiveFile" }],
    });
    const reasons = googleReasonsOf(failure);
    expect(reasons).toEqual([
      "cannotDownloadAbusiveFile",
      "extra0",
      "extra1",
      "extra2",
      "extra3",
      "extra4",
      "extra5",
      "extra6",
    ]);
    expect(Object.isFrozen(reasons)).toBe(true);
    expect(JSON.stringify(reasons)).not.toContain("payroll");
  });

  it("has no reasons for a failure that never reached Google, or for anything else", async () => {
    const unadmitted = await labels(mailbox(), context()).catch((error) => error);
    expect(unadmitted.code).toBe("auth_required");
    expect(googleReasonsOf(unadmitted)).toEqual([]);
    expect(googleReasonsOf(new Error("plain"))).toEqual([]);
    expect(googleReasonsOf(undefined)).toEqual([]);
  });

  it("maps a bad argument to invalid_args and an outage to unavailable", async () => {
    expect((await apiFailure(400, { message: "Invalid query" })).code).toBe("invalid_args");
    expect((await apiFailure(500, { message: "Backend Error" })).code).toBe("unavailable");
  });
});

// --- Non-JSON requests ----------------------------------------------------------------

describe("the shared client reads bytes and text for the products that need them", () => {
  // Drive's download and export are the first users; the client is built
  // here exactly as a product provider builds it.
  function client(maxResponseBytes = 1024) {
    return googleWorkspaceClient({
      provider: "Google Drive",
      api: "Google Drive API",
      baseUrl: "https://www.googleapis.com/drive/v3",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      maxResponseBytes,
      notFound: "ambiguous",
      connection: workspaceConnection("drive", {
        purpose: "Shared files",
        serviceAccount: account(),
        subject: "alice@org.example",
      }),
    });
  }

  it("returns bytes with their content type, under the delegated token", async () => {
    apiReplies.push(() => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "Content-Type": "application/pdf" } }));
    const result = await client().bytes(
      { method: "GET", path: "/files/f1", query: { alt: "media" } },
      context(),
      "application/pdf",
    );
    expect([...result.bytes]).toEqual([37, 80, 68, 70]);
    expect(result.contentType).toBe("application/pdf");
    expect(apiCalls[0]).toMatchObject({
      url: "https://www.googleapis.com/drive/v3/files/f1?alt=media",
      authorization: "Bearer token-1",
      accept: "application/pdf",
    });
  });

  it("decodes text in the charset the response declares", async () => {
    apiReplies.push(
      () => new Response(new Uint8Array([67, 97, 102, 0xe9]), { headers: { "Content-Type": "text/plain; charset=iso-8859-1" } }),
    );
    const result = await client().text({ method: "GET", path: "/files/f1/export", query: { mimeType: "text/plain" } }, context());
    expect(result).toEqual({ text: "Café", contentType: "text/plain; charset=iso-8859-1" });
  });

  it("bounds the body by the product's ceiling", async () => {
    apiReplies.push(() => new Response(new Uint8Array(2048)));
    await expect(client(1024).bytes({ method: "GET", path: "/files/f1" }, context())).rejects.toMatchObject({
      code: "connector_call_failed",
      message: expect.stringContaining("1024-byte"),
    });
  });

  describe("a revision-guarded write", () => {
    const stale = (status: number, reason: string) => () =>
      Response.json(
        { error: { code: status, message: "The required revision ID 'r1' does not match the latest revision.", status: reason } },
        { status },
      );
    const write = { method: "POST" as const, path: "/documents/d1:batchUpdate", body: { requests: [] } };

    it.each([
      [400, "FAILED_PRECONDITION"],
      [409, "ABORTED"],
      [400, "ABORTED"],
      [409, "FAILED_PRECONDITION"],
    ])("maps HTTP %i %s to conflict with fixed words", async (status, reason) => {
      apiReplies.push(stale(status, reason));
      const failure = await client()
        .json(write, context(), { revisionGuarded: true })
        .catch((error) => error);
      expect(failure).toBeInstanceOf(ConnectorCallError);
      expect(failure).toMatchObject({
        code: "conflict",
        retryable: false,
        message:
          "Google Drive refused the write because the item changed after the revision it named. Re-read it for the current revision, reapply the change, and retry.",
      });
    });

    it("applies to bytes and text requests too", async () => {
      apiReplies.push(stale(400, "FAILED_PRECONDITION"), stale(409, "ABORTED"));
      const drive = client();
      await expect(drive.bytes(write, context(), undefined, { revisionGuarded: true })).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(drive.text(write, context(), "text/plain", { revisionGuarded: true })).rejects.toMatchObject({
        code: "conflict",
      });
    });

    it("leaves an unflagged request exactly as before", async () => {
      apiReplies.push(stale(400, "FAILED_PRECONDITION"), stale(409, "ABORTED"));
      const drive = client();
      await expect(drive.json(write, context())).rejects.toMatchObject({ code: "connector_call_failed" });
      await expect(drive.json(write, context(), {})).rejects.toMatchObject({ code: "connector_call_failed" });
    });

    it("does not turn an unrelated refusal into a conflict", async () => {
      apiReplies.push(() =>
        Response.json({ error: { code: 400, message: "Invalid requests[0]", status: "INVALID_ARGUMENT" } }, { status: 400 }),
      );
      await expect(client().json(write, context(), { revisionGuarded: true })).rejects.toMatchObject({
        code: "invalid_args",
      });
    });
  });

  it("replays a byte body intact after a 401", async () => {
    apiReplies.push(
      () => Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 }),
      () => Response.json({ id: "f9" }),
    );
    const upload = new Uint8Array([1, 2, 3, 4]);
    await client().json(
      {
        method: "POST",
        path: "/files",
        headers: { "Content-Type": "application/octet-stream" },
        rawBody: upload,
      },
      context(),
    );
    expect(apiCalls.map((call) => call.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(apiCalls.map((call) => call.body)).toEqual([[1, 2, 3, 4], [1, 2, 3, 4]]);
  });

  it("refuses a stream body, which a replay could not resend, before anything leaves", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    await expect(
      client().json({ method: "POST", path: "/files", rawBody: stream }, context()),
    ).rejects.toThrow(/replayable/);
    expect(tokenCalls).toEqual([]);
    expect(apiCalls).toEqual([]);
  });

  it("maps Google's error body and replays a 401 like the JSON path", async () => {
    apiReplies.push(
      () => Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 }),
      () => new Response("ok", { headers: { "Content-Type": "text/plain" } }),
      () => Response.json({ error: { code: 404, message: "File not found: f2." } }, { status: 404 }),
    );
    const drive = client();
    expect((await drive.text({ method: "GET", path: "/files/f1" }, context())).text).toBe("ok");
    expect(tokenCalls).toHaveLength(2);
    // Drive's 404 can hide a permission gap, so it is not `not_found`.
    await expect(drive.bytes({ method: "GET", path: "/files/f2" }, context())).rejects.toMatchObject({
      code: "connector_call_failed",
    });
  });
});
