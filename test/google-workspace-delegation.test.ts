import { NODE, WORKERS } from "./fixtures/runtime-tags.js";
import { docs } from "../src/providers/docs/index.js";
import { drive } from "../src/providers/drive/index.js";
import { forms } from "../src/providers/forms/index.js";
import { sheets } from "../src/providers/sheets/index.js";
import { slides } from "../src/providers/slides/index.js";
// Google Workspace domain-wide delegation, the layer every Workspace product
// provider shares (src/providers/_shared/google/). Driven through gmail() because the
// layer has no export of its own; the Gmail suite owns the tool surface.
//
// What this pins: the RS256 JWT-bearer assertion (header, claims, and a
// signature that verifies against the key's public half, signed with Web
// Crypto in whichever runtime runs this suite), the in-memory token cache and
// its refresh and dedupe, and the one rule INV-3 exists for — the
// subject comes from deployment config applied to the admitted identity, and
// from nothing a call, a header, or a program sends (#678).
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { machineAuth } from "./helpers/machine-auth.js";
import { attachCaller } from "../src/connector-caller.js";
import { attachCallClassification } from "../src/call-classification.js";
import {
  googleOutcomeOf,
  googleWorkspaceClient,
  workspaceConnection,
} from "../src/providers/_shared/google/workspace.js";
import { classifyCallError, ConnectorCallError } from "../src/errors.js";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { isKnownProviderFailure } from "../src/provider-call.js";
import { errors as gmailErrors } from "../src/providers/gmail/api.js";
import { GMAIL_SCOPES, gmail } from "../src/providers/gmail/index.js";
import { classifyWriteOutcome } from "../src/write-outcome.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { AuthenticatedIdentity, Connector, ConnectorContext, InboundAuth } from "../src/types.js";
import { createMetaTools } from "../src/meta-tools.js";
import { activitySink, createTestConnecta, makeRegistry, silentLogger } from "./helpers.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { scriptedExecutor } from "./fixtures/misc.js";
import { issueAgentToken } from "./helpers/agent-tokens.js";
import { accessTokens } from "../src/access-tokens.js";

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
  const body = btoa(binary)
    .match(/.{1,64}/g)!
    .join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

const PRIVATE_KEY = pem((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
const DER_BASE64 = PRIVATE_KEY.replace(/-----[A-Z ]+-----|\s/g, "");

/** A second, distinct RSA key, for rotation under one client email. */
const ROTATED_KEY = pem(
  (await crypto.subtle.exportKey(
    "pkcs8",
    (
      (await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair
    ).privateKey,
  )) as ArrayBuffer,
);

const EC_PRIVATE_KEY = pem(
  (await crypto.subtle.exportKey(
    "pkcs8",
    (
      (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair
    ).privateKey,
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

function context(caller?: AuthenticatedIdentity, signal?: AbortSignal, authenticated = true): ConnectorContext {
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

function mailbox(overrides: Record<string, unknown> = {}, serviceAccount: unknown = account()): Connector {
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
  it("is RS256 with the delegation claims, and verifies against the key", WORKERS, async () => {
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

  it("accepts the downloaded JSON key text, escaped newlines included", NODE, async () => {
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
    [
      "a user credential file",
      { serviceAccount: JSON.stringify({ type: "authorized_user" }) },
      /not a service_account/,
    ],
    ["no client email", { serviceAccount: { privateKey: PRIVATE_KEY } }, /clientEmail/],
    ["no private key", { serviceAccount: { clientEmail: "a@b.iam.gserviceaccount.com" } }, /privateKey/],
    [
      "a PKCS#1 key",
      {
        serviceAccount: {
          clientEmail: "a@b.c",
          privateKey: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----",
        },
      },
      /PKCS#1/,
    ],
    [
      "a key that is not PKCS#8",
      {
        serviceAccount: {
          clientEmail: "a@b.c",
          privateKey: `-----BEGIN PRIVATE KEY-----\n${btoa("x".repeat(100))}\n-----END PRIVATE KEY-----`,
        },
      },
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
      {
        serviceAccount: {
          clientEmail: "a@b.c",
          privateKey: mutated((der) => {
            der[afterOid(der)] = 0xff;
          }),
        },
      },
      /PKCS#8 RSA/,
    ],
    [
      "bytes after the key that are not attributes",
      {
        serviceAccount: {
          clientEmail: "a@b.c",
          privateKey: mutated(
            (der) => {
              // Grow the outer SEQUENCE by two and put a NULL after the key.
              const length = (der[2]! << 8) + der[3]! + 2;
              der[2] = length >> 8;
              der[3] = length & 0xff;
            },
            [0x05, 0x00],
          ),
        },
      },
      /PKCS#8 RSA/,
    ],
    [
      "a multi-prime RSAPrivateKey version with no other primes",
      {
        serviceAccount: {
          clientEmail: "a@b.c",
          privateKey: mutated((der) => {
            der[rsaVersionAt(der)] = 0x01;
          }),
        },
      },
      /PKCS#8 RSA/,
    ],
    ["no subject", { subject: undefined }, /subject/],
    ["a fixed subject that is not an address", { subject: "alice" }, /email address/],
  ])("%s", WORKERS, (_name, overrides, message) => {
    expect(build(overrides)).toThrow(message);
  });

  it("never puts the key in a construction error", NODE, () => {
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
  it("fails closed with no admitted caller, before any network call", NODE, async () => {
    await expect(labels(mailbox(), context())).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("no admitted caller"),
    });
    expect(tokenCalls).toEqual([]);
    expect(apiCalls).toEqual([]);
  });

  it("never asks the mapping about an unauthenticated caller", NODE, async () => {
    // An open deployment admits everyone as the anonymous actor; a mapping
    // that answers for anyone must still never be consulted for them.
    const mapping = vi.fn(() => "alice@org.example");
    const failure = await labels(
      mailbox({ subject: mapping }),
      context({ actor: { kind: "anonymous" }, interactive: false }, undefined, false),
    ).catch((error) => error);
    expect(failure).toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("without authentication"),
    });
    expect(mapping).not.toHaveBeenCalled();
    expect(tokenCalls).toEqual([]);
    // A fixed subject is the deployment's explicit choice and still works.
    await labels(
      mailbox({ subject: "shared-inbox@org.example" }),
      context({ actor: { kind: "anonymous" }, interactive: false }, undefined, false),
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it("INV-7: hands an async mapping the revocable call signal, once per call", WORKERS, async () => {
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
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(controller.signal);
    expect(seen[0]?.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  });

  it("fails closed when the mapping has no account for this caller", NODE, async () => {
    await expect(labels(mailbox(), context(identity("mallory")))).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("no Google Workspace account mapped"),
    });
    expect(tokenCalls).toEqual([]);
    expect(apiCalls).toEqual([]);
  });

  it("refuses a mapping that throws or answers something that is not an address", NODE, async () => {
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

  it("INV-3: cannot be chosen by an argument", NODE, async () => {
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

  it("maps each admitted user to their own mailbox, whatever the request says", NODE, async () => {
    const connecta = createTestConnecta({
      connectors: [mailbox()],
      auth: users(),
      maintainers: ["alice", "bob"],
      logger: silentLogger,
    });
    const call = async (user: "alice" | "bob", args: Record<string, unknown>) => {
      const request = mcpRpc(
        "tools/call",
        {
          name: "call_tool",
          arguments: { address: "mail.list_labels", args },
        },
        { token: user },
      );
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
        mcpRpc(
          "tools/call",
          { name: "call_tool", arguments: { address: "mail.list_labels", args: {} } },
          token ? { token } : {},
        ),
      ),
    );

  it("counts a machine token without a person behind it as authenticated", NODE, async () => {
    const mapping = vi.fn((who: AuthenticatedIdentity) =>
      who.actor.kind === "access_token" ? "robot@org.example" : undefined,
    );
    const connecta = createTestConnecta({
      connectors: [mailbox({ subject: mapping })],
      auth: machineAuth("service-secret"),
      logger: silentLogger,
    });
    const result = await labelsOver(connecta, "service-secret");
    expect(result.result.isError).toBeFalsy();
    expect(mapping).toHaveBeenCalledTimes(1);
    expect(decodeSegment(tokenCalls[0]!.assertion.split(".")[1]!).sub).toBe("robot@org.example");
  });
});

// --- Pool owners --------------------------------------------------------------------

describe("pool owners: agents act as the pool's owner, humans as themselves (decisions/0006)", () => {
  const agent = (name: string): AuthenticatedIdentity => ({
    actor: { kind: "access_token", id: `agent:${name}` },
    subject: { namespace: "connecta:agent", id: name },
    agent: name,
    interactive: false,
  });
  const inPool = (who: AuthenticatedIdentity, pool?: string, poolOwner?: string): ConnectorContext =>
    attachCaller(
      { storage: memoryStorage(), logger: silentLogger, baseUrl: "https://connecta.example" },
      { identity: who, authenticated: true, ...(pool ? { pool } : {}), ...(poolOwner ? { poolOwner } : {}) },
    );
  const sub = (index = 0) => decodeSegment(tokenCalls[index]!.assertion.split(".")[1]!).sub;

  it(
    "INV-3: an agent in an ownerless pool, or in no pool, fails auth_required before anything leaves",
    NODE,
    async () => {
      const mapping = vi.fn(() => "alice@org.example");
      for (const ctx of [
        inPool(agent("assistant"), "team"),
        inPool(agent("assistant")),
        // An owner without the pool it belongs to is not one core set.
        inPool(agent("assistant"), undefined, "bob@org.example"),
      ]) {
        const failure = await labels(mailbox({ subject: mapping }), ctx).catch((error) => error);
        expect(failure).toBeInstanceOf(ConnectorCallError);
        expect(failure).toMatchObject({ code: "auth_required", message: expect.stringContaining("has no owner") });
        expect(failure.message).not.toContain("@");
      }
      expect(mapping).not.toHaveBeenCalled();
      expect(tokenCalls).toEqual([]);
      expect(apiCalls).toEqual([]);
    },
  );

  it("INV-3: a fixed subject applies to humans and agents alike, and the pool owner is ignored", NODE, async () => {
    const shared = mailbox({ subject: "shared-inbox@org.example" });
    await labels(shared, inPool(identity("alice"), "assistant-bob", "bob@org.example"));
    await labels(shared, inPool(agent("assistant"), "assistant-bob", "bob@org.example"));
    await labels(shared, inPool(agent("assistant"), "team"));
    expect(tokenCalls.map((_, index) => sub(index))).toEqual(["shared-inbox@org.example"]);
    expect(apiCalls).toHaveLength(3);
  });

  describe("over MCP", () => {
    const NAMESPACE = "https://identity.test";
    function people(): InboundAuth {
      return {
        kind: "test-users",
        interactiveOperator: true,
        activityActorNamespace: NAMESPACE,
        authorize(request) {
          const user = /^Bearer (alice|bob)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
          return user
            ? { ok: true, userId: user, subjectId: user }
            : { ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
        },
      };
    }

    // One gmail() serves a pool per person, built in code from the team list.
    const team = [
      { id: "alice", email: "alice@org.example" },
      { id: "bob", email: "bob@org.example" },
    ];

    async function deployment(
      options: { executor?: Parameters<typeof createTestConnecta>[0]["executor"]; extra?: Connector[] } = {},
    ) {
      const storage = memoryStorage();
      const mapping = vi.fn((who: AuthenticatedIdentity) => DIRECTORY[who.principal?.id ?? ""]);
      const connecta = createTestConnecta({
        connectors: [mailbox({ subject: mapping }), ...(options.extra ?? [])],
        auth: people(),
        maintainers: ["alice"],
        agents: ["assistant"],
        accessTokens: accessTokens(storage),
        storage,
        pools: {
          ...Object.fromEntries(
            team.map((person) => [
              `assistant-${person.id}`,
              { tools: ["mail"], owner: person.email, members: [person.id, "agent:assistant"] },
            ]),
          ),
          // Alice assists Bob: Bob owns it, and Alice still acts as herself.
          "assist-bob": { tools: ["mail"], owner: "bob@org.example", members: ["alice"] },
          // A group pool names no owner, so its agents have no mailbox.
          group: {
            tools: ["mail", ...(options.extra ?? []).map((connector) => connector.id)],
            members: ["alice", "bob", "agent:assistant"],
          },
        },
        ...(options.executor ? { executor: options.executor } : {}),
        logger: silentLogger,
      });
      return { connecta, mapping, assistant: await issueAgentToken(storage, "assistant") };
    }

    const callOver = async (
      connecta: { fetch(request: Request): Promise<Response> },
      token: string,
      pool: string,
      args: Record<string, unknown> = {},
      headers: Record<string, string> = {},
    ) => {
      // Agents use /agent/<pool>; people use /mcp/<pool> (#837).
      const request = mcpRpc(
        "tools/call",
        { name: "call_tool", arguments: { address: "mail.list_labels", args } },
        { token, ...(token.startsWith("cta_") ? { agentPool: pool } : { pool }) },
      );
      for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
      return (await readJsonRpc(await connecta.fetch(request))).result;
    };

    it(
      "INV-3: one connector serves per-person pools, and each agent call at /agent/<pool> reaches only its pool owner's mailbox",
      NODE,
      async () => {
        const { connecta, mapping, assistant } = await deployment();
        // The same agent at a human pool endpoint is refused before any delegation.
        const human = await connecta.fetch(
          mcpRpc(
            "tools/call",
            { name: "call_tool", arguments: { address: "mail.list_labels", args: {} } },
            { token: assistant, pool: "assistant-alice" },
          ),
        );
        expect(human.status).toBe(401);
        expect(await human.text()).toContain("host_auth_required");
        expect(tokenCalls).toEqual([]);
        expect((await callOver(connecta, assistant, "assistant-alice")).isError).toBeFalsy();
        expect((await callOver(connecta, assistant, "assistant-bob")).isError).toBeFalsy();
        expect((await callOver(connecta, assistant, "assistant-alice")).isError).toBeFalsy();
        expect(mapping).not.toHaveBeenCalled();
        // The delegated subject in each token request; the third reuses Alice's token.
        expect(tokenCalls.map((_, index) => sub(index))).toEqual(["alice@org.example", "bob@org.example"]);
        expect(apiCalls.map((call) => call.authorization)).toEqual([
          "Bearer token-1",
          "Bearer token-2",
          "Bearer token-1",
        ]);
        await connecta.close();
      },
    );

    it("INV-3: a human in someone else's owned pool still acts as themselves", NODE, async () => {
      const { connecta, mapping } = await deployment();
      expect((await callOver(connecta, "alice", "assist-bob")).isError).toBeFalsy();
      expect(mapping).toHaveBeenCalledTimes(1);
      expect(tokenCalls.map((_, index) => sub(index))).toEqual(["alice@org.example"]);
      await connecta.close();
    });

    it(
      "INV-4: an agent in an ownerless pool does not see a mapping Workspace connector anywhere, and a call fails as for a missing connector",
      NODE,
      async () => {
        // A fixed subject is the shared-account exception and stays visible.
        const shared = gmail("shared_mail", {
          purpose: "Shared inbox",
          serviceAccount: account(),
          subject: "shared-inbox@org.example",
        } as Parameters<typeof gmail>[1]);
        // A kit-built mapping connector carries the same subject tag.
        const formsMapping = vi.fn(() => "alice@org.example");
        const mappedForms = forms("forms", { purpose: "Forms", serviceAccount: account(), subject: formsMapping });
        const code = (error: unknown) => String((error as { code?: string }).code ?? error);
        const { connecta, mapping, assistant } = await deployment({
          extra: [shared, mappedForms],
          executor: scriptedExecutor(async (fns) => ({
            search: ((await fns.search!({ query: "labels" })) as { tools: { address: string }[] }).tools.map(
              (tool) => tool.address,
            ),
            describe: await fns.describe!({ address: "mail.list_labels" }).catch(code),
            describeGhost: await fns.describe!({ address: "ghost.list_labels" }).catch(code),
            call: await fns.call!("mail.list_labels", {}).catch(code),
            callGhost: await fns.call!("ghost.list_labels", {}).catch(code),
          })),
        });
        const rpc = async (
          token: string,
          endpoint: { pool?: string; agentPool?: string },
          name: string,
          args: object,
        ) =>
          (
            await readJsonRpc(
              await connecta.fetch(mcpRpc("tools/call", { name, arguments: args }, { token, ...endpoint })),
            )
          ).result;
        const addresses = (result: { structuredContent: { tools: { address: string }[] } }) =>
          result.structuredContent.tools.map((tool) => tool.address);
        const group = { agentPool: "group" };

        expect(addresses(await rpc(assistant, group, "search_tools", { query: "labels" }))).toEqual([
          "shared_mail.list_labels",
        ]);
        const called = await rpc(assistant, group, "call_tool", { address: "mail.list_labels", args: {} });
        const ghost = await rpc(assistant, group, "call_tool", { address: "ghost.list_labels", args: {} });
        expect(called.isError).toBe(true);
        expect(called.structuredContent.error).toEqual({
          ...ghost.structuredContent.error,
          message: 'Unknown address "mail.list_labels"',
        });
        expect(called.structuredContent.error).toMatchObject({
          code: "unknown_address",
          configuredConnectors: ["shared_mail"],
        });
        const written = await rpc(assistant, group, "call_destructive_tool", { address: "mail.list_labels", args: {} });
        expect(written.structuredContent.error.code).toBe("unknown_address");
        const authorize = await rpc(assistant, group, "authorize_connector", { connector: "mail" });
        expect(authorize.content[0].text).toBe('Unknown connector "mail"');
        const skills = await rpc(assistant, group, "skills", {});
        expect(skills.structuredContent.skills.map((skill: { name: string }) => skill.name)).not.toContain(
          "connector:mail",
        );
        expect(skills.structuredContent.skills.map((skill: { name: string }) => skill.name)).not.toContain(
          "connector:forms",
        );
        expect(addresses(await rpc(assistant, group, "search_tools", { query: "form" }))).toEqual([]);
        expect(
          (await rpc(assistant, group, "call_tool", { address: "forms.get_form", args: { formId: "f" } }))
            .structuredContent.error.code,
        ).toBe("unknown_address");
        expect(
          (await rpc(assistant, group, "call_destructive_tool", { address: "forms.create_form", args: { title: "x" } }))
            .structuredContent.error.code,
        ).toBe("unknown_address");
        expect(skills.structuredContent.skills.map((skill: { name: string }) => skill.name)).toContain(
          "connector:shared_mail",
        );
        const program = (await rpc(assistant, group, "execute_code", { code: "async () => null" })).structuredContent
          .result;
        expect(program.search).toEqual(["shared_mail.list_labels"]);
        // Byte-for-byte what a connector that never existed gets, name aside.
        const asGhost = (value: unknown) => JSON.stringify(value).replaceAll('"mail.', '"ghost.');
        expect(asGhost(program.describe)).toBe(JSON.stringify(program.describeGhost));
        expect(asGhost(program.call)).toBe(JSON.stringify(program.callGhost));

        // People in the same pool, and the agent in an owned pool, still see it.
        expect(addresses(await rpc("alice", { pool: "group" }, "search_tools", { query: "labels" }))).toEqual([
          "mail.list_labels",
          "shared_mail.list_labels",
        ]);
        expect(
          addresses(await rpc(assistant, { agentPool: "assistant-alice" }, "search_tools", { query: "labels" })),
        ).toEqual(["mail.list_labels"]);
        expect(addresses(await rpc("alice", { pool: "group" }, "search_tools", { query: "form" }))).toContain(
          "forms.get_form",
        );
        expect(mapping).not.toHaveBeenCalled();
        expect(formsMapping).not.toHaveBeenCalled();
        expect(tokenCalls).toEqual([]);
        expect(apiCalls).toEqual([]);
        await connecta.close();
      },
    );

    it.each([
      {
        name: "connector-id no-match guidance",
        args: { query: "mail zzzzzqwerty" },
        expected: { tools: [], queryAnalysis: { guidance: expect.stringContaining('"mail"') } },
      },
      {
        name: "absent-service connector roster",
        args: { query: "slack zzzzzqwerty" },
        expected: { tools: [], absence: { service: "Slack", configuredConnectors: ["mail", "shared_mail"] } },
      },
      {
        name: "unknown-scope connector roster",
        args: { connector: "missing" },
        expected: {
          tools: [],
          queryAnalysis: { unknownConnector: true, configuredConnectors: ["mail", "shared_mail"] },
        },
      },
      {
        name: "off-page aggregate counts",
        args: { query: "labels", offset: 10_000 },
        expected: { tools: [], total: 2, hasMore: false },
      },
      {
        name: "fixed-subject guide control",
        args: { connector: "shared_mail", query: "zzzzzqwerty" },
        expected: { tools: [], queryAnalysis: { guide: "connector:shared_mail", guideSummary: expect.any(String) } },
      },
    ])("INV-4: return paging rechecks $name after a pool owner is removed", NODE, async ({ name, args, expected }) => {
      const storage = memoryStorage();
      const mapping = vi.fn((who: AuthenticatedIdentity) => DIRECTORY[who.principal?.id ?? ""]);
      const mail = mailbox({ subject: mapping, title: "Staff mailbox" });
      const shared = gmail("shared_mail", {
        purpose: "Shared inbox",
        serviceAccount: account(),
        subject: "shared-inbox@org.example",
      } as Parameters<typeof gmail>[1]);
      const connectors = [mail, shared];
      let resultId: string | undefined;
      const executor = scriptedExecutor(async (fns) => {
        if (resultId) return fns.result!(resultId, { maxBytes: 8_000 });
        const search = await fns.search!(args);
        expect(search).toMatchObject(expected);
        return { search, padding: "x".repeat(30_000) };
      });
      const deployment = (owner?: string) =>
        createTestConnecta({
          connectors,
          auth: people(),
          maintainers: ["alice"],
          agents: ["assistant"],
          accessTokens: accessTokens(storage),
          storage,
          pools: {
            group: {
              tools: connectors.map((connector) => connector.id),
              members: ["alice", "agent:assistant"],
              ...(owner ? { owner } : {}),
            },
          },
          executor,
          logger: silentLogger,
        });
      const assistant = await issueAgentToken(storage, "assistant");
      const owned = deployment("alice@org.example");
      const run = async (connecta: ReturnType<typeof deployment>) =>
        (
          await readJsonRpc(
            await connecta.fetch(
              mcpRpc(
                "tools/call",
                {
                  name: "execute_code",
                  arguments: { code: "async () => null" },
                },
                { token: assistant, agentPool: "group" },
              ),
            ),
          )
        ).result;
      try {
        const original = await run(owned);
        expect(original.isError, JSON.stringify(original.structuredContent)).toBeFalsy();
        resultId = original.structuredContent.result.resultId;
        expect(resultId).toMatch(/^[a-f0-9-]{36}$/);
        const page = await run(owned);
        expect(page.isError).toBeFalsy();
        expect(page.structuredContent.result.text).toContain('{"search":');
      } finally {
        await owned.close();
      }
      // Same storage, token, identity and endpoint; only the owner changes.
      const ownerless = deployment();
      try {
        if (name.startsWith("off-page")) {
          const fresh = await readJsonRpc(
            await ownerless.fetch(
              mcpRpc("tools/call", { name: "search_tools", arguments: args }, { token: assistant, agentPool: "group" }),
            ),
          );
          expect(fresh.result.structuredContent).toMatchObject({ tools: [], total: 1, hasMore: false });
        }
        const page = await run(ownerless);
        if (name === "fixed-subject guide control") {
          expect(page.isError).toBeFalsy();
          expect(page.structuredContent.result.text).toContain("connector:shared_mail");
        } else {
          expect(page.isError).toBe(true);
          expect(page.structuredContent).toMatchObject({ error: { code: "not_found" } });
          expect(JSON.stringify(page)).not.toContain('"mail"');
          expect(JSON.stringify(page)).not.toContain("connector:mail");
        }
        expect(mapping).not.toHaveBeenCalled();
        expect(tokenCalls).toEqual([]);
        expect(apiCalls).toEqual([]);
      } finally {
        await ownerless.close();
      }
    });

    it(
      "INV-3: nothing an agent sends — arguments, headers, or a program — moves it off its pool owner",
      NODE,
      async () => {
        const { connecta, assistant } = await deployment({
          executor: scriptedExecutor(async (fns) => {
            const forged = await fns.call!("mail.list_labels", { subject: "bob@org.example" }).catch((error) =>
              String((error as { code?: string }).code ?? error),
            );
            await fns.call!("mail.list_labels", {});
            return forged;
          }),
        });
        const forged = await callOver(connecta, assistant, "assistant-alice", { userId: "bob@org.example" });
        expect(forged.isError).toBe(true);
        expect(JSON.stringify(forged)).toContain("invalid_args");
        const headed = await callOver(
          connecta,
          assistant,
          "assistant-alice",
          {},
          {
            "X-Goog-Subject": "bob@org.example",
            "X-Connecta-Pool-Owner": "bob@org.example",
          },
        );
        expect(headed.isError).toBeFalsy();
        const program = (
          await readJsonRpc(
            await connecta.fetch(
              mcpRpc(
                "tools/call",
                { name: "execute_code", arguments: { code: "async () => null" } },
                { token: assistant, agentPool: "assistant-alice" },
              ),
            ),
          )
        ).result;
        expect(program.isError).toBeFalsy();
        expect(JSON.stringify(program)).toContain("invalid_args");
        expect(tokenCalls.map((_, index) => sub(index))).toEqual(["alice@org.example"]);
        expect(apiCalls).toHaveLength(2);
        await connecta.close();
      },
    );

    it("INV-11: construction refuses an owner that is not a Workspace address", NODE, () => {
      for (const owner of ["bob", "bob@", "two@at@org.example", "bob @org.example", "", 42]) {
        expect(() =>
          createTestConnecta({
            connectors: [mailbox()],
            auth: people(),
            maintainers: ["alice"],
            pools: { mine: { tools: ["mail"], members: ["alice"], owner: owner as string } },
            logger: silentLogger,
          }),
        ).toThrow("ConnectaConfig.pools.mine.owner must be a Google Workspace email address.");
      }
    });
  });
});

// --- Token cache --------------------------------------------------------------------

describe("the in-memory token cache", () => {
  it("reuses a token until a minute before it expires, then mints anew", NODE, async () => {
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

  it("keys by subject and scope set, and shares across connectors on one account", NODE, async () => {
    const owner = account();
    const first = mailbox({}, owner);
    const second = mailbox({}, owner);
    await labels(first, context(identity("alice")));
    await labels(second, context(identity("alice")));
    expect(tokenCalls).toHaveLength(1);
    await labels(second, context(identity("bob")));
    expect(tokenCalls).toHaveLength(2);
  });

  it("sends concurrent callers through one mint", WORKERS, async () => {
    const held = deferred();
    tokenReplies.push(held.reply);
    const connector = mailbox();
    const pending = [1, 2, 3].map(() => labels(connector, context(identity("alice"))));
    await vi.waitFor(() => expect(tokenCalls).toHaveLength(1));
    held.release(tokenResponse("shared"));
    await Promise.all(pending);
    expect(tokenCalls).toHaveLength(1);
    expect(apiCalls.map((call) => call.authorization)).toEqual(["Bearer shared", "Bearer shared", "Bearer shared"]);
  });

  it("lets a follower in another request mint again, never reading the owner's signal", WORKERS, async () => {
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

  it("forgets only the token a late 401 rejected, never a newer one", NODE, async () => {
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
    expect(apiCalls.map((call) => call.authorization)).toEqual(["Bearer token-1", "Bearer token-2", "Bearer token-2"]);
    await labels(connector, context(identity("alice")));
    expect(tokenCalls).toHaveLength(2);

    // A kit-built write's late 401 discards only the token it carried
    // (writeRenewal "discard"): it mints nothing and the newer token stays.
    const restore = installOwnedTransport();
    try {
      const form = forms("forms", { purpose: "Forms", serviceAccount: account(), subject: "alice@example.com" });
      const lateWrite = deferred();
      apiReplies.push(lateWrite.reply);
      const write = form
        .callTool("update_form_info", { formId: "f", title: "Renamed" }, context(identity("alice")))
        .catch((error) => error);
      await vi.waitFor(() => expect(apiCalls).toHaveLength(5));
      now += 3_545_000;
      await form.callTool("get_form", { formId: "f" }, context(identity("alice")));
      lateWrite.release(Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 }));
      expect(await write).toMatchObject({ code: "auth_required", retryable: false, writeOutcome: "unknown" });
      await form.callTool("get_form", { formId: "f" }, context(identity("alice")));
      expect(apiCalls.slice(4).map((call) => [call.method, call.authorization])).toEqual([
        ["POST", "Bearer token-3"],
        ["GET", "Bearer token-4"],
        ["GET", "Bearer token-4"],
      ]);
      expect(tokenCalls).toHaveLength(4);
    } finally {
      restore.restore();
    }
  });

  it("keys the cache by the key itself, so a rotated key never reuses a token", WORKERS, async () => {
    const owner = account();
    await labels(mailbox({}, owner), context(identity("alice")));
    await labels(mailbox({}, { ...owner, privateKey: ROTATED_KEY }), context(identity("alice")));
    expect(tokenCalls).toHaveLength(2);
  });

  it("stays bounded, dropping the oldest token first", { ...NODE, timeout: 60_000 }, async () => {
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

  it("shares a refusal from Google with everyone waiting on it", NODE, async () => {
    const held = deferred();
    tokenReplies.push(held.reply);
    const connector = mailbox();
    const pending = [1, 2].map(() => labels(connector, context(identity("alice"))).catch((error) => error));
    await vi.waitFor(() => expect(tokenCalls).toHaveLength(1));
    held.release(Response.json({ error: "unauthorized_client" }, { status: 401 }));
    const failures = await Promise.all(pending);
    expect(failures.map((error) => error.code)).toEqual(["provider_permission_denied", "provider_permission_denied"]);
    expect(tokenCalls).toHaveLength(1);
  });

  it("stops waiting on another caller's mint at its deadline", NODE, async () => {
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

  it("INV-9: the fresh token for a read's replay never clears another request's 401", NODE, async () => {
    apiReplies.push(
      () => Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 }),
      () => Response.json({ files: [] }),
    );
    const drive = googleWorkspaceClient({
      provider: "Google Drive",
      api: "Google Drive API",
      baseUrl: "https://www.googleapis.com/drive/v3",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      maxResponseBytes: 1024,
      notFound: "ambiguous",
      connection: workspaceConnection("drive", {
        purpose: "Shared files",
        serviceAccount: account(),
        subject: "alice@org.example",
      }),
    });
    const tickets = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.example",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
      fetch: async () => new Response(null, { status: 401 }),
    });
    // A direct write that sends a Tickets POST, then reads Drive, then fails.
    const mixed = api("mixed", {
      tools: [
        {
          name: "create",
          description: "Create a ticket and look up its file",
          annotations: { readOnlyHint: false },
          handler: async (_args, ctx) => {
            await tickets({ method: "POST", path: "/items" }, ctx, () => {
              throw new ConnectorCallError("auth_required", "Tickets rejected its token.");
            }).catch(() => undefined);
            await drive.json({ method: "GET", path: "/files", classification: "read" }, ctx);
            throw new ConnectorCallError("unavailable", "A later failure.");
          },
        },
      ],
    });
    const failure = await mixed.callTool("create", {}, context(identity("alice"))).catch((error: unknown) => error);
    expect(classifyCallError(failure)).toMatchObject({
      code: "auth_required",
      retryable: false,
      writeOutcome: "unknown",
      message:
        "Tickets rejected its token. The write was sent before Tickets rejected its credential, so whether it took " +
        "effect is unknown: check the target before repeating it.",
    });
    expect(apiCalls.map(({ method, authorization }) => `${method} ${authorization}`)).toEqual([
      "GET Bearer token-1",
      "GET Bearer token-2",
    ]);
  });

  it("INV-9: an auxiliary read inside a write stops on 401 before sending the draft write", NODE, async () => {
    apiReplies.push(
      () => Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 }),
      () =>
        Response.json({
          id: "d1",
          message: {
            id: "m1",
            threadId: "t1",
            payload: { mimeType: "text/plain", headers: [{ name: "To", value: "bob@org.example" }], body: {} },
          },
        }),
      () => Response.json({ error: { code: 503, message: "Backend Error" } }, { status: 503 }),
    );
    // A write call never replays even its auxiliary GET (0010 B.2).
    const restoreTransport = installOwnedTransport();
    try {
      const failure = await mailbox()
        .callTool("update_draft", { draftId: "d1", body: "Revised." }, context(identity("alice")))
        .catch((error: unknown) => error);
      const error = classifyCallError(failure);
      expect(error).toMatchObject({ code: "auth_required", retryable: false });
      expect(error.message).toContain("Google rejected a freshly minted delegated token");
      expect(error).not.toHaveProperty("writeOutcome");
      expect(error).not.toHaveProperty("reconciliationRequired");
      expect(isKnownProviderFailure(failure)).toBe(true);
      expect(
        classifyWriteOutcome({ ok: false, dispatched: true, answered: isKnownProviderFailure(failure), error }),
      ).toBe("failed");
      expect(apiCalls.map(({ method, authorization }) => `${method} ${authorization}`)).toEqual(["GET Bearer token-1"]);
      expect(apiCalls.filter(({ method }) => method === "POST" || method === "PUT")).toHaveLength(0);
      expect(tokenCalls).toHaveLength(1);
    } finally {
      restoreTransport.restore();
    }
  });
});

describe("Workspace served classification on unauthorized requests", () => {
  // Kit-built Workspace writes go through the Node owned transport that listen() installs.
  beforeEach(() => {
    installOwnedTransport();
  });

  it("INV-9: honors classification: { gmail: { list_labels: write } } for a GET answered 401", NODE, async () => {
    apiReplies.push(
      () => Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 }),
      () => Response.json({ labels: [] }),
    );
    const connector = gmail("gmail", { purpose: "Mail", serviceAccount: account(), subject: "alice@example.com" });
    const registry = makeRegistry([connector], { classification: { gmail: { list_labels: "write" } } });
    const tools = createMetaTools(registry, "https://connecta.example");
    const result = await tools.callDestructiveTool({ address: "gmail.list_labels", args: {} });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "auth_required",
        retryable: false,
        writeOutcome: "unknown",
        reconciliationRequired: true,
        nextAction: { tool: "authorize_connector", arguments: { connector: "gmail" } },
      },
    });
    expect(apiCalls.map(({ method, authorization }) => ({ method, authorization }))).toEqual([
      { method: "GET", authorization: "Bearer token-1" },
    ]);
    expect(tokenCalls).toHaveLength(1);
    // A deliberate repeat is a new call and uses a fresh token.
    expect((await tools.callDestructiveTool({ address: "gmail.list_labels", args: {} })).isError).toBeFalsy();
    expect(apiCalls.map((call) => call.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);

    // Every multi-request mail read also completes when served as a write.
    // Distinct body and row steps must survive more than one summary or body.
    const stored = (id: string) => ({
      id,
      threadId: "t1",
      payload: { mimeType: "text/plain", body: { attachmentId: "body", size: 3 } },
    });
    const body = { data: "YWJj", size: 3 };
    const messages = [stored("m1"), stored("m2"), stored("m3")];
    const thread = { id: "t1", messages };
    const draft = { id: "d1", message: stored("m1") };
    for (const [tool, args, replies] of [
      ["get_message", { messageId: "m1" }, [stored("m1"), body]],
      ["get_draft", { draftId: "d1" }, [draft, body]],
      [
        "get_attachment",
        { messageId: "m1", partId: "1" },
        [
          {
            id: "m1",
            payload: { partId: "1", mimeType: "text/plain", filename: "a.txt", body: { attachmentId: "a1", size: 3 } },
          },
          body,
        ],
      ],
      ["get_thread", { threadId: "t1" }, [thread, body, body, body]],
      ["search_threads", { limit: 2 }, [{ threads: [{ id: "t1" }, { id: "t2" }] }, thread, { ...thread, id: "t2" }]],
      ["list_drafts", { limit: 2 }, [{ drafts: [{ id: "d1" }, { id: "d2" }] }, draft, { ...draft, id: "d2" }]],
    ] as const) {
      let expected;
      for (const served of ["read", "write"] as const) {
        apiReplies.push(...replies.map((reply) => () => Response.json(reply)));
        const meta = createMetaTools(
          makeRegistry([connector], { classification: { gmail: { [tool]: served } } }),
          "https://connecta.example",
        );
        const sent = apiCalls.length;
        const answer = await (served === "write" ? meta.callDestructiveTool : meta.callTool)({
          address: `gmail.${tool}`,
          args,
        });
        expect(answer.isError, `${tool}: ${JSON.stringify(answer.structuredContent)}`).toBeFalsy();
        expect(apiCalls.slice(sent).map((call) => call.method)).toEqual(replies.map(() => "GET"));
        if (served === "read") expected = answer.content;
        else expect(answer.content, tool).toEqual(expected);
      }
    }
  });

  it("INV-9: a served read-classified POST is never replayed after 401", NODE, async () => {
    apiReplies.push(
      () => Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 }),
      () => Response.json({ id: "draft-1", message: { id: "message-1", threadId: "thread-1" } }),
    );
    const connector = gmail("gmail", { purpose: "Mail", serviceAccount: account(), subject: "alice@example.com" });
    const registry = makeRegistry([connector], { classification: { gmail: { create_draft: "read" } } });
    const result = await createMetaTools(registry, "https://connecta.example").callTool({
      address: "gmail.create_draft",
      args: { body: "Draft text" },
    });
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "auth_required", retryable: false } });
    expect(apiCalls.map(({ method, authorization }) => ({ method, authorization }))).toEqual([
      { method: "POST", authorization: "Bearer token-1" },
    ]);
    expect(apiCalls[0]!.body).toBeTypeOf("string");
    expect(tokenCalls).toHaveLength(1);
  });

  it.each([503, "reset"] as const)(
    "INV-9: a write-classified Google GET's %s stays an unknown outcome",
    NODE,
    async (answer) => {
      apiReplies.push(() => {
        if (answer === "reset") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
        return Response.json({ error: { code: 503 } }, { status: 503 });
      });
      const registry = makeRegistry(
        [gmail("gmail", { purpose: "Mail", serviceAccount: account(), subject: "alice@example.com" })],
        { classification: { gmail: { list_labels: "write" } } },
      );
      const result = await createMetaTools(registry, "https://connecta.example").callDestructiveTool({
        address: "gmail.list_labels",
        args: {},
      });
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "connector_call_failed", retryable: false },
      });
      expect(apiCalls).toHaveLength(1);
      // Forms reads that send two requests declare a step for each: served as
      // writes, both GETs leave once and the call answers as on a read.
      const paired = createMetaTools(
        makeRegistry(
          [forms("workspace", { purpose: "Forms", serviceAccount: account(), subject: "alice@example.com" })],
          { classification: { workspace: { list_responses: "write", get_response: "write" } } },
        ),
        "https://connecta.example",
      );
      for (const [tool, args] of [
        ["list_responses", { formId: "form-1" }],
        ["get_response", { formId: "form-1", responseId: "r1" }],
      ] as const) {
        const sent = apiCalls.length;
        const served = await paired.callDestructiveTool({ address: `workspace.${tool}`, args });
        expect(served.isError, JSON.stringify(served.structuredContent)).toBeFalsy();
        expect(apiCalls.slice(sent).map((call) => call.method)).toEqual(["GET", "GET"]);
      }

      const driveReads = createMetaTools(
        makeRegistry([drive("files", { purpose: "Files", serviceAccount: account(), subject: "alice@example.com" })], {
          classification: { files: { get_file_content: "write", list_folder_items: "write" } },
        }),
        "https://connecta.example",
      );
      for (const [mimeType, payload, format, content] of [
        ["text/plain", "hello", "text", "hello"],
        ["application/pdf", new Uint8Array([1, 2, 3]), "base64", "AQID"],
        ["application/vnd.google-apps.document", "# hi", "markdown", "# hi"],
      ] as const) {
        apiReplies.push(
          () => Response.json({ id: "f1", name: "F", mimeType }),
          () => new Response(payload, { headers: { "content-type": "text/plain" } }),
        );
        const sent = apiCalls.length;
        const served = await driveReads.callDestructiveTool({
          address: "files.get_file_content",
          args: { fileId: "f1" },
        });
        expect(served.isError, JSON.stringify(served.structuredContent)).toBeFalsy();
        const block = served.content[0];
        expect(block?.type).toBe("text");
        expect(JSON.parse(block?.type === "text" ? block.text : "null")).toMatchObject({ format, content });
        expect(apiCalls.slice(sent).map((call) => call.method)).toEqual(["GET", "GET"]);
      }
      apiReplies.push(
        () => Response.json({ id: "folder-1", mimeType: "application/vnd.google-apps.folder" }),
        () => Response.json({ files: [{ id: "f1", name: "F" }] }),
      );
      const sent = apiCalls.length;
      const listing = await driveReads.callDestructiveTool({
        address: "files.list_folder_items",
        args: { folderId: "folder-1" },
      });
      expect(listing.isError, JSON.stringify(listing.structuredContent)).toBeFalsy();
      const block = listing.content[0];
      expect(block?.type).toBe("text");
      expect(JSON.parse(block?.type === "text" ? block.text : "null")).toMatchObject({
        files: [{ id: "f1", name: "F" }],
      });
      expect(apiCalls.slice(sent).map((call) => call.method)).toEqual(["GET", "GET"]);
    },
  );

  it.each([
    ["gmail", gmail, "create_draft", { body: "Draft text" }],
    ["drive", drive, "create_folder", { name: "Example" }],
    ["docs", docs, "create_document", { title: "Example" }],
    ["forms", forms, "create_form", { title: "Example" }],
    ["sheets", sheets, "create_spreadsheet", { title: "Example" }],
    ["slides", slides, "create_presentation", { title: "Example" }],
  ] as const)(
    "INV-9: %s preserves the write's authorization verdict and unknown outcome through recovery advice",
    NODE,
    async (_name, provider, tool, args) => {
      apiReplies.push(() => Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 }));
      const registry = makeRegistry([
        provider("workspace", { purpose: "Files", serviceAccount: account(), subject: "alice@example.com" }),
      ]);
      const result = await createMetaTools(registry, "https://connecta.example").callDestructiveTool({
        address: `workspace.${tool}`,
        args,
      });
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: {
          code: "auth_required",
          retryable: false,
          writeOutcome: "unknown",
          reconciliationRequired: true,
          nextAction: { tool: "authorize_connector", arguments: { connector: "workspace" } },
        },
      });
      expect(apiCalls).toHaveLength(1);
      expect(tokenCalls).toHaveLength(1);
      // A program's call meets the same catalog schema before any handler:
      // an undeclared argument is refused and nothing is minted or sent.
      const connecta = createTestConnecta({
        connectors: [
          provider("workspace", { purpose: "Files", serviceAccount: account(), subject: "alice@example.com" }),
        ],
        auth: machineAuth("service-secret"),
        executor: scriptedExecutor(async (fns) =>
          fns.call!(`workspace.${tool}`, { ...args, undeclared: true }).catch((error) =>
            String((error as { code?: string }).code ?? error),
          ),
        ),
        logger: silentLogger,
      });
      const program = (
        await readJsonRpc(
          await connecta.fetch(
            mcpRpc(
              "tools/call",
              { name: "execute_code", arguments: { code: "async () => null" } },
              { token: "service-secret" },
            ),
          ),
        )
      ).result;
      expect(JSON.stringify(program.structuredContent)).toContain("invalid_args");
      expect(apiCalls).toHaveLength(1);
      expect(tokenCalls).toHaveLength(1);
      await connecta.close();
      if (_name === "drive") {
        // INV-5/9: the primary and upload connections share one delegated
        // cache. A late upload refusal must discard only its exact token,
        // never the newer token the primary connection has already minted.
        tokenCalls.length = 0;
        apiCalls.length = 0;
        const shared = drive("shared", {
          purpose: "Files",
          serviceAccount: account(),
          subject: "alice@example.com",
        });
        const ok = () => Response.json({ id: "f1", name: "File" });
        const rejected = () => Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 });
        const read = () => shared.callTool("get_file", { fileId: "f1" }, context(identity("alice")));
        const upload = () =>
          shared.callTool(
            "update_file_content",
            { fileId: "f1", mimeType: "text/plain", content: "Hello" },
            context(identity("alice")),
          );
        apiReplies.push(ok, ok);
        await read();
        await upload();
        expect(tokenCalls).toHaveLength(1);
        expect(apiCalls.map((call) => call.authorization)).toEqual(["Bearer token-1", "Bearer token-1"]);
        expect(new URL(apiCalls[0]!.url).pathname).toBe("/drive/v3/files/f1");
        expect(new URL(apiCalls[1]!.url).pathname).toBe("/upload/drive/v3/files/f1");

        const held = deferred();
        apiReplies.push(held.reply);
        const pending = upload().catch((error) => error);
        await vi.waitFor(() => expect(apiCalls).toHaveLength(3));
        apiReplies.push(rejected, ok);
        await read();
        expect(tokenCalls).toHaveLength(2);
        held.release(rejected());
        expect(await pending).toMatchObject({ code: "auth_required", retryable: false });
        // A refused write does not mint or resend, and its old-token discard
        // leaves token-2 available to both connections on their next calls.
        expect(tokenCalls).toHaveLength(2);
        expect(apiCalls).toHaveLength(5);
        apiReplies.push(ok, ok);
        await upload();
        await read();
        expect(tokenCalls).toHaveLength(2);
        expect(apiCalls.slice(-2).map((call) => call.authorization)).toEqual(["Bearer token-2", "Bearer token-2"]);
      }
    },
  );
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

  it("names the client ID and exact scopes when delegation is not granted", NODE, async () => {
    const { failure, owner } = await refusedWith(401, {
      error: "unauthorized_client",
      error_description: "Client is unauthorized to retrieve access tokens using this method.",
    });
    expect(failure.code).toBe("provider_permission_denied");
    expect(failure.message).toContain(owner.clientId);
    expect(failure.message).toContain(GMAIL_SCOPES.join(","));
    expect(failure.message).toContain("Manage Domain Wide Delegation");
    expect(failure.message).toContain("24 hours");
  });

  it.each(["access_denied", undefined])(
    "INV-6: delegation refusal %s asks an administrator for the exact grant without token-endpoint text",
    NODE,
    async (error) => {
      const { failure } = await refusedWith(403, { error, error_description: "downstream-text-sentinel" });
      expect(failure).toMatchObject({ code: "provider_permission_denied", retryable: false });
      expect(failure.message).toContain("Manage Domain Wide Delegation");
      expect(failure.message).toContain(GMAIL_SCOPES.join(","));
      expect(failure.message).not.toContain("downstream-text-sentinel");
    },
  );

  it("explains invalid_grant: unknown or suspended user, deleted key, or clock skew", NODE, async () => {
    const { failure } = await refusedWith(400, {
      error: "invalid_grant",
      error_description: "Invalid email or User ID",
    });
    expect(failure.code).toBe("auth_required");
    // The step, the host, and the code; never the server's description (#695).
    expect(failure.message).toContain(
      "The token request to https://oauth2.googleapis.com was answered HTTP 400 with OAuth error invalid_grant",
    );
    expect(failure.message).not.toContain("Invalid email or User ID");
    expect(failure.message).toMatch(/suspended/);
    expect(failure.message).toMatch(/clock/);
  });

  it("withholds the token endpoint's description on every refusal (#695)", NODE, async () => {
    const planted = "planted-secret-7f3a9c";
    for (const [status, error] of [
      [401, "unauthorized_client"],
      [400, "invalid_grant"],
      [401, "invalid_client"],
      [429, "rate_limit_exceeded"],
      [503, "temporarily_unavailable"],
      [400, `${planted}_code`],
    ] as const) {
      const { failure } = await refusedWith(status, { error, error_description: `refused ${planted}` });
      expect(failure.message).toContain(
        `The token request to https://oauth2.googleapis.com was answered HTTP ${status}`,
      );
      expect(`${String(failure)} ${failure.stack ?? ""} ${JSON.stringify({ ...failure })}`).not.toContain(planted);
    }
  });

  it("passes on Google's wait and its outages as retryable", NODE, async () => {
    const limited = await refusedWith(429, { error: "rate_limit_exceeded" }, { "Retry-After": "7" });
    expect(limited.failure).toMatchObject({ code: "rate_limited", retryAfterMs: 7000 });
    const down = await refusedWith(503, {});
    expect(down.failure).toMatchObject({ code: "unavailable", retryable: true });
  });

  it("refuses a success that carries no token", NODE, async () => {
    const { failure } = await refusedWith(200, { token_type: "Bearer" });
    expect(failure.code).toBe("connector_call_failed");
  });
});

describe("API refusals map by Google's reason codes", () => {
  // The kit passes only bounded token facts to its detail mapper. These replace
  // assertions against the legacy client's private googleReasonsOf WeakMap.
  let detail: MockInstance<typeof gmailErrors.detail>;
  beforeEach(() => {
    detail = vi.spyOn(gmailErrors, "detail");
  });
  const displayedReasons = () => detail.mock.calls.at(-1)?.[0].facts.reasons ?? [];
  async function apiFailure(status: number, error: Record<string, unknown>) {
    apiReplies.push(() => Response.json({ error: { code: status, ...error } }, { status }));
    return await labels(mailbox(), context(identity("alice"))).catch((failure) => failure);
  }

  it.each([undefined, "value"] as const)(
    "INV-6: scope recovery reaches the agent in %s mode while Google prose stays out of operator sinks",
    NODE,
    async (resultMode) => {
      apiReplies.push(() =>
        Response.json(
          {
            error: {
              code: 403,
              message: "downstream-text-sentinel",
              details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
            },
          },
          { status: 403 },
        ),
      );
      const warn = vi.fn();
      const target = activitySink();
      const registry = makeRegistry([mailbox({ subject: "alice@org.example" })], { logger: { ...silentLogger, warn } });
      const result = await createMetaTools(registry, "https://connecta.example", {
        activity: target.activity,
      }).callTool({
        address: "mail.list_labels",
        ...(resultMode === undefined ? {} : { resultMode }),
      });
      const text = JSON.parse(result.content[0]!.text);
      expect(result.isError).toBe(true);
      expect(text).toEqual(result.structuredContent);
      expect(text).toMatchObject({
        ok: false,
        error: {
          code: "provider_permission_denied",
          retryable: false,
          message: expect.stringContaining(GMAIL_SCOPES.join(",")),
          retry: expect.stringContaining("administrator"),
        },
      });
      expect(text.error.message).toContain("Admin console");
      expect(text.error.message).toContain("downstream-text-sentinel");
      expect(text.error).not.toHaveProperty("nextAction");
      expect(apiCalls).toHaveLength(1);
      expect(tokenCalls).toHaveLength(1);
      expect(target.events).toHaveLength(1);
      expect(
        JSON.stringify([warn.mock.calls, target.events, await registry.statusFor("mail", "https://connecta.example")]),
      ).not.toContain("downstream-text-sentinel");
    },
  );

  it("reports a refused precondition neutrally, with Google's own words for which", NODE, async () => {
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

  it("names a disabled API by Google's reason, whatever status carries it", NODE, async () => {
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
  ])("names a 403 %s precisely", NODE, async (reason, words) => {
    const failure = await apiFailure(403, {
      message: "The caller does not have permission",
      status: "PERMISSION_DENIED",
      errors: [{ reason, domain: "global" }],
    });
    expect(failure).toMatchObject({
      code: reason === "exportSizeLimitExceeded" ? "connector_call_failed" : "provider_permission_denied",
      retryable: false,
    });
    expect(failure.message).toContain(words);
    expect(displayedReasons()).toEqual([reason, "PERMISSION_DENIED"]);
  });

  it("maps either rate-limit reason to rate_limited, whatever the status", NODE, async () => {
    for (const reason of ["rateLimitExceeded", "userRateLimitExceeded"]) {
      const failure = await apiFailure(403, { message: "Rate Limit Exceeded", errors: [{ reason }] });
      expect(failure.code).toBe("rate_limited");
      expect(displayedReasons()).toEqual([reason]);
    }
  });

  it("exposes Google's reasons sanitized and bounded, never its words", NODE, async () => {
    const failure = await apiFailure(403, {
      message: "secret-bearing prose about file Q3-payroll.xlsx",
      status: "PERMISSION_DENIED",
      errors: [
        { reason: "cannotDownloadAbusiveFile", message: "prose" },
        { reason: "has spaces; and punctuation" },
        { reason: "x".repeat(129) },
        { reason: 42 },
        ...Array.from({ length: 10 }, (_, index) => ({ reason: `extra${index}` })),
      ],
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "cannotDownloadAbusiveFile" }],
    });
    expect(failure).toMatchObject({ code: "provider_permission_denied", retryable: false });
    const reasons = displayedReasons();
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
    expect(reasons).toHaveLength(8);
    expect(reasons).not.toContain("has spaces; and punctuation");
    expect(reasons).not.toContain("x".repeat(129));
    expect(JSON.stringify(reasons)).not.toContain("payroll");
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

  it("decodes text in the charset the response declares", NODE, async () => {
    apiReplies.push(
      () =>
        new Response(new Uint8Array([67, 97, 102, 0xe9]), {
          headers: { "Content-Type": "text/plain; charset=iso-8859-1" },
        }),
    );
    const result = await client().text(
      { method: "GET", path: "/files/f1/export", query: { mimeType: "text/plain" } },
      context(),
    );
    expect(result).toEqual({
      text: "Café",
      contentType: "text/plain; charset=iso-8859-1",
      truncated: false,
      status: 200,
      contentRange: undefined,
    });
  });

  describe("a revision-guarded write", () => {
    const stale = (status: number, reason: string) => () =>
      Response.json(
        {
          error: {
            code: status,
            message: "The required revision ID 'r1' does not match the latest revision.",
            status: reason,
          },
        },
        { status },
      );
    const write = { method: "POST" as const, path: "/documents/d1:batchUpdate", body: { requests: [] } };

    it.each([
      [400, "FAILED_PRECONDITION"],
      [409, "ABORTED"],
    ])("maps HTTP %i %s to conflict with fixed words", NODE, async (status, reason) => {
      apiReplies.push(stale(status, reason));
      const failure = await client()
        .json(write, context(), { revisionGuarded: true })
        .catch((error) => error);
      expect(failure).toBeInstanceOf(ConnectorCallError);
      expect(failure).toMatchObject({
        code: "conflict",
        retryable: false,
        message: "Google Drive refused the write because the item changed after the revision it named.",
      });
      // Its advice to send it again is a segment of its own, composed at output.
      expect(classifyCallError(failure).message).toBe(
        "Google Drive refused the write because the item changed after the revision it named. Re-read it for the current revision, reapply the change, and retry.",
      );
    });

    it("applies to bytes and text requests too", NODE, async () => {
      apiReplies.push(stale(400, "FAILED_PRECONDITION"), stale(409, "ABORTED"));
      const drive = client();
      await expect(drive.bytes(write, context(), undefined, { revisionGuarded: true })).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(drive.text(write, context(), "text/plain", { revisionGuarded: true })).rejects.toMatchObject({
        code: "conflict",
      });
    });

    it("leaves an unflagged request exactly as before", NODE, async () => {
      apiReplies.push(stale(400, "FAILED_PRECONDITION"), stale(409, "ABORTED"));
      const drive = client();
      await expect(drive.json(write, context())).rejects.toMatchObject({ code: "connector_call_failed" });
      await expect(drive.json(write, context(), {})).rejects.toMatchObject({ code: "connector_call_failed" });
    });

    // Google's specific reason outranks the guard: a guarded write refused
    // because the API is off, a quota ran out, or a policy forbids it must
    // say so, never "re-read and retry".
    it.each([
      ["SERVICE_DISABLED", 400, "FAILED_PRECONDITION", "connector_call_failed", "is not enabled"],
      ["ACCESS_TOKEN_SCOPE_INSUFFICIENT", 400, "FAILED_PRECONDITION", "provider_permission_denied", "lacks a scope"],
      ["rateLimitExceeded", 409, "ABORTED", "rate_limited", "wait before retrying"],
    ])("lets %s outrank the guard on HTTP %i %s", NODE, async (reason, status, canonical, code, words) => {
      apiReplies.push(() =>
        Response.json(
          {
            error: {
              code: status,
              message: "Refused.",
              status: canonical,
              details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason }],
            },
          },
          { status },
        ),
      );
      const failure: any = await client()
        .json(write, context(), { revisionGuarded: true })
        .catch((error) => error);
      expect(failure).toMatchObject({ code });
      expect(classifyCallError(failure).message).toContain(words);
    });

    it("does not turn an unrelated refusal into a conflict", NODE, async () => {
      apiReplies.push(() =>
        Response.json(
          { error: { code: 400, message: "Invalid requests[0]", status: "INVALID_ARGUMENT" } },
          { status: 400 },
        ),
      );
      await expect(client().json(write, context(), { revisionGuarded: true })).rejects.toMatchObject({
        code: "invalid_args",
      });
    });
  });

  describe("how far a failed request got, and what that means for retrying it", () => {
    /** A 200 whose body breaks off partway, as a dropped socket does. */
    const brokenReply = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id":'));
            controller.error(new TypeError("other side closed"));
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const write = { method: "POST" as const, path: "/files", body: { name: "Plan" } };
    const read = { method: "GET" as const, path: "/files/f1", classification: "read" as const };
    const failing = (promise: Promise<unknown>) =>
      promise.then(
        () => expect.unreachable(),
        (error) => error,
      );

    it("before-send: nothing left, nothing happened", NODE, async () => {
      const mapped = googleWorkspaceClient({
        provider: "Google Drive",
        api: "Google Drive API",
        baseUrl: "https://www.googleapis.com/drive/v3",
        scopes: ["https://www.googleapis.com/auth/drive"],
        maxResponseBytes: 1024,
        notFound: "ambiguous",
        connection: workspaceConnection("drive", {
          purpose: "Shared files",
          serviceAccount: account(),
          subject: () => "alice@org.example",
        }),
      });
      const unadmitted = await failing(mapped.json(write, context()));
      expect(unadmitted.code).toBe("auth_required");
      expect(googleOutcomeOf(unadmitted)).toEqual({ dispatched: false, phase: "before-send" });

      const streamed = await failing(
        client().json({ method: "POST", path: "/files", rawBody: new ReadableStream() }, context()),
      );
      expect(googleOutcomeOf(streamed)).toEqual({ dispatched: false, phase: "before-send" });
      expect(apiCalls).toEqual([]);
    });

    it("reading-body: a 2xx whose body breaks off reads as probably applied for a write", NODE, async () => {
      apiReplies.push(brokenReply, brokenReply, brokenReply);
      const drive = client();

      const accepted = await failing(drive.json(write, context()));
      expect(accepted).toMatchObject({
        code: "connector_call_failed",
        retryable: false,
        message:
          "Google Drive accepted the request but its reply could not be read; the change probably applied. Re-read before repeating it.",
      });
      expect(googleOutcomeOf(accepted)).toEqual({ dispatched: true, status: 200, phase: "reading-body" });

      // The same for a write through bytes(), whose read is not JSON.
      const viaBytes = await failing(drive.bytes({ ...write, method: "PATCH" }, context()));
      expect(viaBytes).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(googleOutcomeOf(viaBytes)).toMatchObject({ status: 200, phase: "reading-body" });

      // A read broken off the same way is safe to read again.
      const reread = await failing(drive.bytes(read, context()));
      expect(reread).toMatchObject({ code: "unavailable", retryable: true });
      expect(reread.message).toContain("reading again is safe");
      expect(googleOutcomeOf(reread)).toEqual({ dispatched: true, status: 200, phase: "reading-body" });
    });

    it("reading-body: an overflowing 2xx or a redirect after a write is never a retryable refusal", NODE, async () => {
      apiReplies.push(
        () => new Response(new Uint8Array(4096), { status: 200 }),
        () => new Response(null, { status: 303, headers: { Location: "https://elsewhere.example/" } }),
        () => new Response(new Uint8Array(4096), { status: 200 }),
      );
      const drive = client(1024);

      const overflow = await failing(drive.json(write, context()));
      expect(overflow).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(overflow.message).toContain("accepted the request but its reply could not be read");
      expect(googleOutcomeOf(overflow)).toEqual({ dispatched: true, status: 200, phase: "reading-body" });

      const redirected = await failing(drive.json({ ...write, method: "DELETE" }, context()));
      expect(redirected).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(redirected.message).toContain("whether the request was applied is unknown");
      expect(redirected.message).not.toContain("probably applied");
      expect(googleOutcomeOf(redirected)).toEqual({ dispatched: true, status: 303, phase: "redirected" });

      // A read that overflows keeps its own, unchanged refusal.
      const big = await failing(drive.bytes(read, context()));
      expect(big.message).toContain("1024-byte");
      expect(googleOutcomeOf(big)).toEqual({ dispatched: true, status: 200, phase: "reading-body" });
    });

    it("refused: an error status stays a refusal when its body is past the ceiling", NODE, async () => {
      apiReplies.push(() => new Response(new Uint8Array(4096), { status: 403, headers: { "Content-Length": "4096" } }));
      const failure = await failing(client(1024).json(write, context()));
      expect(failure.code).toBe("provider_permission_denied");
      expect(failure.message).not.toContain("probably applied");
      expect(googleOutcomeOf(failure)).toEqual({ dispatched: true, status: 403, phase: "refused" });
    });

    it(
      "reading-body: keeps a stream's or parser's error, and the body it quotes, out of every failure (#695)",
      NODE,
      async () => {
        const planted = "planted-secret-7f3a9c";
        const quoting = () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(`{"echo":"${planted}`));
                controller.error(new TypeError(`other side closed after ${planted}`));
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        const malformed = () =>
          new Response(`${planted} is not json`, { headers: { "Content-Type": "application/json" } });
        apiReplies.push(quoting, quoting, malformed, malformed);
        const drive = client();
        const failures = [
          await failing(drive.json(write, context())),
          await failing(drive.json(read, context())),
          await failing(drive.json(write, context())),
          await failing(drive.json(read, context())),
        ];
        expect(failures.map((failure) => [failure.code, failure.retryable])).toEqual([
          ["connector_call_failed", false],
          ["unavailable", true],
          ["connector_call_failed", false],
          ["connector_call_failed", false],
        ]);
        for (const failure of failures) {
          expect(failure.cause).toBeUndefined();
          expect(googleOutcomeOf(failure)).toMatchObject({ status: 200, phase: "reading-body" });
          expect(`${String(failure)} ${failure.stack ?? ""} ${JSON.stringify({ ...failure })}`).not.toContain(planted);
        }
      },
    );

    describe("a 5xx answering a write", () => {
      const upstream = (status: number) => () =>
        Response.json({ error: { code: status, message: "Backend Error", status: "INTERNAL" } }, { status });

      it.each([
        ["PUT", 502],
        ["DELETE", 504],
      ] as const)("%s → %i: outcome unknown, not retried", NODE, async (method, status) => {
        apiReplies.push(upstream(status));
        const failure = await failing(client().json({ method, path: "/files/f1", body: {} }, context()));
        expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
        expect(failure.message).toContain(
          `answered HTTP ${status} after receiving the request, so its outcome is unknown`,
        );
        expect(failure.message).toContain("Re-read its target before repeating it");
        expect(googleOutcomeOf(failure)).toEqual({ dispatched: true, status, phase: "server-error" });
      });

      /** A quota refusal, carried on whichever status. */
      const quota = (status: number, reason: string) => () =>
        Response.json(
          { error: { code: status, message: "Slow down", status: "RESOURCE_EXHAUSTED", errors: [{ reason }] } },
          { status },
        );
      it.each([["DELETE", 403, "RATE_LIMIT_EXCEEDED"]] as const)(
        "%s → %i %s stays rate_limited: Google rejected it before applying",
        NODE,
        async (method, status, reason) => {
          apiReplies.push(quota(status, reason));
          const failure = await failing(client().json({ method, path: "/files/f1", body: {} }, context()));
          expect(failure.code).toBe("rate_limited");
          expect(googleOutcomeOf(failure)).toEqual({ dispatched: true, status, phase: "refused" });
        },
      );

      it.each([["PUT", 307]] as const)(
        "%s → %i redirect: outcome unknown, never probably applied",
        NODE,
        async (method, status) => {
          apiReplies.push(() => new Response(null, { status, headers: { Location: "https://elsewhere.example/" } }));
          const failure = await failing(client().json({ method, path: "/files/f1", body: {} }, context()));
          expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
          expect(failure.message).toContain(`answered HTTP ${status} with a redirect`);
          expect(failure.message).not.toContain("probably applied");
          expect(googleOutcomeOf(failure)).toEqual({ dispatched: true, status, phase: "redirected" });
        },
      );

      it.each([
        ["POST", 300],
        ["PATCH", 304],
      ] as const)(
        "%s → %i with a quota reason is still redirected, never a rate limit",
        NODE,
        async (method, status) => {
          // 300, 304, 305, and 306 pass the transport's own redirect check, so
          // they reach the mapper; a reason in the body must not turn them into
          // a retryable refusal.
          apiReplies.push(
            () =>
              new Response(
                status === 304
                  ? null
                  : JSON.stringify({
                      error: { code: status, message: "Slow down", errors: [{ reason: "rateLimitExceeded" }] },
                    }),
                { status, headers: { "Content-Type": "application/json" } },
              ),
          );
          const failure = await failing(client().json({ method, path: "/files/f1", body: {} }, context()));
          expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
          expect(failure.message).toContain("whether the request was applied is unknown");
          expect(googleOutcomeOf(failure)).toEqual({ dispatched: true, status, phase: "redirected" });
        },
      );

      it("classifies a 300 the same whether its body is readable or past the ceiling", NODE, async () => {
        apiReplies.push(
          () => Response.json({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, { status: 300 }),
          () => new Response(new Uint8Array(4096), { status: 300, headers: { "Content-Length": "4096" } }),
        );
        const drive = client(1024);
        for (let index = 0; index < 2; index += 1) {
          const failure = await failing(drive.json(write, context()));
          expect(googleOutcomeOf(failure)).toEqual({ dispatched: true, status: 300, phase: "redirected" });
          expect(failure.retryable).toBe(false);
        }
      });

      it("keeps a GET's 300 a non-retryable redirect", NODE, async () => {
        apiReplies.push(() => new Response(null, { status: 300 }));
        const failure = await failing(client().json({ method: "GET", path: "/files/f1" }, context()));
        expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
        expect(googleOutcomeOf(failure)).toEqual({ dispatched: true, status: 300, phase: "redirected" });
      });

      it("keeps a GET redirect's own refusal, phase redirected", NODE, async () => {
        apiReplies.push(() => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }));
        const failure = await failing(client().json({ method: "GET", path: "/files/f1" }, context()));
        expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
        expect(failure.message).toContain("never forwards its credential");
        expect(googleOutcomeOf(failure)).toEqual({ dispatched: true, status: 302, phase: "redirected" });
      });

      it("keeps a quota 5xx retryable for a read, and a whole-resource PUT's unknown", NODE, async () => {
        apiReplies.push(quota(503, "rateLimitExceeded"), quota(503, "rateLimitExceeded"));
        const drive = client();
        const read = await failing(drive.json({ method: "GET", path: "/files/f1", classification: "read" }, context()));
        expect(read.code).toBe("rate_limited");
        expect(googleOutcomeOf(read)).toEqual({ dispatched: true, status: 503, phase: "refused" });
        // No operation hint makes a write repeatable: only a key would.
        const put = await failing(drive.json({ method: "PUT", path: "/files/f1", body: {} }, context()));
        expect(put).toMatchObject({ code: "connector_call_failed", retryable: false });
        expect(googleOutcomeOf(put)).toEqual({ dispatched: true, status: 503, phase: "server-error" });
      });

      it("is unknown even when the 5xx body itself is past the ceiling", NODE, async () => {
        apiReplies.push(
          () => new Response(new Uint8Array(4096), { status: 502, headers: { "Content-Length": "4096" } }),
        );
        const failure = await failing(client(1024).json(write, context()));
        expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
        expect(googleOutcomeOf(failure)).toEqual({ dispatched: true, status: 502, phase: "server-error" });
      });
    });

    it("refreshes and replays a read once on a 401 whose body is past the ceiling", NODE, async () => {
      apiReplies.push(
        () => new Response(new Uint8Array(4096), { status: 401, headers: { "Content-Length": "4096" } }),
        () => Response.json({ id: "f1" }),
      );
      await expect(client(1024).json(read, context())).resolves.toEqual({ id: "f1" });
      expect(tokenCalls).toHaveLength(2);
      expect(apiCalls.map((entry) => entry.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
    });

    describe("a cancellation that lands after Google's status", () => {
      /**
       * A caller whose signal reads as aborted from the moment Google's
       * answer arrives — between the status and the transport's checks of
       * the body, where a real cancellation can land.
       */
      function cancelledOnAnswer(reply: () => Response) {
        const controller = new AbortController();
        let answered = false;
        const signal = new Proxy(controller.signal, {
          get(target, key) {
            if (key === "aborted") return answered;
            if (key === "reason") return new Error("caller left");
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        apiReplies.push(() => {
          answered = true;
          return reply();
        });
        return context(undefined, signal);
      }
      const oversized = (status: number) => () =>
        new Response(new Uint8Array(4096), { status, headers: { "Content-Length": "4096" } });

      it.each([
        ["POST", 503, "server-error"],
        ["POST", 200, "reading-body"],
      ] as const)("%s → %i records %s", NODE, async (method, status, phase) => {
        const ctx = cancelledOnAnswer(oversized(status));
        const failure = await failing(client(1024).json({ method, path: "/files", body: {} }, ctx));
        expect(googleOutcomeOf(failure)).toEqual({ dispatched: true, status, phase });
      });

      it("neither refreshes nor replays a 401 once the caller has left, and keeps the 401", NODE, async () => {
        // The caller leaves while the 401's body is being read: whether the
        // body read finishes (a TokenRejected) or fails (the transport's
        // check), no new token is minted and the outcome is the 401 seen.
        for (const reply of [
          () => Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 }),
          () => new Response(new Uint8Array(4096), { status: 401, headers: { "Content-Length": "4096" } }),
        ]) {
          tokenCalls.length = 0;
          apiCalls.length = 0;
          const ctx = cancelledOnAnswer(reply);
          const failure = await failing(client(1024).json(write, ctx));
          expect(googleOutcomeOf(failure)).toEqual({ dispatched: true, status: 401, phase: "refused" });
          expect(tokenCalls).toHaveLength(1);
          expect(apiCalls).toHaveLength(1);
        }
      });
    });
  });

  describe("a bounded read (maxBytes)", () => {
    const CHUNK = 64 * 1024;

    /** A 2 MiB body produced chunk by chunk, recording what was pulled. */
    function source(chunks = 32) {
      const seen = { pulled: 0, cancelled: false };
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (seen.pulled >= chunks) {
              controller.close();
              return;
            }
            seen.pulled += 1;
            controller.enqueue(new Uint8Array(CHUNK).fill(65));
          },
          cancel() {
            seen.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return { seen, stream };
    }

    it("reads one byte past the bound, then cancels the rest of the stream unread", WORKERS, async () => {
      const { seen, stream } = source();
      apiReplies.push(
        () =>
          new Response(stream, {
            status: 206,
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(32 * CHUNK),
              "Content-Range": "bytes 0-9/2097152",
            },
          }),
      );
      const result = await client(16 * 1024 * 1024).bytes(
        { method: "GET", path: "/files/f1", query: { alt: "media" }, headers: { Range: "bytes=0-9" } },
        context(),
        undefined,
        { maxBytes: 10 },
      );
      expect(result.bytes).toEqual(new Uint8Array(10).fill(65));
      expect(result).toMatchObject({ truncated: true, status: 206, contentRange: "bytes 0-9/2097152" });
      // An ignored Range sent the whole file; almost none of it was read.
      await vi.waitFor(() => expect(seen.cancelled).toBe(true));
      expect(seen.pulled).toBeLessThan(4);
    });

    it("returns a capped prefix of a body past the ceiling instead of failing", NODE, async () => {
      apiReplies.push(
        () => new Response(new Uint8Array(4096).fill(66), { headers: { "Content-Length": "4096" } }),
        () => new Response(new Uint8Array(4096).fill(67), { headers: { "Content-Length": "4096" } }),
      );
      const drive = client(1024);
      const small = await drive.bytes({ method: "GET", path: "/files/f1" }, context(), undefined, { maxBytes: 100 });
      expect(small).toMatchObject({ truncated: true, status: 200 });
      expect(small.bytes.length).toBe(100);
      // A bound past the ceiling reads to the ceiling, and says it stopped.
      const large = await drive.bytes({ method: "GET", path: "/files/f1" }, context(), undefined, { maxBytes: 5000 });
      expect(large).toMatchObject({ truncated: true });
      expect(large.bytes.length).toBe(1024);
    });

    it("reports a body that fits the bound as whole", NODE, async () => {
      apiReplies.push(() => new Response("hello", { headers: { "Content-Type": "text/plain" } }));
      const result = await client().text({ method: "GET", path: "/files/f1" }, context(), undefined, { maxBytes: 5 });
      expect(result).toEqual({
        text: "hello",
        contentType: "text/plain",
        truncated: false,
        status: 200,
        contentRange: undefined,
      });
    });

    it("drops a code point the cut left incomplete", NODE, async () => {
      apiReplies.push(() => new Response("hé!", { headers: { "Content-Type": "text/plain; charset=utf-8" } }));
      const result = await client().text({ method: "GET", path: "/files/f1" }, context(), undefined, { maxBytes: 2 });
      expect(result).toMatchObject({ text: "h", truncated: true });
    });

    it("answers an empty file's 416 as an empty result, only when bounded", NODE, async () => {
      const empty = () =>
        new Response("Requested range not satisfiable", {
          status: 416,
          headers: { "Content-Range": "bytes */0", "Content-Type": "text/plain" },
        });
      apiReplies.push(
        empty,
        empty,
        () =>
          new Response("Requested range not satisfiable", { status: 416, headers: { "Content-Range": "bytes */100" } }),
      );
      const drive = client();
      const request = {
        method: "GET" as const,
        path: "/files/f1",
        query: { alt: "media" },
        headers: { Range: "bytes=0-99" },
      };
      await expect(drive.bytes(request, context(), undefined, { maxBytes: 100 })).resolves.toEqual({
        bytes: new Uint8Array(),
        truncated: false,
        status: 416,
        contentType: "text/plain",
        contentRange: "bytes */0",
      });
      // Unbounded reads behave exactly as before: a 416 is a failure.
      await expect(drive.bytes(request, context())).rejects.toMatchObject({ code: "connector_call_failed" });
      // And a 416 for a file that is not empty is still one.
      await expect(drive.bytes(request, context(), undefined, { maxBytes: 100 })).rejects.toMatchObject({
        code: "connector_call_failed",
      });
    });

    it("refuses a bound that is not a whole number of bytes, before anything leaves", NODE, async () => {
      for (const maxBytes of [-1, 1.5, Number.NaN]) {
        await expect(
          client().bytes({ method: "GET", path: "/files/f1" }, context(), undefined, { maxBytes }),
        ).rejects.toThrow(TypeError);
      }
      expect(apiCalls).toEqual([]);
      expect(tokenCalls).toEqual([]);
    });
  });

  it("INV-9: a method override on a positive Google read is never replayed", NODE, async () => {
    apiReplies.push(
      () => Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 }),
      () => Response.json({ id: "unexpected-replay" }),
    );
    const ctx = context();
    attachCallClassification(ctx, "read");
    const error = await client()
      .json(
        { method: "GET", path: "/files/f1", classification: "read", headers: { "X-HTTP-Method-Override": "POST" } },
        ctx,
      )
      .catch((failure) => failure);
    expect(error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    expect(apiCalls).toHaveLength(1);
    expect(tokenCalls).toHaveLength(1);
  });

  it("INV-9: replays a read's byte body intact after a 401, and never a write's", NODE, async () => {
    const rejected = () => Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 });
    apiReplies.push(rejected, () => Response.json({ id: "f9" }), rejected);
    const request = {
      method: "POST" as const,
      path: "/files",
      headers: { "Content-Type": "application/octet-stream" },
      rawBody: new Uint8Array([1, 2, 3, 4]),
    };
    // A call the registry classified as a read may send its POST again.
    const readCall = context();
    attachCallClassification(readCall, "read");
    await client().json(request, readCall);
    expect(apiCalls.map((call) => call.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(apiCalls.map((call) => call.body)).toEqual([
      [1, 2, 3, 4],
      [1, 2, 3, 4],
    ]);
    // A write's is sent once, whatever classification is missing or says.
    for (const classification of [undefined, "write"] as const) {
      apiCalls.length = 0;
      apiReplies.push(rejected);
      const writeCall = context();
      if (classification) attachCallClassification(writeCall, classification);
      await expect(client().json(request, writeCall)).rejects.toMatchObject({
        code: "auth_required",
        retryable: false,
        writeOutcome: "unknown",
      });
      expect(apiCalls).toHaveLength(1);
    }
  });

  it("refuses a stream body, which a replay could not resend, before anything leaves", NODE, async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    await expect(client().json({ method: "POST", path: "/files", rawBody: stream }, context())).rejects.toThrow(
      /replayable/,
    );
    expect(tokenCalls).toEqual([]);
    expect(apiCalls).toEqual([]);
  });
});
