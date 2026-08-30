import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiData } from "../src/operator-ui/model.js";

/**
 * The operator store, driven the way a browser drives it.
 *
 * `test/ui.test.ts` asserts the pure rules in `view.ts`; this suite asserts the
 * wiring that decides *when* those rules run — the Clerk listener, `gate()`, the
 * generation fence, and the request path. That wiring is the security-relevant
 * half: a rule that empties identity-scoped state proves nothing if nothing
 * calls it when the identity changes, and the Playwright suite cannot reach it
 * because it signs in with a bearer token and never changes Clerk sessions.
 */

const BASE = "https://deployment.example";

/** The constants `renderUiHtml` writes into the page ahead of the bundle. */
const PAGE_CONSTANTS = {
  MCP_URL: `${BASE}/mcp`,
  INITIAL_PAGE: "connections",
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
    connectors: [
      { id: identity, title: identity, status: "ok", toolCount: 0, tools: [] },
    ],
    activityEnabled: true,
    credentialManagement: "available",
    accessTokenManagement: "available",
    oauthManagement: true,
  };
}

function accessToken(name: string) {
  return {
    id: `token-${name}`,
    name,
    tokenPrefix: "cta_abc",
    createdAt: "2026-07-30T12:00:00.000Z",
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
) {
  const fetchMock = vi.fn();
  const windowListeners = new Map<string, () => void>();
  let clerkListener:
    | ((resources: { session?: FakeSession | null }) => void)
    | undefined;
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
    location: { href: `${BASE}/`, assign: vi.fn() },
    Clerk: clerk,
    addEventListener: (name: string, listener: () => void) => {
      windowListeners.set(name, listener);
    },
    confirm: () => true,
  };
  for (const [name, value] of Object.entries(PAGE_CONSTANTS)) {
    vi.stubGlobal(name, value);
  }
  vi.stubGlobal("AUTH", browserAuth);
  vi.stubGlobal("window", window);
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  const store = await import("../src/operator-ui/app/store.js");
  return {
    store,
    clerk,
    fetchMock,
    windowListeners,
    /** Hand Clerk's listener a session change, the way Clerk itself would. */
    changeSession(next: FakeSession | null) {
      clerk.session = next as FakeSession;
      clerkListener?.({ session: next });
    },
  };
}

/** The Authorization header the nth request carried. */
function bearerOf(fetchMock: ReturnType<typeof vi.fn>, index: number): unknown {
  const init = fetchMock.mock.calls[index]?.[1] as
    | { headers?: Record<string, string> }
    | undefined;
  return init?.headers?.Authorization;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("operator store identity wiring", () => {
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
      Response.json({ accessTokens: [accessToken("identity-a client")] }),
    );
    await store.loadAccessTokens();
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
    expect(store.getState().tokens).toHaveLength(1);
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
    expect(gated.tokens).toEqual([]);
    expect(gated.activityEvents).toEqual([]);
    expect(gated.connectorFilter).toBe("");
    expect(gated.tokenPhase).toBe("idle");
    expect(gated.activityPhase).toBe("idle");
    expect(gated.tokenNotice).toBeNull();
    expect(gated.credentialNotice).toBeNull();
    expect(gated.oauthNotice).toBeNull();
    expect(gated.createdToken).toBeNull();
    expect(JSON.stringify(gated)).not.toContain("identity-a");

    second.resolve(Response.json(uiData("identity-b")));
    await vi.waitFor(() => {
      expect(store.getState().session).toBe("ready");
      expect(store.getState().data?.serverInfo.name).toBe("identity-b");
    });
    // The refetch asked as the new identity, not with the token that was
    // current when the listener fired.
    expect(bearerOf(fetchMock, fetchMock.mock.calls.length - 1)).toBe(
      "Bearer token-b",
    );
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
    const inFlight = store.loadAccessTokens();

    // identity-b arrives first, and its own /ui/data never settles here.
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    changeSession({ id: "sess_b", getToken: async () => "token-b" });

    slow.resolve(
      Response.json({ accessTokens: [accessToken("identity-a client")] }),
    );
    await inFlight;

    // The fence, not a race: identity-a's tokens never land on identity-b's
    // screen, and the collection stays idle so the new identity refetches.
    expect(store.getState().tokens).toEqual([]);
    expect(store.getState().tokenPhase).toBe("idle");
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
    const loaded = await loadStore(
      { id: "unused", getToken: async () => "unused" },
      { kind: "cloudflare-access" },
    );
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
