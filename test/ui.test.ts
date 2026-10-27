import { ownStatus } from "../src/operator-record.js";
import { describe, expect, it, vi } from "vitest";
import type { ActivityReadPage, ToolCallActivityEvent } from "../src/activity.js";
import { activityHistory } from "../src/activity.js";
import { api } from "../src/connectors/api.js";
import {
  OPERATOR_UI_SCHEME_PATH as SCHEME_PATH,
  OPERATOR_UI_SCRIPT_PATH as SCRIPT_PATH,
} from "../src/operator-ui/generated.js";
import { responseCacheKeys } from "../src/storage/keys.js";
import { memoryStorage } from "../src/storage/memory.js";
import { withAbortableTimeout } from "../src/timeout.js";
import type { Connector, InboundAuth } from "../src/types.js";
import { buildUiData, isSafeHttpsUrl, isSafeIconHref } from "../src/ui.js";
import { CONNECTA_VERSION } from "../src/version.js";
import { calcApi, fakeClerkAuth, makeDeployment } from "./fixtures/http.js";
import { connectRequest, oauthVault } from "./fixtures/oauth.js";
import { BASE, CLERK_OPTIONS, credentialRequest, makeCredentialConnecta, TOKEN } from "./fixtures/ui.js";
import { createTestConnecta, fetchTestUiDetails, makeRegistry, required } from "./helpers.js";
import { machineAuth } from "./helpers/machine-auth.js";

const CALC_OPTIONS = { title: "Calculator", inputSchema: "object" } as const;

/** A connector whose listTools always throws — exercises broken-connector isolation. */
function broken(): Connector {
  return {
    id: "broken",
    description: "Broken connector",
    async listTools() {
      throw new Error("boom");
    },
    async callTool() {
      throw new Error("boom");
    },
  };
}

function uiDeploymentConfig(extra: Connector[] = []) {
  return {
    connectors: [calcApi(CALC_OPTIONS), broken(), ...extra],
    auth: machineAuth(TOKEN),
    storage: memoryStorage(),
    publicUrl: BASE,
  };
}

/** The `src` of every `<script>` tag on a page, in document order. */
function scriptSrcs(body: string): string[] {
  return (body.match(/<script[^>]*>/g) ?? [])
    .map((tag) => /\bsrc="([^"]*)"/.exec(tag)?.[1])
    .filter((src): src is string => src !== undefined);
}

describe("status UI", () => {
  it("keeps deployment and operator data out of every open shell", async () => {
    const c = createTestConnecta({
      connectors: [
        api("sentinel_connector", {
          description: "SENTINEL_CONNECTOR_DESCRIPTION",
          tools: [],
        }),
      ],
      auth: machineAuth(TOKEN, { subjectId: "SENTINEL_ACTOR" }),
      storage: memoryStorage(),
      publicUrl: BASE,
      deploymentInfo: { id: "SENTINEL_DEPLOYMENT" },
    });
    for (const path of ["/"]) {
      const body = await (await c.fetch(new Request(`${BASE}${path}`))).text();
      expect(body).not.toContain("sentinel_connector");
      expect(body).not.toContain("SENTINEL_CONNECTOR_DESCRIPTION");
      expect(body).not.toContain("SENTINEL_ACTOR");
      expect(body).not.toContain("SENTINEL_DEPLOYMENT");
    }
  });

  it("scopes Clerk CAPTCHA, images and workers to pages with a validated loader", async () => {
    const c = createTestConnecta({
      connectors: [calcApi(CALC_OPTIONS)],
      auth: [machineAuth(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const res = await c.fetch(new Request(`${BASE}/`));
    const policy = res.headers.get("content-security-policy")!;
    expect(policy).toContain("script-src 'self' https://clerk.example.com https://challenges.cloudflare.com;");
    expect(policy).toContain("frame-src https://challenges.cloudflare.com");
    expect(policy).toContain("connect-src 'self' https://clerk.example.com;");
    expect(policy).toContain("img-src 'self' https://img.clerk.com;");
    expect(policy).toContain("worker-src 'self' blob:;");
    expect(policy.split(";")[0]).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    const tags = (await res.text()).match(/<script[^>]*>/g) ?? [];
    const clerkTag = tags.find((tag) => tag.includes("data-clerk"));
    // The blocking loader settles before the deferred application boots.
    expect(clerkTag).not.toContain(" defer");
    expect(tags.every((tag) => !tag.includes("nonce="))).toBe(true);
  });

  it("/ui never fetches its sign-in loader from a non-https origin", async () => {
    for (const frontendApiUrl of [
      "javascript:alert(1)",
      "data:text/javascript,alert(1)",
      "http://clerk.example.com",
      "//clerk.example.com",
      "clerk.example.com",
    ]) {
      const c = createTestConnecta({
        connectors: [calcApi(CALC_OPTIONS)],
        auth: [machineAuth(TOKEN), fakeClerkAuth({ ...CLERK_OPTIONS, frontendApiUrl })],
        storage: memoryStorage(),
        publicUrl: BASE,
      });
      const res = await c.fetch(new Request(`${BASE}/`));
      const body = await res.text();
      // The shell still renders — a rejected loader origin drops the loader, it
      // does not fail the page.
      expect(res.status).toBe(200);
      expect(scriptSrcs(body)).toEqual([SCHEME_PATH, SCRIPT_PATH]);
      expect(body).not.toContain("clerk.browser.js");
      // Nor may it reach the page through the inline AUTH object.
      expect(body).not.toContain(frontendApiUrl);
      expect(res.headers.get("content-security-policy")).not.toMatch(/cloudflare|clerk|blob:/);
    }
  });

  it("/ui never hands Clerk a non-https signInUrl/signUpUrl", async () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/plain,alert(1)",
      "http://accounts.example.com/sign-in",
      "//accounts.example.com/sign-in",
      "/sign-in",
    ]) {
      const c = createTestConnecta({
        connectors: [calcApi(CALC_OPTIONS)],
        auth: [machineAuth(TOKEN), fakeClerkAuth({ ...CLERK_OPTIONS, signInUrl: url, signUpUrl: url })],
        storage: memoryStorage(),
        publicUrl: BASE,
      });
      const res = await c.fetch(new Request(`${BASE}/`));
      const body = await res.text();
      // Only the navigation targets drop: the page and its loader still render,
      // and Clerk.load falls back to its own sign-in defaults.
      expect(res.status).toBe(200);
      expect(body).toContain("clerk.browser.js");
      // The inline AUTH object is the only path into the page for these two, so
      // an absent key is the whole check — plus the raw value nowhere at all.
      expect(body).not.toContain('"signInUrl"');
      expect(body).not.toContain('"signUpUrl"');
      expect(body).not.toContain(url);
    }
  });

  it("/ui/data 401s without a token and includes WWW-Authenticate", async () => {
    const c = makeDeployment(uiDeploymentConfig());
    const res = await fetchTestUiDetails(c, new Request(`${BASE}/ui/data`));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
  });

  it("/ui/data with a machine token returns connectors with tools and isolates a broken one", async () => {
    const c = makeDeployment(uiDeploymentConfig());
    const res = await fetchTestUiDetails(
      c,
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.serverInfo.name).toBe("connecta");
    expect(body.connectaVersion).toBe(CONNECTA_VERSION);
    expect(body.activityEnabled).toBe(false);
    expect(body.credentialManagement).toBe("requires_operator");

    const byId = Object.fromEntries(body.connectors.map((x: any) => [x.id, x]));
    expect(byId.calc.status).toBe("ok");
    expect(byId.calc.title).toBe("Calculator");
    expect(byId.calc.toolCount).toBe(1);
    expect(byId.calc.credential).toBeUndefined();
    expect(byId.calc.tools[0]).toMatchObject({
      name: "add",
      address: "calc.add",
      description: "Add two numbers",
    });

    expect(byId.broken.status).toBe("error");
    expect(byId.broken.tools).toEqual([]);
    expect(byId.broken.toolCount).toBe(0);
  });

  it("/ui/data exposes only the credential capability allowed for this identity", async () => {
    const { connecta } = makeCredentialConnecta();
    const bearer = (await (
      await fetchTestUiDetails(
        connecta,
        new Request(`${BASE}/ui/data`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      )
    ).json()) as any;
    expect(bearer.credentialManagement).toBe("requires_operator");
    expect(bearer.connectors[0].credential).toBeUndefined();

    const clerk = (await (
      await fetchTestUiDetails(
        connecta,
        new Request(`${BASE}/ui/data`, {
          headers: { Authorization: "Bearer clerk-token" },
        }),
      )
    ).json()) as any;
    expect(clerk.credentialManagement).toBe("available");
    expect(clerk.connectors[0].credential.label).toBe("API token");

    const withoutSlots = createTestConnecta({
      connectors: [calcApi(CALC_OPTIONS)],
      auth: [fakeClerkAuth(CLERK_OPTIONS)],
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const noSlots = (await (
      await fetchTestUiDetails(
        withoutSlots,
        new Request(`${BASE}/ui/data`, {
          headers: { Authorization: "Bearer clerk-token" },
        }),
      )
    ).json()) as any;
    expect(noSlots.credentialManagement).toBe("no_slots");
  });

  it("invalidates cached OAuth state when physical disconnect cleanup fails", async () => {
    const connector: Connector = {
      id: "oauth",
      kind: "mcp",
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
      async disconnectAuth() {
        throw new Error("provider cleanup failed");
      },
      async finishAuth() {},
      async verifyState() {
        return true;
      },
      async startAuth() {
        return { state: "auth_required" };
      },
    };
    const storage = memoryStorage();
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: fakeClerkAuth(CLERK_OPTIONS),
      storage,
      vault: oauthVault(storage),
      publicUrl: BASE,
    });
    await storage.set(responseCacheKeys.generation("oauth"), "stale catalog");

    const disconnected = await credentialRequest(connecta, "/ui/oauth/oauth", { method: "DELETE" });

    expect(disconnected.status).toBe(400);
    await expect(disconnected.json()).resolves.toEqual({
      error: "OAuth disconnect failed",
    });
    expect(await storage.get(responseCacheKeys.generation("oauth"))).not.toBe("stale catalog");
  });

  it("keeps OAuth mutation same-origin, Clerk-only, and connector-scoped", async () => {
    const connector: Connector = {
      id: "oauth",
      kind: "mcp",
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
      async disconnectAuth() {},
      async finishAuth() {},
      async verifyState() {
        return true;
      },
      async startAuth() {
        return {
          state: "auth_required",
          authorizationUrl: "javascript:alert(1)",
        };
      },
    };
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: [machineAuth(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
      storage: memoryStorage(),
      vault: oauthVault(memoryStorage()),
      publicUrl: BASE,
    });

    const noOrigin = await connecta.fetch(
      new Request(`${BASE}/ui/oauth/oauth`, {
        method: "DELETE",
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    expect(noOrigin.status).toBe(403);

    const bearer = await connecta.fetch(
      new Request(`${BASE}/ui/oauth/oauth`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: BASE },
      }),
    );
    expect(bearer.status).toBe(403);

    const unknown = await credentialRequest(connecta, "/ui/oauth/missing", { method: "DELETE" });
    expect(unknown.status).toBe(404);

    const options = await connecta.fetch(new Request(`${BASE}/ui/oauth/oauth`, { method: "OPTIONS" }));
    expect(options.status).toBe(405);
    expect(options.headers.get("access-control-allow-origin")).toBeNull();

    const restarted = await connectRequest(connecta, "/ui/oauth/oauth", { method: "POST" });
    expect(restarted.status).toBe(502);
    await expect(restarted.json()).resolves.toEqual({
      error: "OAuth authorization requires consent but no safe URL is available",
    });
  });

  it("closes OAuth mutation scopes and rejects connector error states", async () => {
    const closeScope = vi.fn(async () => {});
    const connector: Connector = {
      id: "oauth",
      kind: "mcp",
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
      async disconnectAuth() {},
      async finishAuth() {},
      async verifyState() {
        return true;
      },
      async startAuth() {
        return {
          state: "error",
          message: "downstream unavailable",
        };
      },
      closeScope,
    };
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: fakeClerkAuth(CLERK_OPTIONS),
      storage: memoryStorage(),
      vault: oauthVault(memoryStorage()),
      publicUrl: BASE,
    });

    expect(
      (
        await credentialRequest(connecta, "/ui/oauth/oauth", {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(closeScope).toHaveBeenCalledTimes(1);

    const restarted = await connectRequest(connecta, "/ui/oauth/oauth", { method: "POST" });
    expect(restarted.status).toBe(502);
    await expect(restarted.json()).resolves.toEqual({
      error: "OAuth authorization could not start",
    });
    expect(closeScope).toHaveBeenCalledTimes(2);

    const unsupported = await credentialRequest(connecta, "/ui/oauth/oauth", { method: "PUT" });
    expect(unsupported.status).toBe(405);
    expect(closeScope).toHaveBeenCalledTimes(2);
  });

  it("/ui/data bounds a never-settling scope teardown", async () => {
    let closes = 0;
    const connector: Connector = {
      id: "remote",
      kind: "mcp",
      description: "Remote service",
      async status() {
        return { state: "ok" };
      },
      async listTools() {
        return [{ name: "read", description: "Read records" }];
      },
      async callTool() {
        return null;
      },
      async closeScope() {
        closes++;
        await new Promise<never>(() => {});
      },
    };
    const c = createTestConnecta({
      connectors: [connector],
      auth: machineAuth(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });

    const res = await withAbortableTimeout(
      () =>
        fetchTestUiDetails(
          c,
          new Request(`${BASE}/ui/data`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
          }),
        ),
      1_000,
      "/ui/data with hung teardown",
    );

    expect(res.status).toBe(200);
    expect(closes).toBe(1);
  });

  it("/ui/data waits for every sibling probe before teardown after a rejection", async () => {
    let slowStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      slowStarted = resolve;
    });
    let releaseSlow!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowFinished = false;
    let closedMidProbe = false;
    const rejecting: Connector = {
      id: "rejecting",
      description: "Rejecting connector",
      async status() {
        return { state: "ok" };
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const slow: Connector = {
      id: "slow",
      description: "Slow connector",
      async status() {
        slowStarted();
        await release;
        slowFinished = true;
        return { state: "ok" };
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
      async closeScope() {
        if (!slowFinished) closedMidProbe = true;
      },
    };
    const registry = makeRegistry([rejecting, slow]);
    const credentialDriftFor = registry.credentialDriftFor.bind(registry);
    registry.credentialDriftFor = async (id) => {
      if (id === "rejecting") throw new Error("future unguarded rejection");
      return credentialDriftFor(id);
    };

    const loading = buildUiData(registry, BASE, {
      name: "connecta",
      version: "test",
    });
    await started;
    await Promise.resolve();
    expect(closedMidProbe).toBe(false);

    releaseSlow();
    const settled = await loading;
    expect(settled).toMatchObject({
      connectors: [
        { id: "rejecting", status: "error", problem: "connector_unavailable" },
        { id: "slow", status: "ok" },
      ],
    });
    // The rejection's text is classified, not shipped (see the status-message
    // tests in operator-ui-model.test.ts).
    expect(JSON.stringify(settled)).not.toContain("future unguarded rejection");
    expect(slowFinished).toBe(true);
    expect(closedMidProbe).toBe(false);
  });

  it("resolves activity ids only through their admitting provider namespace", async () => {
    const directoryA = vi.fn(async () => "Wrong Person");
    const directoryB = vi.fn(async () => "Right Person");
    const duplicateDirectoryB = vi.fn(async () => "Duplicate Resolver");
    const denied = () => ({
      ok: false as const,
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    });
    const providerA: InboundAuth = {
      kind: "oidc",
      interactiveOperator: true,
      activityActorNamespace: "https://id-a.example",
      activityActorLabel: directoryA,
      authorize: denied,
    };
    const providerB: InboundAuth = {
      kind: "oidc",
      interactiveOperator: true,
      activityActorNamespace: "https://id-b.example",
      activityActorLabel: directoryB,
      recognizesCredential: (request) => request.headers.get("authorization") === "Bearer operator",
      authorize(request) {
        return request.headers.get("authorization") === "Bearer operator" ? { ok: true, userId: "operator" } : denied();
      },
    };
    const providerBSecondGate: InboundAuth = {
      kind: "oidc",
      interactiveOperator: true,
      activityActorNamespace: "https://id-b.example",
      activityActorLabel: duplicateDirectoryB,
      authorize: denied,
    };
    const baseEvent: ToolCallActivityEvent = {
      schemaVersion: 1,
      id: "event-namespaced",
      occurredAt: "2026-07-23T12:00:00.000Z",
      requestId: "request",
      actor: {
        interactiveOperator: true,
        kind: "oidc",
        id: "local-user-1",
        namespace: "https://id-b.example",
        label: "Forged Stored Label",
      } as ToolCallActivityEvent["actor"],
      connectorId: "calc",
      toolName: "add",
      address: "calc.add",
      source: "call_tool",
      outcome: "success",
      durationMs: 1,
      attempts: 1,
      serverName: "connecta",
      serverVersion: "0.1.0",
    };
    const c = createTestConnecta({
      connectors: [calcApi(CALC_OPTIONS)],
      auth: [providerA, providerB, providerBSecondGate],
      maintainers: [{ namespace: "https://id-b.example", id: "operator" }],
      activity: activityHistory({
        store: {
          record() {},
          async list() {
            return {
              events: [
                baseEvent,
                {
                  ...baseEvent,
                  id: "event-legacy",
                  actor: {
                    interactiveOperator: true,
                    kind: "oidc",
                    id: "legacy-local-id",
                    label: "Forged Legacy Label",
                  } as ToolCallActivityEvent["actor"],
                },
              ],
            };
          },
        },
      }),
      publicUrl: BASE,
    });

    const response = await c.fetch(
      new Request(`${BASE}/ui/activity`, {
        headers: { Authorization: "Bearer operator" },
      }),
    );
    const page = (await response.json()) as ActivityReadPage;

    expect(required(page.events[0]).actor).toEqual({
      kind: "oidc",
      id: "local-user-1",
      namespace: "https://id-b.example",
      label: "Right Person",
    });
    expect(required(page.events[1]).actor).toEqual({
      kind: "oidc",
      id: "legacy-local-id",
    });
    expect(directoryA).not.toHaveBeenCalled();
    expect(directoryB).toHaveBeenCalledOnce();
    expect(duplicateDirectoryB).not.toHaveBeenCalled();
  });

  it("does not resolve legacy ids when any same-kind provider makes the directory ambiguous", async () => {
    const denied = () => ({
      ok: false as const,
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    });
    for (const ownerNamespace of ["https://id-a.example", undefined]) {
      const wrongDirectory = vi.fn(async () => "Wrong Person");
      const ownerWithoutResolver: InboundAuth = {
        interactiveOperator: true,
        kind: "oidc",
        ...(ownerNamespace ? { activityActorNamespace: ownerNamespace } : {}),
        authorize: denied,
      };
      const otherDirectory: InboundAuth = {
        interactiveOperator: true,
        kind: "oidc",
        activityActorNamespace: "https://id-b.example",
        activityActorLabel: wrongDirectory,
        recognizesCredential: (request) => request.headers.get("authorization") === "Bearer operator",
        authorize(request) {
          return request.headers.get("authorization") === "Bearer operator"
            ? { ok: true, userId: "operator" }
            : denied();
        },
      };
      const event: ToolCallActivityEvent = {
        schemaVersion: 1,
        id: "event-legacy",
        occurredAt: "2026-07-23T12:00:00.000Z",
        requestId: "request",
        actor: { kind: "oidc", id: "legacy-local-id" },
        connectorId: "calc",
        toolName: "add",
        address: "calc.add",
        source: "call_tool",
        outcome: "success",
        durationMs: 1,
        attempts: 1,
        serverName: "connecta",
        serverVersion: "0.1.0",
      };
      const c = createTestConnecta({
        connectors: [calcApi(CALC_OPTIONS)],
        auth: [ownerWithoutResolver, otherDirectory],
        maintainers: [{ namespace: "https://id-b.example", id: "operator" }],
        activity: activityHistory({
          store: {
            record() {},
            async list() {
              return { events: [event] };
            },
          },
        }),
        publicUrl: BASE,
      });

      const response = await c.fetch(
        new Request(`${BASE}/ui/activity`, {
          headers: { Authorization: "Bearer operator" },
        }),
      );
      const page = (await response.json()) as ActivityReadPage;

      expect(required(page.events[0]).actor).toEqual(event.actor);
      expect(wrongDirectory).not.toHaveBeenCalled();
    }
  });

  it("INV-7: bounds and aborts a custom activity-label resolver that never settles", async () => {
    vi.useFakeTimers();
    try {
      let enterResolver!: () => void;
      const resolverStarted = new Promise<void>((resolve) => {
        enterResolver = resolve;
      });
      let lookupSignal: AbortSignal | undefined;
      const resolveLabel = vi.fn((_id: string, signal?: AbortSignal) => {
        lookupSignal = signal;
        enterResolver();
        return new Promise<string | undefined>(() => {});
      });
      const auth: InboundAuth = {
        interactiveOperator: true,
        kind: "oidc",
        activityActorNamespace: "https://identity.example",
        activityActorLabel: resolveLabel,
        authorize: () => ({ ok: true, userId: "operator" }),
      };
      const event: ToolCallActivityEvent = {
        schemaVersion: 1,
        id: "event",
        occurredAt: "2026-07-23T12:00:00.000Z",
        requestId: "request",
        actor: {
          kind: "oidc",
          id: "local-user",
          namespace: "https://identity.example",
        },
        connectorId: "calc",
        toolName: "add",
        address: "calc.add",
        source: "call_tool",
        outcome: "success",
        durationMs: 1,
        attempts: 1,
        serverName: "connecta",
        serverVersion: "0.1.0",
      };
      const c = createTestConnecta({
        connectors: [calcApi(CALC_OPTIONS)],
        auth,
        activity: activityHistory({
          store: {
            record() {},
            async list() {
              return { events: [event] };
            },
          },
        }),
        maintainers: ["operator"],
        publicUrl: BASE,
      });

      const pending = c.fetch(
        new Request(`${BASE}/ui/activity`, {
          headers: { Authorization: "Bearer operator" },
        }),
      );
      // Authorization includes native async work. Wait for actual resolver
      // entry without spending any of its request-owned virtual deadline.
      await resolverStarted;
      expect(resolveLabel).toHaveBeenCalledExactlyOnceWith("local-user", expect.any(AbortSignal));
      await vi.advanceTimersByTimeAsync(1_500);
      const response = await pending;
      expect(lookupSignal?.aborted).toBe(true);
      const page = (await response.json()) as ActivityReadPage;
      expect(required(page.events[0]).actor).toEqual(event.actor);
    } finally {
      vi.useRealTimers();
    }
  });

  it("INV-6: /ui/data replaces connector-supplied catalog access with the current bounded observation", async () => {
    const hostile: Connector = {
      id: "hostile_status",
      description: "Hostile status seam",
      async status() {
        return {
          state: "ok",
          catalogAccess: {
            state: "stale",
            observedAt: "2026-08-13T12:00:00.000Z",
            payload: "exfiltrate-this",
          },
          arbitraryPayload: "exfiltrate-this-too",
        } as never;
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const c = makeDeployment(uiDeploymentConfig([hostile]));
    const res = await fetchTestUiDetails(
      c,
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    const body = (await res.json()) as any;
    const connector = body.connectors.find((candidate: any) => candidate.id === "hostile_status");

    expect(connector.catalogAccess).toEqual({ state: "fresh", observedAt: expect.any(String) });
    expect(connector.catalogAccess.observedAt).not.toBe("2026-08-13T12:00:00.000Z");
    expect(JSON.stringify(body)).not.toContain("exfiltrate-this");
  });
});

describe("isSafeHttpsUrl", () => {
  // Stricter than the branding href gate on purpose: the loader origin is
  // derived rather than typed, and the sign-in/sign-up targets are hosted
  // Account Portal addresses, which are https too — so there is no dev-loopback
  // or cleartext case to accommodate for any of the three.
  it("rejects http, other schemes, relative values, and non-strings", () => {
    expect(isSafeHttpsUrl("http://clerk.x.test")).toBe(false);
    expect(isSafeHttpsUrl("http://localhost:3000")).toBe(false);
    expect(isSafeHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpsUrl("data:text/javascript,alert(1)")).toBe(false);
    expect(isSafeHttpsUrl("//clerk.x.test")).toBe(false);
    expect(isSafeHttpsUrl("/npm/clerk.js")).toBe(false);
    expect(isSafeHttpsUrl("")).toBe(false);
    expect(isSafeHttpsUrl(undefined)).toBe(false);
    expect(isSafeHttpsUrl(42)).toBe(false);
  });
});

describe("isSafeIconHref", () => {
  it("rejects relative-looking values that carry an authority", () => {
    expect(isSafeIconHref("//evil.test/icon.svg")).toBe(false);
    expect(isSafeIconHref("/\\evil.test/icon.svg")).toBe(false);
    expect(isSafeIconHref("/\t/evil.test/icon.svg")).toBe(false);
    expect(isSafeIconHref("\\\\evil.test/icon.svg")).toBe(false);
  });

  // The origin comparison resolves against a fixed probe host, so a value whose
  // own authority is that host would pass it. The structural single-slash check
  // is what rejects these; without it the gate is only as good as the constant.
  it("rejects an authority that collides with the probe origin", () => {
    expect(isSafeIconHref("//connecta.invalid/x.svg")).toBe(false);
    expect(isSafeIconHref("//CONNECTA.INVALID/x")).toBe(false);
    expect(isSafeIconHref("/\\connecta.invalid/x")).toBe(false);
    expect(isSafeIconHref("//connecta.invalid:443/x")).toBe(false);
    expect(isSafeIconHref("//user@connecta.invalid/x")).toBe(false);
  });
});

it("INV-7: detail scopes finish independently and carry complete schemas and catalog facts", async () => {
  let slowClosed = 0;
  let fastClosed = 0;
  const slow: Connector = {
    id: "slow",
    listTools: async () => [],
    callTool: async () => null,
    status: (ctx) =>
      new Promise((_resolve, reject) =>
        ctx.signal!.addEventListener("abort", () => reject(ctx.signal!.reason), { once: true }),
      ),
    closeScope: async () => {
      slowClosed++;
    },
  };
  const fast: Connector = {
    id: "fast",
    callTool: async () => null,
    status: async () => ownStatus({ state: "ok", registrationPath: "static" }),
    listTools: async () => [
      {
        name: "read",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        outputSchema: { type: "object", properties: { found: { type: "boolean" } } },
      },
    ],
    closeScope: async () => {
      fastClosed++;
    },
  };
  const app = createTestConnecta({ connectors: [slow, fast], discovery: { probeTimeoutMs: 100 }, logger: "silent" });
  try {
    const blocked = app.fetch(new Request(`${BASE}/ui/connectors/slow`));
    const response = await app.fetch(new Request(`${BASE}/ui/connectors/fast`));
    expect(response.status).toBe(200);
    const detail = (await response.json()) as { overlay: unknown };
    expect(detail.overlay).toMatchObject({
      id: "fast",
      status: "ok",
      auth: { registrationPath: "static" },
      tools: [
        {
          address: "fast.read",
          classification: "read",
          inputSchema: { properties: { id: { type: "string" } } },
          outputSchema: { properties: { found: { type: "boolean" } } },
        },
      ],
      lastCall: null,
    });
    expect(fastClosed).toBe(1);
    const failed = (await (await blocked).json()) as { status: string };
    expect(failed.status).toBe("error");
    expect(slowClosed).toBe(1);
    expect(fastClosed).toBe(1);
  } finally {
    await app.close();
  }
});
