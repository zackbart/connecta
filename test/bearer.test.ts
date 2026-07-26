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

// The binding a token declares (issue #37). Enforcement is the server's job and
// is covered end-to-end in toolkits.test.ts; what matters here is that the
// adapter refuses to construct a binding that does not say what it means.
describe("bearerToken toolkit binding", () => {
  it("declares no binding by default, so the token stays unbound", () => {
    expect(bearerToken("s").toolkitBinding).toBeUndefined();
    expect(bearerToken("s", { subjectId: "ci" }).toolkitBinding).toBeUndefined();
  });

  it("declares the toolkits a token may open", () => {
    expect(
      bearerToken("s", { subjectId: "support", toolkits: ["support"] })
        .toolkitBinding,
    ).toEqual({ toolkits: ["support"] });
  });

  it("carries unscoped access only when asked for it", () => {
    expect(
      bearerToken("s", { toolkits: ["support"], unscoped: true })
        .toolkitBinding,
    ).toEqual({ toolkits: ["support"], unscoped: true });
  });

  it("accepts an unscoped-only binding", () => {
    expect(
      bearerToken("s", { toolkits: [], unscoped: true }).toolkitBinding,
    ).toEqual({ toolkits: [], unscoped: true });
  });

  it("collapses a repeated toolkit name", () => {
    expect(
      bearerToken("s", { toolkits: ["support", "support"] }).toolkitBinding,
    ).toEqual({ toolkits: ["support"] });
  });

  it("throws on `unscoped` with no toolkits — it would grant nothing", () => {
    expect(() => bearerToken("s", { unscoped: true })).toThrow(
      "`unscoped` only means something beside `toolkits`",
    );
    expect(() => bearerToken("s", { unscoped: false })).toThrow(
      "`unscoped` only means something beside `toolkits`",
    );
  });

  it("throws on a binding that permits nothing at all", () => {
    expect(() => bearerToken("s", { toolkits: [] })).toThrow(
      "binds no toolkits and no unscoped access",
    );
  });

  it("throws on a name outside the toolkit grammar, which could never match", () => {
    expect(() => bearerToken("s", { toolkits: ["Support Team"] })).toThrow(
      '`toolkits` entry "Support Team" is not a toolkit name',
    );
    expect(() =>
      bearerToken("s", { subjectId: "support", toolkits: [42 as never] }),
    ).toThrow('bearerToken (subjectId "support")');
  });

  it("throws when `toolkits` is not an array", () => {
    expect(() =>
      bearerToken("s", { toolkits: "support" as unknown as string[] }),
    ).toThrow("`toolkits` must be an array of toolkit names");
  });

  it("freezes the binding it declares", () => {
    const binding = bearerToken("s", { toolkits: ["support"] }).toolkitBinding!;
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.toolkits)).toBe(true);
  });
});
