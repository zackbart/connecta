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
});

describe("operator admission gate", () => {
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

describe("operator unreadable collections", () => {
  it.each(["truncated JSON", "{}"])("reports an unreadable token collection instead of no tokens: %s", async (body) => {
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
});

describe("operator connection writes", () => {
  const writes = (paths: string[]) =>
    paths.filter((path) => path.startsWith("/ui/credentials/") || path.startsWith("/ui/oauth/"));

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
});

describe("round 5 independent review probes", () => {
  const none = { name: "triage", state: "none", revision: "r0" };
  const issued = { name: "triage", state: "issued", issuedAt: NOW, revision: "r1" };
  const writes = (mock: ReturnType<typeof vi.fn>) =>
    mock.mock.calls.filter(([, init]) => ["POST", "DELETE"].includes((init as RequestInit | undefined)?.method ?? ""));

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
