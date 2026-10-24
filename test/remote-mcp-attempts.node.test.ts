// Node-only: process-global undici dispatcher and the owned Node socket sender.
import { Agent, RetryAgent, fetch as dispatcherFetch, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { expect, it, onTestFinished, vi } from "vitest";
import { configureGuardedTransport } from "../src/guarded-transport.js";
import { nodeGuardedTransport } from "../src/http/node-transport.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { probeRemoteAttempt } from "./fixtures/remote-mcp-attempts.js";

/** A host interceptor makes fetch's streamed JSON body replayable by RetryAgent. */
function installHostRetries() {
  const previous = getGlobalDispatcher();
  const retry = new RetryAgent(new Agent(), {
    methods: ["POST"],
    statusCodes: [503],
    maxRetries: 1,
    minTimeout: 1,
    maxTimeout: 1,
  });
  setGlobalDispatcher(
    retry.compose((dispatch) => (options, handler) => {
      void (async () => {
        const chunks: Buffer[] = [];
        if (options.body)
          for await (const chunk of options.body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
        dispatch({ ...options, body: Buffer.concat(chunks) }, handler);
      })().catch((error: Error) => handler.onError?.(error));
      return true;
    }),
  );
  // Node 26's bundled undici uses dispatcher protocol v2. Exercise the pinned
  // v1 fetch there; on supported Node 22 this uses native fetch unchanged.
  if (Number(process.versions.undici?.split(".")[0]) >= 8) vi.stubGlobal("fetch", dispatcherFetch);
  onTestFinished(async () => {
    vi.unstubAllGlobals();
    setGlobalDispatcher(previous);
    await retry.close();
  });
}

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
  for (const versionNegotiation of ["legacy", "auto"] as const)
    for (const challenge of ["json", "sse"]) {
      const probe = await probeRemoteAttempt(challenge, "write", { versionNegotiation });
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
        headers: { "x-probe": "fixture", "content-type": "application/json" },
      });
      expect(probe.wire[0]!.headers.accept).toContain("text/event-stream");
      expect(JSON.parse(probe.received[0]!)).toMatchObject({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "create_item", arguments: {} },
      });
      await expect.poll(probe.inspect).toMatchObject({ closed: 1 });
    }
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
