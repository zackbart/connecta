import { installHostRetries } from "./fixtures/host-retries.js";
// Node-only: process-global undici dispatcher and the owned Node socket sender.
import { expect, inject, it, onTestFinished } from "vitest";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { configureGuardedTransport } from "../src/guarded-transport.js";
import { nodeGuardedTransport } from "../src/http/node-transport.js";
import { createMetaTools } from "../src/meta-tools.js";
import { scopes } from "../src/storage/keys.js";
import { memoryStorage } from "../src/storage/memory.js";
import { seedGrant } from "./fixtures/oauth.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { probeRemoteAttempt } from "./fixtures/remote-mcp-attempts.js";
import { makeRegistry } from "./helpers.js";

for (const challenge of ["421-closed", "421-open", "reset", "retry-reset", "retry-503"])
  it(`INV-1 INV-9: the owned remote MCP write sends once after ${challenge}`, { timeout: 30_000 }, async () => {
    if (challenge.startsWith("retry")) installHostRetries();
    const previous = configureGuardedTransport(nodeGuardedTransport);
    onTestFinished(() => {
      configureGuardedTransport(previous);
    });
    for (const operation of ["write", "source-write", "effective-write", "read", "resource"] as const) {
      const probe = await probeRemoteAttempt(challenge, operation);
      const write = operation.includes("write");
      const repeatedRead = !write && (challenge === "421-open" || challenge.startsWith("retry"));
      expect(probe.received, operation).toHaveLength(repeatedRead ? 2 : 1);
      expect(new Set(probe.received).size, operation).toBe(1);
      // An owned 421 is the first physical reply, so the existing core HTTP
      // refusal rule applies. A reset or 503 cannot confirm the write failed.
      if (write)
        expect(probe.error, operation).toMatchObject({
          retryable: false,
          ...(challenge.startsWith("421") ? {} : { writeOutcome: "unknown" }),
        });
      else if (repeatedRead) expect(probe.error, operation).toBeUndefined();
      else expect(probe.error, operation).toMatchObject({ retryable: true });
    }
  });

for (const challenge of ["retry-reset", "retry-503"])
  it(
    `INV-9: native remote MCP writes are a duplicate-send control under ${challenge}`,
    { timeout: 30_000 },
    async () => {
      installHostRetries();
      // Deliberately substitute native fetch, never a production sender.
      installOwnedTransport();
      for (const operation of ["write", "read", "resource"] as const) {
        const probe = await probeRemoteAttempt(challenge, operation);
        expect(probe.received, operation).toHaveLength(2);
        expect(new Set(probe.received).size).toBe(1);
        expect(probe.error, operation).toBeUndefined();
      }
    },
  );

it("INV-9 INV-11: a remote write without the owned Node transport is refused before dispatch", async () => {
  const previous = configureGuardedTransport(undefined);
  onTestFinished(() => {
    configureGuardedTransport(previous);
  });
  const probe = await probeRemoteAttempt("pass", "write");
  expect(probe.received).toEqual([]);
  expect(probe.error).toMatchObject({ retryable: false, message: expect.stringContaining("@zackbart/connecta/node") });
  expect(probe.error).not.toHaveProperty("writeOutcome", "unknown");
});

it("INV-7 INV-9: owned remote writes preserve modern JSON/SSE and legacy SDK wire contracts", async () => {
  const previous = configureGuardedTransport(nodeGuardedTransport);
  onTestFinished(() => {
    configureGuardedTransport(previous);
  });
  for (const [versionNegotiation, challenge, unicode] of [
    ["legacy", "json", false],
    ["legacy", "sse", false],
    ["auto", "json", false],
    ["auto", "sse", false],
    ["auto", "json", true],
  ] as const) {
    const args = unicode ? { label: "café 😀" } : {};
    const probe = await probeRemoteAttempt(challenge, "write", {
      versionNegotiation,
      args,
      ...(unicode ? { headers: { "user-agent": "fixture-client/1.0" } } : {}),
    });
    expect(probe.error, `${versionNegotiation} ${challenge}`).toBeUndefined();
    expect(probe.result).toEqual({
      content: [{ type: "text", text: "ok" }],
      ...(versionNegotiation === "auto"
        ? { _meta: { "io.modelcontextprotocol/serverInfo": { name: "attempt-probe", version: "1.0.0" } } }
        : {}),
    });
    expect(probe.received).toHaveLength(1);
    expect(probe.wire[0]).toMatchObject({
      method: "POST",
      headers: {
        "x-probe": "fixture",
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(probe.received[0]!, "utf8")),
        "user-agent": unicode ? "fixture-client/1.0" : "connecta",
      },
    });
    expect(probe.wire[0]!.headers).not.toHaveProperty("transfer-encoding");
    expect(probe.wire[0]!.headers.accept).toContain("text/event-stream");
    expect(JSON.parse(probe.received[0]!)).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "create_item", arguments: args },
    });
    await expect.poll(probe.inspect).toMatchObject({ closed: 1 });
  }
});

it("INV-9: an owned socket write answered 401 retains the reauthorization prompt without replay", async () => {
  const previous = configureGuardedTransport(nodeGuardedTransport);
  onTestFinished(() => {
    configureGuardedTransport(previous);
  });
  const control = inject("remoteMcpAttemptServer");
  const { origin, id } = (await (await fetch(`${control}/401`, { method: "POST" })).json()) as {
    origin: string;
    id: string;
  };
  const storage = memoryStorage();
  const connector = remoteMcp("remote", { url: `${origin}/mcp`, auth: { type: "oauth" } });
  const registry = makeRegistry([connector], { storage });
  const base = "https://connecta.example";
  await seedGrant(
    storage,
    {
      issuer: origin,
      client: {
        value: {
          client_id: "fixture-client",
          redirect_uris: [`${base}/oauth/callback/remote`],
          token_endpoint_auth_method: "none",
        },
      },
      tokens: { access_token: "stale-access", refresh_token: "stale-refresh", token_type: "Bearer" },
    },
    "v3:seeded",
    scopes.connector("remote"),
  );
  const result = await createMetaTools(registry, base).callDestructiveTool({ address: "remote.create_item", args: {} });
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({
    error: {
      code: "downstream_oauth_required",
      retryable: false,
      reconciliationRequired: true,
      writeOutcome: "unknown",
      nextAction: { tool: "authorize_connector", arguments: { connector: "remote" } },
    },
  });
  const state = (await (await fetch(`${control}/${id}`)).json()) as { received: string[]; closed: number };
  expect(state.received).toHaveLength(1);
  expect(state.closed).toBe(1);
});

it("INV-7 INV-9: cancelling a remote write closes the owned SSE body and never resends", async () => {
  const previous = configureGuardedTransport(nodeGuardedTransport);
  onTestFinished(() => {
    configureGuardedTransport(previous);
  });
  const probe = await probeRemoteAttempt("sse-hold", "write", { signal: AbortSignal.timeout(500) });
  expect(probe.received).toHaveLength(1);
  expect(probe.error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
  await expect.poll(probe.inspect).toMatchObject({ closed: 1 });
});
