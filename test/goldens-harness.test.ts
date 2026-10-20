// The characterization harness's own tests: each provider-side mutation the
// goldens exist to catch must change a golden or fail the capture. A seam
// stands in for a provider that calls fetch differently; a spy disables
// sent-secret redaction. See the contributor section of
// documentation/architecture.md.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SentSecrets } from "../src/sent-secrets.js";
import { captureEcho, captureGoldens, type FetchSeam, type GoldenSpec } from "./goldens/harness.js";
import infisical from "./goldens/infisical/spec.js";

const specs = import.meta.glob<GoldenSpec>("./goldens/*/spec.ts", { import: "default", eager: true });
const stored = import.meta.glob<string>("./goldens/infisical/calls.json", {
  query: "?raw",
  import: "default",
  eager: true,
})["./goldens/infisical/calls.json"]!;

const LOGIN = "/api/v1/auth/universal-auth/login";

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
  String(input instanceof Request ? input.url : input).endsWith(LOGIN)
    ? send(input, { ...init, body: "{}" })
    : send(input, init);

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

  it("INV-5: fails every provider's echo fixture, before placeholders, when sent-secret redaction is disabled", async () => {
    vi.spyOn(SentSecrets.prototype, "redact").mockImplementation((value) => value);
    await expect(captureGoldens(infisical)).rejects.toThrow(/the caller-visible result leaks <secret:/);
    for (const spec of Object.values(specs)) {
      await expect(captureEcho(spec), spec.provider).rejects.toThrow(
        new RegExp(`^${spec.provider} .* echoes sent secrets: the caller-visible result leaks <secret:`),
      );
    }
  });

  it("matches the stored goldens without a mutation, so no earlier capture's state decided the tests above", async () => {
    expect((await captureGoldens(infisical)).calls).toBe(stored);
  });
});
