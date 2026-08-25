import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { CredentialVault } from "../src/credentials.js";
import { ConnectorCallError } from "../src/errors.js";
import { createMetaTools } from "../src/meta-tools.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectorContext, Logger } from "../src/types.js";
import { activitySink, makeRegistry, required, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const URL_UNDER_TEST = "https://downstream.test/mcp";
const CREDENTIAL_KEY = btoa(
  String.fromCharCode(...new Uint8Array(32).fill(7)),
);

/** One captured downstream request: who it claimed to be, and what it asked. */
interface Captured {
  headers: Headers;
  body: string;
}

/**
 * Serve a real MCP downstream over a stubbed global fetch.
 *
 * The credential shape is only observable on the wire, so these tests use the
 * connector's own transport rather than the `_transportFactory` seam — the
 * seam bypasses exactly the header assembly under test.
 */
function serveDownstream(): Captured[] {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "downstream", version: "1.0.0" });
    server.registerTool(
      "echo",
      {
        description: "Echo text back",
        inputSchema: z.object({ text: z.string() }),
        annotations: { readOnlyHint: true },
      },
      async ({ text }) => ({ content: [{ type: "text", text }] }),
    );
    return server;
  });
  const captured: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const request = new Request(input as string | URL, init);
      const clone = request.clone();
      captured.push({
        headers: new Headers(request.headers),
        body: request.method === "POST" ? await clone.text() : "",
      });
      return handler.fetch(request);
    },
  );
  return captured;
}

/**
 * Authorization values from the requests that opened a session — the 2026
 * `server/discover` probe or the legacy `initialize` handshake. One entry per
 * connect, which is what makes a reconnect visible.
 */
function sessionOpenAuthorizations(captured: Captured[]): (string | null)[] {
  return captured
    .filter(
      (entry) =>
        entry.body.includes('"method":"server/discover"') ||
        entry.body.includes('"method":"initialize"'),
    )
    .map((entry) => entry.headers.get("authorization"));
}

/** A context whose vault answer can change between calls, like a rotation. */
function credentialCtx(read: () => string | null): ConnectorContext {
  return {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: BASE,
    credential: {
      get: async () => read(),
      getAll: async () => {
        const value = read();
        return value === null ? null : { value };
      },
    },
  };
}

/** A context with no vault behind it — `credentials.encryptionKey` unset. */
function vaultlessCtx(): ConnectorContext {
  return { storage: memoryStorage(), logger: silentLogger, baseUrl: BASE };
}

function loggerSpy(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { logger: { ...silentLogger, warn }, warn };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remoteMcp() credential auth — the declared slot", () => {
  it("declares a default slot an operator page can render", () => {
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential" },
    });
    expect(connector.credential).toEqual({ label: "API key" });
    // No startAuth: authorize_connector reads that absence plus the declared
    // slot to return the /credentials handoff instead of a consent URL.
    expect(connector.startAuth).toBeUndefined();
    expect(connector.testCredential).toBeTypeOf("function");
  });

  it("keeps the caller's label, description, and placeholder", () => {
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: {
        type: "credential",
        credential: {
          label: "API v2 secret key",
          description: "Reaches exactly one project.",
          placeholder: "sk_…",
        },
      },
    });
    expect(connector.credential).toEqual({
      label: "API v2 secret key",
      description: "Reaches exactly one project.",
      placeholder: "sk_…",
    });
  });

  it("refuses named credential fields at construction", () => {
    expect(() =>
      remoteMcp("down", {
        url: URL_UNDER_TEST,
        auth: {
          type: "credential",
          credential: {
            label: "Service credentials",
            fields: [
              { name: "email", label: "Account email" },
              { name: "apiKey", label: "API key" },
            ],
          },
        },
      }),
    ).toThrow("reads the reserved `value` field only");
  });

  it("declares no slot for the other auth shapes", () => {
    expect(
      remoteMcp("oauthed", { url: URL_UNDER_TEST, auth: { type: "oauth" } })
        .credential,
    ).toBeUndefined();
    expect(
      remoteMcp("headered", {
        url: URL_UNDER_TEST,
        auth: { type: "headers", headers: { authorization: "Bearer k" } },
      }).credential,
    ).toBeUndefined();
  });
});

describe("remoteMcp() credential auth — header framing", () => {
  it.each([
    [undefined, "Bearer stored-secret"],
    ["Bearer", "Bearer stored-secret"],
    [null, "stored-secret"],
    ["", "stored-secret"],
    ["Token", "Token stored-secret"],
  ] as const)("scheme %s sends %s", async (scheme, expected) => {
    const captured = serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: {
        type: "credential",
        ...(scheme === undefined ? {} : { scheme }),
      },
    });
    const ctx = credentialCtx(() => "stored-secret");

    await expect(connector.listTools(ctx)).resolves.toHaveLength(1);
    await connector.closeScope?.(ctx);

    expect(sessionOpenAuthorizations(captured)).toEqual([expected]);
  });

  it("base64-encodes a value framed as HTTP Basic credentials", async () => {
    const captured = serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential", scheme: "Basic" },
    });
    const ctx = credentialCtx(() => "user:secret");

    await expect(connector.listTools(ctx)).resolves.toHaveLength(1);
    await connector.closeScope?.(ctx);

    expect(sessionOpenAuthorizations(captured)).toEqual([
      `Basic ${btoa("user:secret")}`,
    ]);
  });

  it("encodes a nested Basic framing, which is Mixpanel's documented form", async () => {
    const captured = serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential", scheme: "Bearer Basic" },
    });
    const ctx = credentialCtx(() => "user:secret");

    await expect(connector.listTools(ctx)).resolves.toHaveLength(1);
    await connector.closeScope?.(ctx);

    expect(sessionOpenAuthorizations(captured)).toEqual([
      `Bearer Basic ${btoa("user:secret")}`,
    ]);
  });

  it("sends the credential on a named header when one is declared", async () => {
    const captured = serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential", header: "X-Api-Key", scheme: null },
    });
    const ctx = credentialCtx(() => "stored-secret");

    await expect(connector.listTools(ctx)).resolves.toHaveLength(1);
    await connector.closeScope?.(ctx);

    const first = required(captured[0]);
    expect(first.headers.get("x-api-key")).toBe("stored-secret");
    expect(first.headers.get("authorization")).toBeNull();
  });
});

describe("remoteMcp() credential auth — an empty slot", () => {
  it("fails calls with auth_required rather than reaching the downstream", async () => {
    const captured = serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential" },
    });
    const ctx = credentialCtx(() => null);

    const err = await connector
      .callTool("echo", { text: "hi" }, ctx)
      .then(() => null, (error: unknown) => error);

    expect(err).toBeInstanceOf(ConnectorCallError);
    expect(err).toMatchObject({ code: "auth_required" });
    expect((err as Error).message).toContain("has no stored credential");
    expect((err as Error).message).toContain("authorize_connector");
    expect(captured).toHaveLength(0);
  });

  it("reports an unauthenticated status instead of an error", async () => {
    serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential" },
    });

    await expect(
      connector.status!(credentialCtx(() => null)),
    ).resolves.toMatchObject({
      state: "auth_required",
      message: expect.stringContaining("no stored credential"),
    });
  });

  it("names credentials.encryptionKey when there is no vault at all", async () => {
    serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential" },
    });

    const err = await connector
      .listTools(vaultlessCtx())
      .then(() => null, (error: unknown) => error);

    expect(err).toMatchObject({ code: "auth_required" });
    expect((err as Error).message).toContain("credentials.encryptionKey");
  });

  it("treats a whitespace-only stored value as no credential", async () => {
    serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential" },
    });

    await expect(
      connector.listTools(credentialCtx(() => "   ")),
    ).rejects.toMatchObject({ code: "auth_required" });
  });
});

describe("remoteMcp() credential auth — rotation", () => {
  it("reconnects with the replacement without ending the request scope", async () => {
    const captured = serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential" },
    });
    let stored = "first-secret";
    const ctx = credentialCtx(() => stored);

    await connector.listTools(ctx);
    expect(sessionOpenAuthorizations(captured)).toEqual([
      "Bearer first-secret",
    ]);

    // An operator saved a replacement between two calls of one request scope.
    stored = "second-secret";
    await connector.listTools(ctx);
    await connector.closeScope?.(ctx);

    expect(sessionOpenAuthorizations(captured)).toEqual([
      "Bearer first-secret",
      "Bearer second-secret",
    ]);
  });

  it("keeps the cached client while the stored value is unchanged", async () => {
    const captured = serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential" },
    });
    const ctx = credentialCtx(() => "stored-secret");

    await connector.listTools(ctx);
    await connector.listTools(ctx);
    await connector.callTool("echo", { text: "hi" }, ctx);
    await connector.closeScope?.(ctx);

    expect(sessionOpenAuthorizations(captured)).toHaveLength(1);
  });

  it("fails the next call after the value is wiped", async () => {
    serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential" },
    });
    let stored: string | null = "stored-secret";
    const ctx = credentialCtx(() => stored);

    await expect(connector.listTools(ctx)).resolves.toHaveLength(1);

    stored = null;
    await expect(
      connector.callTool("echo", { text: "hi" }, ctx),
    ).rejects.toMatchObject({ code: "auth_required" });
    await connector.closeScope?.(ctx);
  });

  it("never exposes the stored value through an error or a status", async () => {
    serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential" },
    });
    const ctx = credentialCtx(() => "do-not-leak-this");

    const status = await connector.status!(ctx);
    const err = await connector
      .callTool("nope", {}, ctx)
      .then(() => null, (error: unknown) => error);
    await connector.closeScope?.(ctx);

    expect(JSON.stringify(status)).not.toContain("do-not-leak-this");
    expect(String((err as Error).message)).not.toContain("do-not-leak-this");
  });

  it("reconnects when the value rotates while the first connect is in flight", async () => {
    const captured = serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential" },
    });
    let stored = "first-secret";
    const ctx = credentialCtx(() => stored);

    // A starts connecting on V1 and does not finish before B enters.
    const first = connector.listTools(ctx);
    stored = "second-secret";
    const second = connector.listTools(ctx);
    await Promise.allSettled([first, second]);
    await connector.closeScope?.(ctx);

    // B must not have ridden A's client: the rotated-away key is abandoned and
    // a second session opens on the replacement.
    expect(sessionOpenAuthorizations(captured)).toContain(
      "Bearer second-secret",
    );
  });
});

describe("remoteMcp() credential auth — a value a header cannot carry", () => {
  const MALFORMED = "sk_live_TOPSECRET\nmore\r";

  /** Every fragment of the stored value that must appear on no surface. */
  function assertNoLeak(text: string): void {
    expect(text).not.toContain("TOPSECRET");
    expect(text).not.toContain("sk_live_");
    expect(text).not.toContain(MALFORMED.trim());
  }

  it("refuses it before framing, and says so without quoting it", async () => {
    const captured = serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential" },
    });
    const ctx = credentialCtx(() => MALFORMED);

    const err = await connector
      .listTools(ctx)
      .then(() => null, (error: unknown) => error);

    expect(err).toMatchObject({ code: "auth_required" });
    expect((err as Error).message).toContain("re-enter it on /credentials");
    assertNoLeak((err as Error).message);
    // Nothing reached the downstream: the check runs before any transport.
    expect(captured).toHaveLength(0);
  });

  it("keeps it out of every surface an agent or operator can read", async () => {
    serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential" },
    });
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, CREDENTIAL_KEY);
    await vault.set("down", MALFORMED, "user_1");
    const registry = makeRegistry([connector], {
      storage,
      credentialVault: vault,
    });

    // 1. The call_tool result — the one that leaves the host for the model.
    const activity = activitySink();
    const result = await createMetaTools(registry, BASE, {
      activity: activity.activity,
    }).callTool({
      address: "down.echo",
      args: { text: "hi" },
    });
    expect(result.isError).toBe(true);
    assertNoLeak(JSON.stringify(result));

    // 2. Connector status, which the operator page renders.
    assertNoLeak(JSON.stringify(await registry.statusFor("down", BASE)));

    // 3. The /credentials Test result.
    assertNoLeak(
      JSON.stringify(
        await connector.testCredential!(
          MALFORMED,
          registry.contextFor("down", BASE),
        ),
      ),
    );

    // 4. The payload-free activity event.
    assertNoLeak(JSON.stringify(activity.events));

    // 5. The thrown error itself, whatever catches it next.
    const err = await connector
      .callTool("echo", { text: "hi" }, registry.contextFor("down", BASE))
      .then(() => null, (error: unknown) => error);
    assertNoLeak(`${(err as Error).message}${(err as Error).stack ?? ""}`);
  });

  it("refuses an interior control character in any framing", async () => {
    serveDownstream();
    for (const scheme of [null, "Bearer", "Basic", "Bearer Basic"] as const) {
      const connector = remoteMcp("down", {
        url: URL_UNDER_TEST,
        auth: { type: "credential", scheme },
      });
      // Base64 would launder the newline for the Basic framings; the value is
      // still a paste to redo, so the refusal does not depend on the framing.
      await expect(
        connector.listTools(credentialCtx(() => MALFORMED)),
      ).rejects.toMatchObject({ code: "auth_required" });
    }
  });

  it("refuses a header name that is not a field token, at construction", () => {
    expect(() =>
      remoteMcp("down", {
        url: URL_UNDER_TEST,
        auth: { type: "credential", header: "X Bad" },
      }),
    ).toThrow("not a valid HTTP field name");
  });
});

describe("remoteMcp() credential auth — the Test action", () => {
  it("reports the catalog the stored credential reaches, and closes its scope", async () => {
    serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential" },
    });
    const ctx = credentialCtx(() => "stored-secret");

    await expect(
      connector.testCredential!("stored-secret", ctx),
    ).resolves.toEqual({
      ok: true,
      message: "Connected — the downstream served 1 tool.",
    });
    // The scope is closed, not merely abandoned: reusing it is refused, which
    // is what closeScope's tombstone does and nothing else does.
    await expect(connector.listTools(ctx)).rejects.toThrow("scope ended");
  });

  it("reports a downstream that will not answer, and still closes its scope", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential" },
    });
    const ctx = credentialCtx(() => "stored-secret");

    await expect(
      connector.testCredential!("stored-secret", ctx),
    ).resolves.toMatchObject({ ok: false });
    await expect(connector.listTools(ctx)).rejects.toThrow("scope ended");
  });

  it("refuses to report on a candidate that is not what is saved", async () => {
    serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential" },
    });

    // The route hands this hook the stored value, so the connect below tests
    // the same string. A future route testing an unsaved candidate must be
    // told no rather than quietly graded on the old value.
    await expect(
      connector.testCredential!("a-candidate", credentialCtx(() => "what-is-saved")),
    ).resolves.toEqual({
      ok: false,
      message:
        "This connector tests the credential that is currently saved. Save " +
        "the value first, then test it.",
    });
  });
});

describe("remoteMcp() unauthenticated status for a non-OAuth connector", () => {
  it.each([
    ["credential", { type: "credential" } as const],
    [
      "headers",
      { type: "headers", headers: { Authorization: "Bearer stale" } } as const,
    ],
  ])("never offers a consent URL for %s auth", async (_shape, auth) => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 401 }));
    const connector = remoteMcp("down", { url: URL_UNDER_TEST, auth });
    const ctx =
      auth.type === "credential"
        ? credentialCtx(() => "stored-secret")
        : vaultlessCtx();

    // A downstream 401 without an auth provider is an SDK HTTP failure, not an
    // `UnauthorizedError`, so neither shape reaches the authRequired latch at
    // all — and neither may hand back a URL to open, which is what the
    // OAuth-only guard in `status()` protects if one ever does.
    const status = await connector.status!(ctx);
    expect(status).not.toHaveProperty("authorizationUrl");
    expect(JSON.stringify(status)).not.toContain("stored-secret");
    await connector.closeScope?.(ctx);
  });
});

describe("remoteMcp() credential auth — cleartext destination", () => {
  it("warns when an operator-managed credential would travel over http://", () => {
    const { logger, warn } = loggerSpy();
    remoteMcp("down", {
      url: "http://downstream.test/mcp",
      auth: { type: "credential" },
      logger,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("cleartext"),
    );
  });

  it("does not warn over https:// or loopback", () => {
    const { logger, warn } = loggerSpy();
    remoteMcp("secure", {
      url: URL_UNDER_TEST,
      auth: { type: "credential" },
      logger,
    });
    remoteMcp("local", {
      url: "http://localhost:8787/mcp",
      auth: { type: "credential" },
      logger,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("still refuses a cleartext destination under requireHttps", () => {
    expect(() =>
      remoteMcp("down", {
        url: "http://downstream.test/mcp",
        auth: { type: "credential" },
        requireHttps: true,
        logger: silentLogger,
      }),
    ).toThrow("refusing to connect");
  });
});

describe("remoteMcp() credential auth — through the deployment", () => {
  // Each call builds a fresh context, so each gets its own request scope and
  // its own connect — the digest path is not what reconnects here. What this
  // asserts is that the registry hands the vault through, and that a value
  // saved between two requests is the one the next request sends.
  it("hands the vault through, so each request sends what is saved now", async () => {
    const captured = serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: { type: "credential" },
    });
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, CREDENTIAL_KEY);
    const registry = makeRegistry([connector], {
      storage,
      credentialVault: vault,
    });

    await expect(
      connector.listTools(registry.contextFor("down", BASE)),
    ).rejects.toMatchObject({ code: "auth_required" });

    await vault.set("down", "first-secret", "user_1");
    await connector.listTools(registry.contextFor("down", BASE));

    await vault.set("down", "second-secret", "user_1");
    await connector.listTools(registry.contextFor("down", BASE));

    expect(sessionOpenAuthorizations(captured)).toEqual([
      "Bearer first-secret",
      "Bearer second-secret",
    ]);
  });

  it("hands authorize_connector the /credentials recovery, not an OAuth URL", async () => {
    serveDownstream();
    const connector = remoteMcp("down", {
      url: URL_UNDER_TEST,
      auth: {
        type: "credential",
        credential: {
          label: "API v2 secret key",
          description: "The key for this project.",
        },
      },
    });
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, CREDENTIAL_KEY);
    await vault.set("down", "do-not-return-this-secret", "user_1");
    const result = await createMetaTools(
      makeRegistry([connector], { storage, credentialVault: vault }),
      BASE,
    ).authorizeConnector({ connector: "down" });

    expect(result.isError).toBeFalsy();
    const text = required(result.content[0]).text;
    expect(JSON.parse(text)).toMatchObject({
      connector: "down",
      recovery: "operator_config",
      credential: {
        label: "API v2 secret key",
        fields: [{ name: "value", guidance: "The key for this project." }],
      },
      operatorUrl: `${BASE}/credentials`,
    });
    expect(text).not.toContain("do-not-return-this-secret");
  });
});
