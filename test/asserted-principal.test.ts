// A bearer secret that may name the user it acts for (#679): the adapter's
// verdicts, construction-time refusals, and the asserted principal reaching
// connector access rules, the caller a connector sees, and activity.

import { describe, expect, it } from "vitest";
import { activityHistory, type ToolCallActivityEvent } from "../src/activity.js";
import { bearerToken, type AssertedPrincipalOptions } from "../src/auth/bearer.js";
import { callerOf } from "../src/connector-caller.js";
import { api } from "../src/connectors/api.js";
import type { AuthResult, Connector, InboundAuth } from "../src/types.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { readJsonRpc } from "./fixtures/http.js";

const BASE = "https://connecta.test";
const SECRET = "agent-secret-0123456789";
const HEADER = "X-Connecta-Principal";

const assertion: AssertedPrincipalOptions = {
  header: HEADER,
  namespace: "eve:example.com",
  accept: (id) => /^[a-z0-9._%+-]+@example\.com$/.test(id),
};

function req(headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/mcp`, { method: "POST", headers });
}

async function refusal(result: AuthResult | Promise<AuthResult>) {
  const resolved = await result;
  if (resolved.ok) throw new Error("expected a refusal");
  return {
    status: resolved.response.status,
    final: resolved.final,
    body: await resolved.response.json() as { error: string },
  };
}

describe("bearerToken asserted principal", () => {
  const auth = bearerToken(SECRET, { assertedPrincipal: assertion });

  it("admits the secret with an accepted principal as that principal and subject", async () => {
    const result = await auth.authorize(
      req({ authorization: `Bearer ${SECRET}`, [HEADER]: "alice@example.com" }),
      BASE,
    );
    expect(result).toEqual({
      ok: true,
      subjectId: "alice@example.com",
      principal: { namespace: "eve:example.com", id: "alice@example.com" },
    });
    expect(auth.kind).toBe("bearer");
    expect(auth.activityActorNamespace).toBe("eve:example.com");
  });

  it("matches the header name case-insensitively and drops surrounding whitespace", async () => {
    for (const name of ["x-connecta-principal", "X-CONNECTA-PRINCIPAL"]) {
      const result = await auth.authorize(
        req({ authorization: `Bearer ${SECRET}`, [name]: "  bob@example.com " }),
        BASE,
      );
      expect(result).toMatchObject({ ok: true, principal: { id: "bob@example.com" } });
    }
    const lower = bearerToken(SECRET, { assertedPrincipal: { ...assertion, header: "x-connecta-principal" } });
    expect(await lower.authorize(
      req({ authorization: `Bearer ${SECRET}`, [HEADER]: "bob@example.com" }),
      BASE,
    )).toMatchObject({ ok: true });
  });

  it("ignores the header entirely without the secret", async () => {
    for (const authorization of [undefined, "Bearer wrong-secret"]) {
      const result = await refusal(auth.authorize(
        req({
          ...(authorization ? { authorization } : {}),
          [HEADER]: "alice@example.com",
        }),
        BASE,
      ));
      // The plain bearer's non-match: a 401 challenge another provider may override.
      expect(result).toEqual({ status: 401, final: undefined, body: { error: "unauthorized" } });
    }
  });

  it("refuses the secret with no principal, and never admits it as the bare credential", async () => {
    for (const headers of [{}, { [HEADER]: "" }, { [HEADER]: "   " }]) {
      expect(await refusal(auth.authorize(
        req({ authorization: `Bearer ${SECRET}`, ...headers }),
        BASE,
      ))).toEqual({ status: 403, final: true, body: { error: "asserted principal required" } });
    }
  });

  it("refuses an unaccepted, malformed, or duplicated principal", async () => {
    const malformed = [
      "mallory@evil.test", // well-formed but outside accept
      "Alice@Example.com", // ids are verbatim; accept decides canonical form
      "alice @example.com", // interior space fails validIdentityReference
      `${"a".repeat(250)}@example.com`, // longer than 256
    ];
    for (const id of malformed) {
      expect(await refusal(auth.authorize(
        req({ authorization: `Bearer ${SECRET}`, [HEADER]: id }),
        BASE,
      ))).toEqual({ status: 403, final: true, body: { error: "asserted principal refused" } });
    }
    const duplicated = new Headers({ authorization: `Bearer ${SECRET}` });
    duplicated.append(HEADER, "alice@example.com");
    duplicated.append(HEADER, "bob@example.com");
    expect(await refusal(auth.authorize(
      new Request(`${BASE}/mcp`, { method: "POST", headers: duplicated }),
      BASE,
    ))).toMatchObject({ status: 403, final: true });
  });

  it("only a literal true from accept admits; a throw or a truthy value refuses", async () => {
    let seen: string | undefined;
    for (const accept of [
      () => { throw new Error("directory down"); },
      () => 1 as unknown as boolean,
      async () => false,
      (id: string) => { seen = id; return Promise.resolve("yes" as unknown as boolean); },
    ]) {
      const strict = bearerToken(SECRET, { assertedPrincipal: { ...assertion, accept } });
      expect(await refusal(strict.authorize(
        req({ authorization: `Bearer ${SECRET}`, [HEADER]: "alice@example.com" }),
        BASE,
      ))).toMatchObject({ status: 403, final: true });
    }
    expect(seen).toBe("alice@example.com");
    const asyncAccept = bearerToken(SECRET, { assertedPrincipal: { ...assertion, accept: async () => true } });
    expect(await asyncAccept.authorize(
      req({ authorization: `Bearer ${SECRET}`, [HEADER]: "alice@example.com" }),
      BASE,
    )).toMatchObject({ ok: true });
  });

  it("throws at construction on a structural mistake", () => {
    const cases: [unknown, string][] = [
      [{ ...assertion, header: "" }, "must be an HTTP header name"],
      [{ ...assertion, header: "X Principal" }, "must be an HTTP header name"],
      [{ ...assertion, header: "x-principal:" }, "must be an HTTP header name"],
      [{ ...assertion, header: "Authorization" }, "already means something else"],
      [{ ...assertion, header: "cookie" }, "already means something else"],
      [{ ...assertion, namespace: "" }, "namespace must be"],
      [{ ...assertion, namespace: "has space" }, "namespace must be"],
      [{ header: HEADER, namespace: "eve" }, "accept is required"],
      [{ ...assertion, accept: true }, "accept is required"],
      [{ ...assertion, acept: () => true }, 'unknown option "acept"'],
      [null, "must be an object"],
    ];
    for (const [assertedPrincipal, message] of cases) {
      expect(() => bearerToken(SECRET, { assertedPrincipal } as never)).toThrow(message);
    }
    expect(() => bearerToken(SECRET, { subjectId: "eve", assertedPrincipal: assertion }))
      .toThrow("exclusive");
  });

  it("leaves the plain bearer unchanged when the option is absent", async () => {
    const plain = bearerToken(SECRET, { subjectId: "bot" });
    expect(plain.activityActorNamespace).toBeUndefined();
    expect(await plain.authorize(
      req({ authorization: `Bearer ${SECRET}`, [HEADER]: "alice@example.com" }),
      BASE,
    )).toEqual({ ok: true, subjectId: "bot" });
    expect(await bearerToken(SECRET).authorize(req({ authorization: `Bearer ${SECRET}` }), BASE))
      .toEqual({ ok: true });
    const miss = await bearerToken(SECRET).authorize(req({ authorization: "Bearer nope" }), BASE);
    if (miss.ok) throw new Error("expected a refusal");
    expect(miss).not.toHaveProperty("final");
    expect(miss.response.status).toBe(401);
    expect(miss.response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await miss.response.json()).toEqual({ error: "unauthorized" });
  });
});

describe("an asserted principal through a deployment", () => {
  function whoami(id: string): Connector {
    return api(id, {
      description: `Reports the caller to ${id}`,
      tools: [{
        name: "me",
        description: "Return the caller core attached",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", additionalProperties: true },
        handler: (_args, ctx) => callerOf(ctx) ?? null,
      }],
    });
  }

  // Stands in for a provider that admits on something other than the
  // Authorization header, as Cloudflare Access admits on `ctx.access`.
  const edge: InboundAuth = {
    kind: "edge",
    authorize: () => ({ ok: true, subjectId: "edge-service" }),
  };

  function deploy(auth: InboundAuth[]) {
    const events: ToolCallActivityEvent[] = [];
    const seenByRule: unknown[] = [];
    const connecta = createTestConnecta({
      connectors: [whoami("common"), whoami("alice_only")],
      auth,
      identity: {
        connectorAccess: (identity) => {
          seenByRule.push(identity);
          return identity.principal?.namespace === "eve:example.com" &&
              identity.principal.id === "alice@example.com"
            ? ["common", "alice_only"]
            : ["common"];
        },
      },
      activity: activityHistory({ store: { record: (event) => void events.push(event) } }),
      logger: silentLogger,
    });
    const call = async (address: string, headers: Record<string, string>) => {
      const response = await connecta.fetch(new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "call_tool", arguments: { address, args: { caller: "mallory@example.com" } } },
        }),
      }));
      return response.status === 200
        ? { status: 200, result: (await readJsonRpc(response)).result }
        : { status: response.status, body: await response.json() };
    };
    return { connecta, events, seenByRule, call };
  }

  it("reaches connector access rules, the caller a connector sees, and activity", async () => {
    const { connecta, events, seenByRule, call } = deploy([
      bearerToken(SECRET, { assertedPrincipal: assertion }),
    ]);
    const alice = { authorization: `Bearer ${SECRET}`, [HEADER]: "alice@example.com" };
    const bob = { authorization: `Bearer ${SECRET}`, [HEADER]: "bob@example.com" };

    const own = await call("alice_only.me", alice);
    expect(own.status).toBe(200);
    expect(JSON.parse(own.result.content[0].text)).toEqual({
      identity: {
        actor: { kind: "bearer", id: "alice@example.com", namespace: "eve:example.com" },
        subject: { namespace: "eve:example.com", id: "alice@example.com" },
        principal: { namespace: "eve:example.com", id: "alice@example.com" },
        interactive: false,
      },
    });
    expect(seenByRule).toContainEqual(expect.objectContaining({
      principal: { namespace: "eve:example.com", id: "alice@example.com" },
    }));

    const denied = await call("alice_only.me", bob);
    expect(denied.status).toBe(200);
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0].text).toContain("unknown_address");
    const shared = await call("common.me", bob);
    expect(JSON.parse(shared.result.content[0].text)).toMatchObject({
      identity: { principal: { id: "bob@example.com" } },
    });

    // Activity records the asserted user as the actor and nothing more.
    expect(events.map((event) => event.actor)).toContainEqual({
      kind: "bearer",
      id: "alice@example.com",
      namespace: "eve:example.com",
    });
    expect(JSON.stringify(events)).not.toContain("mallory");
    await connecta.close();
  });

  it("stops at the refusal instead of letting a later provider admit the request", async () => {
    const { connecta, call } = deploy([
      bearerToken(SECRET, { assertedPrincipal: assertion }),
      edge,
    ]);
    expect(await call("common.me", { authorization: `Bearer ${SECRET}` }))
      .toEqual({ status: 403, body: { error: "asserted principal required" } });
    expect(await call("common.me", {
      authorization: `Bearer ${SECRET}`,
      [HEADER]: "mallory@evil.test",
    })).toEqual({ status: 403, body: { error: "asserted principal refused" } });

    // Without the secret the header is ignored and the next provider decides.
    const fallthrough = await call("common.me", {
      authorization: "Bearer someone-else",
      [HEADER]: "alice@example.com",
    });
    expect(JSON.parse(fallthrough.result.content[0].text)).toEqual({
      identity: {
        actor: { kind: "edge", id: "edge-service" },
        subject: { namespace: "connecta:auth:edge", id: "edge-service" },
        interactive: false,
      },
    });
    await connecta.close();
  });

  it("sits beside a plain bearer whose callers keep their own subject", async () => {
    const { connecta, call } = deploy([
      bearerToken("plain-secret", { subjectId: "calendar-bot" }),
      bearerToken(SECRET, { assertedPrincipal: assertion }),
    ]);
    const plain = await call("common.me", {
      authorization: "Bearer plain-secret",
      [HEADER]: "alice@example.com",
    });
    expect(JSON.parse(plain.result.content[0].text)).toEqual({
      identity: {
        actor: { kind: "bearer", id: "calendar-bot" },
        subject: { namespace: "connecta:auth:bearer", id: "calendar-bot" },
        interactive: false,
      },
    });
    const asserted = await call("alice_only.me", {
      authorization: `Bearer ${SECRET}`,
      [HEADER]: "alice@example.com",
    });
    expect(JSON.parse(asserted.result.content[0].text)).toMatchObject({
      identity: { principal: { id: "alice@example.com" } },
    });
    await connecta.close();
  });
});
