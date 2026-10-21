// A write is a known failure only on evidence the guarded transport itself
// gathered: real refused and reset connections, through each runtime's own
// fetch. Node's undici names a refused connect's errno; workerd names none,
// so there a failed write without an answer is never proven unsent.
import { describe, expect, inject, it } from "vitest";
import { api } from "../src/connectors/api.js";
import { guardedFetch, type GuardedRequest } from "../src/connectors/guarded-fetch.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import { InvocationService } from "../src/invocation.js";
import { CatalogService } from "../src/catalog-service.js";
import { classifyWriteOutcome } from "../src/write-outcome.js";
import { makeRegistry } from "./helpers.js";

const WORKERD = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
const BASE = "https://connecta.example";

async function write(baseUrl: string, request: GuardedRequest) {
  const send = guardedFetch({
    provider: "Tickets",
    baseUrl,
    authenticate: () => ({}),
    maxResponseBytes: 1024,
  });
  const connector = tracksEveryRequest(
    api("tickets", {
      tools: [
        {
          name: "send",
          description: "Send a ticket",
          annotations: { readOnlyHint: false },
          handler: (_args, ctx) => send(request, ctx, (response) => response.json()),
        },
      ],
    }),
  );
  const registry = makeRegistry([connector]);
  const result = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
    "tickets.send",
    {},
    { source: "call_destructive_tool" },
  );
  if (result.ok) throw new Error("expected the write to fail");
  return {
    error: result.error,
    state: classifyWriteOutcome({
      ok: false,
      dispatched: result.dispatched,
      answered: result.answered === true,
      error: result.error,
    }),
  };
}

async function exchanges(id: string): Promise<Array<{ method: string; bytes: number }>> {
  return (await (await fetch(`${inject("evidenceHttpServer")}/${id}/exchanges`)).json()) as Array<{
    method: string;
    bytes: number;
  }>;
}

describe("write evidence over real connections", () => {
  it.each([
    ["no body", { method: "DELETE", path: "/tickets/1" }],
    ["a JSON body", { method: "POST", path: "/tickets", body: { title: "Fixture" } }],
  ] as const)("INV-9: a write whose connection is refused, with %s", async (_name, request) => {
    const { error, state } = await write(inject("refusedHttpOrigin"), request);
    if (WORKERD) {
      // "Network connection lost." with no errno: nothing proves it unsent.
      expect(error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
      expect(state).toBe("unknown");
    } else {
      expect(error).toMatchObject({ code: "unavailable", retryable: true, details: { code: "ECONNREFUSED" } });
      expect(error).not.toHaveProperty("writeOutcome");
      expect(state).toBe("failed");
    }
  });

  it("INV-9: a write the server received before the connection reset is unknown on every runtime", async () => {
    const id = crypto.randomUUID();
    const { error, state } = await write(`${inject("evidenceHttpServer")}/${id}`, {
      method: "POST",
      path: "/reset",
      body: { title: "Fixture" },
    });
    expect(error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    expect(state).toBe("unknown");
    expect(await exchanges(id)).toEqual([{ method: "POST", bytes: JSON.stringify({ title: "Fixture" }).length }]);
  });
});

describe("an aborted write never proves itself unsent", () => {
  const tickets = (baseUrl: string) => {
    const send = guardedFetch({ provider: "Tickets", baseUrl, authenticate: () => ({}), maxResponseBytes: 1024 });
    const connector = tracksEveryRequest(
      api("tickets", {
        tools: [
          {
            name: "send",
            description: "Send a ticket",
            annotations: { readOnlyHint: false },
            handler: (args, ctx) => send(args as GuardedRequest, ctx, (response) => response.json()),
          },
        ],
      }),
    );
    return { send, connector, registry: makeRegistry([connector]) };
  };
  const failure = (pending: Promise<unknown>) =>
    pending.then(
      () => {
        throw new Error("expected the write to fail");
      },
      (error: unknown) => error,
    );

  it("INV-9: a write aborted with a real refusal as its reason, after the server read its body, is unknown", async () => {
    // A genuine connect-phase failure from another request. workerd names no
    // errno, so there the reason is shaped as undici's own.
    const refusal = await fetch(inject("refusedHttpOrigin")).then(
      () => undefined,
      (error: unknown) => error,
    );
    const reason = WORKERD
      ? new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        })
      : refusal;
    expect(reason).toMatchObject({ cause: { code: "ECONNREFUSED" } });
    const body = { title: "Fixture" };
    for (const ledger of [true, false]) {
      const id = crypto.randomUUID();
      const { send, connector, registry } = tickets(`${inject("evidenceHttpServer")}/${id}`);
      const controller = new AbortController();
      const ctx = registry.contextFor("tickets", BASE, undefined, { signal: controller.signal });
      const request = { method: "POST", path: "/hold", body } as const;
      const pending = failure(
        ledger ? connector.callTool("send", request, ctx) : send(request, ctx, (response) => response.json()),
      );
      // Abort only once the server holds every byte the write carried.
      let received: Array<{ method: string; bytes: number }> = [];
      for (let attempt = 0; attempt < 200 && received[0]?.bytes !== JSON.stringify(body).length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        received = await exchanges(id);
      }
      expect(received).toEqual([{ method: "POST", bytes: JSON.stringify(body).length }]);
      controller.abort(reason);
      const error = await pending;
      expect(error, `ledger: ${ledger}`).toMatchObject({ retryable: false, writeOutcome: "unknown" });
      expect(classifyWriteOutcome({ ok: false, dispatched: true, answered: false, error: error as never })).toBe(
        "unknown",
      );
    }
  });

  it("INV-9: a refused write with no body and a live signal stays a known failure on Node", async () => {
    const { connector, registry } = tickets(inject("refusedHttpOrigin"));
    const ctx = registry.contextFor("tickets", BASE, undefined, { signal: new AbortController().signal });
    const error = await failure(connector.callTool("send", { method: "DELETE", path: "/tickets/1" }, ctx));
    if (WORKERD) {
      expect(error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    } else {
      expect(error).toMatchObject({ code: "unavailable", retryable: true, details: { code: "ECONNREFUSED" } });
      expect((error as { writeOutcome?: unknown }).writeOutcome).toBeUndefined();
    }
  });
});
