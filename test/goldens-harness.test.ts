import { NODE, WORKERS } from "./fixtures/runtime-tags.js";
// The characterization harness's own tests: each provider-side mutation the
// goldens exist to catch must change a golden or fail the capture, and no
// schedule may. A seam stands in for a provider that calls fetch differently
// or waits on its own timer; spies weaken sent-secret redaction. See the
// contributor section of documentation/architecture.md.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Clock, Effect, Scheduler } from "effect";
import { runEdge } from "../src/runtime/run.js";
import {
  captureCall as captureCallBoth,
  captureGoldens as captureGoldensBoth,
  GOLDEN_NOW,
  type Replies,
  errorEchoForms,
  LEAK_RUN_UNITS,
  leakedSecret,
  secretEncodings,
  type FetchSeam,
  type GoldenSpec,
  type StubResponse,
} from "./goldens/harness.js";
import infisical from "./goldens/infisical/spec.js";
import planningCenter from "./goldens/planning-center/spec.js";

import { canonicalGolden } from "./goldens/canonical.js";
import { PRIVATE_KEY, PUBLIC_KEY } from "./goldens/rsa-fixture.js";
import { goldenSources } from "./goldens/sources.js";

// Small source probes use one order. Nightly's Node job exercises every seed.
const determinism = process.env.CONNECTA_GOLDENS_DETERMINISM === "1";
const captureCall: typeof captureCallBoth = (spec, label, options) =>
  captureCallBoth(spec, label, { orders: "canonical", ...options });
const captureGoldens: typeof captureGoldensBoth = (spec, options) =>
  captureGoldensBoth(spec, { orders: "canonical", ...options });

const specs = Object.values(import.meta.glob<GoldenSpec>("./goldens/*/spec.ts", { import: "default", eager: true }))
  .slice()
  .sort((a, b) => a.provider.localeCompare(b.provider));
const stored = import.meta.glob<string>("./goldens/*/*.json", { query: "?raw", import: "default", eager: true });
const storedInfisicalCalls = canonicalGolden(stored["./goldens/infisical/calls.json"]!);

interface Row {
  label: string;
  steps: Array<Array<{ url: string; after: number }>>;
  variants?: Array<Row & { order: "reverse" }>;
  waitedMs?: number;
  result: unknown;
}

const rowOf = (calls: string, label: string) => (JSON.parse(calls) as Row[]).find((row) => row.label === label)!;
/** How many requests each causal step of a call held. */
const stepSizes = (row: Row) => row.steps.map((step) => step.length);
const requestsOnly = (row: Row) => row.steps.flat().map(({ after: _after, ...request }) => request);

/** Minimal provider for causal and host-API probes; uses the same invocation path. */
function probeSpec(work: () => Promise<unknown>, replies?: Replies): GoldenSpec {
  const tools = [
    {
      name: "probe",
      description: "Harness probe",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
  ];
  return {
    ...infisical,
    provider: "probe",
    auxiliary: [],
    create: () => ({ id: "probe", kind: "api", staticTools: tools, listTools: async () => tools, callTool: work }),
    calls: [{ tool: "probe", ...(replies ? { replies } : {}) }],
  };
}

// Deliberately saved before capture and before fresh module loading.
const savedImmediate = (globalThis as { setImmediate?: (callback: () => void) => NodeJS.Immediate }).setImmediate?.bind(
  globalThis,
);
const savedTimeout = globalThis.setTimeout.bind(globalThis);
const savedAbortTimeout = AbortSignal.timeout.bind(AbortSignal);
const savedDigest = crypto.subtle.digest.bind(crypto.subtle);

// A producer-fed body read deliberately exceeding the 10,000-turn
// polling limit. It must reject rather than extending the native-only budget.
// Harness-native turns avoid virtual time and runner-clock mocks.
function delayedRead(): Promise<string> {
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let turn = 0; turn < 11_000; turn++) await goldenSources().turn();
        controller.enqueue(new TextEncoder().encode("body"));
        controller.close();
      },
    }),
  ).text();
}
// A counted read whose producer queues controlled work after the driver's
// tick. Native yields must never strand the subsequent zero-time callback.
function queuedTimerRead(turns = 0, callbacks = 1): Promise<string> {
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let turn = 0; turn < turns; turn++) await goldenSources().turn();
        const produce = () => {
          if (--callbacks > 0) queueMicrotask(() => setTimeout(produce, 0));
          else {
            controller.enqueue(new TextEncoder().encode("body"));
            controller.close();
          }
        };
        queueMicrotask(() => setTimeout(produce, 0));
      },
    }),
  ).text();
}
function producedStream(produce: (close: () => void) => void | Promise<void>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      return produce(() => {
        controller.enqueue(new TextEncoder().encode("body"));
        controller.close();
      });
    },
  });
}
function producedRead(produce: (close: () => void) => void | Promise<void>): Promise<string> {
  return new Response(producedStream(produce)).text();
}
const controlledIOCases = [
  {
    name: "a positive timer behind a microtask",
    produce: (close: () => void) => {
      queueMicrotask(() => setTimeout(close, 1));
    },
  },
  {
    name: "a zero-delay interval needing three callbacks",
    produce: (close: () => void) => {
      let callbacks = 0;
      const interval = setInterval(() => {
        if (++callbacks === 3) {
          clearInterval(interval);
          close();
        }
      }, 0);
    },
  },
  {
    name: "a longer-delay chain",
    produce: (close: () => void) => {
      queueMicrotask(() => setTimeout(() => setTimeout(() => setTimeout(close, 5_000), 50), 2));
    },
  },
  {
    name: "a native producer's direct zero timer then future close",
    produce: async (close: () => void) => {
      for (let turn = 0; turn < 3; turn++) await goldenSources().turn();
      setTimeout(() => setTimeout(close, 1), 0);
    },
  },
];
// These timeouts only guard regressions: rejection comes from the harness's
// bounded turn loop, never from elapsed time.
const CONTROLLED_IO = { ...WORKERS, timeout: 30_000 };
const DRAIN_REJECTION = "Controlled work could not drain after rejected capture";
async function expectCleanCapture(): Promise<void> {
  const clean = JSON.parse(
    await captureCall(
      probeSpec(async () => "clean"),
      "probe",
    ),
  ) as Row;
  expect(clean.result).toMatchObject({ ok: true, value: "clean" });
}
const countedReadCases = [
  { name: "delayed counted I/O", read: delayedRead },
  { name: "counted I/O with a queued zero timer", read: queuedTimerRead },
];
const savedNow = performance.now.bind(performance);
const savedDateNow = Date.now.bind(Date);
const descriptorDateNow = Object.getOwnPropertyDescriptor(Date, "now")!.value as () => number;
const savedCompression = CompressionStream;
const savedFetch = fetch.bind(globalThis);
const savedWait = (globalThis as { scheduler?: { wait(ms: number): Promise<void> } }).scheduler?.wait.bind(
  (globalThis as { scheduler?: object }).scheduler,
);
const savedMicrotask = queueMicrotask.bind(globalThis);
const savedHrtime = globalThis.process?.hrtime;
const savedScheduler = new Scheduler.MixedScheduler("async", (callback) => {
  if (savedImmediate) {
    const handle = savedImmediate(callback);
    return () => clearImmediate(handle);
  }
  const handle = savedTimeout(callback);
  return () => clearTimeout(handle);
});

const LOGIN = "/api/v1/auth/universal-auth/login";
const CREATE_SECRET = "/api/v4/secrets/API_KEY";

const urlOf = (input: RequestInfo | URL) => String(input instanceof Request ? input.url : input);
const isCreateSecret = (input: RequestInfo | URL, init?: RequestInit) =>
  urlOf(input).endsWith(CREATE_SECRET) && init?.method === "POST";

/** A provider that puts Authorization on a Request, then passes init.headers without it. */
const authorizationOnRequestOnly: FetchSeam = (send) => (input, init) => {
  const headers = new Headers(init?.headers);
  const authorization = headers.get("authorization");
  if (!authorization || input instanceof Request) return send(input, init);
  headers.delete("authorization");
  return send(new Request(input, { headers: { authorization } }), { ...init, headers });
};

/** A provider that logs in to Infisical with an empty body. */
const emptyLoginBody: FetchSeam = (send) => (input, init) =>
  urlOf(input).endsWith(LOGIN) ? send(input, { ...init, body: "{}" }) : send(input, init);

/** A provider that serializes the same Infisical login fields differently. */
const reshapedLogin =
  (reshape: (fields: Record<string, unknown>) => string): FetchSeam =>
  (send) =>
  (input, init) => {
    if (!urlOf(input).endsWith(LOGIN)) return send(input, init);
    if (typeof init?.body !== "string") throw new Error("the Infisical login body is no longer a string");
    return send(input, { ...init, body: reshape(JSON.parse(init.body) as Record<string, unknown>) });
  };

/** A provider that sends its write before Infisical answers the login, holding a token it already has. */
const writeBeforeLoginAnswer: FetchSeam = (send) => (input, init) => {
  if (!urlOf(input).endsWith(LOGIN)) return send(input, init);
  void send(input, init).catch(() => undefined);
  const { body } = infisical.auxiliary!.find((route) => route.name === "universal-auth-login")!.reply as StubResponse;
  return Promise.resolve(Response.json(body));
};

/** A provider that sends Infisical's create_secret write twice before either is answered. */
const writeTwiceAtOnce: FetchSeam = (send) => (input, init) => {
  if (!isCreateSecret(input, init)) return send(input, init);
  const first = send(input, init);
  void send(input, init).catch(() => undefined);
  return first;
};

/** A provider that sends it again once the first is answered. */
const writeTwiceInTurn: FetchSeam = (send) => async (input, init) => {
  if (!isCreateSecret(input, init)) return send(input, init);
  const first = await send(input, init);
  await send(input, init);
  return first;
};

/** A provider that waits on its own `ms` timer before requesting a plan's items. */
const itemsAfter =
  (ms: number): FetchSeam =>
  (send) =>
  async (input, init) => {
    if (new URL(urlOf(input)).pathname.endsWith("/items")) await new Promise((resolve) => setTimeout(resolve, ms));
    return send(input, init);
  };

function base64(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const base64Url = (value: string) => base64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

type Internals = { register(value: string, kind: number): void; store(form: string, kind: number): void };

/** The variants redaction stores for a form: percent hex folded to uppercase, from any start (`wireForms`). */
function storedVariants(form: string): string[] {
  const fold = (text: string) => text.replace(/[a-f]/g, (letter) => letter.toUpperCase());
  const folded = form.replace(/%[^%]?[^%]?/g, fold);
  return [folded, fold(folded.slice(0, 1)) + folded.slice(1), fold(folded.slice(0, 2)) + folded.slice(2)];
}

/** Sent-secret redaction that never registers `forms(value)` of a value, beyond the value itself. */
function withoutForms(forms: (value: string) => string[]): void {
  vi.doMock("../src/sent-secrets.js", async () => {
    const module = await vi.importActual<typeof import("../src/sent-secrets.js")>("../src/sent-secrets.js");
    const proto = module.SentSecrets.prototype as unknown as Internals;
    if (vi.isMockFunction(proto.register)) vi.mocked(proto.register).mockRestore();
    if (vi.isMockFunction(proto.store)) vi.mocked(proto.store).mockRestore();
    const { register, store } = proto;
    let dropped = new Set<string>();
    vi.spyOn(proto, "register").mockImplementation(function (this: Internals, value, kind) {
      const outer = dropped;
      dropped = new Set(
        forms(value)
          .filter((form) => form !== value)
          .flatMap(storedVariants),
      );
      try {
        register.call(this, value, kind);
      } finally {
        dropped = outer;
      }
    });
    vi.spyOn(proto, "store").mockImplementation(function (this: Internals, form, kind) {
      if (!dropped.has(form)) store.call(this, form, kind);
    });
    return module;
  });
}

/** Every provider's echo observation, captured before any mutation. */
async function echoBaselines(): Promise<Map<string, string>> {
  const baselines = new Map<string, string>();
  for (const spec of specs) baselines.set(spec.provider, await captureCall(spec, "echo"));
  return baselines;
}

/** Every provider whose echo fixture neither fails with a leak nor, given unmutated baselines,
 * changes. Redaction's fragment matching can cover part of a dropped form through the forms
 * that remain, so the rest of the echo then shows in the observation instead of a leak. */
async function echoesThatPass(baselines?: Map<string, string>): Promise<string[]> {
  const passed: string[] = [];
  for (const spec of specs) {
    const leak = new RegExp(`^${spec.provider} .* echoes sent secrets: the caller-visible result leaks <secret:`);
    const outcome = await captureCall(spec, "echo").then(
      (observation) => ({ observation }),
      (caught: unknown) => ({ caught }),
    );
    const leaked = "caught" in outcome && outcome.caught instanceof Error && leak.test(outcome.caught.message);
    const changed =
      "observation" in outcome && baselines !== undefined && outcome.observation !== baselines.get(spec.provider);
    if (!leaked && !changed) passed.push(spec.provider);
  }
  return passed;
}

const suiteName = "characterization golden harness";
describe(suiteName, { timeout: 120_000 }, () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../src/sent-secrets.js");
  });

  // Each mutation is compared with an unmutated capture from the same
  // harness, so a harness that stopped recording the field fails here too.
  it(
    "INV-5: records init.headers replacing a Request's headers, so a dropped Authorization changes the goldens",
    NODE,
    async () => {
      const baseline = (await captureGoldens(infisical)).calls!;
      const { calls } = await captureGoldens(infisical, { seam: authorizationOnRequestOnly });
      expect(baseline).toContain('"authorization": "Bearer <secret:accessToken>"');
      expect(calls).not.toContain('"authorization": "Bearer <secret:accessToken>"');
      expect(calls).not.toBe(baseline);
    },
  );

  it("INV-5: records auxiliary request bodies, so an emptied Infisical login changes the goldens", NODE, async () => {
    const baseline = (await captureGoldens(infisical)).calls!;
    const { calls } = await captureGoldens(infisical, { seam: emptyLoginBody });
    expect(baseline).toContain('"clientSecret": "<secret:clientSecret>"');
    expect(calls).not.toContain('"clientSecret": "<secret:clientSecret>"');
    expect(calls).not.toBe(baseline);
  });

  it(
    "records a JSON body's exact bytes, so respacing or reordering the Infisical login changes the goldens",
    NODE,
    async () => {
      const baseline = (await captureGoldens(infisical)).calls!;
      expect(baseline).not.toContain('"text": "{');
      const spaced = (
        await captureGoldens(infisical, { seam: reshapedLogin((fields) => JSON.stringify(fields, null, 1)) })
      ).calls!;
      expect(spaced).toContain('"text": "{\\n \\"clientId\\": \\"<secret:clientId>\\"');
      expect(spaced).not.toBe(baseline);
      const reordered = (
        await captureGoldens(infisical, {
          seam: reshapedLogin((fields) => JSON.stringify(Object.fromEntries(Object.entries(fields).reverse()))),
        })
      ).calls!;
      expect(reordered).not.toBe(baseline);
      expect(reordered).not.toBe(spaced);
    },
  );

  // Canonical order puts the login first in either case, so only the step
  // boundary tells the two apart.
  it(
    "records causal steps, so a write sent before the Infisical login is answered changes the goldens",
    NODE,
    async () => {
      const baseline = await captureCall(infisical, "create_secret");
      const early = await captureCall(infisical, "create_secret", { seam: writeBeforeLoginAnswer });
      expect(early).not.toBe(baseline);
      expect(stepSizes(JSON.parse(baseline) as Row)).toEqual([1, 1]);
      expect(stepSizes(JSON.parse(early) as Row)).toEqual([2]);
      expect(requestsOnly(JSON.parse(early) as Row)).toEqual(requestsOnly(JSON.parse(baseline) as Row));
    },
  );

  it("records a duplicated write, and whether its copies were sent together or in turn", NODE, async () => {
    // A duplicate must receive the same answer: distinct replies for identical
    // concurrent requests are an authoring error, tested separately below.
    const call = infisical.calls.find((candidate) => candidate.tool === "create_secret")!;
    const reply = (call.replies as StubResponse[])[0]!;
    const spec = { ...infisical, calls: [{ ...call, replies: () => reply }] };
    const baseline = await captureCall(spec, "create_secret");
    const together = await captureCall(spec, "create_secret", { seam: writeTwiceAtOnce });
    const inTurn = await captureCall(spec, "create_secret", { seam: writeTwiceInTurn });
    expect(together).not.toBe(baseline);
    expect(inTurn).not.toBe(baseline);
    expect(together).not.toBe(inTurn);
    expect(stepSizes(JSON.parse(together) as Row)).toEqual([1, 2]);
    expect(stepSizes(JSON.parse(inTurn) as Row)).toEqual([1, 1, 1]);
  });

  it("records partial dependencies: C awaiting A differs from C awaiting B, including a 0 ms timer", NODE, async () => {
    for (const timer of [false, true]) {
      const captures = new Map<string, string>();
      for (const dependency of ["a", "b"]) {
        const spec = probeSpec(async () => {
          const a = fetch("https://probe.example/a");
          const b = fetch("https://probe.example/b");
          await (dependency === "a" ? a : b);
          if (timer) await new Promise((resolve) => setTimeout(resolve, 0));
          await fetch("https://probe.example/c");
          await Promise.all([a, b]);
          return "done";
        });
        const rows = new Set<string>();
        for (const jitter of determinism ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [1])
          rows.add(await captureCall(spec, "probe", { jitter }));
        expect(rows.size).toBe(1);
        const capture = [...rows][0]!;
        const row = JSON.parse(capture) as Row;
        expect(stepSizes(row)).toEqual([2, 1]);
        expect(row.steps.flat().map((request) => request.after)).toEqual([0, 0, dependency === "a" ? 1 : 2]);
        captures.set(dependency, capture);
      }
      expect(captures.get("a")).not.toBe(captures.get("b"));
    }
  });

  it("rejects distinct queued replies for indistinguishable concurrent requests", NODE, async () => {
    const work = async () =>
      Promise.all(
        [fetch("https://probe.example/same"), fetch("https://probe.example/same")].map(async (response) =>
          (await response).text(),
        ),
      );
    for (const replies of [
      [{ text: "first" }, { text: "second" }],
      [{ body: null }, {}],
      [{ status: 201 }, { status: 202 }],
      [{ headers: { "x-probe": "first" } }, { headers: { "x-probe": "second" } }],
    ]) {
      for (const jitter of determinism ? [1, 2, 3, 4, 5, 6] : [1]) {
        await expect(captureCall(probeSpec(work, replies), "probe", { jitter })).rejects.toThrow(
          /fixture authoring error: indistinguishable concurrent requests.*distinct queued replies/,
        );
      }
    }
    // Identical replies are unambiguous, including duplicated writes.
    const a = await captureCall(probeSpec(work, [{ text: "same" }, { text: "same" }]), "probe", { jitter: 1 });
    const b = await captureCall(probeSpec(work, [{ text: "same" }, { text: "same" }]), "probe", { jitter: 2 });
    expect(a).toBe(b);
    expect((JSON.parse(a) as Row).result).toMatchObject({ ok: true, value: ["same", "same"] });
  });

  it(
    "fails loudly for native CompressionStream async iteration before a Planning Center request",
    WORKERS,
    async () => {
      const compressedItems: FetchSeam = (send) => async (input, init) => {
        if (new URL(urlOf(input)).pathname.endsWith("/items")) {
          const stream = new Blob(["probe"]).stream().pipeThrough(new CompressionStream("gzip"));
          for await (const _chunk of stream) {
            /* native work bypasses reader.read() */
          }
        }
        return send(input, init);
      };
      for (const jitter of determinism ? [1, 2, 3, 4, 5, 6] : [1]) {
        await expect(captureCall(planningCenter, "get_plan", { seam: compressedItems, jitter })).rejects.toThrow(
          /Unsupported asynchronous source: CompressionStream/,
        );
      }
    },
  );

  it("rejects scheduler.wait instead of mistaking native waiting for a fake timer", WORKERS, async () => {
    const scheduler = (globalThis as { scheduler?: { wait(ms: number): Promise<void> } }).scheduler;
    if (!scheduler) return; // Workers-only API; the same suite runs on both projects.
    await expect(
      captureCall(
        probeSpec(async () => {
          await scheduler.wait(0);
          return "done";
        }),
        "probe",
      ),
    ).rejects.toThrow(/Unsupported asynchronous source: scheduler.wait/);
  });

  const probes: Array<[string, () => Promise<unknown>]> = [
    [
      "saved setImmediate",
      async () => {
        const a = fetch("https://probe.example/a");
        for (let turn = 0; turn < 12; turn++)
          await new Promise<void>((resolve) => (savedImmediate ?? savedTimeout)(resolve));
        await fetch("https://probe.example/b");
        await a;
        return "done";
      },
    ],
    [
      "Effect saved immediate scheduler",
      async () => {
        const a = fetch("https://probe.example/a");
        const dispatcher = savedScheduler.makeDispatcher();
        for (let turn = 0; turn < 12; turn++) await new Promise<void>((resolve) => dispatcher.scheduleTask(resolve, 0));
        await fetch("https://probe.example/b");
        await a;
        return "done";
      },
    ],
    [
      "prebound crypto.subtle.digest",
      async () => [...new Uint8Array(await savedDigest("SHA-256", new Uint8Array([1, 2, 3])))],
    ],
    [
      "saved setTimeout(0)",
      async () => {
        await new Promise((resolve) => savedTimeout(resolve, 0));
        return "done";
      },
    ],
    [
      "saved AbortSignal.timeout(0)",
      async () => {
        const signal = savedAbortTimeout(0);
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return signal.reason.name;
      },
    ],
    [
      "prebound clocks",
      async () => {
        const before = savedNow();
        await new Promise((resolve) => savedTimeout(resolve, 5));
        return {
          before,
          after: savedNow(),
          date: savedDateNow(),
          descriptorDate: descriptorDateNow(),
          nanos: savedHrtime ? String(savedHrtime.bigint()) : "absent",
        };
      },
    ],
    [
      "saved queueMicrotask",
      async () => {
        await new Promise<void>((resolve) => savedMicrotask(resolve));
        return "done";
      },
    ],
  ];
  for (const [name, work] of probes) {
    it(`controls ${name} captured before provider imports`, WORKERS, async () => {
      const rows = new Set<string>();
      for (const jitter of determinism ? [1, 2, 3, 4, 5, 6] : [1])
        rows.add(await captureCall(probeSpec(work), "probe", { jitter }));
      expect(rows.size, name).toBe(1);
      const row = JSON.parse([...rows][0]!) as Row;
      expect(row.result, name).toMatchObject({ ok: true });
      if (name === "saved setImmediate" || name === "Effect saved immediate scheduler") {
        expect(stepSizes(row), name).toEqual([2]);
        expect(
          row.steps.flat().map((request) => request.after),
          name,
        ).toEqual([0, 0]);
      }
      if (name === "prebound clocks") {
        expect(row.waitedMs).toBe(5);
        expect(row.result).toMatchObject({
          value: { before: 0, after: 5, date: GOLDEN_NOW + 5, descriptorDate: GOLDEN_NOW + 5 },
        });
      }
    });
  }

  it("rejects saved unsupported sources even when the provider swallows their errors", WORKERS, async () => {
    const probes = [
      ["CompressionStream", () => new savedCompression("gzip")],
      ["prebound fetch", () => savedFetch("https://probe.example/real-network")],
      ["timer delay", () => savedTimeout(() => undefined, 0.5)],
      ...(savedWait ? [["scheduler.wait", () => savedWait(0)] as const] : []),
    ] as const;
    for (const [name, work] of probes) {
      await expect(
        captureCall(
          probeSpec(async () => {
            try {
              await work();
            } catch {
              /* Still poisons the capture. */
            }
            return "swallowed";
          }),
          "probe",
        ),
      ).rejects.toThrow(`Unsupported asynchronous source: ${name}`);
    }
  });

  it(
    "refreshes module state and controls values read at module load for every order and capture",
    WORKERS,
    async () => {
      const load = async () => probeSpec((await import("./goldens/load-probe.js")).sample);
      const spec = await load();
      const rows = [];
      for (const jitter of determinism ? [1, 2, 3] : [1]) rows.push(await captureCall(spec, "probe", { jitter, load }));
      expect(new Set(rows).size).toBe(1);
      const row = JSON.parse(rows[0]!) as Row;
      expect(row.variants).toBeUndefined();
      expect(row.result).toMatchObject({ ok: true, value: { loadedAt: GOLDEN_NOW, calls: 1, before: 0, after: 5 } });
    },
  );

  it("fails on controlled work left after completion instead of dropping it at the next scenario", NODE, async () => {
    await expect(
      captureCall(
        probeSpec(async () => {
          setTimeout(() => {
            void fetch("https://probe.example/late");
          }, 10);
          return "done";
        }),
        "probe",
      ),
    ).rejects.toThrow(/outstanding controlled timer after call completion/);
    await expect(
      captureCall(
        probeSpec(async () => {
          const signal = savedAbortTimeout(10);
          signal.addEventListener("abort", () => {
            void fetch("https://probe.example/late").catch(() => undefined);
          });
          return "done";
        }),
        "probe",
      ),
    ).rejects.toThrow(/controlled work outlived call completion/);
  });

  it("rejects provider module loading as an unsupported source at entry", NODE, async () => {
    const load = async () => probeSpec((await import("./goldens/import-probe.js")).unsupportedImport);
    await expect(captureCall(await load(), "probe", { load })).rejects.toThrow(
      /Unsupported asynchronous source: dynamic import/,
    );
  });

  it("rejects Node host-module aliases before a provider can save native references", NODE, async () => {
    const load = async () => probeSpec((await import("./goldens/native-import-probe.js")).unsupportedAlias);
    await expect(
      captureCall(
        probeSpec(async () => "unused"),
        "probe",
        { load },
      ),
    ).rejects.toThrow(/Unsupported asynchronous source: host module: node:timers/);
  });

  it("keeps Vitest runner clocks and timers native outside capture", WORKERS, async () => {
    const before = Date.now();
    expect(before).toBeGreaterThan(GOLDEN_NOW);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(Date.now() - before).toBeGreaterThanOrEqual(1);
    await captureCall(
      probeSpec(async () => savedDateNow()),
      "probe",
    );
    expect(Date.now()).toBeGreaterThanOrEqual(before);
    expect(vi.isFakeTimers()).toBe(false);
  });

  it("distinguishes C awaiting B from C awaiting both by the reverse-order observation", NODE, async () => {
    const capture = (both: boolean) =>
      captureCall(
        probeSpec(async () => {
          const a = fetch("https://probe.example/a");
          const b = fetch("https://probe.example/b");
          await (both ? Promise.all([a, b]) : b);
          await fetch("https://probe.example/c");
          await a;
          return "done";
        }),
        "probe",
        { orders: "both" },
      );
    const onlyB = JSON.parse(await capture(false)) as Row;
    const both = JSON.parse(await capture(true)) as Row;
    expect(onlyB.steps).toEqual(both.steps);
    expect(onlyB.variants?.[0]?.order).toBe("reverse");
    expect(onlyB.variants?.[0]?.steps.flat().map((request) => request.after)).toEqual([0, 0, 1]);
    expect(both.variants).toBeUndefined();
    expect(onlyB).not.toEqual(both);
  });

  it("keeps frontiers linear for 300 sequential pages", NODE, async () => {
    const capture = async (pages: number) =>
      JSON.parse(
        await captureCall(
          probeSpec(async () => {
            for (let page = 0; page < pages; page++) await fetch(`https://probe.example/pages/${page}`);
            return "done";
          }),
          "probe",
        ),
      ) as Row;
    const small = await capture(150);
    const large = await capture(300);
    expect(large.steps.flat().map((request) => request.after)).toEqual(
      Array.from({ length: 300 }, (_, index) => index),
    );
    expect(large.variants).toBeUndefined();
    expect(JSON.stringify(large).length).toBeLessThan(JSON.stringify(small).length * 2.1);
  });

  it("supports queueMicrotask, counted Blob reads, and synchronous TextDecoderStream pipelines", WORKERS, async () => {
    const spec = probeSpec(async () => {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const text = await new Blob(["body"]).text();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      }).pipeThrough(new TextDecoderStream());
      let decoded = "";
      for await (const chunk of stream) decoded += chunk;
      await fetch("https://probe.example/supported");
      return decoded;
    });
    const a = await captureCall(spec, "probe", { jitter: 1 });
    expect(a).toBe(await captureCall(spec, "probe", { jitter: 2 }));
    expect((JSON.parse(a) as Row).result).toMatchObject({ ok: true, value: "body" });
  });

  it.each([0, 3])(
    "drives a counted body producer's queued zero timer after %i native turns",
    WORKERS,
    async (turns) => {
      const baseline = await captureCall(
        probeSpec(async () => new Response("body").text()),
        "probe",
      );
      expect(
        await captureCall(
          probeSpec(async () => queuedTimerRead(turns)),
          "probe",
        ),
      ).toBe(baseline);
    },
  );

  it.each(["timer", "microtask"] as const)(
    "completes a native producer's direct zero-time %s after native turns",
    CONTROLLED_IO,
    async (source) => {
      const row = JSON.parse(
        await captureCall(
          probeSpec(async () =>
            producedRead(async (close) => {
              for (let turn = 0; turn < 3; turn++) await goldenSources().turn();
              if (source === "timer") setTimeout(close, 0);
              else queueMicrotask(close);
            }),
          ),
          "probe",
        ),
      ) as Row;
      expect(row.result).toMatchObject({ ok: true, value: "body" });
      expect(row.waitedMs).toBeUndefined();
      await expectCleanCapture();
    },
  );

  // Unsupported producers deliberately assert bounded rejection and a clean
  // following capture. They must never become unbounded native waits.
  it.each(controlledIOCases)(
    "rejects controlled I/O produced by $name within the bound and recovers",
    CONTROLLED_IO,
    async ({ produce }) => {
      await expect(
        captureCall(
          probeSpec(async () => producedRead(produce)),
          "probe",
        ),
      ).rejects.toThrow(DRAIN_REJECTION);
      await expectCleanCapture();
    },
  );

  it.each([
    {
      name: "a reader",
      read: async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        const { value } = await reader.read();
        await reader.read();
        return new TextDecoder().decode(value);
      },
    },
    { name: "a response clone", read: (stream: ReadableStream<Uint8Array>) => new Response(stream).clone().text() },
    { name: "a tee", read: (stream: ReadableStream<Uint8Array>) => new Response(stream.tee()[0]).text() },
    {
      name: "a synchronous transform",
      read: async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
        const { value } = await reader.read();
        await reader.read();
        return value;
      },
    },
  ])("rejects a future-timer read through $name within the bound and recovers", CONTROLLED_IO, async ({ read }) => {
    await expect(
      captureCall(
        probeSpec(async () =>
          read(
            producedStream((close) => {
              queueMicrotask(() => setTimeout(close, 1));
            }),
          ),
        ),
        "probe",
      ),
    ).rejects.toThrow(DRAIN_REJECTION);
    await expectCleanCapture();
  });

  it.each([
    {
      name: "an endless controlled interval",
      produce: () => {
        setInterval(() => {}, 1);
      },
    },
    { name: "a stream that never closes and has no timers", produce: () => {} },
    {
      name: "a future timer whose callback would fail",
      produce: () => {
        setTimeout(() => {
          throw new Error("timer producer failed");
        }, 1);
      },
    },
    {
      name: "a native producer's failing microtask",
      produce: async () => {
        for (let turn = 0; turn < 3; turn++) await goldenSources().turn();
        queueMicrotask(() => {
          throw new Error("microtask producer failed");
        });
      },
    },
  ])("rejects $name within the bound and recovers", CONTROLLED_IO, async ({ produce }) => {
    await expect(
      captureCall(
        probeSpec(async () => producedRead(produce)),
        "probe",
      ),
    ).rejects.toThrow(DRAIN_REJECTION);
    await expectCleanCapture();
  });

  it(
    "rejects overlapping capture without releasing its owner, then recovers after bounded rejection",
    CONTROLLED_IO,
    async () => {
      let overlaps = 0;
      await expect(
        captureCall(
          probeSpec(async () => {
            await expect(
              captureCall(
                probeSpec(async () => "overlap"),
                "probe",
              ),
            ).rejects.toThrow("Overlapping golden captures are unsupported");
            overlaps++;
            return producedRead((close) => {
              queueMicrotask(() => setTimeout(close, 1));
            });
          }),
          "probe",
        ),
      ).rejects.toThrow(DRAIN_REJECTION);
      expect(overlaps).toBe(1);
      await expectCleanCapture();
    },
  );

  it("rejects a future-timer read after construction fails within the bound and recovers", CONTROLLED_IO, async () => {
    const spec = probeSpec(async () => "unused");
    spec.create = () => {
      void producedRead((close) => {
        queueMicrotask(() => setTimeout(close, 1));
      });
      throw new Error("construction rejected");
    };
    await expect(captureCall(spec, "probe")).rejects.toThrow(DRAIN_REJECTION);
    await expectCleanCapture();
  });

  it("rejects a producer-fed read beyond 10,000 turns within the bound and recovers", CONTROLLED_IO, async () => {
    await expect(captureCall(probeSpec(delayedRead), "probe")).rejects.toThrow("controlled work never settled");
    await expectCleanCapture();
  });

  it.each(countedReadCases)(
    "rejects concurrent fake requests during $name and recovers",
    CONTROLLED_IO,
    async ({ read }) => {
      const error = new Error("fixture rejected");
      const spec = probeSpec(
        async () => Promise.all([fetch("https://probe.example/a"), fetch("https://probe.example/b")]),
        () => {
          void read();
          throw error;
        },
      );
      await expect(captureCall(spec, "probe")).rejects.toThrow(error);
      await expectCleanCapture();
    },
  );

  it.each(countedReadCases)(
    "rejects construction during $name within the bound and recovers",
    CONTROLLED_IO,
    async ({ read }) => {
      const spec = probeSpec(async () => "unused");
      spec.create = () => {
        void read();
        throw new Error("construction rejected");
      };
      await expect(captureCall(spec, "probe")).rejects.toThrow(
        read === delayedRead ? DRAIN_REJECTION : "construction rejected",
      );
      await expectCleanCapture();
    },
  );

  it("completes 6,000 controlled timer/microtask callbacks within the turn bound", CONTROLLED_IO, async () => {
    const row = JSON.parse(
      await captureCall(
        probeSpec(async () => {
          let left = 6_000;
          const repeat = () => {
            if (--left > 0) queueMicrotask(() => setTimeout(repeat, 0));
          };
          setTimeout(repeat, 0);
          return "done";
        }),
        "probe",
      ),
    ) as Row;
    expect(row.result).toMatchObject({ ok: true, value: "done" });
    await expectCleanCapture();
  });

  it(
    "completes a counted body read with 6,000 timer/microtask callbacks within the turn bound",
    CONTROLLED_IO,
    async () => {
      const row = JSON.parse(
        await captureCall(
          probeSpec(async () => queuedTimerRead(0, 6_000)),
          "probe",
        ),
      ) as Row;
      expect(row.result).toMatchObject({ ok: true, value: "body" });
      await expectCleanCapture();
    },
  );

  it("rejects a controlled read awaiting the fake network within the bound and recovers", CONTROLLED_IO, async () => {
    await expect(
      captureCall(
        probeSpec(async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                const response = await fetch("https://probe.example/body");
                controller.enqueue(new TextEncoder().encode(await response.text()));
                controller.close();
              },
            }),
          ).text(),
        ),
        "probe",
      ),
    ).rejects.toThrow("controlled work never settled");
    await expectCleanCapture();
  });

  it.each(["response", "upload"])(
    "rejects a directly driven TransformStream %s within the bound and recovers",
    CONTROLLED_IO,
    async (destination) => {
      await expect(
        captureCall(
          probeSpec(async () => {
            const stream = new TransformStream<Uint8Array, Uint8Array>();
            const writer = stream.writable.getWriter();
            setTimeout(() => {
              void writer.write(new TextEncoder().encode("body")).then(() => writer.close());
            }, 1);
            if (destination === "response") return new Response(stream.readable).text();
            const response = await fetch("https://probe.example/upload", {
              method: "POST",
              body: stream.readable,
              duplex: "half",
            } as RequestInit);
            return response.text();
          }),
          "probe",
        ),
      ).rejects.toThrow(DRAIN_REJECTION);
      await expectCleanCapture();
    },
  );

  it("awaits native crypto without advancing a deadline or changing capture bytes", CONTROLLED_IO, async () => {
    const baseline = await captureCall(
      probeSpec(async () => "done"),
      "probe",
    );
    const captured = await captureCall(
      probeSpec(async () => {
        let expired = false;
        const deadline = setTimeout(() => {
          expired = true;
        }, 1);
        for (let operation = 0; operation < 3; operation++)
          await crypto.subtle.digest("SHA-256", new Uint8Array([operation]));
        clearTimeout(deadline);
        expect(expired).toBe(false);
        return "done";
      }),
      "probe",
    );
    expect(captured).toBe(baseline);
    await expectCleanCapture();
  });

  it("observes requests issued by native crypto after the handler returns", CONTROLLED_IO, async () => {
    const captured = JSON.parse(
      await captureCall(
        probeSpec(async () => {
          void crypto.subtle.digest("SHA-256", new Uint8Array([1])).then(() => fetch("https://probe.example/late"));
          return "done";
        }),
        "probe",
      ),
    ) as Row;
    expect(captured.steps.flat()).toHaveLength(1);
    expect(captured.steps.flat()[0]!.url).toBe("https://probe.example/late");
    await expectCleanCapture();
  });

  it("accounts for rejected native crypto and rejected body reads, then recovers", CONTROLLED_IO, async () => {
    const row = JSON.parse(
      await captureCall(
        probeSpec(async () => {
          await expect(crypto.subtle.digest("unsupported", new Uint8Array())).rejects.toThrow();
          await expect(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error("body rejected"));
                },
              }),
            ).text(),
          ).rejects.toThrow("body rejected");
          return "done";
        }),
        "probe",
      ),
    ) as Row;
    expect(row.result).toMatchObject({ ok: true, value: "done" });
    await expectCleanCapture();
  });

  it("controls Effect nanoseconds and its scheduler across captures on the virtual clock", WORKERS, async () => {
    const spec = probeSpec(async () => {
      const before = await runEdge(Clock.currentTimeNanos);
      const monotonicBefore = await runEdge(Clock.monotonicTimeNanos);
      await runEdge(Effect.sleep(5));
      return {
        before: String(before),
        after: String(await runEdge(Clock.currentTimeNanos)),
        elapsed: String((await runEdge(Clock.monotonicTimeNanos)) - monotonicBefore),
      };
    });
    const rows = [];
    for (const jitter of determinism ? [1, 2, 3] : [1]) rows.push(await captureCall(spec, "probe", { jitter }));
    expect(new Set(rows).size).toBe(1);
    expect((JSON.parse(rows[0]!) as Row).result).toMatchObject({
      ok: true,
      value: {
        before: String(BigInt(GOLDEN_NOW) * 1_000_000n),
        after: String(BigInt(GOLDEN_NOW + 5) * 1_000_000n),
        elapsed: "5000000",
      },
    });
  });

  // Planning Center's get_plan sends three requests at once. A provider timer
  // before one of them is virtual: a delay of 0 ms leaves it in the first
  // step, any longer one moves it to the next, and no schedule changes which.
  it(
    "places a request sent after a provider's own delay by causality, the same under every schedule",
    NODE,
    async () => {
      const plan = rowOf(stored["./goldens/planning-center/calls.json"]!, "get_plan");
      expect(stepSizes(plan)).toEqual([3]);
      for (const ms of [0, 1, 5, 50]) {
        const rows = new Set<string>();
        for (const jitter of determinism ? [undefined, 1, 2, 3, 4, 5, 6] : [undefined]) {
          rows.add(
            await captureCall(planningCenter, "get_plan", { seam: itemsAfter(ms), ...(jitter ? { jitter } : {}) }),
          );
        }
        expect(rows.size, `${ms} ms`).toBe(1);
        const row = JSON.parse([...rows][0]!) as Row;
        if (ms === 0) {
          expect(row).toEqual(plan);
          continue;
        }
        expect(stepSizes(row), `${ms} ms`).toEqual([2, 1]);
        expect(row.steps[1]![0]!.url).toMatch(/\/items\?/);
        expect(row.waitedMs).toBe(ms);
        expect(row.result).toEqual(plan.result);
      }
    },
  );

  it("INV-5: the leak guard decodes every encoding of a secret, nested, and a truncated start", NODE, () => {
    const secret = "golden-probe-token/123+456=é";
    const secrets = { probe: secret };
    const leaks = [
      ...secretEncodings(secret),
      `Basic ${base64(`alice:${secret}`)}`,
      // A base64 run that starts inside a word, and one cut short.
      `token${base64(secret)}`,
      base64(secret).slice(0, 16),
      // An encoding inside another, and a JSON document inside a string.
      encodeURIComponent(secretEncodings(secret).find((form) => form.startsWith("\\u"))!),
      base64(encodeURIComponent(secret)),
      JSON.stringify(JSON.stringify({ token: secret })),
      secret.slice(0, LEAK_RUN_UNITS),
      // A run that does not start the secret, as a cut leaves it.
      secret.slice(1),
      secret.slice(-LEAK_RUN_UNITS - 1, -1),
    ];
    expect(secretEncodings(secret)).toEqual([
      secret,
      encodeURIComponent(secret),
      encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
      base64(secret),
      base64Url(secret),
      [...secret].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
      [...secret].map((char) => `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join(""),
    ]);
    for (const leak of leaks) {
      expect(leakedSecret({ message: `rejected ${leak} today` }, secrets), leak).toBe("probe");
      expect(leakedSecret({ [leak]: true }, secrets), leak).toBe("probe");
    }
    // Shorter runs, a changed case, and base64 with its case changed are not the secret.
    for (const safe of [
      secret.slice(0, LEAK_RUN_UNITS - 1),
      secret.slice(5, 5 + LEAK_RUN_UNITS - 1),
      secret.slice(0, 12).toUpperCase(),
      base64(secret).toLowerCase(),
      "[redacted]",
    ]) {
      expect(leakedSecret({ message: `rejected ${safe} today` }, secrets), safe).toBeUndefined();
    }
  });

  it(
    "INV-5: Google's 401 echo rows carry every form redaction covers, Basic, Bearer and token framings included, each redacted",
    NODE,
    () => {
      const secret = "golden-probe-token/123+456=é";
      const pair = `alice:${secret}`;
      expect(errorEchoForms(secret)).toEqual([
        ...secretEncodings(secret),
        `Bearer ${secret}`,
        `token ${secret}`,
        `Basic ${base64(pair)}`,
        base64(pair),
        base64Url(pair),
      ]);
      // The leak guard reads every form, so a form redaction missed fails the capture.
      for (const form of errorEchoForms(secret))
        expect(leakedSecret({ message: `rejected ${form} today` }, { probe: secret }), form).toBe("probe");
      const google = ["docs", "drive", "forms", "gmail", "sheets", "slides"];
      expect(specs.filter((spec) => spec.errorEcho === "all").map((spec) => spec.provider)).toEqual(google);
      for (const provider of google) {
        const spec = specs.find((candidate) => candidate.provider === provider)!;
        const sent = Object.entries(spec.secrets ?? {}).filter(([name]) => !spec.unsent?.includes(name));
        const forms = sent.flatMap(([, value]) => errorEchoForms(value));
        const failures = JSON.parse(stored[`./goldens/${provider}/failures.json`]!) as Record<
          "read" | "write",
          { cases: Record<string, { result: { error: { message: string } } }> }
        >;
        for (const kind of ["read", "write"] as const) {
          const { message } = failures[kind].cases["401 echo"]!.result.error;
          // One marker per form: each was echoed, and each was redacted where it stood.
          const echoed = /rejected (.*?) Google rejected/.exec(message)?.[1] ?? "";
          expect(
            echoed.split(" ").filter((word) => word.includes("[redacted]")),
            `${provider} ${kind}`,
          ).toHaveLength(forms.length);
        }
      }
    },
  );

  it("uses well-formed RSA fixture PEM keys that sign and verify", WORKERS, async () => {
    const der = (pem: string) =>
      Uint8Array.from(atob(pem.split("-----")[2]!.replace(/\s/g, "")), (char) => char.charCodeAt(0));
    const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    const privateKey = await crypto.subtle.importKey("pkcs8", der(PRIVATE_KEY), algorithm, false, ["sign"]);
    const publicKey = await crypto.subtle.importKey("spki", der(PUBLIC_KEY), algorithm, false, ["verify"]);
    const message = new TextEncoder().encode("golden fixture");
    const signature = await crypto.subtle.sign(algorithm, privateKey, message);
    expect(await crypto.subtle.verify(algorithm, publicKey, signature, message)).toBe(true);
    expect(await crypto.subtle.verify(algorithm, publicKey, signature, new Uint8Array([0]))).toBe(false);
    expect(privateKey.algorithm).toMatchObject({ modulusLength: 2048 });
  });

  it("INV-5: the leak guard looks for a PEM key past its armor and DER framing, which guides print", NODE, () => {
    const body = PRIVATE_KEY.split("-----")[2]!.replace(/\s/g, "");
    // A 2048-bit RSA key's first 37 bytes, 49 base64 characters, are tags,
    // lengths, version, and algorithm; its modulus follows.
    const FRAMING = 49;
    expect(body.slice(0, FRAMING)).toMatch(/^MIIE..IBADANBgkqhkiG9w0BAQEFAASC.{8}AgEAAoIBA$/);
    for (const newline of ["\n", "\\n"]) {
      const armor = `-----BEGIN PRIVATE KEY-----${newline}`;
      const secret = `${armor}${body}${newline}-----END PRIVATE KEY-----${newline}`;
      const secrets = { privateKey: secret };
      const opening = armor.length + FRAMING;
      for (const safe of [
        "Paste the key from -----BEGIN PRIVATE KEY----- to -----END PRIVATE KEY-----.",
        `${secret.slice(0, opening)}…`,
        secret.slice(0, opening + LEAK_RUN_UNITS - 1),
      ]) {
        expect(leakedSecret({ message: safe }, secrets), safe).toBeUndefined();
      }
      for (const leak of [
        secret.slice(0, opening + LEAK_RUN_UNITS),
        secret,
        base64(secret),
        JSON.stringify({ private_key: secret }),
      ]) {
        expect(leakedSecret({ message: leak }, secrets), leak).toBe("privateKey");
      }
    }
  });

  it(
    "INV-5: fails every provider's echo fixture, before placeholders, when sent-secret redaction is disabled",
    NODE,
    async () => {
      vi.doMock("../src/sent-secrets.js", async () => {
        const module = await vi.importActual<typeof import("../src/sent-secrets.js")>("../src/sent-secrets.js");
        // Every entry point that returns redacted text: the projection, wire text, provider
        // lanes, and bounded reads.
        vi.spyOn(module.SentSecrets.prototype, "redact").mockImplementation((value) => value);
        vi.spyOn(module.SentSecrets.prototype, "text").mockImplementation((value) => value);
        vi.spyOn(module.SentSecrets.prototype, "parts").mockImplementation((parts) => parts);
        vi.spyOn(module.SentSecrets.prototype, "redactOpenTail").mockImplementation((value) => value);
        return module;
      });
      await expect(captureGoldens(infisical)).rejects.toThrow(/the caller-visible result leaks <secret:/);
      expect(await echoesThatPass()).toEqual([]);
    },
  );

  it(
    "INV-5: fails or changes every provider's echo fixture when redaction stops registering percent-encoded forms",
    NODE,
    async () => {
      const baselines = await echoBaselines();
      withoutForms((value) => [
        new URLSearchParams({ value }).toString().slice(6),
        encodeURIComponent(value),
        encodeURI(value),
      ]);
      expect(await echoesThatPass(baselines)).toEqual([]);
    },
  );

  it(
    "INV-5: fails or changes every provider's echo fixture when redaction stops registering base64 forms",
    NODE,
    async () => {
      const baselines = await echoBaselines();
      withoutForms((value) => [base64(value), base64Url(value)]);
      expect(await echoesThatPass(baselines)).toEqual([]);
    },
  );

  it(
    "INV-5: fails or changes every provider's echo fixture when redaction stops registering the base64url form alone",
    NODE,
    async () => {
      const baselines = await echoBaselines();
      withoutForms((value) => [base64Url(value)].filter((form) => form !== base64(value)));
      expect(await echoesThatPass(baselines)).toEqual([]);
    },
  );

  it(
    "matches the stored goldens without a mutation, so no earlier capture's state decided the tests above",
    NODE,
    async () => {
      expect((await captureGoldens(infisical)).calls).toBe(storedInfisicalCalls);
    },
  );
});
