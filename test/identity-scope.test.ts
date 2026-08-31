import { describe, expect, it } from "vitest";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, InboundAuth } from "../src/types.js";
import { createTestConnecta } from "./helpers.js";

const BASE = "https://connecta.test";
const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

function users(): InboundAuth {
  return {
    kind: "test-users",
    interactiveOperator: true,
    activityActorNamespace: "https://identity.test",
    authorize(request) {
      const user = /^Bearer (alice|bob)$/u.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      return user
        ? { ok: true, userId: user, subjectId: user }
        : {
            ok: false,
            response: Response.json({ error: "unauthorized" }, { status: 401 }),
          };
    },
  };
}

function request(
  path: string,
  user: "alice" | "bob",
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${user}`);
  return new Request(`${BASE}${path}`, { ...init, headers });
}

function visible(id: string): Connector {
  return api(id, { description: id, tools: [] });
}

describe("identity-scoped connectors", () => {
  it("refuses static headers disguised as personal auth", () => {
    expect(() =>
      remoteMcp("bad", {
        url: "https://mcp.test",
        authScope: "personal",
        auth: { type: "headers", headers: { Authorization: "secret" } },
      })
    ).toThrow("cannot combine authScope \"personal\" with static headers");
  });

  it("derives connector visibility from the authenticated principal", async () => {
    const connecta = createTestConnecta({
      connectors: [visible("common"), visible("alice_only"), visible("bob_only")],
      auth: users(),
      identity: {
        connectorAccess(identity) {
          return identity.principal?.id === "alice"
            ? ["common", "alice_only"]
            : ["common", "bob_only"];
        },
      },
      storage: memoryStorage(),
      publicUrl: BASE,
    });

    const alice = await connecta.fetch(request("/ui/data", "alice"));
    const bob = await connecta.fetch(request("/ui/data", "bob"));
    expect(((await alice.json()) as any).connectors.map((item: Connector) => item.id))
      .toEqual(["common", "alice_only"]);
    expect(((await bob.json()) as any).connectors.map((item: Connector) => item.id))
      .toEqual(["common", "bob_only"]);

    const aliceResults = connecta.registry.scoped({
      connectorIds: "all",
      subjectKey: "alice-subject",
    }).resultsStorage();
    const bobResults = connecta.registry.scoped({
      connectorIds: "all",
      subjectKey: "bob-subject",
    }).resultsStorage();
    await aliceResults.set("result:id", "alice result");
    expect(await bobResults.get("result:id")).toBeNull();
  });

  it("isolates personal vault entries while visible shared auth stays editable", async () => {
    const personal = api("personal", {
      description: "Personal connection",
      authScope: "personal",
      credential: { label: "Personal token" },
      tools: [],
    });
    personal.status = async (ctx) => {
      const value = await ctx.credential?.get();
      return value
        ? { state: "ok", message: value.slice(-4) }
        : { state: "auth_required" };
    };
    const shared = api("shared", {
      description: "Shared connection",
      credential: { label: "Shared token" },
      tools: [],
    });
    const connecta = createTestConnecta({
      connectors: [personal, shared],
      auth: users(),
      identity: {
        operatorAccess: (principal) => principal.id === "alice",
      },
      credentials: { encryptionKey: ENCRYPTION_KEY },
      accessTokens: {},
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const put = (connector: string, user: "alice" | "bob", value: string) =>
      connecta.fetch(
        request(`/ui/credentials/${connector}`, user, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Origin: BASE },
          body: JSON.stringify({ value }),
        }),
      );

    expect((await put("personal", "alice", "alice-secret-1111")).status).toBe(200);
    expect((await put("personal", "bob", "bob-secret-2222")).status).toBe(200);
    expect((await put("shared", "bob", "shared-secret-3333")).status).toBe(200);
    expect((await put("shared", "alice", "shared-secret-4444")).status).toBe(200);

    const alice = await connecta.fetch(request("/ui/data", "alice"));
    const bob = await connecta.fetch(request("/ui/data", "bob"));
    const aliceData = await alice.json() as any;
    const bobData = await bob.json() as any;
    expect(aliceData.connectors.find((item: any) => item.id === "personal")
      .credential.lastFour).toBe("1111");
    expect(bobData.connectors.find((item: any) => item.id === "personal")
      .credential.lastFour).toBe("2222");
    expect(bobData.connectors.find((item: any) => item.id === "shared")
      .credential.lastFour).toBe("4444");

    const tokenResponse = await connecta.fetch(
      request("/ui/access-tokens", "alice", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE },
        body: JSON.stringify({ name: "Alice agent" }),
      }),
    );
    const token = (await tokenResponse.json() as any).token as string;
    const tokenView = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const tokenData = await tokenView.json() as any;
    expect(tokenData.accessTokenManagement).toBe("requires_operator");
    expect(tokenData.connectors.find((item: any) => item.id === "shared")
      .credential).toBeUndefined();
    expect(tokenData.connectors.find((item: any) => item.id === "personal")
      .message).toBe("1111");
  });

  it("returns a personal OAuth callback to the principal that started it", async () => {
    const oauth: Connector = {
      id: "oauth",
      description: "Personal OAuth connection",
      authScope: "personal",
      async listTools() {
        return [];
      },
      async callTool() {},
      async status(ctx) {
        return await ctx.storage.get("token")
          ? { state: "ok" }
          : { state: "auth_required" };
      },
      async startAuth(ctx) {
        const state = crypto.randomUUID();
        await ctx.storage.set("pending", state);
        return {
          state: "auth_required",
          authorizationUrl: `https://provider.test/authorize?state=${state}`,
        };
      },
      async disconnectAuth(ctx) {
        await ctx.storage.delete("token");
        await ctx.storage.delete("pending");
      },
      async verifyState(state, ctx) {
        return state !== null && state === await ctx.storage.get("pending");
      },
      async finishAuth(_code, ctx) {
        await ctx.storage.set("token", "connected");
        await ctx.storage.delete("pending");
      },
    };
    const connecta = createTestConnecta({
      connectors: [oauth],
      auth: users(),
      identity: { operatorAccess: () => false },
      storage: memoryStorage(),
      publicUrl: BASE,
    });

    const started = await connecta.fetch(
      request("/ui/oauth/oauth", "alice", {
        method: "POST",
        headers: { Origin: BASE },
      }),
    );
    expect(started.status).toBe(200);
    const authorizationUrl = new URL((await started.json() as any).authorizationUrl);
    const state = authorizationUrl.searchParams.get("state");
    const fixedByAnotherUser = await connecta.fetch(
      request(`/oauth/callback/oauth?code=code&state=${state}`, "bob"),
    );
    expect(fixedByAnotherUser.status).toBe(400);
    const callback = await connecta.fetch(
      new Request(`${BASE}/oauth/callback/oauth?code=code&state=${state}`),
    );
    expect(callback.status).toBe(200);
    const replay = await connecta.fetch(
      new Request(`${BASE}/oauth/callback/oauth?code=code&state=${state}`),
    );
    expect(replay.status).toBe(400);

    const alice = await connecta.fetch(request("/ui/data", "alice"));
    const bob = await connecta.fetch(request("/ui/data", "bob"));
    expect(((await alice.json()) as any).connectors[0].status).toBe("ok");
    expect(((await bob.json()) as any).connectors[0].status).toBe("auth_required");
  });
});
