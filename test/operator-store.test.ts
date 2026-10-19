import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperatorUiContractV2 } from "../src/operator-ui/contract.js";
import type { UiData } from "../src/operator-ui/model.js";
import { OPERATOR_V2_MAINTAINER, OPERATOR_V2_MEMBER } from "./fixtures/operator-contract-v2.js";

const NOW = "2026-10-15T12:00:00.000Z";

/**
 * Within-document identity changes and request ordering in the operator store.
 * The visual matrix covers presentation; real-server flows cover sign-in and
 * reloads. These tests exercise Clerk listener changes while requests are in
 * flight, so stale data cannot land under another identity.
 */

const stores: Array<{ forgetBearer(): void }> = [];

const BASE = "https://deployment.example";
const CONFIG = "/ui/api/config";

type ConfigConnector = { id: string; title?: string };
type LiveConnector = { id: string; status: string; [key: string]: unknown };

/**
 * A maintainer's v2 contract with these configured connectors and live rows,
 * on the frozen fixture's other facts. Live rows gain the overlay fields the
 * contract requires.
 */
function v2(config: ConfigConnector[], live: LiveConnector[] = []): OperatorUiContractV2 {
  const base = structuredClone(OPERATOR_V2_MAINTAINER) as OperatorUiContractV2;
  return {
    ...base,
    config: {
      ...base.config!,
      connectors: config as NonNullable<OperatorUiContractV2["config"]>["connectors"],
    },
    live: {
      ...base.live,
      connectors: live.map((row) => ({
        tools: [],
        catalogAgeMs: null,
        lastCall: null,
        ...row,
      })) as never,
    },
    matrix: [],
  };
}

/** A v2 contract body for one role, fresh for every response. */
function contract(role: "maintainer" | "member"): Response {
  return Response.json(role === "maintainer" ? v2([]) : (structuredClone(OPERATOR_V2_MEMBER) as OperatorUiContractV2));
}

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
 *
 * `GET /ui/api/config`, the gate every load starts with, answers from its own
 * mock: a maintainer's v2 contract unless a test says otherwise, whose
 * connectors are the ones `declare()` names, else those of the last
 * `/ui/data` seen. The contract is read before `/ui/data`, so a test whose
 * first summary lists connectors declares them. `paths` records every request
 * in order, config included.
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
    location: {
      href: `${BASE}/`,
      pathname: "/connectors",
      assign: vi.fn(),
      reload: vi.fn(),
    },
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
  let summary: UiData | undefined;
  let declared: string[] | undefined;
  const paths: string[] = [];
  const configMock = vi.fn(async (_path: string, _init: RequestInit) =>
    Response.json(v2((declared ?? summary?.connectors.map(({ id }) => id) ?? []).map((id) => ({ id })))),
  );
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    paths.push(path);
    if (path.startsWith("/ui/api/config")) return configMock(path, init);
    const response = (await fetchMock(path, init)) as Response | undefined;
    if (path === "/ui/data" && response?.ok) {
      try {
        summary = (await response.clone().json()) as UiData;
      } catch {
        /* Unreadable response fixture. */
      }
    }
    return response;
  });
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
  stores.push(store);
  return {
    store,
    clerk,
    fetchMock,
    configMock,
    paths,
    windowListeners,
    window,
    /** The connectors the default contract configures, before any `/ui/data` is seen. */
    declare(ids: string[]) {
      declared = ids;
    },
    /** Hand Clerk's listener a session change, the way Clerk itself would. */
    changeSession(next: FakeSession | null) {
      clerk.session = next as FakeSession;
      clerkListener?.({ session: next });
    },
  };
}

/** Boot as a maintainer with no connectors, then forget the boot's calls. */
async function bootMaintainer(loaded: Awaited<ReturnType<typeof loadStore>>, identity = "operator") {
  loaded.fetchMock.mockResolvedValueOnce(Response.json(uiData(identity)));
  await loaded.store.boot();
  expect(loaded.store.getState()).toMatchObject({
    session: "ready",
    role: "maintainer",
  });
  loaded.fetchMock.mockClear();
  loaded.configMock.mockClear();
  loaded.paths.length = 0;
}

/** The Authorization header the nth request carried. */
function bearerOf(fetchMock: ReturnType<typeof vi.fn>, index: number): unknown {
  const init = fetchMock.mock.calls[index]?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.Authorization;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.forgetBearer();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("operator store identity wiring", () => {
  it("consumes Query cancellation and drops a pending connector detail after sign-out", async () => {
    const { store, fetchMock, changeSession, declare } = await loadStore({
      id: "sess_a",
      getToken: async () => "token-a",
    });
    declare(["github"]);
    const connector = { id: "github", status: "ok", toolCount: 0, tools: [] };
    fetchMock.mockImplementation(async (path: string) =>
      Response.json(path === "/ui/data" ? { ...uiData("identity-a"), connectors: [connector] } : connector),
    );
    await store.boot();
    await vi.waitFor(() => expect(store.getState().data?.connectors[0]?.status).toBe("ok"));
    const pending = deferred<Response>();
    fetchMock.mockImplementationOnce(() => pending.promise);
    const refresh = store.refreshConnector("github");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
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
    const { store, fetchMock, configMock, paths, changeSession } = await loadStore(sessionA);

    fetchMock.mockResolvedValueOnce(Response.json(uiData("identity-a")));
    await store.boot();
    // The contract decides the role first; a maintainer's data follows.
    expect(paths).toEqual([CONFIG, "/ui/data"]);
    expect(store.getState().session).toBe("ready");
    expect(store.getState().data?.serverInfo.name).toBe("identity-a");
    expect(bearerOf(fetchMock, 0)).toBe("Bearer token-a");
    expect(bearerOf(configMock, 0)).toBe("Bearer token-a");

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
    // current when the listener fired, and asked for the contract first.
    expect(bearerOf(fetchMock, fetchMock.mock.calls.length - 1)).toBe("Bearer token-b");
    expect(bearerOf(configMock, configMock.mock.calls.length - 1)).toBe("Bearer token-b");
    expect(paths.slice(-2)).toEqual([CONFIG, "/ui/data"]);
  });

  it("drops a response the previous identity asked for", async () => {
    const sessionA: FakeSession = {
      id: "sess_a",
      getToken: async () => "token-a",
    };
    const { store, fetchMock, configMock, changeSession } = await loadStore(sessionA);

    fetchMock.mockResolvedValueOnce(Response.json(uiData("identity-a")));
    await store.boot();

    // identity-a asks for its activity and the answer is slow. The request is
    // on the wire, past its token lookup, before anything else happens.
    const slow = deferred<Response>();
    fetchMock.mockImplementationOnce(() => slow.promise);
    const inFlight = store.loadActivity(true);
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/ui\/api\/activity\?/), expect.anything()),
    );

    // identity-b arrives while it is in flight, and its own load never settles here.
    configMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    changeSession({ id: "sess_b", getToken: async () => "token-b" });

    slow.resolve(Response.json({ events: [{ connectorId: "identity-a client" }] }));
    await inFlight;

    // The fence, not a race: identity-a's events never land on identity-b's
    // screen, and the collection stays idle so the new identity refetches.
    expect(store.getState()).toMatchObject({ activityEvents: [], activityPhase: "idle", activityNotice: null });
    expect(JSON.stringify(store.getState())).not.toContain("identity-a client");
  });

  it("gates without a session and never asks for operator data", async () => {
    const { store, fetchMock, paths } = await loadStore({
      id: "sess_a",
      getToken: async () => "",
    });
    await store.boot();
    expect(store.getState().session).toBe("gated");
    expect(store.getState().data).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(paths).toEqual([]);
  });

  it("uses the same-origin Access session without a browser-readable token", async () => {
    const loaded = await loadStore({ id: "unused", getToken: async () => "unused" }, { kind: "cloudflare-access" });
    loaded.fetchMock.mockResolvedValueOnce(Response.json(uiData("access-user")));

    await loaded.store.boot();

    expect(loaded.store.getState().session).toBe("ready");
    expect(loaded.clerk.load).not.toHaveBeenCalled();
    // The contract decides the role first; a maintainer's data follows.
    expect(loaded.paths).toEqual([CONFIG, "/ui/data"]);
    expect(loaded.configMock.mock.calls[0]?.[1]).toMatchObject({ headers: {}, credentials: "same-origin" });
    expect(loaded.fetchMock).toHaveBeenCalledWith("/ui/data", {
      signal: expect.any(AbortSignal),
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
    const { store, fetchMock, declare } = await loadStore({
      id: "sess_a",
      getToken: async () => "token-a",
    });
    // Writes go out only for a connector the maintainer's contract shows.
    declare(["svc"]);
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
    ).toMatchObject({
      tone: "error",
      message: expect.stringContaining("Disconnect failed."),
    });
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
      message: "The new tab was blocked. Open the link here.",
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
    ).toMatchObject({
      tone: "error",
      message: "The credential test couldn't run.",
    });
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
    ).toMatchObject({
      tone: "error",
      message: expect.stringContaining("Not saved."),
    });
    // A failure the page words itself keeps its words: a 403 on a mutation is
    // a missing permission, answered inline, and never a trip to the gate.
    expect(
      await land(
        () => store.testCredential("svc"),
        () => Response.json({ error: SECRET }, { status: 403 }),
        "credentialNotice",
      ),
    ).toMatchObject({
      message: "You can't change this connection's authentication.",
    });
    expect(store.getState().session).toBe("ready");
    expect(store.getState().credentialNoticeFor).toBe("svc");

    expect(JSON.stringify(store.getState())).not.toContain(SECRET);
  });

  it("asks the route to continue or restart through the mode parameter", async () => {
    const { store, fetchMock, declare } = await loadStore({
      id: "sess_a",
      getToken: async () => "token-a",
    });
    // Writes go out only for a connector the maintainer's contract shows.
    declare(["svc"]);
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
    expect(store.getState().oauthNotice).toEqual({
      tone: "info",
      message: "Connected.",
    });
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
    expect(store.getState()).toMatchObject({
      session: "ready",
      loadFailure: "server",
      gate: null,
    });

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await store.retryLoad();
    expect(store.getState()).toMatchObject({
      session: "ready",
      loadFailure: "network",
    });

    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(150);
    fetchMock.mockResolvedValueOnce(Response.json(uiData("identity-a")));
    await store.retryLoad();
    expect(store.getState()).toMatchObject({
      session: "ready",
      loadFailure: null,
    });
    expect(store.getState().data?.serverInfo.name).toBe("identity-a");
  });

  it("returns to the gate only when the session read is refused", async () => {
    const { store, fetchMock } = await loadStore({
      id: "sess_a",
      getToken: async () => "token-a",
    });
    fetchMock.mockResolvedValueOnce(Response.json({ error: "unauthorized" }, { status: 401 }));
    await store.boot();
    expect(store.getState()).toMatchObject({
      session: "gated",
      loadFailure: null,
    });
    expect(store.getState().gate?.message).toContain("Clerk session not accepted");
  });
});

describe("operator admission gate", () => {
  it("gates on a refused contract before any operator data is requested", async () => {
    const { store, fetchMock, configMock, paths } = await loadStore({ id: "sess_a", getToken: async () => "token-a" });
    configMock.mockResolvedValueOnce(Response.json({ error: "unauthorized" }, { status: 401 }));
    await store.boot();
    expect(store.getState()).toMatchObject({ session: "gated", role: null, contract: null });
    expect(store.getState().gate?.message).toContain("Clerk session not accepted");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(paths).toEqual([CONFIG]);
  });

  it("INV-4: the contract's private 404 is signed in without access, and asks for nothing else", async () => {
    const { store, fetchMock, configMock, paths, windowListeners } = await loadStore({
      id: "sess_a",
      getToken: async () => "token-a",
    });
    configMock.mockImplementation(async () => Response.json({ error: "Not found" }, { status: 404 }));
    await store.boot();
    expect(store.getState()).toMatchObject({ session: "denied", role: null, contract: null, data: null });
    // No passive recovery: a viewer without access has nothing to retry.
    windowListeners.get("focus")?.();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(paths).toEqual([CONFIG]);
  });
});

describe("managed token secret lifetime", () => {
  it("drops an issued secret when the requesting identity changes", async () => {
    const { store, fetchMock, changeSession } = await loadStore({
      id: "a",
      getToken: async () => "a",
    });
    fetchMock.mockResolvedValueOnce(Response.json(uiData("a")));
    await store.boot();
    // Only a live slot is acted on: seed it, so the POST really goes out.
    fetchMock.mockResolvedValueOnce(
      Response.json({ agents: [{ name: "desktop", state: "none", revision: "desktopNoneRevision000" }] }),
    );
    await store.loadAccessTokens();
    const slow = deferred<Response>();
    fetchMock.mockImplementationOnce(() => slow.promise);
    const pending = store.rotateAgentToken("desktop");
    // The POST is in flight under the original session before identities switch.
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/ui/access-tokens/desktop",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    changeSession({ id: "b", getToken: async () => "b" });
    slow.resolve(
      Response.json({
        token: "cta_disposable-secret",
        agent: { name: "desktop", state: "issued", issuedAt: NOW },
      }),
    );
    await pending;
    expect(store.getState().createdToken).toBeNull();
    expect(JSON.stringify(store.getState())).not.toContain("cta_disposable-secret");
  });
});

describe("operator collection ordering", () => {
  const none = (name: string) => ({ name, state: "none" as const, revision: `${name}-none` });
  const issued = (name: string) => ({ name, state: "issued" as const, issuedAt: NOW, revision: `${name}-issued` });

  it("loads agent slots and keeps an issuance when an earlier list finishes later", async () => {
    const loaded = await loadStore({
      id: "session",
      getToken: async () => "token",
    });
    const { store, fetchMock } = loaded;
    await bootMaintainer(loaded);
    // Only a live slot is acted on, so a first list has to land.
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [none("simon"), none("ci")] }));
    await store.loadAccessTokens();
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    const listing = store.loadAccessTokens();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fetchMock.mockResolvedValueOnce(Response.json({ token: "secret", agent: issued("simon") }));
    await store.rotateAgentToken("simon");
    expect(fetchMock).toHaveBeenLastCalledWith("/ui/access-tokens/simon", expect.objectContaining({ method: "POST" }));
    old.resolve(Response.json({ agents: [none("simon"), none("ci")] }));
    await listing;
    expect(store.getState().tokens).toEqual([issued("simon"), none("ci")]);
    expect(store.getState().tokenPhase).toBe("ready");
  });

  it("keeps a local revoke when a pending list captured the issued slot earlier", async () => {
    const loaded = await loadStore({
      id: "session",
      getToken: async () => "token",
    });
    const { store, fetchMock } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [issued("simon"), none("ci")] }));
    await store.loadAccessTokens();
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    const listing = store.loadAccessTokens();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const revoked = {
      name: "simon",
      state: "revoked" as const,
      revokedAt: "2026-10-01T00:00:00Z",
    };
    fetchMock.mockResolvedValueOnce(Response.json({ agent: revoked }));
    await store.revokeAgentToken("simon");
    await store.confirmTokenAction();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/ui/access-tokens/simon",
      expect.objectContaining({ method: "DELETE" }),
    );
    old.resolve(Response.json({ agents: [issued("simon"), none("ci")] }));
    await listing;
    expect(store.getState().tokens).toEqual([revoked, none("ci")]);
  });

  it("sends the listed slot revision as expect, then the one each mutation returns", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock } = loaded;
    await bootMaintainer(loaded);
    const listed = "listedRevision00000000";
    const afterRotate = "rotatedRevision0000000";
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [{ ...issued("simon"), revision: listed }] }));
    await store.loadAccessTokens();
    fetchMock.mockResolvedValueOnce(
      Response.json({ token: "secret", agent: { ...issued("simon"), revision: afterRotate } }),
    );
    await store.rotateAgentToken("simon");
    // Rotation asks in the row first.
    await store.confirmTokenAction();
    const body = (call: number) => JSON.parse(String((fetchMock.mock.calls[call]![1] as RequestInit).body));
    expect(body(1)).toEqual({ expect: listed });
    const revoked = { name: "simon", state: "revoked" as const, revokedAt: NOW, revision: "revokedRevision0000000" };
    fetchMock.mockResolvedValueOnce(Response.json({ agent: revoked }));
    await store.revokeAgentToken("simon");
    await store.confirmTokenAction();
    expect(body(2)).toEqual({ expect: afterRotate });
    // The revoked slot, at the revision the revocation returned.
    expect(store.getState().tokens).toEqual([revoked]);
  });

  it("refuses an issuance response for another agent and reveals nothing", async () => {
    const loaded = await loadStore({
      id: "session",
      getToken: async () => "token",
    });
    const { store, fetchMock } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [none("simon")] }));
    await store.loadAccessTokens();
    fetchMock.mockResolvedValueOnce(Response.json({ token: "cta_misrouted", agent: issued("ci") }));
    await store.rotateAgentToken("simon");
    expect(store.getState().createdToken).toBeNull();
    expect(store.getState().tokenNotice?.tone).toBe("error");
    expect(store.getState().tokens).toEqual([none("simon")]);
  });

  it.each([
    [503, "issued", "Rotate result unknown for simon. No secret came back, so rotate again."],
    [503, "none", "Issue result unknown for simon. No secret came back, so rotate again."],
    [499, "issued", "The request ended before simon's token arrived."],
  ] as const)("shows a %i on %s as a failure and never retries it", async (status, slot, copy) => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [slot === "issued" ? issued("simon") : none("simon")] }));
    await store.loadAccessTokens();
    const before = fetchMock.mock.calls.length;
    fetchMock.mockResolvedValueOnce(Response.json({ error: "server words" }, { status }));
    await store.rotateAgentToken("simon");
    // Answers the in-row question a rotation asks; an issue sends at once.
    await store.confirmTokenAction();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock.mock.calls.slice(before).map(([path, init]) => [path, init.method])).toEqual([
      ["/ui/access-tokens/simon", "POST"],
    ]);
    expect(store.getState().tokenNotice).toMatchObject({ tone: "error" });
    expect(store.getState().tokenNotice?.message).toContain(copy);
    expect(store.getState().tokenNotice?.message).not.toContain("server words");
    expect(store.getState()).toMatchObject({ createdToken: null, tokenBusy: false });
  });

  it("never rotates or revokes an agent the live slot list does not show, even when the contract says issued", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock, window } = loaded;
    await bootMaintainer(loaded);
    // The contract says simon-ada is issued; the live list has no slot for it.
    expect(store.getState().contract?.agents.find((a) => a.name === "simon-ada")?.token.state).toBe("issued");
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [none("triage")] }));
    await store.loadAccessTokens();
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    const before = fetchMock.mock.calls.length;
    await store.rotateAgentToken("simon-ada");
    await store.revokeAgentToken("simon-ada");
    expect(fetchMock.mock.calls.length - before).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(store.getState().tokenConfirm).toBeNull();
    // A live issued slot still asks first, and a declined confirm sends nothing.
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [issued("simon-ada"), none("triage")] }));
    await store.loadAccessTokens();
    await store.rotateAgentToken("simon-ada");
    expect(store.getState().tokenConfirm).toEqual({ name: "simon-ada", action: "rotate" });
    store.cancelTokenAction();
    expect(fetchMock.mock.calls.length - before).toBe(1);
  });

  it("shows an unknown revocation as a failure and sends nothing more", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [issued("simon")] }));
    await store.loadAccessTokens();
    const before = fetchMock.mock.calls.length;
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "Revocation outcome unknown; revoke again" }, { status: 503 }),
    );
    await store.revokeAgentToken("simon");
    await store.confirmTokenAction();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock.mock.calls.length - before).toBe(1);
    expect(store.getState().tokenNotice?.message).toBe("Revoke result unknown for simon. Revoke again to be sure.");
    expect(store.getState().tokens).toEqual([issued("simon")]);
  });
});

describe("operator recovery races", () => {
  it.each(["disconnect", "remove"])("reloads connector state after a partially applied %s fails", async (action) => {
    const { store, fetchMock, declare } = await loadStore({
      id: "session",
      getToken: async () => "token",
    });
    declare(["svc"]);
    const connected = {
      id: "svc",
      status: "ok",
      tools: [{ name: "read" }],
      toolCount: 1,
    };
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
        ? Response.json({
            ...connected,
            status: "auth_required",
            tools: [],
            toolCount: 0,
          })
        : Response.json({ problem: "storage_failed" }, { status: 500 }),
    );
    if (action === "disconnect") await store.disconnectOAuth("svc");
    else await store.removeCredential("svc");
    await vi.waitFor(() => expect(store.getState().data?.connectors[0]?.status).toBe("auth_required"));
    expect(store.getState().data?.connectors[0]?.tools).toEqual([]);
    expect(store.getState()[action === "disconnect" ? "oauthNotice" : "credentialNotice"]?.tone).toBe("error");
  });

  it("keeps the latest operator reload when two retries overlap", async () => {
    const { store, fetchMock } = await loadStore({
      id: "session",
      getToken: async () => "token",
    });
    fetchMock.mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 500 }));
    await store.boot();
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    const first = store.retryLoad();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(150);
    fetchMock.mockResolvedValueOnce(Response.json(uiData("newer deployment state")));
    await store.retryLoad();
    old.resolve(Response.json(uiData("older deployment state")));
    await first;
    expect(store.getState().data?.serverInfo.name).toBe("newer deployment state");
  });
});

describe("operator unreadable collections", () => {
  it("keeps the operator retry available when /ui/data returns JSON null", async () => {
    const { store, fetchMock } = await loadStore({
      id: "session",
      getToken: async () => "token",
    });
    fetchMock.mockResolvedValueOnce(Response.json(null));
    await store.boot();
    expect(store.getState()).toMatchObject({
      session: "ready",
      loadFailure: "server",
    });
  });

  it.each(["truncated JSON", "null", "{}"])(
    "reports an unreadable token collection instead of no tokens: %s",
    async (body) => {
      const loaded = await loadStore({
        id: "session",
        getToken: async () => "token",
      });
      const { store, fetchMock } = loaded;
      await bootMaintainer(loaded);
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
      await store.loadAccessTokens();
      expect(store.getState().tokenPhase).toBe("error");
      // The page's error block says it once; the notice line stays empty.
      expect(store.getState().tokenNotice).toBeNull();
      fetchMock.mockResolvedValueOnce(Response.json({ agents: [{ name: "recovered", state: "none" }] }));
      await store.loadAccessTokens();
      expect(store.getState().tokenPhase).toBe("ready");
      expect(store.getState().tokens[0]?.name).toBe("recovered");
    },
  );
});

describe("activity collection recovery", () => {
  it.each(["truncated JSON", "null", "{}"])("offers retry for an unreadable activity page: %s", async (body) => {
    const { store, fetchMock } = await loadStore({
      id: "session",
      getToken: async () => "token",
    });
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
    const { store, fetchMock } = await loadStore({
      id: "session",
      getToken: async () => "token",
    });
    fetchMock.mockResolvedValueOnce(Response.json(uiData("operator")));
    await store.boot();
    fetchMock.mockResolvedValueOnce(
      Response.json({
        events: [{ connectorId: "initial" }],
        nextCursor: "page-two",
      }),
    );
    await store.loadActivity(true);
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    const pagination = store.loadActivity(false);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    fetchMock.mockResolvedValueOnce(
      Response.json({
        events: [{ connectorId: "fresh" }],
        nextCursor: "fresh-cursor",
      }),
    );
    await store.loadActivity(true);
    old.resolve(
      Response.json({
        events: [{ connectorId: "old-page-two" }],
        nextCursor: "old-cursor",
      }),
    );
    await pagination;
    expect(store.getState().activityEvents).toEqual([{ connectorId: "fresh" }]);
    expect(store.getState().activityCursor).toBe("fresh-cursor");
  });
});

describe("operator recovery bounds and snapshot ordering", () => {
  it("INV-4: fences queued focus and suppresses passive recovery until a new Clerk session", async () => {
    const { store, clerk, fetchMock, windowListeners, changeSession } = await loadStore({
      id: "a",
      getToken: async () => "a",
    });
    fetchMock.mockImplementation(async () => Response.json(uiData("operator")));
    await store.boot();
    await vi.waitFor(() => expect(store.getState().contractPhase).toBe("ready"));
    vi.useFakeTimers();
    clerk.signOut.mockImplementation(() => new Promise(() => {}));
    windowListeners.get("focus")?.();
    store.signOut();
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(200);
    expect(store.getState().session).toBe("gated");
    await vi.advanceTimersByTimeAsync(2100);
    windowListeners.get("focus")?.();
    await store.retryLoad();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getState().data).toBeNull();
    changeSession({ id: "b", getToken: async () => "b" });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().session).toBe("ready");
  });

  it("INV-4: drops a queued focus pass across an identity change", async () => {
    const { store, fetchMock, windowListeners, changeSession } = await loadStore({
      id: "a",
      getToken: async () => "a",
    });
    fetchMock.mockImplementation(async () => Response.json(uiData("operator")));
    await store.boot();
    await vi.waitFor(() => expect(store.getState().contractPhase).toBe("ready"));
    vi.useFakeTimers();
    windowListeners.get("focus")?.();
    const pending = deferred<Response>();
    fetchMock.mockReturnValue(pending.promise);
    changeSession({ id: "b", getToken: async () => "b" });
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/ui/data")).toHaveLength(2);
    pending.resolve(Response.json(uiData("new-operator")));
    await vi.advanceTimersByTimeAsync(0);
  });

  async function pollingStore() {
    const loaded = await loadStore({ id: "a", getToken: async () => "a" });
    const { store, fetchMock, configMock } = loaded;
    const connector = {
      id: "svc",
      status: "auth_required",
      oauth: true,
      tools: [],
      toolCount: 0,
    };
    const other = { ...connector, id: "other", status: "ok" };
    const contract = (rows = [connector, other]) =>
      v2(
        rows.map(({ id }) => ({ id })),
        rows.map((row) => ({ ...row, catalogAgeMs: null, lastCall: null })),
      );
    configMock.mockImplementation(async () => Response.json(contract()));
    fetchMock.mockImplementation(async (path: string) =>
      Response.json(
        path === "/ui/data"
          ? { ...uiData("operator"), connectors: [connector, other] }
          : path.startsWith("/ui/oauth/")
            ? {
                state: "auth_required",
                authorizationUrl: "https://provider.test/consent",
              }
            : path.endsWith("/other")
              ? other
              : connector,
      ),
    );
    store.routeChanged("/connectors/svc");
    await store.boot();
    await vi.waitFor(() => expect(store.getState().contractPhase).toBe("ready"));
    vi.useFakeTimers();
    await store.startOAuth("svc", "continue");
    await vi.advanceTimersByTimeAsync(0);
    fetchMock.mockClear();
    configMock.mockClear();
    return { ...loaded, connector, other, contract };
  }

  it("INV-4 INV-10: limits OAuth polls to the pending connector and preserves unrelated facts", async () => {
    const { store, fetchMock, configMock, connector, contract } = await pollingStore();
    const other = store.getState().data?.connectors[1];
    configMock.mockImplementation(async () => Response.json(contract([connector])));
    await vi.advanceTimersByTimeAsync(2100);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/ui/connectors/svc"]);
    expect(configMock.mock.calls.map(([path]) => path)).toEqual(["/ui/api/config?connector=svc"]);
    expect(store.getState().data?.connectors[1]).toBe(other);
    expect(store.getState().contract?.live.connectors).toHaveLength(2);
  });

  it.each(["ok", "error", "network", "refused"])("INV-10: stops OAuth polling on %s", async (terminal) => {
    const { fetchMock, configMock, connector, contract } = await pollingStore();
    fetchMock.mockImplementation(async () => {
      if (terminal === "network") throw new Error("offline");
      return terminal === "refused"
        ? new Response(null, { status: 500 })
        : Response.json({ ...connector, status: terminal });
    });
    configMock.mockImplementation(async () => Response.json(contract([{ ...connector, status: terminal }])));
    await vi.advanceTimersByTimeAsync(2100);
    fetchMock.mockClear();
    configMock.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(configMock).not.toHaveBeenCalled();
  });

  it.each(["/tools", "/connectors/other", "unmount", "sign-out", "deadline"])(
    "INV-4 INV-10: aborts both OAuth reads on %s and drops late responses",
    async (path) => {
      const { store, fetchMock, configMock, connector, contract } = await pollingStore();
      const pending = deferred<Response>();
      const pendingContract = deferred<Response>();
      let signal: AbortSignal | undefined;
      let contractSignal: AbortSignal | undefined;
      fetchMock.mockImplementation((_path: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return pending.promise;
      });
      configMock.mockImplementation((_path: string, init: RequestInit) => {
        contractSignal = init.signal ?? undefined;
        return pendingContract.promise;
      });
      await vi.advanceTimersByTimeAsync(2100);
      if (path === "unmount") store.stopConnectorReads("svc");
      else if (path === "sign-out") store.signOut();
      else if (path === "deadline") await vi.advanceTimersByTimeAsync(30_000);
      else store.routeChanged(path);
      expect(signal?.aborted).toBe(true);
      expect(contractSignal?.aborted).toBe(true);
      pendingContract.resolve(Response.json(contract([{ ...connector, status: "ok" }])));
      pending.resolve(Response.json({ ...connector, status: "ok" }));
      fetchMock.mockClear();
      configMock.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.getState().data?.connectors[0]?.status).toBe(path === "sign-out" ? undefined : "auth_required");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(configMock).not.toHaveBeenCalled();
    },
  );

  it("INV-10: never arms OAuth polling when its pending start finishes after unmount", async () => {
    const { store, fetchMock, configMock } = await pollingStore();
    store.stopOAuthPolling("svc");
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const start = store.startOAuth("svc", "continue");
    await vi.advanceTimersByTimeAsync(0);
    store.stopOAuthPolling("svc");
    pending.resolve(
      Response.json({
        state: "auth_required",
        authorizationUrl: "https://provider.test/consent",
      }),
    );
    await start;
    await vi.advanceTimersByTimeAsync(0);
    fetchMock.mockClear();
    configMock.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(configMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 503])(
    "INV-4 INV-10: preserves passive retry deadlines across Access %s refusals",
    async (status) => {
      const { store, fetchMock, windowListeners } = await loadStore(
        { id: "unused", getToken: async () => "unused" },
        { kind: "cloudflare-access" },
      );
      const visibilityListeners = new Map<string, () => void>();
      vi.stubGlobal("document", {
        visibilityState: "visible",
        addEventListener: (name: string, listener: () => void) => visibilityListeners.set(name, listener),
      });
      vi.useFakeTimers();
      vi.setSystemTime(100_000);
      const attempts: number[] = [];
      fetchMock.mockImplementation(async () => {
        attempts.push(Date.now() - 100_000);
        return Response.json({ problem: "identity_unavailable" }, { status });
      });
      await store.boot();
      const focus = () => {
        windowListeners.get("focus")?.();
        visibilityListeners.get("visibilitychange")?.();
      };
      // The reviewer's ten returns, each just past the focus debounce.
      for (let i = 0; i < 10; i++) {
        focus();
        await vi.advanceTimersByTimeAsync(160);
      }
      expect(attempts).toEqual([0]);
      await vi.advanceTimersByTimeAsync(400);
      expect(attempts).toEqual([0, 2000]);
      focus();
      await vi.advanceTimersByTimeAsync(1999);
      expect(attempts).toEqual([0, 2000]);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toEqual([0, 2000, 4000]);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(attempts).toEqual([0, 2000, 4000, 8000, 16_000]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toHaveLength(5);
      focus();
      await vi.advanceTimersByTimeAsync(160);
      expect(attempts).toHaveLength(6);
      for (let i = 0; i < 40; i++) {
        focus();
        await vi.advanceTimersByTimeAsync(160);
      }
      expect(attempts).toHaveLength(6);
      expect(store.getState().session).toBe("gated");
      expect(store.getState().data).toBeNull();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toHaveLength(6);
      // Only an explicit, debounced retry resets the exhausted budget.
      await Promise.all([store.retryLoad(), store.retryLoad(), store.retryLoad()]);
      expect(attempts).toHaveLength(7);
      await vi.advanceTimersByTimeAsync(2000);
      expect(attempts).toHaveLength(8);
    },
  );

  it("INV-4 INV-10: coalesces passive returns during an in-flight recovery and resets after success", async () => {
    const { store, fetchMock, windowListeners } = await loadStore(
      { id: "unused", getToken: async () => "unused" },
      { kind: "cloudflare-access" },
    );
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(Response.json({ problem: "identity_unavailable" }, { status: 503 }));
    await store.boot();
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(2000);
    for (let i = 0; i < 5; i++) {
      windowListeners.get("focus")?.();
      await vi.advanceTimersByTimeAsync(2100);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    pending.resolve(Response.json(uiData("recovered")));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().session).toBe("ready");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockImplementation(async () => Response.json({ problem: "identity_unavailable" }, { status: 503 }));
    await store.retryLoad();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it.each(["summary", "config", "config-body", "detail", "detail-body", "token"])(
    "INV-4 INV-10: publishes a healthy 16-second normal %s read without aborting or duplicating it",
    async (delayed) => {
      vi.useFakeTimers();
      const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 16_000));
      const { store, fetchMock, configMock, windowListeners } = await loadStore({
        id: "a",
        getToken: vi
          .fn()
          .mockImplementationOnce(async () => {
            if (delayed === "token") await wait();
            return "token";
          })
          .mockResolvedValue("token"),
      });
      const connector = { id: "svc", status: "ok", tools: [], toolCount: 0 };
      const contract = v2([{ id: "svc", title: "fresh" }], [{ ...connector, catalogAgeMs: null, lastCall: null }]);
      const signals: AbortSignal[] = [];
      const response = async (kind: string, value: object, init: RequestInit) => {
        signals.push(init.signal!);
        if (delayed === kind) await wait();
        const result = Response.json(value);
        if (delayed === `${kind}-body`)
          vi.spyOn(result, "json").mockImplementation(async () => {
            await wait();
            return value;
          });
        return result;
      };
      configMock.mockImplementation((_path, init) => response("config", contract, init));
      fetchMock.mockImplementation((path: string, init: RequestInit) =>
        path === "/ui/data"
          ? response("summary", { ...uiData("operator"), connectors: [connector] }, init)
          : response("detail", connector, init),
      );
      const boot = store.boot();
      await vi.advanceTimersByTimeAsync(15_000);
      await boot;
      expect(store.getState().recoveryPending).toBe(false);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      windowListeners.get("focus")?.();
      await vi.advanceTimersByTimeAsync(1000);
      expect(store.getState().contractPhase).toBe("ready");
      expect(store.getState().contract?.config?.connectors[0]?.title).toBe("fresh");
      expect(store.getState().data?.connectors[0]?.status).toBe("ok");
      await vi.advanceTimersByTimeAsync(100_000);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      expect(fetchMock.mock.calls.filter(([path]) => path === "/ui/data")).toHaveLength(1);
      expect(fetchMock.mock.calls.filter(([path]) => path === "/ui/connectors/svc")).toHaveLength(1);
      expect(configMock).toHaveBeenCalledTimes(1);
    },
  );

  it("INV-4 INV-10: bounds stalled session-token acquisition and fences its late continuation", async () => {
    const token = vi.fn(async () => "token");
    const { store, fetchMock, windowListeners } = await loadStore({
      id: "a",
      getToken: token,
    });
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await store.boot();
    const pending = deferred<string>();
    token.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getState().recoveryPending).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.getState().recoveryPending).toBe(false);
    expect(store.getState().loadFailure).toBe("network");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(async () => Response.json(uiData("recovered")));
    await store.retryLoad();
    pending.resolve("stale-token");
    windowListeners.get("focus")?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.getState().data?.serverInfo.name).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["summary", "config", "config-body", "detail", "detail-body"])(
    "INV-4 INV-10: bounds a never-settling %s recovery, preserves backoff, and lets Retry supersede it",
    async (stalled) => {
      const { store, fetchMock, configMock, windowListeners } = await loadStore(
        { id: "unused", getToken: async () => "unused" },
        { kind: "cloudflare-access" },
      );
      vi.useFakeTimers();
      const connector = { id: "svc", status: "ok", tools: [], toolCount: 0 };
      const contract = v2([{ id: "svc" }], [{ ...connector, catalogAgeMs: null, lastCall: null }]);
      const pending = deferred<Response>();
      const signals: AbortSignal[] = [];
      const stuck = (init: RequestInit, value: object) => {
        signals.push(init.signal!);
        if (!stalled.endsWith("body")) return pending.promise;
        const response = Response.json(value);
        vi.spyOn(response, "json").mockReturnValue(new Promise(() => {}));
        return Promise.resolve(response);
      };
      // The contract is the admission gate, so the first, failed admission is
      // its read; the passive retry then stalls at the stage under test.
      configMock.mockResolvedValueOnce(Response.json({ problem: "identity_unavailable" }, { status: 503 }));
      configMock.mockImplementation(async (_path, init) =>
        stalled.startsWith("config") ? stuck(init, contract) : Response.json(contract),
      );
      fetchMock.mockImplementation(async (path: string, init: RequestInit) => {
        if (path === "/ui/data")
          return stalled === "summary"
            ? stuck(init, {})
            : Response.json({ ...uiData("operator"), connectors: [connector] });
        return stalled.startsWith("detail") ? stuck(init, connector) : Response.json(connector);
      });
      await store.boot();
      await vi.advanceTimersByTimeAsync(2000);
      for (let i = 0; i < 7; i++) {
        windowListeners.get("focus")?.();
        await vi.advanceTimersByTimeAsync(2100);
      }
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);
      // A stalled contract stops admission before any `/ui/data` read.
      const admittedBeforeData = stalled.startsWith("config");
      expect(fetchMock.mock.calls.filter(([path]) => path === "/ui/data")).toHaveLength(admittedBeforeData ? 0 : 1);
      await vi.advanceTimersByTimeAsync(300);
      expect(signals[0]?.aborted).toBe(false);
      expect(store.getState().recoveryPending).toBe(false);
      // Without data, Access returns to its gate; with it, the snapshot errs.
      const noData = stalled === "summary" || admittedBeforeData;
      expect(noData ? store.getState().session : store.getState().contractPhase).toBe(noData ? "gated" : "error");
      // Timers and focus coalesce onto the pending read even after its guard
      // releases. They cannot abort it or start another request of any kind.
      await vi.advanceTimersByTimeAsync(100_000);
      windowListeners.get("focus")?.();
      await vi.advanceTimersByTimeAsync(160);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);
      configMock.mockImplementation(async () => Response.json(contract));
      fetchMock.mockImplementation(async (path: string) =>
        Response.json(path === "/ui/data" ? { ...uiData("recovered"), connectors: [connector] } : connector),
      );
      await Promise.all([store.retryLoad(), store.retryLoad()]);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(store.getState().contractPhase).toBe("ready");
      expect(store.getState().data?.serverInfo.name).toBe("recovered");
      pending.resolve(Response.json({ ...uiData("stale"), ...contract, ...connector }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.getState().data?.serverInfo.name).toBe("recovered");
      expect(fetchMock.mock.calls.filter(([path]) => path === "/ui/data")).toHaveLength(admittedBeforeData ? 1 : 2);
      // Boot, the stalled retry and the explicit Retry each start with the contract.
      expect(configMock).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["summary", "config"])(
    "INV-4 INV-10: coalesces the automatic schedule onto a never-settling %s read",
    async (stalled) => {
      const { store, fetchMock, configMock, windowListeners } = await loadStore(
        { id: "unused", getToken: async () => "unused" },
        { kind: "cloudflare-access" },
      );
      vi.useFakeTimers();
      const signals: AbortSignal[] = [];
      const stuck = (_path: string, init: RequestInit) => {
        signals.push(init.signal!);
        return new Promise<Response>(() => {});
      };
      // Admission starts with the contract: its first read fails, and the
      // passive retry stalls at the contract or, past it, at `/ui/data`.
      configMock.mockResolvedValueOnce(Response.json({ problem: "identity_unavailable" }, { status: 503 }));
      configMock.mockImplementation(stalled === "config" ? stuck : async () => contract("maintainer"));
      fetchMock.mockImplementation(stalled === "summary" ? stuck : async () => Response.json(uiData("operator")));
      await store.boot();
      await vi.advanceTimersByTimeAsync(100_000);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);
      expect(store.getState().recoveryPending).toBe(false);
      expect(fetchMock.mock.calls.filter(([path]) => path === "/ui/data")).toHaveLength(stalled === "summary" ? 1 : 0);
      windowListeners.get("focus")?.();
      await vi.advanceTimersByTimeAsync(160);
      await vi.advanceTimersByTimeAsync(100_000);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);
    },
  );

  it.each(["summary", "config"])(
    "INV-4: sign-out cancels a never-settling %s recovery and fences queued work",
    async (stalled) => {
      const { store, fetchMock, configMock, windowListeners } = await loadStore(
        { id: "unused", getToken: async () => "unused" },
        { kind: "cloudflare-access" },
      );
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      const stuck = (_path: string, init: RequestInit) => {
        signal = init.signal!;
        return new Promise<Response>(() => {});
      };
      // Admission starts with the contract: its first read fails, and the
      // passive retry stalls at the contract or, past it, at `/ui/data`.
      configMock.mockResolvedValueOnce(Response.json({ problem: "identity_unavailable" }, { status: 503 }));
      configMock.mockImplementation(stalled === "config" ? stuck : async () => contract("maintainer"));
      fetchMock.mockImplementation(stalled === "summary" ? stuck : async () => Response.json(uiData("operator")));
      await store.boot();
      await vi.advanceTimersByTimeAsync(2000);
      windowListeners.get("focus")?.();
      store.signOut();
      expect(signal?.aborted).toBe(true);
      expect(store.getState().recoveryPending).toBe(false);
      await vi.advanceTimersByTimeAsync(100_000);
      windowListeners.get("focus")?.();
      await vi.advanceTimersByTimeAsync(200);
      // The failed boot read and the cancelled retry, and nothing after sign-out.
      expect(fetchMock).toHaveBeenCalledTimes(stalled === "summary" ? 1 : 0);
      expect(configMock).toHaveBeenCalledTimes(2);
      expect(store.getState().data).toBeNull();
      expect(store.getState().contract).toBeNull();
    },
  );

  it.each(["navigation", "unmount", "sign-out"])(
    "INV-4: %s aborts a timed-out config read and fences its late result",
    async (action) => {
      const { store, fetchMock, configMock } = await loadStore(
        { id: "unused", getToken: async () => "unused" },
        { kind: "cloudflare-access" },
      );
      vi.useFakeTimers();
      const pending = deferred<Response>();
      configMock.mockReturnValueOnce(pending.promise);
      fetchMock.mockResolvedValue(Response.json(uiData("operator")));
      const boot = store.boot();
      await vi.advanceTimersByTimeAsync(15_000);
      await boot;
      const signal = configMock.mock.calls[0]?.[1].signal;
      expect(signal?.aborted).toBe(false);
      if (action === "navigation") store.routeChanged("/tools");
      else if (action === "unmount") store.stopConnectorReads("svc");
      else store.signOut();
      expect(signal?.aborted).toBe(true);
      pending.resolve(Response.json(v2([], [])));
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().contract).toBeNull();
      expect(store.getState().recoveryPending).toBe(false);
    },
  );

  it.each(["config", "detail", "explicit-config", "explicit-detail"])(
    "INV-4 INV-10: publishes delayed %s recovery despite continuous focus with bounded reads",
    async (kind) => {
      const delayed = kind.endsWith("config") ? "config" : "detail";
      const { store, fetchMock, configMock, windowListeners } = await loadStore(
        { id: "unused", getToken: async () => "unused" },
        { kind: "cloudflare-access" },
      );
      vi.useFakeTimers();
      const connector = { id: "svc", status: "ok", tools: [], toolCount: 0 };
      const contract = v2([{ id: "svc" }], [{ ...connector, catalogAgeMs: null, lastCall: null }]);
      const pendingAuth = {
        ...connector,
        status: "auth_required",
        oauth: true,
      };
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      // The first admission fails at its contract read; the recovery's
      // contract and detail reads are both slow, one slower than the other.
      configMock.mockResolvedValueOnce(Response.json({ problem: "identity_unavailable" }, { status: 503 }));
      configMock.mockImplementation(async () => {
        await delay(delayed === "config" ? 7000 : 5000);
        return Response.json(contract);
      });
      fetchMock.mockImplementation(async (path: string) => {
        if (path === "/ui/data")
          return Response.json({
            ...uiData("recovered"),
            connectors: [pendingAuth],
          });
        await delay(delayed === "detail" ? 7000 : 5000);
        return Response.json(connector);
      });
      await store.boot();
      expect(store.getState().session).toBe("gated");
      if (kind.startsWith("explicit")) {
        void store.retryLoad();
        await vi.advanceTimersByTimeAsync(0);
      } else await vi.advanceTimersByTimeAsync(2000);
      expect(store.getState().contractPhase).toBe("loading");
      // Every return is beyond the minimum interval, including while the
      // config has landed but its matching auth detail is still pending.
      for (let i = 0; i < 11; i++) {
        windowListeners.get("focus")?.();
        await vi.advanceTimersByTimeAsync(2100);
      }
      expect(store.getState().contractPhase).toBe("ready");
      expect(store.getState().contract?.live.connectors[0]?.status).toBe("ok");
      expect(store.getState().data?.connectors[0]?.status).toBe("ok");
      expect(fetchMock.mock.calls.filter(([path]) => path === "/ui/data")).toHaveLength(1);
      expect(fetchMock.mock.calls.filter(([path]) => path === "/ui/connectors/svc")).toHaveLength(1);
      // The failed boot read, then one recovery whose contract the details reuse.
      expect(configMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(configMock).toHaveBeenCalledTimes(2);
    },
  );

  // Admission reads the contract first and the details reuse it, so the
  // recovery never has both in flight: each is held in turn.
  it.each([
    ["retry", "config"],
    ["retry", "detail"],
    ["sign-out", "config"],
    ["sign-out", "detail"],
  ] as const)("INV-4: preserves %s while the passive recovery's %s read is in flight", async (action, held) => {
    const { store, fetchMock, configMock } = await loadStore(
      { id: "unused", getToken: async () => "unused" },
      { kind: "cloudflare-access" },
    );
    vi.useFakeTimers();
    const connector = { id: "svc", status: "ok", tools: [], toolCount: 0 };
    const contract = (title: string) =>
      v2([{ id: "svc", title }], [{ ...connector, catalogAgeMs: null, lastCall: null }]);
    const oldConfig = deferred<Response>();
    const oldDetail = deferred<Response>();
    configMock.mockResolvedValueOnce(Response.json({ problem: "identity_unavailable" }, { status: 503 }));
    if (held === "config") configMock.mockReturnValueOnce(oldConfig.promise);
    else configMock.mockResolvedValueOnce(Response.json(contract("recovering")));
    configMock.mockImplementation(async () => Response.json(contract("newer")));
    fetchMock.mockImplementation(async (path: string) =>
      path === "/ui/data" ? Response.json({ ...uiData("operator"), connectors: [connector] }) : oldDetail.promise,
    );
    await store.boot();
    await vi.advanceTimersByTimeAsync(2000);
    expect(configMock).toHaveBeenCalledTimes(2);
    const heldSignal =
      held === "config"
        ? configMock.mock.calls[1]?.[1].signal
        : fetchMock.mock.calls.find(([path]) => path === "/ui/connectors/svc")?.[1].signal;
    expect(heldSignal?.aborted).toBe(false);
    if (action === "retry") {
      fetchMock.mockImplementation(async (path: string) =>
        Response.json(path === "/ui/data" ? { ...uiData("operator"), connectors: [connector] } : connector),
      );
      await store.retryLoad();
      expect(store.getState().contract?.config?.connectors[0]?.title).toBe("newer");
    } else {
      store.signOut();
    }
    expect(heldSignal?.aborted).toBe(true);
    oldConfig.resolve(Response.json(contract("stale")));
    oldDetail.resolve(Response.json({ ...connector, status: "auth_required" }));
    await vi.advanceTimersByTimeAsync(60_000);
    if (action === "retry") {
      expect(store.getState().contract?.config?.connectors[0]?.title).toBe("newer");
      expect(store.getState().data?.connectors[0]?.status).toBe("ok");
    } else {
      expect(store.getState().session).toBe("gated");
      expect(store.getState().data).toBeNull();
      expect(store.getState().contract).toBeNull();
    }
    expect(configMock).toHaveBeenCalledTimes(action === "retry" ? 3 : 2);
    const summaries = (held === "config" ? 0 : 1) + (action === "retry" ? 1 : 0);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/ui/data")).toHaveLength(summaries);
  });

  it("INV-4: bounds gated Access retries and resumes admission checks on focus", async () => {
    const { store, fetchMock, windowListeners } = await loadStore(
      { id: "unused", getToken: async () => "unused" },
      { kind: "cloudflare-access" },
    );
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => Response.json({ problem: "identity_unavailable" }, { status: 503 }));
    await store.boot();
    expect(store.getState().session).toBe("gated");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(store.getState().data).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    fetchMock.mockImplementation(async () => Response.json(uiData("recovered")));
    windowListeners.get("focus")?.();
    await vi.advanceTimersByTimeAsync(200);
    expect(store.getState().session).toBe("ready");
    expect(store.getState().data?.serverInfo.name).toBe("recovered");
  });

  it("INV-10: polls status for a bounded OAuth window without replaying authorization", async () => {
    const { store, fetchMock, declare } = await loadStore({
      id: "a",
      getToken: async () => "a",
    });
    declare(["svc"]);
    const connector = {
      id: "svc",
      status: "auth_required",
      oauth: true,
      tools: [],
      toolCount: 0,
    };
    fetchMock.mockImplementation(async (path: string) =>
      Response.json(path === "/ui/data" ? { ...uiData("operator"), connectors: [connector] } : connector),
    );
    await store.boot();
    await vi.waitFor(() => expect(store.getState().data?.connectors[0]?.status).toBe("auth_required"));
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (path: string) =>
      Response.json(
        path.startsWith("/ui/oauth/")
          ? {
              state: "auth_required",
              authorizationUrl: "https://provider.test/consent",
            }
          : connector,
      ),
    );
    await store.startOAuth("svc", "continue");
    await vi.advanceTimersByTimeAsync(60_000);
    const count = fetchMock.mock.calls.length;
    expect(fetchMock.mock.calls.filter(([path]) => String(path).startsWith("/ui/connectors/")).length).toBeGreaterThan(
      2,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(count);
    expect(fetchMock.mock.calls.filter(([path]) => String(path).startsWith("/ui/oauth/"))).toHaveLength(1);
  });

  it("INV-4: a newer catalog cycle fences a timed-out summary without aborting it", async () => {
    const { store, fetchMock, configMock } = await loadStore({
      id: "a",
      getToken: async () => "a",
    });
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(Response.json(uiData("operator")));
    await store.boot();
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const retry = store.retryLoad();
    await vi.advanceTimersByTimeAsync(15_000);
    await retry;
    const signal = fetchMock.mock.calls[1]?.[1].signal;
    expect(signal?.aborted).toBe(false);
    await store.loadOperatorContract();
    expect(signal?.aborted).toBe(false);
    pending.resolve(Response.json(uiData("stale")));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().data?.serverInfo.name).toBe("operator");
    expect(store.getState().contractPhase).toBe("ready");
    // Boot, the timed-out Retry's admission, and the newer catalog cycle.
    expect(configMock).toHaveBeenCalledTimes(3);
  });

  it("INV-4 INV-10: publishes one catalog/auth revision and drops a late older refresh", async () => {
    const { store, fetchMock, configMock } = await loadStore({
      id: "a",
      getToken: async () => "a",
    });
    const old = {
      id: "svc",
      status: "auth_required",
      problem: "oauth_required",
      oauth: true,
      tools: [],
      toolCount: 0,
    };
    const live = {
      id: "svc",
      status: "ok",
      tools: [],
      catalogAgeMs: null,
      lastCall: null,
    };
    const contract = (row: object) => v2([{ id: "svc" }], [row as LiveConnector]);
    configMock.mockImplementation(async () => Response.json(contract(old)));
    fetchMock.mockImplementation(async (path: string) =>
      Response.json(path === "/ui/data" ? { ...uiData("operator"), connectors: [old] } : old),
    );
    await store.boot();
    await vi.waitFor(() => expect(store.getState().contractPhase).toBe("ready"));
    const pendingContract = deferred<Response>();
    const pendingDetail = deferred<Response>();
    configMock.mockReturnValueOnce(pendingContract.promise);
    fetchMock.mockReturnValueOnce(pendingDetail.promise);
    const first = store.loadOperatorContract();
    await vi.waitFor(() => expect(configMock).toHaveBeenCalledTimes(2));
    const oldSignal = configMock.mock.calls[1]?.[1].signal;
    expect(oldSignal?.aborted).toBe(false);
    configMock.mockImplementation(async () => Response.json(contract(live)));
    fetchMock.mockImplementation(async () => Response.json({ ...old, status: "ok", problem: undefined }));
    const seen: string[] = [];
    const stop = store.subscribe(() => {
      const state = store.getState();
      if (state.contract)
        seen.push(`${state.contract.live.connectors[0]?.status}/${state.data?.connectors[0]?.status}`);
    });
    await store.loadOperatorContract();
    expect(oldSignal?.aborted).toBe(false);
    pendingContract.resolve(Response.json(contract(old)));
    pendingDetail.resolve(Response.json(old));
    await first;
    stop();
    expect(store.getState().contract?.live.connectors[0]?.status).toBe("ok");
    expect(store.getState().data?.connectors[0]?.status).toBe("ok");
    expect(seen).not.toContain("ok/auth_required");
    expect(seen).not.toContain("auth_required/ok");
  });
});

describe("operator role changes", () => {
  const PRIVILEGED = ["/ui/data", "/ui/connectors/", "/ui/api/activity", "/ui/access-tokens"];
  const privileged = (paths: string[]) => paths.filter((path) => PRIVILEGED.some((prefix) => path.startsWith(prefix)));

  /** A maintainer with a connector waiting on OAuth, activity and tokens all loaded. */
  async function maintainerWithState() {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    loaded.declare(["github"]);
    const waiting = { id: "github", status: "auth_required", oauth: true, tools: [], toolCount: 0 };
    loaded.fetchMock.mockImplementation(async (path: string) => {
      if (path === "/ui/data") return Response.json({ ...uiData("maintainer data"), connectors: [waiting] });
      if (path.startsWith("/ui/connectors/")) return Response.json(waiting);
      if (path.startsWith("/ui/api/activity")) return Response.json({ events: [{ connectorId: "maintainer event" }] });
      if (path === "/ui/access-tokens")
        return Response.json({ agents: [{ name: "maintainer token", state: "issued", issuedAt: NOW }] });
      return Response.json({}, { status: 404 });
    });
    await loaded.store.boot();
    await vi.waitFor(() => expect(loaded.store.getState().data?.connectors[0]?.status).toBe("auth_required"));
    await loaded.store.loadActivity(true);
    await loaded.store.loadAccessTokens();
    expect(loaded.store.getState()).toMatchObject({ role: "maintainer", activityPhase: "ready", tokenPhase: "ready" });
    return loaded;
  }

  /** Every way a member's page could still ask for maintainer data. */
  async function tryPrivilegedReads(loaded: Awaited<ReturnType<typeof loadStore>>) {
    // A focus return re-reads connectors waiting on OAuth, after its debounce.
    loaded.windowListeners.get("focus")?.();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await loaded.store.refreshConnector("github");
    await loaded.store.loadActivity(true);
    await loaded.store.loadAccessTokens();
    await loaded.store.rotateAgentToken("maintainer token");
  }

  it.each([
    ["503", () => Response.json({ error: "unavailable" }, { status: 503 })],
    ["network error", () => Promise.reject(new TypeError("Failed to fetch"))],
  ] as const)(
    "INV-4: maintainer, then a %s on refresh, then member drops every maintainer fact and request",
    async (_name, failure) => {
      const loaded = await maintainerWithState();
      const { store, configMock, paths } = loaded;
      configMock.mockImplementationOnce(failure as () => Promise<Response>);
      await store.loadOperatorContract();
      // The failure leaves no contract to read a role from, but the store remembers it.
      expect(store.getState()).toMatchObject({ contract: null, contractPhase: "error", role: "maintainer" });

      // The demotion is the deployment's, so every read after it says member.
      configMock.mockImplementation(async () => contract("member"));
      const generation = store.getState().generation;
      await store.retryLoad();
      // The reset admits the viewer again from the top; wait for that answer.
      await vi.waitFor(() => expect(store.getState()).toMatchObject({ session: "ready", role: "member" }));
      const member = store.getState();
      expect(member.generation).toBeGreaterThan(generation);
      expect(member).toMatchObject({
        session: "ready",
        role: "member",
        data: null,
        tokens: [],
        activityEvents: [],
        activityPhase: "idle",
        tokenPhase: "idle",
        connectorFailures: {},
      });
      expect(member.contract?.role).toBe("member");
      expect(JSON.stringify(member)).not.toMatch(/maintainer (data|event|token)/);

      paths.length = 0;
      await tryPrivilegedReads(loaded);
      expect(privileged(paths)).toEqual([]);
    },
  );

  it("INV-4: a member promoted to maintainer loads maintainer data fresh", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock, configMock, paths } = loaded;
    configMock.mockResolvedValueOnce(contract("member"));
    fetchMock.mockResolvedValueOnce(Response.json(uiData("promoted data")));
    await store.boot();
    expect(store.getState()).toMatchObject({ session: "ready", role: "member", data: null });
    expect(paths).toEqual([CONFIG]);
    // Nothing maintainer-only goes out while the viewer is a member.
    await tryPrivilegedReads(loaded);
    expect(privileged(paths)).toEqual([]);

    const generation = store.getState().generation;
    await store.loadOperatorContract();
    await vi.waitFor(() => expect(store.getState().data?.serverInfo.name).toBe("promoted data"));
    expect(store.getState()).toMatchObject({ session: "ready", role: "maintainer" });
    expect(store.getState().contract?.role).toBe("maintainer");
    expect(store.getState().generation).toBeGreaterThan(generation);
    // One contract read for the promotion, then the maintainer's data.
    expect(paths.slice(-2)).toEqual([CONFIG, "/ui/data"]);
  });
});

describe("operator privileged requests", () => {
  it("INV-4: withholds a token read whose contract failed while its session token was read", async () => {
    // The first token lookup after boot is held; every other one answers at once.
    let held: ReturnType<typeof deferred<string>> | null = null;
    const loaded = await loadStore({
      id: "session",
      getToken: () => {
        const hold = held;
        held = null;
        return hold ? hold.promise : Promise.resolve("token");
      },
    });
    const { store, fetchMock, configMock, paths } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockImplementation(async () =>
      Response.json({ agents: [{ name: "maintainer token", state: "issued", issuedAt: NOW }] }),
    );

    const token = deferred<string>();
    held = token;
    const listing = store.loadAccessTokens();
    expect(held).toBeNull();
    // A refresh answers 503 while the token list waits on its session token.
    configMock.mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }));
    await store.loadOperatorContract();
    expect(store.getState()).toMatchObject({ contract: null, contractPhase: "error" });

    token.resolve("token");
    await listing;
    expect(paths.filter((path) => path.startsWith("/ui/access-tokens"))).toEqual([]);
    expect(store.getState().tokens).toEqual([]);
    expect(store.getState().tokenPhase).toBe("error");
  });
});

describe("operator connection writes", () => {
  const writes = (paths: string[]) =>
    paths.filter((path) => path.startsWith("/ui/credentials/") || path.startsWith("/ui/oauth/"));

  it.each(["credential save", "OAuth connect"] as const)(
    "INV-4: withholds the %s whose contract failed while its session token was read",
    async (kind) => {
      // The first token lookup after boot is held; every other one answers at once.
      let held: ReturnType<typeof deferred<string>> | null = null;
      const loaded = await loadStore({
        id: "session",
        getToken: () => {
          const hold = held;
          held = null;
          return hold ? hold.promise : Promise.resolve("token");
        },
      });
      const { store, fetchMock, configMock, paths } = loaded;
      loaded.declare(["svc"]);
      await bootMaintainer(loaded);
      fetchMock.mockImplementation(async () => Response.json({ state: "ok" }));

      const token = deferred<string>();
      held = token;
      const write =
        kind === "credential save"
          ? store.saveCredential("svc", { value: "typed" })
          : store.startOAuth("svc", "continue");
      expect(held).toBeNull();
      // A refresh answers 503 while the write waits on its session token.
      configMock.mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }));
      await store.loadOperatorContract();
      expect(store.getState()).toMatchObject({ contract: null, contractPhase: "error", role: "maintainer" });

      token.resolve("token");
      await write;
      expect(writes(paths)).toEqual([]);
      // Not sent, and the row says so.
      const notice = kind === "credential save" ? store.getState().credentialNotice : store.getState().oauthNotice;
      expect(notice?.tone).toBe("error");
    },
  );

  it("INV-4: sends a maintainer's write on a connector the contract shows, and nothing else", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock, paths } = loaded;
    loaded.declare(["svc"]);
    await bootMaintainer(loaded);
    fetchMock.mockImplementation(async () => Response.json({ state: "ok" }));
    await store.saveCredential("svc", { value: "typed" });
    await store.saveCredential("unlisted", { value: "typed" });
    expect(writes(paths)).toEqual(["/ui/credentials/svc"]);
    expect(store.getState().credentialNotice?.tone).toBe("error");
  });

  it("INV-4: a member writes only to their own personal connectors, with the actions manage names", async () => {
    const { store, fetchMock, configMock, paths } = await loadStore({ id: "session", getToken: async () => "token" });
    configMock.mockImplementation(async () => contract("member"));
    await store.boot();
    expect(store.getState()).toMatchObject({ session: "ready", role: "member" });
    fetchMock.mockImplementation(async () => Response.json({ state: "ok" }));
    // Personal, and the action is in `manage.actions`: sent.
    await store.startOAuth("slack", "continue");
    await store.saveCredential("notion", { values: { token: "typed" } });
    // Calendar may only disconnect; GitHub is shared; nothing else is listed.
    await store.startOAuth("calendar", "continue");
    await store.saveCredential("github", { value: "typed" });
    await store.disconnectOAuth("drive");
    expect(writes(paths)).toEqual(["/ui/oauth/slack?mode=continue", "/ui/credentials/notion"]);
    expect(store.getState().oauthNotice?.tone).toBe("error");
    expect(store.getState().credentialNotice?.tone).toBe("error");
  });
});

describe("actions revalidate at dispatch", () => {
  const none = (name: string) => ({ name, state: "none" as const, revision: `${name}-none` });
  const issued = (name: string) => ({ name, state: "issued" as const, issuedAt: NOW, revision: `${name}-issued` });
  /** A session whose next token read waits until released; every other read answers at once. */
  function heldSession() {
    let armed = false;
    let taken: ReturnType<typeof deferred<string>> | null = null;
    return {
      session: {
        id: "session",
        getToken: () => {
          if (!armed) return Promise.resolve("token");
          armed = false;
          taken = deferred<string>();
          return taken.promise;
        },
      } as FakeSession,
      hold() {
        armed = true;
      },
      release() {
        taken!.resolve("token");
      },
    };
  }
  const sent = (fetchMock: ReturnType<typeof vi.fn>, method: string) =>
    fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === method)
      .map(([path]) => path);

  it("does not issue when a reload turns the slot issued during the session-token await", async () => {
    const held = heldSession();
    const loaded = await loadStore(held.session);
    const { store, fetchMock, window } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [none("triage")] }));
    await store.loadAccessTokens();
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    held.hold();
    const issuing = store.rotateAgentToken("triage");
    // Meanwhile another tab issued it: the list now says issued.
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [issued("triage")] }));
    await store.loadAccessTokens();
    held.release();
    await issuing;
    expect(sent(fetchMock, "POST")).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
    expect(store.getState().tokenNotice?.message).toContain("changed, so nothing was sent");
  });

  it("does not rotate or revoke a confirmed slot that a reload removed before dispatch", async () => {
    const held = heldSession();
    const loaded = await loadStore(held.session);
    const { store, fetchMock } = loaded;
    await bootMaintainer(loaded);
    for (const act of [store.rotateAgentToken, store.revokeAgentToken]) {
      fetchMock.mockResolvedValueOnce(Response.json({ agents: [issued("simon-ada"), none("triage")] }));
      await store.loadAccessTokens();
      // Asked and confirmed; the reload lands while the send waits on its token.
      await act("simon-ada");
      held.hold();
      const acting = store.confirmTokenAction();
      fetchMock.mockResolvedValueOnce(Response.json({ agents: [none("triage")] }));
      await store.loadAccessTokens();
      held.release();
      await acting;
    }
    expect([...sent(fetchMock, "POST"), ...sent(fetchMock, "DELETE")]).toEqual([]);
  });

  it.each([503, 499])("leaves a slot unresolved after %i until a list read that started afterwards", async (status) => {
    {
      const loaded = await loadStore({ id: "session", getToken: async () => "token" });
      const { store, fetchMock, window } = loaded;
      await bootMaintainer(loaded);
      fetchMock.mockResolvedValueOnce(Response.json({ agents: [none("triage")] }));
      await store.loadAccessTokens();
      // A list read already in flight when the outcome went unknown proves nothing.
      const early = deferred<Response>();
      fetchMock.mockReturnValueOnce(early.promise);
      const earlyRead = store.loadAccessTokens();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      fetchMock.mockResolvedValueOnce(Response.json({ error: "unknown" }, { status }));
      await store.rotateAgentToken("triage");
      early.resolve(Response.json({ agents: [none("triage")] }));
      await earlyRead;
      window.confirm = vi.fn(() => true);
      await store.rotateAgentToken("triage");
      expect(sent(fetchMock, "POST")).toEqual(["/ui/access-tokens/triage"]);
      expect(window.confirm).not.toHaveBeenCalled();
      expect(store.getState().unresolvedSlots).toEqual(["triage"]);
      // A read that started after the failure settles it; the slot works again.
      fetchMock.mockResolvedValueOnce(Response.json({ agents: [none("triage")] }));
      await store.loadAccessTokens();
      expect(store.getState().unresolvedSlots).toEqual([]);
      fetchMock.mockResolvedValueOnce(Response.json({ token: "cta_x", agent: issued("triage") }));
      await store.rotateAgentToken("triage");
      expect(sent(fetchMock, "POST")).toEqual(["/ui/access-tokens/triage", "/ui/access-tokens/triage"]);
    }
  });

  /** A member contract with Notion's credential actions replaced. */
  function memberContract(actions: Array<"save" | "test" | "clear">): Response {
    const body = structuredClone(OPERATOR_V2_MEMBER) as typeof OPERATOR_V2_MEMBER & Record<string, unknown>;
    const notion = body.connectors.find((c) => c.id === "notion")!;
    (notion.manage as { actions: string[] }).actions = actions;
    return Response.json(body);
  }

  async function bootMember(session: FakeSession, actions: Array<"save" | "test" | "clear">) {
    const loaded = await loadStore(session);
    loaded.configMock.mockResolvedValueOnce(memberContract(actions));
    await loaded.store.boot();
    expect(loaded.store.getState()).toMatchObject({ session: "ready", role: "member" });
    return loaded;
  }

  it("closes a member's open Clear confirmation when a refresh drops clear, and never sends it", async () => {
    const { store, fetchMock, configMock } = await bootMember({ id: "session", getToken: async () => "token" }, [
      "save",
      "test",
      "clear",
    ]);
    store.askConfirm("notion", "credential_remove");
    expect(store.getState().confirming).toEqual({ connectorId: "notion", action: "credential_remove" });
    configMock.mockResolvedValueOnce(memberContract(["save"]));
    await store.loadOperatorContract();
    expect(store.getState().confirming).toBeNull();
    // The bar's callback, had it survived, is refused before dispatch.
    await store.removeCredential("notion");
    expect(sent(fetchMock, "DELETE")).toEqual([]);
    expect(store.getState().credentialNotice?.tone).toBe("error");
  });

  it("refuses a member's confirmed Clear when a refresh during the token await drops clear", async () => {
    const held = heldSession();
    const { store, fetchMock, configMock } = await bootMember(held.session, ["save", "test", "clear"]);
    held.hold();
    const clearing = store.removeCredential("notion");
    configMock.mockResolvedValueOnce(memberContract(["save"]));
    const refresh = store.loadOperatorContract();
    await vi.waitFor(() => expect(configMock).toHaveBeenCalledTimes(2));
    await refresh;
    held.release();
    await clearing;
    expect(sent(fetchMock, "DELETE")).toEqual([]);
  });

  it("refuses a member's edit and save without save, and closes the form when a refresh drops it", async () => {
    const { store, fetchMock, configMock } = await bootMember({ id: "session", getToken: async () => "token" }, [
      "save",
    ]);
    store.editCredential("notion");
    expect(store.getState().credentialEditing).toBe("notion");
    configMock.mockResolvedValueOnce(memberContract([]));
    await store.loadOperatorContract();
    expect(store.getState().credentialEditing).toBeNull();
    store.editCredential("notion");
    expect(store.getState().credentialEditing).toBeNull();
    await store.saveCredential("notion", { values: { workspace: "a", token: "b" } });
    await store.testCredential("notion");
    expect([...sent(fetchMock, "PUT"), ...sent(fetchMock, "POST")]).toEqual([]);
  });

  it("refuses member OAuth actions the refreshed contract no longer lists", async () => {
    const { store, fetchMock, configMock } = await bootMember({ id: "session", getToken: async () => "token" }, [
      "save",
    ]);
    vi.stubGlobal("window", { ...globalThis.window, open: () => null });
    const body = structuredClone(OPERATOR_V2_MEMBER);
    (body.connectors.find((c) => c.id === "slack")!.manage as { actions: string[] }).actions = [];
    configMock.mockResolvedValueOnce(Response.json(body));
    await store.loadOperatorContract();
    await store.startOAuth("slack", "continue");
    await store.startOAuth("slack", "restart");
    await store.disconnectOAuth("slack");
    expect([...sent(fetchMock, "POST"), ...sent(fetchMock, "DELETE")]).toEqual([]);
  });
});

describe("a token slot is resolved only by a list read that started after its last change", () => {
  // As the frozen contract lists triage, so the two agree until a test says otherwise.
  const none = (name: string) => ({
    name,
    state: "none" as const,
    revision: name === "triage" ? "triageNoneRevision0000" : `${name}-none`,
  });
  const issued = (name: string) => ({ name, state: "issued" as const, issuedAt: NOW, revision: `${name}-issued` });
  // simon-ada as the fixture contract reports it, so the two agree.
  const simon = {
    name: "simon-ada",
    state: "issued" as const,
    issuedAt: "2026-10-01T09:30:00.000Z",
    revision: "simonAdaIssuedRevision",
  };
  const posts = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST").map(([p]) => p);

  /** A 200 whose body breaks off: the connection drops while `json()` reads it. */
  function droppedBody(): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"token":"cta_'));
        controller.error(new Error("connection reset"));
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  for (const [label, answer] of [
    ["a truncated 200 body", () => new Response('{"token":"cta_half', { status: 200 })],
    ["a connection that drops during json()", droppedBody],
  ] as const) {
    it(`leaves the slot unresolved after ${label}, so a second Issue sends nothing`, async () => {
      const loaded = await loadStore({ id: "session", getToken: async () => "token" });
      const { store, fetchMock, window } = loaded;
      await bootMaintainer(loaded);
      fetchMock.mockResolvedValueOnce(Response.json({ agents: [none("triage")] }));
      await store.loadAccessTokens();
      fetchMock.mockResolvedValueOnce(answer());
      await store.rotateAgentToken("triage");
      expect(store.getState().tokenNotice?.tone).toBe("error");
      // The issuance may have committed: no unconfirmed rotation can follow it.
      const confirm = vi.fn(() => true);
      window.confirm = confirm;
      await store.rotateAgentToken("triage");
      expect(posts(fetchMock)).toEqual(["/ui/access-tokens/triage"]);
      expect(confirm).not.toHaveBeenCalled();
      expect(store.getState().unresolvedSlots).toEqual(["triage"]);
      // Only a list read that starts now settles it.
      fetchMock.mockResolvedValueOnce(Response.json({ agents: [issued("triage")] }));
      await store.loadAccessTokens();
      expect(store.getState().unresolvedSlots).toEqual([]);
    });
  }

  it("aborts a pending issue when a newer contract reports a different token state for that agent", async () => {
    let armed = false;
    let taken: ReturnType<typeof deferred<string>> | null = null;
    const session: FakeSession = {
      id: "session",
      getToken: () => {
        if (!armed) return Promise.resolve("token");
        armed = false;
        taken = deferred<string>();
        return taken.promise;
      },
    };
    const loaded = await loadStore(session);
    const { store, fetchMock, configMock, window } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [simon, none("triage")] }));
    await store.loadAccessTokens();
    window.confirm = vi.fn(() => true);
    armed = true;
    const issuing = store.rotateAgentToken("triage");
    // The contract, read later, says triage is issued; the cached list still says none.
    const newer = structuredClone(OPERATOR_V2_MAINTAINER);
    newer.agents = newer.agents.map((agent) =>
      agent.name === "triage"
        ? { ...agent, token: { state: "issued" as const, issuedAt: NOW, revision: "triageIssuedRevision00" } }
        : agent,
    );
    configMock.mockResolvedValueOnce(Response.json(newer));
    await store.loadOperatorContract();
    taken!.resolve("token");
    await issuing;
    expect(posts(fetchMock)).toEqual([]);
    expect(store.getState().unresolvedSlots).toEqual(["triage"]);
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("leaves a slot unresolved when a contract refresh removes its agent", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock, configMock } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [simon, none("triage")] }));
    await store.loadAccessTokens();
    const newer = structuredClone(OPERATOR_V2_MAINTAINER);
    newer.agents = newer.agents.filter((agent) => agent.name !== "triage");
    configMock.mockResolvedValueOnce(Response.json(newer));
    await store.loadOperatorContract();
    expect(store.getState().unresolvedSlots).toEqual(["triage"]);
  });
});

describe("token mutations compare and swap on the slot revision (P3b, #837)", () => {
  const simon = {
    name: "simon-ada",
    state: "issued" as const,
    issuedAt: "2026-10-01T09:30:00.000Z",
    revision: "simonAdaIssuedRevision",
  };
  const calls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls
      .filter(([, init]) => ["POST", "DELETE"].includes((init as RequestInit | undefined)?.method ?? "GET"))
      .map(([path, init]) => [
        (init as RequestInit).method,
        path,
        (init as RequestInit).body === undefined ? undefined : JSON.parse(String((init as RequestInit).body)),
      ]);

  it("sends expect with the revision the operator confirmed against", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock, window } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        agents: [
          { ...simon, revision: "r1" },
          { name: "triage", state: "none", revision: "t1" },
        ],
      }),
    );
    await store.loadAccessTokens();
    window.confirm = vi.fn(() => true);
    fetchMock.mockResolvedValueOnce(Response.json({ token: "cta_a", agent: { ...simon, revision: "r2" } }));
    await store.rotateAgentToken("simon-ada");
    await store.confirmTokenAction();
    fetchMock.mockResolvedValueOnce(
      Response.json({ agent: { name: "simon-ada", state: "revoked", revokedAt: NOW, revision: "r3" } }),
    );
    await store.revokeAgentToken("simon-ada");
    await store.confirmTokenAction();
    fetchMock.mockResolvedValueOnce(
      Response.json({ token: "cta_b", agent: { name: "triage", state: "issued", issuedAt: NOW, revision: "t2" } }),
    );
    await store.rotateAgentToken("triage");
    expect(calls(fetchMock)).toEqual([
      ["POST", "/ui/access-tokens/simon-ada", { expect: "r1" }],
      // The revocation was confirmed against the slot the rotation returned.
      ["DELETE", "/ui/access-tokens/simon-ada", { expect: "r2" }],
      ["POST", "/ui/access-tokens/triage", { expect: "t1" }],
    ]);
    expect(store.getState().tokens.find((slot) => slot.name === "simon-ada")?.revision).toBe("r3");
  });

  it("says a 409 slot_changed in fixed words, leaves the slot unresolved and sends nothing more", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock, window } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [{ ...simon, revision: "r1" }] }));
    await store.loadAccessTokens();
    window.confirm = vi.fn(() => true);
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "slot moved: route text", code: "slot_changed" }, { status: 409 }),
    );
    await store.rotateAgentToken("simon-ada");
    expect(store.getState().tokenConfirm).toEqual({ name: "simon-ada", action: "rotate" });
    await store.confirmTokenAction();
    expect(store.getState().tokenNotice).toEqual({ message: "Changed since you looked. Refresh.", tone: "error" });
    expect(store.getState().unresolvedSlots).toEqual(["simon-ada"]);
    await store.rotateAgentToken("simon-ada");
    await store.revokeAgentToken("simon-ada");
    // Unresolved: neither asks again, and nothing more is sent.
    expect(store.getState().tokenConfirm).toBeNull();
    await store.confirmTokenAction();
    expect(calls(fetchMock)).toHaveLength(1);
  });

  it("never dispatches against a slot read without a revision, and shows it unresolved", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock } = loaded;
    await bootMaintainer(loaded);
    const bare = { name: "simon-ada", state: "issued" as const, issuedAt: "2026-10-01T09:30:00.000Z" };
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [bare, { name: "triage", state: "none" }] }));
    await store.loadAccessTokens();
    await store.rotateAgentToken("triage");
    await store.rotateAgentToken("simon-ada");
    await store.revokeAgentToken("simon-ada");
    await store.confirmTokenAction();
    // No question opens and nothing is sent: there is no revision to send as `expect`.
    expect(store.getState().tokenConfirm).toBeNull();
    expect(calls(fetchMock)).toEqual([]);
  });

  it("sends the revision as expect when issuing a none slot, in the body for DELETE as for POST", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(
      Response.json({ agents: [{ name: "triage", state: "none", revision: "triageNoneRevision0000" }] }),
    );
    await store.loadAccessTokens();
    fetchMock.mockResolvedValueOnce(
      Response.json({
        token: "cta_t",
        agent: { name: "triage", state: "issued", issuedAt: NOW, revision: "triageIssuedRevision00" },
      }),
    );
    await store.rotateAgentToken("triage");
    fetchMock.mockResolvedValueOnce(
      Response.json({
        agent: { name: "triage", state: "revoked", revokedAt: NOW, revision: "triageRevokedRevision0" },
      }),
    );
    await store.revokeAgentToken("triage");
    await store.confirmTokenAction();
    expect(calls(fetchMock)).toEqual([
      ["POST", "/ui/access-tokens/triage", { expect: "triageNoneRevision0000" }],
      ["DELETE", "/ui/access-tokens/triage", { expect: "triageIssuedRevision00" }],
    ]);
    const headers = (fetchMock.mock.calls.at(-1)![1] as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("unresolves a slot whose contract revision differs from the list's, same state and date", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock, configMock } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(
      Response.json({ agents: [simon, { name: "triage", state: "none", revision: "triageNoneRevision0000" }] }),
    );
    await store.loadAccessTokens();
    expect(store.getState().unresolvedSlots).toEqual([]);
    // Another operator rotated and revoked meanwhile, landing on "none" again at a new revision.
    const newer = structuredClone(OPERATOR_V2_MAINTAINER);
    newer.agents = newer.agents.map((agent) =>
      agent.name === "triage"
        ? { ...agent, token: { state: "none" as const, revision: "triageNoneRevision0001" } }
        : agent,
    );
    configMock.mockResolvedValueOnce(Response.json(newer));
    await store.loadOperatorContract();
    expect(store.getState().unresolvedSlots).toEqual(["triage"]);
    await store.rotateAgentToken("triage");
    expect(calls(fetchMock)).toEqual([]);
  });
});

describe("review round 4: one generation fence per agent slot", () => {
  // Every slot carries a revision since P3b (#837); the defaults match the frozen contract's triage.
  const triageNone = (revision = "triageNoneRevision0000") => ({ name: "triage", state: "none", revision });
  const triageIssued = (issuedAt = NOW, revision = "triageIssuedRevision00") => ({
    name: "triage",
    state: "issued",
    issuedAt,
    revision,
  });
  const writes = (mock: ReturnType<typeof vi.fn>) =>
    mock.mock.calls.filter(([, init]) => ["POST", "DELETE"].includes((init as RequestInit | undefined)?.method ?? ""));

  for (const failure of ["truncated", "503", "slot_changed"] as const) {
    it(`review: a list read during a pending mutation must not resolve its later ${failure}`, async () => {
      const loaded = await loadStore({ id: "session", getToken: async () => "token" });
      const { store, fetchMock, window } = loaded;
      await bootMaintainer(loaded);
      const revision = failure === "slot_changed" ? "r0" : undefined;
      fetchMock.mockResolvedValueOnce(Response.json({ agents: [triageNone(revision)] }));
      await store.loadAccessTokens();
      const response = deferred<Response>();
      fetchMock.mockReturnValueOnce(response.promise);
      const pending = store.rotateAgentToken("triage");
      await vi.waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
      // This GET can read the old slot before the in-flight POST commits.
      fetchMock.mockResolvedValueOnce(Response.json({ agents: [triageNone(revision)] }));
      await store.loadAccessTokens();
      response.resolve(
        failure === "truncated"
          ? new Response('{"token":"cta_half', { status: 200 })
          : Response.json(
              { code: failure === "slot_changed" ? "slot_changed" : "outcome_unknown" },
              { status: failure === "slot_changed" ? 409 : 503 },
            ),
      );
      await pending;
      expect.soft(store.getState().unresolvedSlots).toContain("triage");
      window.confirm = vi.fn(() => true);
      fetchMock.mockResolvedValueOnce(
        Response.json({ token: "cta_second", agent: triageIssued(NOW, revision === undefined ? undefined : "r1") }),
      );
      await store.rotateAgentToken("triage");
      expect.soft(writes(fetchMock)).toHaveLength(1);
      expect(window.confirm).not.toHaveBeenCalled();
    });
  }

  it("review: a late mutation success must not replace a newer list revision", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock, window } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [triageNone("r0")] }));
    await store.loadAccessTokens();
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const pending = store.rotateAgentToken("triage");
    await vi.waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
    // POST committed r1, then another operator rotated r2, then this GET observed r2.
    const newer = triageIssued("2026-10-15T12:01:00.000Z", "r2");
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [newer] }));
    await store.loadAccessTokens();
    response.resolve(Response.json({ token: "cta_old", agent: triageIssued(NOW, "r1") }));
    await pending;
    const snapshot = store.getState();
    expect.soft(snapshot.unresolvedSlots.includes("triage") || snapshot.tokens[0]?.revision === "r2").toBe(true);
    window.confirm = vi.fn(() => true);
    fetchMock.mockResolvedValueOnce(
      Response.json({ agent: { name: "triage", state: "revoked", revokedAt: NOW, revision: "r3" } }),
    );
    await store.revokeAgentToken("triage");
    const last = writes(fetchMock).at(-1)!;
    expect(last[1]?.body).not.toBe(JSON.stringify({ expect: "r1" }));
  });

  it("review: a late mutation success must not clear a newer contract invalidation", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock, configMock } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [triageNone()] }));
    await store.loadAccessTokens();
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const pending = store.rotateAgentToken("triage");
    await vi.waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
    const newer = structuredClone(OPERATOR_V2_MAINTAINER);
    newer.agents = newer.agents.map((agent) =>
      agent.name === "triage"
        ? {
            ...agent,
            token: {
              state: "revoked" as const,
              revokedAt: "2026-10-15T12:01:00.000Z",
              revision: "triageRevokedRevision0",
            },
          }
        : agent,
    );
    configMock.mockResolvedValueOnce(Response.json(newer));
    await store.loadOperatorContract();
    expect(store.getState().unresolvedSlots).toContain("triage");
    response.resolve(Response.json({ token: "cta_old", agent: triageIssued() }));
    await pending;
    expect(store.getState().unresolvedSlots).toContain("triage");
  });

  it("review: an older list cannot clear a later contract invalidation", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock, configMock } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [triageNone()] }));
    await store.loadAccessTokens();
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const pending = store.loadAccessTokens();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const newer = structuredClone(OPERATOR_V2_MAINTAINER);
    newer.agents = newer.agents.map((agent) =>
      agent.name === "triage"
        ? { ...agent, token: { state: "issued" as const, issuedAt: NOW, revision: "triageIssuedRevision00" } }
        : agent,
    );
    configMock.mockResolvedValueOnce(Response.json(newer));
    await store.loadOperatorContract();
    response.resolve(Response.json({ agents: [triageNone()] }));
    await pending;
    expect(store.getState().unresolvedSlots).toContain("triage");
  });

  it("review: a revision-only list change invalidates a pending confirmation", async () => {
    let armed = false;
    const authToken = deferred<string>();
    const loaded = await loadStore({
      id: "session",
      getToken: () => {
        if (armed) {
          armed = false;
          return authToken.promise;
        }
        return Promise.resolve("token");
      },
    });
    const { store, fetchMock, window } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [triageIssued(NOW, "r1")] }));
    await store.loadAccessTokens();
    window.confirm = vi.fn(() => true);
    await store.revokeAgentToken("triage");
    expect(store.getState().tokenConfirm).toEqual({ name: "triage", action: "revoke" });
    armed = true;
    const pending = store.confirmTokenAction();
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [triageIssued(NOW, "r2")] }));
    await store.loadAccessTokens();
    authToken.resolve("token");
    await pending;
    expect(writes(fetchMock)).toHaveLength(0);
  });

  it("review: rapid double issue dispatches only one mutation", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [triageNone()] }));
    await store.loadAccessTokens();
    fetchMock.mockResolvedValueOnce(Response.json({ token: "cta_a", agent: triageIssued() }));
    await Promise.all([store.rotateAgentToken("triage"), store.rotateAgentToken("triage")]);
    expect(writes(fetchMock)).toHaveLength(1);
  });

  it("review: an older overlapping list failure cannot invalidate a newer success", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock } = loaded;
    await bootMaintainer(loaded);
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const pending = store.loadAccessTokens();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [triageNone("r1")] }));
    await store.loadAccessTokens();
    response.resolve(new Response("truncated", { status: 200 }));
    await pending;
    expect(store.getState().unresolvedSlots).toEqual([]);
    expect(store.getState().tokens).toEqual([triageNone("r1")]);
  });

  it.each([
    { token: "", agent: triageIssued() },
    { token: "cta_a", agent: { name: "triage", state: "issued" } },
    { token: "cta_a", agent: triageNone() },
  ])("review: malformed 200 does not resolve a slot: %j", async (payload) => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [triageNone()] }));
    await store.loadAccessTokens();
    fetchMock.mockResolvedValueOnce(Response.json(payload));
    await store.rotateAgentToken("triage");
    expect(store.getState().unresolvedSlots).toContain("triage");
  });

  it("review: extra response fields are not retained as slot state", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [{ ...triageNone(), credential: "SENTINEL" }] }));
    await store.loadAccessTokens();
    expect(store.getState().tokens).toEqual([triageNone()]);
    fetchMock.mockResolvedValueOnce(
      Response.json({ token: "cta_a", agent: { ...triageIssued(), credential: "SENTINEL" } }),
    );
    await store.rotateAgentToken("triage");
    expect(store.getState().tokens).toEqual([triageIssued()]);
  });

  it("keeps a newer list read's slot when a delayed issue success arrives after it", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock, window } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [triageNone()] }));
    await store.loadAccessTokens();
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const pending = store.rotateAgentToken("triage");
    await vi.waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
    // The issue committed, then someone revoked it; this read, started after dispatch, saw that.
    const revoked = { name: "triage", state: "revoked", revokedAt: "2026-10-15T12:02:00.000Z" };
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [revoked] }));
    await store.loadAccessTokens();
    response.resolve(Response.json({ token: "cta_late", agent: triageIssued() }));
    await pending;
    // The newer evidence stays; the late result is not restored, and the slot stays unresolved.
    expect(store.getState().tokens).toEqual([revoked]);
    expect(store.getState().unresolvedSlots).toEqual(["triage"]);
    expect(store.getState().tokenNotice?.message).toBe(
      "triage's token changed during this request. Refresh to check it.",
    );
    window.confirm = vi.fn(() => true);
    await store.rotateAgentToken("triage");
    expect(writes(fetchMock)).toHaveLength(1);
    // A read that starts now settles it.
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [revoked] }));
    await store.loadAccessTokens();
    expect(store.getState().unresolvedSlots).toEqual([]);
  });
});

describe("round 5 independent review probes", () => {
  const none = { name: "triage", state: "none", revision: "r0" };
  const issued = { name: "triage", state: "issued", issuedAt: NOW, revision: "r1" };
  const writes = (mock: ReturnType<typeof vi.fn>) =>
    mock.mock.calls.filter(([, init]) => ["POST", "DELETE"].includes((init as RequestInit | undefined)?.method ?? ""));

  it("a recovered contract that drops an agent invalidates a pending Issue even after an intervening failure", async () => {
    let armed = false;
    const authToken = deferred<string>();
    const loaded = await loadStore({
      id: "a",
      getToken: () => {
        if (armed) {
          armed = false;
          return authToken.promise;
        }
        return Promise.resolve("token");
      },
    });
    const { store, fetchMock, configMock } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [none] }));
    await store.loadAccessTokens();
    armed = true;
    const pending = store.rotateAgentToken("triage");
    configMock.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await store.loadOperatorContract();
    expect(store.getState().contract).toBeNull();
    const newer = structuredClone(OPERATOR_V2_MAINTAINER);
    newer.agents = newer.agents.filter((agent) => agent.name !== "triage");
    configMock.mockResolvedValueOnce(Response.json(newer));
    await store.loadOperatorContract();
    const beforeDispatch = store.getState();
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 404 }));
    authToken.resolve("token");
    await pending;
    expect.soft(beforeDispatch.unresolvedSlots).toContain("triage");
    expect.soft(writes(fetchMock)).toHaveLength(0);
  });

  it("an abandoned identity's completion must not leave a fresh identity's row silently actionable", async () => {
    const loaded = await loadStore({ id: "a", getToken: async () => "a" });
    const { store, fetchMock, changeSession } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [none] }));
    await store.loadAccessTokens();
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    const pending = store.rotateAgentToken("triage");
    await vi.waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
    fetchMock.mockResolvedValueOnce(Response.json(uiData("b")));
    changeSession({ id: "b", getToken: async () => "b" });
    await vi.waitFor(() => expect(store.getState().data?.serverInfo.name).toBe("b"));
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [none] }));
    await store.loadAccessTokens();
    old.resolve(Response.json({ token: "cta_old_identity", agent: issued }));
    await pending;
    expect(store.getState().createdToken).toBeNull();
    // If completion invalidates this row, the projected state must show that.
    const shownAsResolved = !store.getState().unresolvedSlots.includes("triage");
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(Response.json({ token: "cta_b", agent: issued }));
    await store.rotateAgentToken("triage");
    expect({ shownAsResolved, dispatched: writes(fetchMock).length }).not.toEqual({
      shownAsResolved: true,
      dispatched: 0,
    });
    // Stronger: A's completion leaves B's fence alone, so B's row is resolved and its Issue goes out.
    expect(shownAsResolved).toBe(true);
    expect(writes(fetchMock)).toHaveLength(1);
  });

  it("a superseded secret remains bound to its requested agent, then dismissal and rereads cannot replay it", async () => {
    const loaded = await loadStore({ id: "a", getToken: async () => "a" }, undefined, "tokens");
    const { store, fetchMock } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [none] }));
    await store.loadAccessTokens();
    const delayed = deferred<Response>();
    fetchMock.mockReturnValueOnce(delayed.promise);
    const pending = store.rotateAgentToken("triage");
    await vi.waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
    const revoked = { name: "triage", state: "revoked", revokedAt: NOW, revision: "r2" };
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [revoked] }));
    await store.loadAccessTokens();
    delayed.resolve(Response.json({ token: "cta_once", agent: issued }));
    await pending;
    expect(store.getState()).toMatchObject({
      createdToken: "cta_once",
      createdTokenFor: "triage",
      tokens: [revoked],
      unresolvedSlots: ["triage"],
    });
    store.dismissCreatedToken();
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [revoked] }));
    await store.loadAccessTokens();
    store.routeChanged("/connections");
    store.routeChanged("/tokens");
    expect(store.getState()).toMatchObject({ createdToken: null, createdTokenFor: null });
    expect(writes(fetchMock)).toHaveLength(1);
  });

  it("a list read that drops an agent invalidates a pending Issue against it", async () => {
    let armed = false;
    const authToken = deferred<string>();
    const loaded = await loadStore({
      id: "a",
      getToken: () => {
        if (armed) {
          armed = false;
          return authToken.promise;
        }
        return Promise.resolve("token");
      },
    });
    const { store, fetchMock } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [none] }));
    await store.loadAccessTokens();
    armed = true;
    const pending = store.rotateAgentToken("triage");
    // The agent is no longer declared: the next list read leaves it out.
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [] }));
    await store.loadAccessTokens();
    expect(store.getState().unresolvedSlots).toContain("triage");
    authToken.resolve("token");
    await pending;
    expect(writes(fetchMock)).toHaveLength(0);
  });
});

describe("round 6: member refresh deadline and authorization return", () => {
  /** A member contract with Notion's credential actions and Slack's state set. */
  function member(notion: Array<"save" | "test" | "clear">, slack: "ok" | "auth_required" = "ok"): Response {
    const body = structuredClone(OPERATOR_V2_MEMBER) as typeof OPERATOR_V2_MEMBER & Record<string, unknown>;
    (body.connectors.find((c) => c.id === "notion")!.manage as { actions: string[] }).actions = notion;
    body.connectors.find((c) => c.id === "slack")!.connection =
      slack === "ok" ? { state: "ok" } : { state: "auth_required", problem: "oauth_required" };
    return Response.json(body);
  }
  const sent = (fetchMock: ReturnType<typeof vi.fn>, method: string) =>
    fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method).map(([p]) => p);

  it("a stalled member refresh past its deadline closes Clear and the form, and sends no DELETE", async () => {
    const loaded = await loadStore({ id: "m", getToken: async () => "m" });
    const { store, fetchMock, configMock } = loaded;
    configMock.mockResolvedValueOnce(member(["save", "test", "clear"]));
    await store.boot();
    expect(store.getState()).toMatchObject({ session: "ready", role: "member" });
    store.editCredential("notion");
    store.askConfirm("notion", "credential_remove");
    expect(store.getState()).toMatchObject({ credentialEditing: "notion", confirming: { connectorId: "notion" } });
    vi.useFakeTimers();
    const stalled = deferred<Response>();
    configMock.mockReturnValueOnce(stalled.promise);
    void store.loadOperatorContract();
    await vi.advanceTimersByTimeAsync(15_001);
    // The member's own unavailable state: nothing actionable left on screen.
    expect(store.getState()).toMatchObject({
      session: "ready",
      contract: null,
      contractPhase: "error",
      confirming: null,
      credentialEditing: null,
      focusIfLost: "memberHeading",
    });
    await store.removeCredential("notion");
    expect(sent(fetchMock, "DELETE")).toEqual([]);
    // The read that missed its deadline cannot bring the old actions back.
    configMock.mockImplementation(() => new Promise<Response>(() => {}));
    stalled.resolve(member(["save", "test", "clear"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().contract).toBeNull();
    // A fresh read started afterwards does.
    configMock.mockImplementation(async () => member(["save", "test", "clear"]));
    await store.retryLoad();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().contract?.role).toBe("member");
  });

  it("re-reads the contract on return after consent outlasts the 30 s poll window, and says Connected", async () => {
    const loaded = await loadStore({ id: "m", getToken: async () => "m" });
    const { store, fetchMock, configMock, windowListeners } = loaded;
    configMock.mockImplementation(async () => member(["save"], "auth_required"));
    await store.boot();
    // The poll and its 30 s window run on these timers.
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(Response.json({ authorizationUrl: "https://auth.example.test/authorize" }));
    await store.startOAuth("slack", "continue");
    expect(sent(fetchMock, "POST")).toEqual(["/ui/oauth/slack?mode=continue"]);
    // Consent takes 35 s; the poll window has long closed.
    await vi.advanceTimersByTimeAsync(35_000);
    configMock.mockClear();
    configMock.mockImplementation(async () => member(["save"], "ok"));
    windowListeners.get("focus")?.();
    await vi.advanceTimersByTimeAsync(200);
    expect(configMock).toHaveBeenCalled();
    expect(store.getState().contract?.connectors.find((c) => c.id === "slack")?.connection?.state).toBe("ok");
    expect(store.getState()).toMatchObject({ oauthNoticeFor: "slack", oauthNotice: { message: "Connected." } });
    // Settled: a later return does not keep re-reading.
    configMock.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    windowListeners.get("focus")?.();
    await vi.advanceTimersByTimeAsync(200);
    expect(configMock).not.toHaveBeenCalled();
  });
});

describe("token confirmations live in the row", () => {
  const simon = {
    name: "simon-ada",
    state: "issued" as const,
    issuedAt: "2026-10-01T09:30:00.000Z",
    revision: "simonAdaIssuedRevision",
  };
  const writes = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(([, init]) =>
      ["POST", "DELETE"].includes((init as RequestInit | undefined)?.method ?? ""),
    );

  it("asks before rotating or revoking, sends only on confirm, and refuses when the slot changed meanwhile", async () => {
    const loaded = await loadStore({ id: "session", getToken: async () => "token" });
    const { store, fetchMock } = loaded;
    await bootMaintainer(loaded);
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [simon] }));
    await store.loadAccessTokens();
    await store.revokeAgentToken("simon-ada");
    expect(store.getState()).toMatchObject({
      tokenConfirm: { name: "simon-ada", action: "revoke" },
      pendingFocus: "confirm-cancel-token-simon-ada",
    });
    // Cancel sends nothing.
    store.cancelTokenAction("token-revoke-simon-ada");
    expect(store.getState()).toMatchObject({ tokenConfirm: null, pendingFocus: "token-revoke-simon-ada" });
    // Asked again; a list read lands before the confirm: the slot moved, so nothing is sent.
    await store.rotateAgentToken("simon-ada");
    fetchMock.mockResolvedValueOnce(Response.json({ agents: [simon] }));
    await store.loadAccessTokens();
    await store.confirmTokenAction();
    expect(writes(fetchMock)).toEqual([]);
    expect(store.getState().tokenNotice?.message).toContain("changed, so nothing was sent");
    // Asked and confirmed on a settled slot: one request.
    await store.rotateAgentToken("simon-ada");
    fetchMock.mockResolvedValueOnce(Response.json({ token: "cta_r", agent: { ...simon, issuedAt: NOW } }));
    await store.confirmTokenAction();
    expect(writes(fetchMock).map(([path, init]) => [path, (init as RequestInit).method])).toEqual([
      ["/ui/access-tokens/simon-ada", "POST"],
    ]);
    expect(store.getState().createdToken).toBeNull();
  });
});

describe("round 8: the member authorization return keeps its own throttle", () => {
  it("two returns within 2 s send one config read while an authorization is outstanding", async () => {
    const loaded = await loadStore({ id: "m", getToken: async () => "m" });
    const { store, fetchMock, configMock, windowListeners } = loaded;
    const body = structuredClone(OPERATOR_V2_MEMBER) as typeof OPERATOR_V2_MEMBER & Record<string, unknown>;
    body.connectors.find((c) => c.id === "slack")!.connection = { state: "auth_required", problem: "oauth_required" };
    configMock.mockImplementation(async () => Response.json(structuredClone(body)));
    await store.boot();
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(Response.json({ authorizationUrl: "https://auth.example.test/authorize" }));
    await store.startOAuth("slack", "continue");
    // Let the poll window pass, so only the return check is left.
    await vi.advanceTimersByTimeAsync(35_000);
    configMock.mockClear();
    windowListeners.get("focus")?.();
    await vi.advanceTimersByTimeAsync(200);
    // The first return's read succeeds, which resets the shared recovery state.
    expect(configMock).toHaveBeenCalledTimes(1);
    windowListeners.get("focus")?.();
    await vi.advanceTimersByTimeAsync(200);
    expect(configMock).toHaveBeenCalledTimes(1);
    // After the interval a return checks again.
    await vi.advanceTimersByTimeAsync(2_000);
    windowListeners.get("focus")?.();
    await vi.advanceTimersByTimeAsync(200);
    expect(configMock).toHaveBeenCalledTimes(2);
  });
});
