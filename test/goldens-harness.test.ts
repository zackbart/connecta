// The characterization harness's own tests: each provider-side mutation the
// goldens exist to catch must change a golden or fail the capture. A seam
// stands in for a provider that calls fetch differently; spies weaken
// sent-secret redaction. See the contributor section of
// documentation/architecture.md.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SentSecrets } from "../src/sent-secrets.js";
import {
  captureEcho,
  captureGoldens,
  goldenFiles,
  LEAK_PREFIX_UNITS,
  leakedSecret,
  secretEncodings,
  type FetchSeam,
  type GoldenSpec,
} from "./goldens/harness.js";
import infisical from "./goldens/infisical/spec.js";

const specs = Object.values(import.meta.glob<GoldenSpec>("./goldens/*/spec.ts", { import: "default", eager: true }))
  .slice()
  .sort((a, b) => a.provider.localeCompare(b.provider));
const stored = import.meta.glob<string>("./goldens/*/*.json", { query: "?raw", import: "default", eager: true });
const storedInfisicalCalls = stored["./goldens/infisical/calls.json"]!;

const LOGIN = "/api/v1/auth/universal-auth/login";

const urlOf = (input: RequestInfo | URL) => String(input instanceof Request ? input.url : input);

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
    const error = await captureEcho(spec).then(
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

  // Two captures in one process, each with a different seed reordering
  // request arrival, delaying answers, and answering a batch in shuffled
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
