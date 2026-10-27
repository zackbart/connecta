import { timingSafeEqual } from "node:crypto";
import { endpoint, selectBinding } from "./endpoint.mjs";
import { proof } from "./proof.mjs";

export async function handle(
  request,
  { expected, origin, runId, runKey, bypass, deploymentId, getToken, exchange, retain, emit, verify, onRead },
) {
  const supplied = Buffer.from(request.headers.get("x-proof-key") ?? "");
  const wanted = Buffer.from(runKey ?? "");
  if (!wanted.length || supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted))
    return new Response(null, { status: 401 });
  const url = new URL(request.url);
  if (request.method !== "POST") return new Response(null, { status: 405 });
  let sequence = 0;
  const receipt = (stage, signalAborted) =>
    emit({
      event: "workload-proof",
      runId,
      deploymentId,
      stage,
      signalAborted,
      at: Date.now(),
      sequence: ++sequence,
      runtime: process.version,
    });
  try {
    if (url.pathname === "/proof") {
      let invocations = 0;
      const fetcher = (input, init = {}) => {
        if (new URL(input).origin !== origin || ++invocations > 15)
          throw new Error("Fixture invocation bound exceeded");
        const headers = new Headers(init.headers);
        headers.set("x-proof-key", runKey);
        if (bypass) headers.set("x-vercel-protection-bypass", bypass);
        return fetch(input, { ...init, headers });
      };
      const result = await proof({ origin, expected, getToken, exchange, fetcher, verify });
      return Response.json(
        {
          ...result,
          live: Boolean(process.env.VERCEL),
          deploymentId,
          runId,
          runtime: process.version,
          invocations: invocations + 1,
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    let started;
    const ready = new Promise((accept) => {
      started = accept;
    });
    const app = endpoint(
      selectBinding(expected, url.searchParams.get("variant") ?? "positive"),
      onRead,
      (stage, aborted) => {
        receipt(stage, aborted);
        if (stage === "handler-started") started();
      },
    );
    if (url.pathname === "/agent/assistant" && url.searchParams.get("cancel") === "1") {
      // The original platform Request goes straight to Connecta. Neither
      // cancelling our response reader nor closing the app fabricates abort.
      const work = (async () => {
        try {
          const response = await app.fetch(request);
          await response.arrayBuffer();
        } finally {
          await app.close();
          receipt("app-closed", request.signal.aborted);
        }
      })();
      retain(work.catch(() => {}));
      await Promise.race([
        ready,
        work.then(() => {
          throw new Error("Handler never started");
        }),
      ]);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": handler-started\n\n"));
            void work
              .then(
                () => controller.close(),
                () => controller.error(new Error("fixture ended")),
              )
              .catch(() => {});
          },
          cancel() {},
        }),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-store, no-transform" } },
      );
    }
    try {
      const response = await app.fetch(request);
      return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
    } finally {
      await app.close();
    }
  } catch {
    return Response.json({ error: "proof_failed" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
