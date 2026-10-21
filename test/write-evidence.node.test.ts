// Node-only: streams a request body over undici with `duplex: "half"`; workerd ends a request whose body stream errors and reports success.
// The reviewer's case: the server received body bytes before the body's own
// producer raised a connect-phase errno, so the errno proves nothing.
import { expect, inject, it } from "vitest";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import { InvocationService } from "../src/invocation.js";
import { CatalogService } from "../src/catalog-service.js";
import { classifyWriteOutcome } from "../src/write-outcome.js";
import { makeRegistry } from "./helpers.js";

it("INV-9: a streamed write whose producer raised ECONNREFUSED after the server read 20 bytes is unknown", async () => {
  const id = crypto.randomUUID();
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new Uint8Array(20).fill(65));
        else controller.error(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
      },
    },
    { highWaterMark: 0 },
  );
  const send = guardedFetch({
    provider: "Tickets",
    baseUrl: `${inject("evidenceHttpServer")}/${id}`,
    authenticate: () => ({}),
    maxResponseBytes: 1024,
    fetch: (url, init) => fetch(url, { ...init, duplex: "half" } as RequestInit),
  });
  const connector = tracksEveryRequest(
    api("tickets", {
      tools: [
        {
          name: "upload",
          description: "Upload a ticket attachment",
          annotations: { readOnlyHint: false },
          handler: (_args, ctx) => send({ method: "POST", path: "/sink", rawBody: body }, ctx, (r) => r.json()),
        },
      ],
    }),
  );
  const registry = makeRegistry([connector]);
  const result = await new InvocationService(registry, new CatalogService(registry, "https://connecta.example")).invoke(
    "tickets.upload",
    {},
    { source: "call_destructive_tool" },
  );
  if (result.ok) throw new Error("expected the write to fail");
  // undici reports the producer's errno as the fetch failure's cause.
  expect(result.error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
  expect(
    classifyWriteOutcome({
      ok: false,
      dispatched: result.dispatched,
      answered: result.answered === true,
      error: result.error,
    }),
  ).toBe("unknown");
  let received: Array<{ bytes: number }> = [];
  for (let attempt = 0; attempt < 50 && received[0]?.bytes !== 20; attempt++) {
    received = (await (await fetch(`${inject("evidenceHttpServer")}/${id}/exchanges`)).json()) as typeof received;
    if (received[0]?.bytes !== 20) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(received).toEqual([{ method: "POST", bytes: 20 }]);
});

it("INV-9: a Blob write whose overridden stream() raised ECONNREFUSED after the server read 20 bytes is unknown", async () => {
  const id = crypto.randomUUID();
  let pulls = 0;
  // undici reads a Blob body through its stream(), so a Blob can carry a
  // producer of its own.
  const blob = new Blob([new Uint8Array(64)]);
  Object.defineProperty(blob, "stream", {
    value: () =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (pulls++ === 0) controller.enqueue(new Uint8Array(20).fill(65));
            else controller.error(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
          },
        },
        { highWaterMark: 0 },
      ),
  });
  const send = guardedFetch({
    provider: "Tickets",
    baseUrl: `${inject("evidenceHttpServer")}/${id}`,
    authenticate: () => ({}),
    maxResponseBytes: 1024,
  });
  const ctx = makeRegistry([]).contextFor("tickets", "https://connecta.example");
  const error = await send({ method: "POST", path: "/sink", rawBody: blob }, ctx, (r) => r.json()).then(
    () => {
      throw new Error("expected the write to fail");
    },
    (failure: unknown) => failure,
  );
  expect(pulls).toBeGreaterThan(1);
  expect(error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
  let received: Array<{ bytes: number }> = [];
  for (let attempt = 0; attempt < 50 && received[0]?.bytes !== 20; attempt++) {
    received = (await (await fetch(`${inject("evidenceHttpServer")}/${id}/exchanges`)).json()) as typeof received;
    if (received[0]?.bytes !== 20) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(received).toEqual([{ method: "POST", bytes: 20 }]);
});
