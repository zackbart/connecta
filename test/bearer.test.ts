import { describe, expect, it } from "vitest";
import { bearerToken } from "../src/auth/bearer.js";

function req(auth?: string): Request {
  return new Request("https://connecta.test/mcp", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });
}

describe("bearerToken inbound auth", () => {
  const auth = bearerToken("s3cret-token");

  it("admits the correct token", async () => {
    const r = await auth.authorize(req("Bearer s3cret-token"), "https://x");
    expect(r.ok).toBe(true);
  });

  it("is case-insensitive on the scheme keyword", async () => {
    const r = await auth.authorize(req("bearer s3cret-token"), "https://x");
    expect(r.ok).toBe(true);
  });

  it("rejects a wrong token with a 401 Bearer challenge", async () => {
    const r = await auth.authorize(req("Bearer wrong"), "https://x");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(401);
    expect(r.response.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("rejects a token that is a prefix of the secret (length differs)", async () => {
    const r = await auth.authorize(req("Bearer s3cret"), "https://x");
    expect(r.ok).toBe(false);
  });

  it("rejects a missing Authorization header with 401", async () => {
    const r = await auth.authorize(req(), "https://x");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(401);
  });
});

describe("retired bearerToken audience options", () => {
  it("throws instead of silently ignoring toolkit-era options", () => {
    for (const options of [
      { toolkits: ["support"] },
      { unscoped: true },
    ]) {
      expect(() => bearerToken("s", options as never)).toThrow(
        "removed in issue #178",
      );
      expect(() => bearerToken("s", options as never)).toThrow("ethos.md");
    }
  });
});
