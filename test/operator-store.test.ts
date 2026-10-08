import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiData } from "../src/operator-ui/model.js";

/**
 * Within-document identity changes and request ordering in the operator store.
 * The visual matrix covers presentation; real-server flows cover sign-in and
 * reloads. These tests exercise Clerk listener changes while requests are in
 * flight, so stale data cannot land under another identity.
 */

const BASE = "https://deployment.example";

/** The constants `renderUiHtml` writes into the page ahead of the bundle. */
const PAGE_CONSTANTS = {
  MCP_URL: `${BASE}/mcp`,
  INITIAL_PAGE: "connections",
  HOME_URL: `${BASE}/`,
  TITLE_SUFFIX: " · Connecta",
  PRODUCT_NAME: "Connecta",
  PRODUCT_DESCRIPTION: "One MCP endpoint.",
  PRODUCT_OPERATOR_LABEL: "Connecta operator",
};

interface FakeSession {
  id: string;
  getToken(): Promise<string>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function uiData(identity: string): UiData {
  return {
    serverInfo: { name: identity, version: "host" },
    connectaVersion: "package",
    connectors: [],
    activityEnabled: true,
    credentialManagement: "available",
    oauthManagement: true,
  };
}

/**
 * A fake browser, then a fresh copy of the store module. The store reads its
 * configuration and its globals at import time, so the globals go up first and
 * the module registry is reset for every test — one store, one identity, one
 * test.
 */
async function loadStore(
  session: FakeSession,
  browserAuth: Record<string, unknown> = {
    kind: "clerk",
    publishableKey: "pk_test_fake",
  },
  page = "connections",
) {
  const fetchMock = vi.fn();
  const windowListeners = new Map<string, () => void>();
  let clerkListener: ((resources: { session?: FakeSession | null }) => void) | undefined;
  const clerk = {
    user: { id: "user_a" },
    session,
    load: vi.fn(async () => {}),
    addListener: (listener: typeof clerkListener) => {
      clerkListener = listener;
    },
    redirectToSignIn: vi.fn(),
    signOut: vi.fn(async () => {}),
  };
  const window = {
    location: { href: `${BASE}/`, assign: vi.fn(), reload: vi.fn() },
    Clerk: clerk,
    addEventListener: (name: string, listener: () => void) => {
      windowListeners.set(name, listener);
    },
    confirm: () => true,
  };
  vi.stubGlobal("window", window);
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  vi.doMock("../src/operator-ui/app/config.js", () => ({
    auth: browserAuth,
    initialPage: page,
    mcpUrl: PAGE_CONSTANTS.MCP_URL,
    homeUrl: PAGE_CONSTANTS.HOME_URL,
    titleSuffix: PAGE_CONSTANTS.TITLE_SUFFIX,
    productName: PAGE_CONSTANTS.PRODUCT_NAME,
    productDescription: PAGE_CONSTANTS.PRODUCT_DESCRIPTION,
    productOperatorLabel: PAGE_CONSTANTS.PRODUCT_OPERATOR_LABEL,
    TOKEN_KEY: "connecta:token",
  }));
  const store = await import("../src/operator-ui/app/store.js");
  return {
    store,
    clerk,
    fetchMock,
    windowListeners,
    window,
    /** Hand Clerk's listener a session change, the way Clerk itself would. */
    changeSession(next: FakeSession | null) {
      clerk.session = next as FakeSession;
      clerkListener?.({ session: next });
    },
  };
}

/** The Authorization header the nth request carried. */
function bearerOf(fetchMock: ReturnType<typeof vi.fn>, index: number): unknown {
  const init = fetchMock.mock.calls[index]?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.Authorization;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("operator store identity wiring", () => {
  it("consumes Query cancellation and drops a pending connector detail after sign-out", async () => {
    const { store, fetchMock, changeSession } = await loadStore({ id: "sess_a", getToken: async () => "token-a" });
    fetchMock.mockResolvedValueOnce(Response.json(uiData("identity-a")));
    await store.boot();
    const pending = deferred<Response>();
    fetchMock.mockImplementationOnce(() => pending.promise);
    const refresh = store.refreshConnector("github");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    changeSession(null);
    await expect(refresh).resolves.toBeUndefined();
    pending.resolve(Response.json({ id: "github", status: "ok", toolCount: 1, tools: [] }));
    await Promise.resolve();
    expect(store.getState().session).toBe("gated");
    expect(store.getState().data).toBeNull();
  });

  it("clears and refetches identity state when Clerk reports a new session", async () => {
    const sessionA: FakeSession = {
      id: "sess_a",
      getToken: async () => "token-a",
    };
    const { store, fetchMock, changeSession } = await loadStore(sessionA);

    fetchMock.mockResolvedValueOnce(Response.json(uiData("identity-a")));
    await store.boot();
    expect(store.getState().session).toBe("ready");
    expect(store.getState().data?.serverInfo.name).toBe("identity-a");
    expect(bearerOf(fetchMock, 0)).toBe("Bearer token-a");

    // Fill the rest of the identity-scoped state the way a working page does.
    fetchMock.mockResolvedValueOnce(
      Response.json({
        events: [
          {
            occurredAt: "2026-07-30T12:00:00.000Z",
            connectorId: "identity-a",
            toolName: "read",
            address: "identity-a.read",
            source: "call_tool",
            outcome: "success",
            durationMs: 2,
            attempts: 1,
          },
        ],
      }),
    );
    await store.loadActivity(true);
    store.setConnectorFilter("identity-a");
    expect(store.getState().activityEvents).toHaveLength(1);

    // The replacement identity's /ui/data is held open, so the assertions below
    // describe the window between "Clerk changed identity" and "the new
    // identity's data arrived" — the window in which stale data would show.
    const second = deferred<Response>();
    fetchMock.mockImplementationOnce(() => second.promise);
    const before = store.getState().generation;
    changeSession({ id: "sess_b", getToken: async () => "token-b" });

    const gated = store.getState();
    expect(gated.generation).toBe(before + 1);
    expect(gated.session).toBe("gated");
    expect(gated.data).toBeNull();
    expect(gated.activityEvents).toEqual([]);
    expect(gated.connectorFilter).toBe("");
    expect(gated.activityPhase).toBe("idle");
    expect(gated.credentialNotice).toBeNull();
    expect(gated.oauthNotice).toBeNull();
    expect(JSON.stringify(gated)).not.toContain("identity-a");

    second.resolve(Response.json(uiData("identity-b")));
    await vi.waitFor(() => {
      expect(store.getState().session).toBe("ready");
      expect(store.getState().data?.serverInfo.name).toBe("identity-b");
    });
    // The refetch asked as the new identity, not with the token that was
    // current when the listener fired.
    expect(bearerOf(fetchMock, fetchMock.mock.calls.length - 1)).toBe("Bearer token-b");
  });

  it("drops a response the previous identity asked for", async () => {
    const sessionA: FakeSession = {
      id: "sess_a",
      getToken: async () => "token-a",
    };
    const { store, fetchMock, changeSession } = await loadStore(sessionA);

    fetchMock.mockResolvedValueOnce(Response.json(uiData("identity-a")));
    await store.boot();

    // identity-a asks for its access tokens and the answer is slow.
    const slow = deferred<Response>();
    fetchMock.mockImplementationOnce(() => slow.promise);
    const inFlight = store.loadActivity(true);

    // identity-b arrives first, and its own /ui/data never settles here.
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    changeSession({ id: "sess_b", getToken: async () => "token-b" });

    slow.resolve(Response.json({ events: [{ connectorId: "identity-a client" }] }));
    await inFlight;

    // The fence, not a race: identity-a's tokens never land on identity-b's
    // screen, and the collection stays idle so the new identity refetches.
    expect(JSON.stringify(store.getState())).not.toContain("identity-a client");
  });

  it("gates without a session and never asks for operator data", async () => {
    const { store, fetchMock } = await loadStore({
      id: "sess_a",
      getToken: async () => "",
    });
    await store.boot();
    expect(store.getState().session).toBe("gated");
    expect(store.getState().data).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the same-origin Access session without a browser-readable token", async () => {
    const loaded = await loadStore({ id: "unused", getToken: async () => "unused" }, { kind: "cloudflare-access" });
    loaded.fetchMock.mockResolvedValueOnce(Response.json(uiData("access-user")));

    await loaded.store.boot();

    expect(loaded.store.getState().session).toBe("ready");
    expect(loaded.clerk.load).not.toHaveBeenCalled();
    expect(loaded.fetchMock).toHaveBeenCalledWith("/ui/data", {
      headers: {},
      credentials: "same-origin",
    });
  });
});

describe("operator store action notices", () => {
  it("never puts a route's words in an OAuth or credential Test notice", async () => {
    // Stands in for an older or hostile server: every answer below carries a
    // downstream's words where the current routes send fixed ones or none.
    const SECRET = "sk_live_store_leak";
    const { store, fetchMock } = await loadStore({
      id: "sess_a",
      getToken: async () => "token-a",
    });
    fetchMock.mockResolvedValueOnce(Response.json(uiData("identity-a")));
    await store.boot();

    let answer: () => Response = () => Response.json({});
    fetchMock.mockImplementation(async (path: string) =>
      path.startsWith("/ui/connectors/") ? Response.json({ error: "unknown connector" }, { status: 404 }) : answer(),
    );
    const land = async (
      act: () => Promise<void>,
      respond: () => Response,
      notice: "oauthNotice" | "credentialNotice",
    ) => {
      answer = respond;
      await act();
      return store.getState()[notice];
    };

    expect(
      await land(
        () => store.startOAuth("svc", "restart"),
        () => Response.json({ error: `token ${SECRET}` }, { status: 502 }),
        "oauthNotice",
      ),
    ).toMatchObject({
      tone: "error",
      message: expect.stringContaining("Authorization couldn't start."),
      fix: { kind: "oauth_action_failed", connectorId: "svc" },
    });
    expect(
      await land(
        () => store.disconnectOAuth("svc"),
        () => Response.json({ error: SECRET }, { status: 400 }),
        "oauthNotice",
      ),
    ).toMatchObject({ tone: "error", message: expect.stringContaining("Disconnect didn't finish.") });
    // No window.open in this fake browser: the tab counts as blocked, and the
    // notice points at the link the row now offers.
    expect(
      await land(
        () => store.startOAuth("svc", "continue"),
        () =>
          Response.json({
            state: "auth_required",
            authorizationUrl: "https://provider.test/authorize",
            message: SECRET,
          }),
        "oauthNotice",
      ),
    ).toEqual({
      tone: "info",
      message: "Your browser blocked the new tab. Open the authorization page from the link here.",
    });
    expect(store.getState().oauthBlocked).toBe("svc");
    expect(
      await land(
        () => store.testCredential("svc"),
        () => Response.json({ ok: false, message: SECRET }),
        "credentialNotice",
      ),
    ).toMatchObject({
      tone: "error",
      message: expect.stringContaining("Credential test failed"),
      fix: { kind: "credential_test_failed" },
    });
    expect(
      await land(
        () => store.testCredential("svc"),
        () => Response.json({ error: SECRET }, { status: 502 }),
        "credentialNotice",
      ),
    ).toMatchObject({ tone: "error", message: "The credential test couldn't run." });
    expect(
      await land(
        () => store.testCredential("svc"),
        () => Response.json({ error: SECRET, problem: "credential_mismatch" }, { status: 409 }),
        "credentialNotice",
      ),
    ).toMatchObject({ tone: "error", fix: { kind: "credential_mismatch" } });
    // A save the route refused says what to do next, never what the route said.
    expect(
      await land(
        () => store.saveCredential("svc", { value: "x" }),
        () => Response.json({ error: `vault said ${SECRET}` }, { status: 400 }),
        "credentialNotice",
      ),
    ).toMatchObject({ tone: "error", message: expect.stringContaining("wasn't saved") });
    // A failure the page words itself keeps its words: a 403 on a mutation is
    // a missing permission, answered inline, and never a trip to the gate.
    expect(
      await land(
        () => store.testCredential("svc"),
        () => Response.json({ error: SECRET }, { status: 403 }),
        "credentialNotice",
      ),
    ).toMatchObject({
      message: "You don't have permission to change this connection's authentication.",
    });
    expect(store.getState().session).toBe("ready");
    expect(store.getState().credentialNoticeFor).toBe("svc");

    expect(JSON.stringify(store.getState())).not.toContain(SECRET);
  });

  it("asks the route to continue or restart through the mode parameter", async () => {
    const { store, fetchMock } = await loadStore({
      id: "sess_a",
      getToken: async () => "token-a",
    });
    fetchMock.mockResolvedValueOnce(Response.json(uiData("identity-a")));
    await store.boot();
    fetchMock.mockImplementation(async () => Response.json({ state: "ok" }));
    await store.startOAuth("svc", "continue");
    await store.startOAuth("svc", "restart");
    const starts = fetchMock.mock.calls
      .filter(([path]) => String(path).startsWith("/ui/oauth/"))
      .map(([path, init]) => [path, (init as RequestInit).method]);
    expect(starts).toEqual([
      ["/ui/oauth/svc?mode=continue", "POST"],
      ["/ui/oauth/svc?mode=restart", "POST"],
    ]);
    // `continue` on a healthy connector changes nothing and says so.
    expect(store.getState().oauthNotice).toEqual({ tone: "info", message: "Connected." });
  });
});

describe("operator store load failures", () => {
  it("stays signed in with a retry when /ui/data fails for any reason but the session", async () => {
    const { store, fetchMock } = await loadStore({
      id: "sess_a",
      getToken: async () => "token-a",
    });
    fetchMock.mockResolvedValueOnce(Response.json({ error: "boom" }, { status: 500 }));
    await store.boot();
    expect(store.getState()).toMatchObject({ session: "ready", loadFailure: "server", gate: null });

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await store.retryLoad();
    expect(store.getState()).toMatchObject({ session: "ready", loadFailure: "network" });

    fetchMock.mockResolvedValueOnce(Response.json(uiData("identity-a")));
    await store.retryLoad();
    expect(store.getState()).toMatchObject({ session: "ready", loadFailure: null });
    expect(store.getState().data?.serverInfo.name).toBe("identity-a");
  });

  it("returns to the gate only when the session read is refused", async () => {
    const { store, fetchMock } = await loadStore({
      id: "sess_a",
      getToken: async () => "token-a",
    });
    fetchMock.mockResolvedValueOnce(Response.json({ error: "unauthorized" }, { status: 401 }));
    await store.boot();
    expect(store.getState()).toMatchObject({ session: "gated", loadFailure: null });
    expect(store.getState().gate?.message).toContain("Clerk session wasn't accepted");
  });
});

describe("managed token secret lifetime", () => {
  it("drops an issued secret when the requesting identity changes", async () => {
    const { store, fetchMock, changeSession } = await loadStore({ id: "a", getToken: async () => "a" });
    fetchMock.mockResolvedValueOnce(Response.json(uiData("a")));
    await store.boot();
    const slow = deferred<Response>();
    fetchMock.mockImplementationOnce(() => slow.promise);
    const pending = store.createAccessToken("desktop");
    // Let the POST capture its original session before switching identities.
    await Promise.resolve();
    await Promise.resolve();
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    changeSession({ id: "b", getToken: async () => "b" });
    slow.resolve(Response.json({ token: "cta_disposable-secret", accessToken: { id: "issued", name: "desktop" } }));
    expect(await pending).toBe(false);
    expect(store.getState().createdToken).toBeNull();
    expect(JSON.stringify(store.getState())).not.toContain("cta_disposable-secret");
  });
});

describe("operator collection ordering", () => {
  it("loads existing tokens and keeps issuance when an earlier list finishes later", async () => {
    const { store, fetchMock } = await loadStore({ id: "session", getToken: async () => "token" });
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    const listing = store.loadAccessTokens();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const issued = { id: "issued", name: "client" };
    fetchMock.mockResolvedValueOnce(Response.json({ token: "secret", accessToken: issued }));
    expect(await store.createAccessToken("client")).toBe(true);
    const existing = { id: "existing", name: "older client" };
    old.resolve(Response.json({ accessTokens: [existing] }));
    await listing;
    expect(store.getState().tokens).toEqual([issued, existing]);
    expect(store.getState().tokenPhase).toBe("ready");
  });

  it.each(["rename", "revoke"])(
    "keeps a local %s when a pending list captured the new token earlier",
    async (action) => {
      const { store, fetchMock } = await loadStore({ id: "session", getToken: async () => "token" });
      const old = deferred<Response>();
      fetchMock.mockReturnValueOnce(old.promise);
      const listing = store.loadAccessTokens();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const issued = { id: "issued", name: "client" };
      fetchMock.mockResolvedValueOnce(Response.json({ token: "secret", accessToken: issued }));
      expect(await store.createAccessToken("client")).toBe(true);
      const existing = { id: "existing", name: "older client" };
      const snapshot = Response.json({ accessTokens: [issued, existing] });
      const updated =
        action === "rename" ? { ...issued, name: "renamed client" } : { ...issued, revokedAt: "2026-10-01T00:00:00Z" };
      fetchMock.mockResolvedValueOnce(Response.json({ accessToken: updated }));
      if (action === "rename") await store.saveAccessTokenName(issued.id, updated.name);
      else await store.revokeAccessToken(issued.id);
      old.resolve(snapshot);
      await listing;
      expect(store.getState().tokens).toEqual([updated, existing]);
    },
  );

  it("keeps an existing token's local rename while a creation exposes its card during a pending read", async () => {
    const { store, fetchMock } = await loadStore({ id: "session", getToken: async () => "token" });
    const existing = { id: "existing", name: "older client" };
    fetchMock.mockResolvedValueOnce(Response.json({ accessTokens: [existing] }));
    await store.loadAccessTokens();
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    const listing = store.loadAccessTokens();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const issued = { id: "issued", name: "new client" };
    fetchMock.mockResolvedValueOnce(Response.json({ token: "secret", accessToken: issued }));
    await store.createAccessToken("new client");
    const updated = { ...existing, name: "renamed client" };
    fetchMock.mockResolvedValueOnce(Response.json({ accessToken: updated }));
    await store.saveAccessTokenName(existing.id, updated.name);
    const other = { id: "other", name: "another client" };
    old.resolve(Response.json({ accessTokens: [issued, existing, other] }));
    await listing;
    expect(store.getState().tokens).toEqual([issued, updated, other]);
  });
});

describe("operator recovery races", () => {
  it.each(["disconnect", "remove"])("reloads connector state after a partially applied %s fails", async (action) => {
    const { store, fetchMock } = await loadStore({ id: "session", getToken: async () => "token" });
    const connected = { id: "svc", status: "ok", tools: [{ name: "read" }], toolCount: 1 };
    fetchMock.mockImplementation(async (path: string) =>
      path === "/ui/data"
        ? Response.json({ ...uiData("operator"), connectors: [connected] })
        : Response.json(connected),
    );
    await store.boot();
    await vi.waitFor(() => expect(store.getState().data?.connectors[0]?.status).toBe("ok"));
    fetchMock.mockClear();
    // The server retired the grant, then its cleanup failed. Re-reading is
    // how the operator learns that a failed click still disconnected it.
    fetchMock.mockImplementation(async (path: string) =>
      path.startsWith("/ui/connectors/")
        ? Response.json({ ...connected, status: "auth_required", tools: [], toolCount: 0 })
        : Response.json({ problem: "storage_failed" }, { status: 500 }),
    );
    if (action === "disconnect") await store.disconnectOAuth("svc");
    else await store.removeCredential("svc");
    await vi.waitFor(() => expect(store.getState().data?.connectors[0]?.status).toBe("auth_required"));
    expect(store.getState().data?.connectors[0]?.tools).toEqual([]);
    expect(store.getState()[action === "disconnect" ? "oauthNotice" : "credentialNotice"]?.tone).toBe("error");
  });

  it("keeps the latest operator reload when two retries overlap", async () => {
    const { store, fetchMock } = await loadStore({ id: "session", getToken: async () => "token" });
    fetchMock.mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 500 }));
    await store.boot();
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    const first = store.retryLoad();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fetchMock.mockResolvedValueOnce(Response.json(uiData("newer deployment state")));
    await store.retryLoad();
    old.resolve(Response.json(uiData("older deployment state")));
    await first;
    expect(store.getState().data?.serverInfo.name).toBe("newer deployment state");
  });
});

describe("operator unreadable collections", () => {
  it("keeps the operator retry available when /ui/data returns JSON null", async () => {
    const { store, fetchMock } = await loadStore({ id: "session", getToken: async () => "token" });
    fetchMock.mockResolvedValueOnce(Response.json(null));
    await store.boot();
    expect(store.getState()).toMatchObject({ session: "ready", loadFailure: "server" });
  });

  it.each(["truncated JSON", "null", "{}"])(
    "reports an unreadable token collection instead of no tokens: %s",
    async (body) => {
      const { store, fetchMock } = await loadStore({ id: "session", getToken: async () => "token" });
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
      await store.loadAccessTokens();
      expect(store.getState().tokenPhase).toBe("error");
      expect(store.getState().tokenNotice?.tone).toBe("error");
      fetchMock.mockResolvedValueOnce(Response.json({ accessTokens: [{ id: "recovered", name: "Client" }] }));
      await store.loadAccessTokens();
      expect(store.getState().tokenPhase).toBe("ready");
      expect(store.getState().tokens[0]?.id).toBe("recovered");
    },
  );
});

describe("activity collection recovery", () => {
  it.each(["truncated JSON", "null", "{}"])("offers retry for an unreadable activity page: %s", async (body) => {
    const { store, fetchMock } = await loadStore({ id: "session", getToken: async () => "token" });
    fetchMock.mockResolvedValueOnce(Response.json(uiData("operator")));
    await store.boot();
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
    await store.loadActivity(true);
    expect(store.getState().activityPhase).toBe("error");
    expect(store.getState().activityNotice?.tone).toBe("error");
    fetchMock.mockResolvedValueOnce(Response.json({ events: [{ connectorId: "recovered" }] }));
    await store.loadActivity(true);
    expect(store.getState().activityPhase).toBe("ready");
    expect(store.getState().activityEvents).toEqual([{ connectorId: "recovered" }]);
  });

  it("drops an older pagination response after a collection reset", async () => {
    const { store, fetchMock } = await loadStore({ id: "session", getToken: async () => "token" });
    fetchMock.mockResolvedValueOnce(Response.json(uiData("operator")));
    await store.boot();
    fetchMock.mockResolvedValueOnce(Response.json({ events: [{ connectorId: "initial" }], nextCursor: "page-two" }));
    await store.loadActivity(true);
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    const pagination = store.loadActivity(false);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    fetchMock.mockResolvedValueOnce(Response.json({ events: [{ connectorId: "fresh" }], nextCursor: "fresh-cursor" }));
    await store.loadActivity(true);
    old.resolve(Response.json({ events: [{ connectorId: "old-page-two" }], nextCursor: "old-cursor" }));
    await pagination;
    expect(store.getState().activityEvents).toEqual([{ connectorId: "fresh" }]);
    expect(store.getState().activityCursor).toBe("fresh-cursor");
  });
});
