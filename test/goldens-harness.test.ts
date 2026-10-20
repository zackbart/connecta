// The characterization harness's own tests: each provider-side mutation the
// goldens exist to catch must change a golden or fail the capture, and no
// schedule may. A seam stands in for a provider that calls fetch differently
// or waits on its own timer; spies weaken sent-secret redaction. See the
// contributor section of documentation/architecture.md.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Clock, Effect } from "effect";
import { runEdge } from "../src/runtime/run.js";
import { SentSecrets } from "../src/sent-secrets.js";
import {
  captureCall,
  captureGoldens,
  goldenFiles,
  GOLDEN_NOW,
  type Replies,
  LEAK_PREFIX_UNITS,
  leakedSecret,
  secretEncodings,
  type FetchSeam,
  type GoldenSpec,
  type StubResponse,
} from "./goldens/harness.js";
import infisical from "./goldens/infisical/spec.js";
import planningCenter from "./goldens/planning-center/spec.js";

const specs = Object.values(import.meta.glob<GoldenSpec>("./goldens/*/spec.ts", { import: "default", eager: true }))
  .slice()
  .sort((a, b) => a.provider.localeCompare(b.provider));
const stored = import.meta.glob<string>("./goldens/*/*.json", { query: "?raw", import: "default", eager: true });
const storedInfisicalCalls = stored["./goldens/infisical/calls.json"]!;

interface Row {
  label: string;
  steps: Array<Array<{ url: string; after: number[] }>>;
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

const hostSchedule = globalThis.setImmediate?.bind(globalThis) ?? globalThis.setTimeout.bind(globalThis);

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
  const proto = SentSecrets.prototype as unknown as Internals;
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
}

/** Every provider whose echo fixture does not fail with a leak. */
async function echoesThatPass(): Promise<string[]> {
  const passed: string[] = [];
  for (const spec of specs) {
    const leak = new RegExp(`^${spec.provider} .* echoes sent secrets: the caller-visible result leaks <secret:`);
    const error = await captureCall(spec, "echo").then(
      () => undefined,
      (caught: unknown) => caught,
    );
    if (!(error instanceof Error && leak.test(error.message))) passed.push(spec.provider);
  }
  return passed;
}

describe("characterization golden harness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Each mutation is compared with an unmutated capture from the same
  // harness, so a harness that stopped recording the field fails here too.
  it("INV-5: records init.headers replacing a Request's headers, so a dropped Authorization changes the goldens", async () => {
    const baseline = (await captureGoldens(infisical)).calls!;
    const { calls } = await captureGoldens(infisical, { seam: authorizationOnRequestOnly });
    expect(baseline).toContain('"authorization": "Bearer <secret:accessToken>"');
    expect(calls).not.toContain('"authorization": "Bearer <secret:accessToken>"');
    expect(calls).not.toBe(baseline);
  });

  it("INV-5: records auxiliary request bodies, so an emptied Infisical login changes the goldens", async () => {
    const baseline = (await captureGoldens(infisical)).calls!;
    const { calls } = await captureGoldens(infisical, { seam: emptyLoginBody });
    expect(baseline).toContain('"clientSecret": "<secret:clientSecret>"');
    expect(calls).not.toContain('"clientSecret": "<secret:clientSecret>"');
    expect(calls).not.toBe(baseline);
  });

  it("records a JSON body's exact bytes, so respacing or reordering the Infisical login changes the goldens", async () => {
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
  });

  // Canonical order puts the login first in either case, so only the step
  // boundary tells the two apart.
  it("records causal steps, so a write sent before the Infisical login is answered changes the goldens", async () => {
    const baseline = await captureCall(infisical, "create_secret");
    const early = await captureCall(infisical, "create_secret", { seam: writeBeforeLoginAnswer });
    expect(early).not.toBe(baseline);
    expect(stepSizes(JSON.parse(baseline) as Row)).toEqual([1, 1]);
    expect(stepSizes(JSON.parse(early) as Row)).toEqual([2]);
    expect(requestsOnly(JSON.parse(early) as Row)).toEqual(requestsOnly(JSON.parse(baseline) as Row));
  });

  it("records a duplicated write, and whether its copies were sent together or in turn", async () => {
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

  it("records partial dependencies: C awaiting A differs from C awaiting B, including a 0 ms timer", async () => {
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
        for (const jitter of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) rows.add(await captureCall(spec, "probe", { jitter }));
        expect(rows.size).toBe(1);
        const capture = [...rows][0]!;
        const row = JSON.parse(capture) as Row;
        expect(stepSizes(row)).toEqual([2, 1]);
        expect(row.steps.flat().map((request) => request.after)).toEqual([[], [], dependency === "a" ? [0] : [0, 1]]);
        captures.set(dependency, capture);
      }
      expect(captures.get("a")).not.toBe(captures.get("b"));
    }
  });

  it("rejects distinct queued replies for indistinguishable concurrent requests", async () => {
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
      for (const jitter of [1, 2, 3, 4, 5, 6]) {
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

  it("fails loudly for native CompressionStream async iteration before a Planning Center request", async () => {
    const compressedItems: FetchSeam = (send) => async (input, init) => {
      if (new URL(urlOf(input)).pathname.endsWith("/items")) {
        const stream = new Blob(["probe"]).stream().pipeThrough(new CompressionStream("gzip"));
        for await (const _chunk of stream) {
          /* native work bypasses reader.read() */
        }
      }
      return send(input, init);
    };
    for (const jitter of [1, 2, 3, 4, 5, 6]) {
      await expect(captureCall(planningCenter, "get_plan", { seam: compressedItems, jitter })).rejects.toThrow(
        /Unsupported asynchronous source: CompressionStream/,
      );
    }
  });

  it("rejects scheduler.wait instead of mistaking native waiting for a fake timer", async () => {
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

  it("fails if an uncounted host callback sends a request or settles the call after declared quiescence", async () => {
    // Escape the model deliberately via a saved real scheduler. Four turns
    // finish after settling's quiet turns but during the no-stimulus audit.
    for (const request of [true, false]) {
      const spec = probeSpec(async () => {
        for (let turn = 0; turn < 4; turn++) await new Promise<void>((resolve) => hostSchedule(resolve));
        if (request) await fetch("https://probe.example/late");
        return "done";
      });
      await expect(captureCall(spec, "probe")).rejects.toThrow(
        /progress after declared quiescence.*likely unsupported asynchronous source/,
      );
    }
  });

  it("supports queueMicrotask, counted Blob reads, and synchronous TextDecoderStream pipelines", async () => {
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

  it("controls Effect nanoseconds and its scheduler across captures on the virtual clock", async () => {
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
    for (const jitter of [1, 2, 3]) rows.push(await captureCall(spec, "probe", { jitter }));
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
  it("places a request sent after a provider's own delay by causality, the same under every schedule", async () => {
    const plan = rowOf(stored["./goldens/planning-center/calls.json"]!, "get_plan");
    expect(stepSizes(plan)).toEqual([3]);
    for (const ms of [0, 1, 5, 50]) {
      const rows = new Set<string>();
      for (const jitter of [undefined, 1, 2, 3, 4, 5, 6]) {
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
  });

  it("INV-5: the leak guard decodes every encoding of a secret, nested, and a truncated start", () => {
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
      secret.slice(0, LEAK_PREFIX_UNITS),
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
    // Shorter or later fragments, a changed case, and base64 with its case changed are not the secret.
    for (const safe of [
      secret.slice(0, LEAK_PREFIX_UNITS - 1),
      secret.slice(1),
      secret.toUpperCase(),
      base64(secret).toLowerCase(),
      "[redacted]",
    ]) {
      expect(leakedSecret({ message: `rejected ${safe} today` }, secrets), safe).toBeUndefined();
    }
  });

  it("INV-5: the leak guard looks for a PEM key past its armor and DER framing, which guides print", async () => {
    const keys = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
    const body = btoa(String.fromCharCode(...der));
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
        secret.slice(0, opening + LEAK_PREFIX_UNITS - 1),
      ]) {
        expect(leakedSecret({ message: safe }, secrets), safe).toBeUndefined();
      }
      for (const leak of [
        secret.slice(0, opening + LEAK_PREFIX_UNITS),
        secret,
        base64(secret),
        JSON.stringify({ private_key: secret }),
      ]) {
        expect(leakedSecret({ message: leak }, secrets), leak).toBe("privateKey");
      }
    }
  });

  it("INV-5: fails every provider's echo fixture, before placeholders, when sent-secret redaction is disabled", async () => {
    vi.spyOn(SentSecrets.prototype, "redact").mockImplementation((value) => value);
    await expect(captureGoldens(infisical)).rejects.toThrow(/the caller-visible result leaks <secret:/);
    expect(await echoesThatPass()).toEqual([]);
  });

  it("INV-5: fails every provider's echo fixture when redaction stops registering percent-encoded forms", async () => {
    withoutForms((value) => [
      new URLSearchParams({ value }).toString().slice(6),
      encodeURIComponent(value),
      encodeURI(value),
    ]);
    expect(await echoesThatPass()).toEqual([]);
  });

  it("INV-5: fails every provider's echo fixture when redaction stops registering base64 forms", async () => {
    withoutForms((value) => [base64(value), base64Url(value)]);
    expect(await echoesThatPass()).toEqual([]);
  });

  it("INV-5: fails every provider's echo fixture when redaction stops registering the base64url form alone", async () => {
    withoutForms((value) => [base64Url(value)].filter((form) => form !== base64(value)));
    expect(await echoesThatPass()).toEqual([]);
  });

  it("matches the stored goldens without a mutation, so no earlier capture's state decided the tests above", async () => {
    expect((await captureGoldens(infisical)).calls).toBe(storedInfisicalCalls);
  });

  // Two captures in one process, each with a different seed delaying requests
  // before and after they reach the network (microtasks, timers due now, real
  // Web Crypto and event-loop turns) and releasing one answer at a time in canonical
  // order: neither an earlier capture's caches nor scheduling may move a byte.
  for (const spec of specs) {
    it(`${spec.provider}: repeated captures with scheduling jitter match the stored goldens`, async () => {
      for (const jitter of [1, 2]) {
        const files = await captureGoldens(spec, { jitter });
        for (const file of goldenFiles(spec)) {
          expect(files[file], `${spec.provider}/${file}.json with jitter ${jitter}`).toBe(
            stored[`./goldens/${spec.provider}/${file}.json`],
          );
        }
      }
    }, 120_000);
  }
});
