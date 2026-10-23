import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AccessTokenManager, accessTokens } from "../src/access-tokens.js";
import { activityHistory, type ToolCallActivityEvent } from "../src/activity.js";
import type { AgentConfig } from "../src/agent-config.js";
import { AGENT_NAMESPACE } from "../src/agent-identity.js";
import { vercelAgentAuth } from "../src/auth/vercel-agent.js";
import { api } from "../src/connectors/api.js";
import { authorizeAgent } from "../src/routes/shared.js";
import { memoryStorage } from "../src/storage/memory.js";
import { readJsonRpc } from "./fixtures/http.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { issueAgentToken } from "./helpers/agent-tokens.js";

const BASE = "https://connecta.test";
const JWKS = "https://oidc.vercel.com/.well-known/jwks";
const credential = { team: "team_assistant", project: "prj_assistant" };
const agents = [{ name: "assistant", vercel: credential }];
let first: CryptoKeyPair;
let second: CryptoKeyPair;
let publicFirst: JsonWebKey;
let publicSecond: JsonWebKey;
const now = () => Math.floor(Date.now() / 1000);
const b64 = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const json = (value: unknown) => b64(new TextEncoder().encode(JSON.stringify(value)));

beforeAll(async () => {
  const generate = () =>
    crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
  first = (await generate()) as CryptoKeyPair;
  second = (await generate()) as CryptoKeyPair;
  publicFirst = (await crypto.subtle.exportKey("jwk", first.publicKey)) as JsonWebKey;
  publicSecond = (await crypto.subtle.exportKey("jwk", second.publicKey)) as JsonWebKey;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function claims() {
  return {
    iss: "https://oidc.vercel.com/assistant",
    aud: "https://vercel.com/assistant",
    sub: "owner:assistant:project:assistant:environment:production",
    owner: "assistant",
    owner_id: "team_assistant",
    project: "assistant",
    project_id: "prj_assistant",
    environment: "production",
    iat: now(),
    nbf: now(),
    exp: now() + 7200,
  };
}

async function token(
  changes: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key = first.privateKey,
) {
  const input = `${json({ alg: "RS256", typ: "JWT", kid: "first", ...header })}.${json({ ...claims(), ...changes })}`;
  return `${input}.${b64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input))))}`;
}

function mockKeys(keys = [{ ...publicFirst, kid: "first" }]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe(JWKS);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toEqual({ Accept: "application/json" });
    return Response.json({ keys });
  });
}

function auth() {
  return vercelAgentAuth([{ name: "assistant", vercel: { ...credential, environments: ["production"] } }])!;
}
const request = (value: string, path = "/agent/assistant") =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${value}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("Vercel workload verification", () => {
  it("INV-4 INV-6: admits team and global issuers as one agent without a human principal or token in the identity", async () => {
    const fetcher = mockKeys();
    const provider = auth();
    for (const iss of [claims().iss, "https://oidc.vercel.com"]) {
      const value = await token({ iss });
      const result = await authorizeAgent(request(value), BASE, [provider], silentLogger);
      expect(result).toMatchObject({
        ok: true,
        actor: { kind: "vercel_oidc", id: "assistant", namespace: AGENT_NAMESPACE },
        identity: {
          agent: "assistant",
          subject: { namespace: AGENT_NAMESPACE, id: "agent:assistant" },
          interactive: false,
        },
      });
      if (result.ok) expect(result.identity.principal).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(value);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { iss: "https://attacker.test" },
    { iss: "https://oidc.vercel.com/other" },
    { iss: "https://oidc.vercel.com.attacker.test/assistant" },
    { aud: "https://vercel.com/other" },
    { aud: ["https://vercel.com/assistant", "other"] },
    { project_id: "prj_other" },
    { owner_id: "team_other" },
    { environment: "preview", sub: "owner:assistant:project:assistant:environment:preview" },
    { environment: "development", sub: "owner:assistant:project:assistant:environment:development" },
    { sub: "owner:assistant:project:other:environment:production" },
    { owner: "other" },
    { project: "other" },
    { external_sub: "user_alice" },
    { iat: undefined },
    { exp: undefined },
    { exp: "later" },
    { nbf: "later" },
  ])("INV-4: rejects a mismatched or missing claim %j before fetching keys", async (changes) => {
    const fetcher = mockKeys();
    const result = await auth().authorize(request(await token(changes)), BASE);
    expect(result.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("INV-4: validates expiry, nbf and iat with only thirty seconds of skew", async () => {
    mockKeys();
    const provider = auth();
    for (const changes of [
      { exp: now() - 60 },
      { nbf: now() + 60 },
      { iat: now() + 60 },
      { iat: now() + 8000 },
      { nbf: now() + 8000 },
      { exp: now() - 60, iat: now() - 120 },
    ]) {
      expect((await provider.authorize(request(await token(changes)), BASE)).ok).toBe(false);
    }
    expect((await provider.authorize(request(await token({ nbf: now() + 10, iat: now() + 10 })), BASE)).ok).toBe(true);
    expect((await provider.authorize(request(await token({ nbf: undefined })), BASE)).ok).toBe(true);
  });

  it("INV-4: rejects bad signatures, disallowed algorithms, critical headers and malformed tokens", async () => {
    mockKeys();
    const provider = auth();
    for (const value of [
      await token({}, {}, second.privateKey),
      await token({}, { alg: "none" }),
      await token({}, { alg: "HS256" }),
      await token({}, { crit: ["custom"] }),
      await token({}, { b64: false }),
      "a.b.c",
      "not-a-jwt",
      "a".repeat(16_385),
    ]) {
      const result = await provider.authorize(request(value), BASE);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(401);
        expect(await result.response.text()).toBe('{"error":"unauthorized"}');
      }
    }
  });

  it("INV-4: matches exact slugs and explicitly enabled environments", async () => {
    mockKeys();
    const provider = vercelAgentAuth([
      { name: "assistant", vercel: { team: "assistant", project: "assistant", environments: ["preview"] } },
    ])!;
    expect((await provider.authorize(request(await token()), BASE)).ok).toBe(false);
    expect(
      (
        await provider.authorize(
          request(
            await token({ environment: "preview", sub: "owner:assistant:project:assistant:environment:preview" }),
          ),
          BASE,
        )
      ).ok,
    ).toBe(true);
  });

  it("INV-4 INV-7: refreshes once on unknown kid and bounds rotation misses", async () => {
    const fetcher = mockKeys();
    const provider = auth();
    expect((await provider.authorize(request(await token()), BASE)).ok).toBe(true);
    fetcher.mockResolvedValue(Response.json({ keys: [{ ...publicSecond, kid: "second" }] }));
    expect((await provider.authorize(request(await token({}, { kid: "second" }, second.privateKey)), BASE)).ok).toBe(
      true,
    );
    for (const kid of ["unknown", "another", "first"]) {
      expect((await provider.authorize(request(await token({}, { kid })), BASE)).ok).toBe(false);
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("INV-4 INV-7: expires cached keys and fails closed on a JWKS outage with bounded retries", async () => {
    const fetcher = mockKeys();
    const provider = auth();
    const value = await token();
    expect((await provider.authorize(request(value), BASE)).ok).toBe(true);
    const later = Date.now() + 300_001;
    vi.spyOn(Date, "now").mockReturnValue(later);
    fetcher.mockRejectedValue(new Error("private upstream error"));
    for (let i = 0; i < 3; i++) expect((await provider.authorize(request(value), BASE)).ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["empty", "too-many", "small", "private", "duplicate"])(
    "INV-4: rejects unusable or unbounded JWKS (%s)",
    async (kind) => {
      const key = { ...publicFirst, kid: "first" };
      const keys =
        kind === "empty"
          ? []
          : kind === "too-many"
            ? Array.from({ length: 17 }, (_, i) => ({ ...key, kid: `${i}` }))
            : kind === "small"
              ? [{ ...key, n: "AQAB" }]
              : kind === "private"
                ? [{ ...key, d: "private" }]
                : [key, key];
      mockKeys(keys);
      expect((await auth().authorize(request(await token()), BASE)).ok).toBe(false);
    },
  );

  it("INV-7: cancels an oversized JWKS body and an interrupted body read", async () => {
    const value = await token();
    const cancelled = vi.fn();
    const fetcher = mockKeys();
    fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(65_537));
          },
          cancel: cancelled,
        }),
      ),
    );
    expect((await auth().authorize(request(value), BASE)).ok).toBe(false);
    expect(cancelled).toHaveBeenCalled();
    const controller = new AbortController();
    fetcher.mockImplementationOnce(async (_url, init) => {
      expect(init?.signal?.aborted).toBe(false);
      return new Response(
        new ReadableStream({
          start() {
            controller.abort();
          },
          cancel: cancelled,
        }),
      );
    });
    const req = new Request(request(value), { signal: controller.signal });
    expect((await auth().authorize(req, BASE)).ok).toBe(false);
    expect(cancelled).toHaveBeenCalledTimes(2);
  });

  it("INV-7: cancels a pending stream read without poisoning the next request's key cache", async () => {
    const provider = auth();
    const value = await token();
    const controller = new AbortController();
    const cancelled = vi.fn();
    let reading!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const fetcher = mockKeys();
    fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream(
          {
            pull() {
              reading();
            },
            cancel: cancelled,
          },
          { highWaterMark: 0 },
        ),
      ),
    );
    const pending = provider.authorize(new Request(request(value), { signal: controller.signal }), BASE);
    await readStarted;
    controller.abort();
    expect((await pending).ok).toBe(false);
    expect(cancelled).toHaveBeenCalled();
    expect((await provider.authorize(request(value), BASE)).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("Vercel agent configuration and endpoint isolation", () => {
  const connector = () =>
    api("notes", {
      description: "Notes",
      tools: [
        {
          name: "read",
          description: "Read notes",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          handler: () => "notes",
        },
      ],
    });
  const deployment = (extra = {}) =>
    createTestConnecta({
      agents,
      connectors: [connector()],
      pools: {
        assistant: { tools: ["notes"], members: ["agent:assistant"] },
        other: { tools: ["notes"], members: ["agent:other"] },
      },
      ...extra,
      logger: silentLogger,
    });

  it("INV-4 INV-11: supports OIDC-only deployments and preserves pool membership and agent-token coexistence", async () => {
    mockKeys();
    const storage = memoryStorage();
    const declared = [...agents, { name: "other", vercel: { ...credential, project: "prj_other" } }];
    const app = deployment({ agents: declared, storage, accessTokens: accessTokens(storage) });
    try {
      const oidc = await token();
      const cta = await issueAgentToken(storage, "assistant");
      for (const value of [oidc, cta]) {
        expect((await app.fetch(request(value))).status).toBe(200);
        expect((await app.fetch(request(value, "/agent/other"))).status).toBe(404);
        expect((await app.fetch(request(value, "/agent/missing"))).status).toBe(404);
        for (const path of ["/mcp", "/mcp/assistant", "/ui/access-tokens", "/connect/notes"]) {
          expect((await app.fetch(request(value, path))).status).not.toBe(200);
        }
      }
      expect(app.describeConfig().agents).toEqual(["assistant", "other"]);
      expect((await new AccessTokenManager(storage, { agents: declared }).list()).map((slot) => slot.name)).toEqual([
        "assistant",
        "other",
      ]);
    } finally {
      await app.close();
    }
    const only = createTestConnecta({
      agents,
      connectors: [connector()],
      pools: { assistant: { tools: ["notes"], members: ["agent:assistant"] } },
    });
    try {
      const response = await only.fetch(request(await token()));
      expect(response.status).toBe(200);
      expect(await readJsonRpc(response)).toHaveProperty("result.tools");
      expect((await only.fetch(new Request(`${BASE}/mcp`))).status).toBe(401);
    } finally {
      await only.close();
    }
  });

  it("INV-4: never consults human auth or ambient Access context for Vercel agent credentials", async () => {
    const fetcher = mockKeys();
    const human = {
      kind: "people",
      interactiveOperator: true as const,
      activityActorNamespace: "people",
      recognizesCredential: vi.fn(() => true),
      authorize: vi.fn(() => ({ ok: true as const, userId: "alice" })),
    };
    const app = createTestConnecta({
      agents,
      auth: human,
      maintainers: ["alice"],
      connectors: [connector()],
      pools: { assistant: { tools: ["notes"], members: ["agent:assistant"] } },
    });
    const getIdentity = vi.fn(() => {
      throw new Error("Access should not run");
    });
    try {
      const value = await token();
      expect(
        (await app.fetch(request(value), undefined, { access: { aud: "access", getIdentity }, waitUntil() {} })).status,
      ).toBe(200);
      for (const path of ["/mcp", "/ui/access-tokens", "/connect/notes"]) await app.fetch(request(value, path));
      expect(human.authorize).not.toHaveBeenCalled();
      expect(human.recognizesCredential).not.toHaveBeenCalled();
      expect(getIdentity).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("INV-6: records the agent name without the JWT or workload claims in activity and logs", async () => {
    mockKeys();
    const events: ToolCallActivityEvent[] = [];
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const app = createTestConnecta({
      agents,
      connectors: [connector()],
      logger,
      pools: { assistant: { tools: ["notes"], members: ["agent:assistant"] } },
      activity: activityHistory({
        store: {
          record: (event) => {
            events.push(event);
          },
        },
      }),
    });
    try {
      const value = await token();
      const req = request(value);
      const response = await app.fetch(
        new Request(req.url, {
          method: "POST",
          headers: req.headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "call_tool",
              arguments: { address: "notes.read", args: {} },
            },
          }),
        }),
      );
      expect((await readJsonRpc(response)).result.isError).not.toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]!.actor).toEqual({ kind: "vercel_oidc", id: "assistant", namespace: AGENT_NAMESPACE });
      const recorded = JSON.stringify({ events, logs: Object.values(logger).flatMap((method) => method.mock.calls) });
      for (const secret of [value, "team_assistant", "prj_assistant", "owner:assistant", "private upstream error"]) {
        expect(recorded).not.toContain(secret);
      }
    } finally {
      await app.close();
    }
  });

  it("INV-11: rejects invalid, duplicate or overlapping bindings, unknown fields and accessors without echoing them", () => {
    const invalid: unknown[] = [
      [{ name: "assistant", vercel: { ...credential, environments: [] } }],
      [{ name: "assistant", vercel: { ...credential, environments: ["*"] } }],
      [{ name: "assistant", vercel: { ...credential, team: "https://private.invalid" } }],
      [{ name: "assistant", vercel: { ...credential, team: "assistant\n" } }],
      [{ name: "assistant", vercel: { ...credential, project: "assistant\n" } }],
      [{ name: "assistant", vercel: { ...credential, projects: "private" } }],
      [...agents, agents[0]],
      [...agents, { name: "other", vercel: credential }],
      [...agents, { name: "other", vercel: { team: "assistant", project: "assistant" } }],
      [{ name: "assistant" }],
      ["assistant"],
    ];
    const getter = vi.fn(() => "private");
    invalid.push([
      {
        name: "assistant",
        vercel: {
          ...credential,
          get environments() {
            return getter();
          },
        },
      },
    ]);
    for (const value of invalid) {
      expect(() => createTestConnecta({ agents: value as AgentConfig[], connectors: [] })).toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
  });
});
