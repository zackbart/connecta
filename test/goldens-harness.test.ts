// The characterization harness's own tests: each provider-side mutation the
// goldens exist to catch must change a golden or fail the capture, and no
// schedule may. A seam stands in for a provider that calls fetch differently
// or waits on its own timer; spies weaken sent-secret redaction. See the
// contributor section of documentation/architecture.md.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SentSecrets } from "../src/sent-secrets.js";
import {
  captureCall,
  captureGoldens,
  goldenFiles,
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
  steps: Array<Array<{ url: string }>>;
  waitedMs?: number;
  result: unknown;
}

const rowOf = (calls: string, label: string) => (JSON.parse(calls) as Row[]).find((row) => row.label === label)!;
/** How many requests each causal step of a call held. */
const stepSizes = (row: Row) => row.steps.map((step) => step.length);

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
    expect(JSON.parse(early).steps.flat()).toEqual(JSON.parse(baseline).steps.flat());
  });

  it("records a duplicated write, and whether its copies were sent together or in turn", async () => {
    const baseline = (await captureGoldens(infisical)).calls!;
    const together = (await captureGoldens(infisical, { seam: writeTwiceAtOnce })).calls!;
    const inTurn = (await captureGoldens(infisical, { seam: writeTwiceInTurn })).calls!;
    expect(together).not.toBe(baseline);
    expect(inTurn).not.toBe(baseline);
    expect(together).not.toBe(inTurn);
    expect(stepSizes(rowOf(together, "create_secret"))).toEqual([1, 2]);
    expect(stepSizes(rowOf(inTurn, "create_secret"))).toEqual([1, 1, 1]);
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
  // Web Crypto and event-loop turns) and answering each step in shuffled
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
